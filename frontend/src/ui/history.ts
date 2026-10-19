/**
 * 历史曲线图表模块（建议8/9 拆分产物）：数据加载、渲染、区间/传感器/风扇筛选。
 */
import {store} from "../store";
import {echarts} from "../echarts-setup";
import type {SeriesOption, YAXisComponentOption} from "../echarts-setup";
import {$, esc, toast} from "./core";
import {getSensorDisplayName} from "./sources";
import {fetchHistory, setGlobalConfig} from "../api";
import {HistoryPoint, HistoryRange, HistorySeries} from "../types";
import {getChartPalette, onThemeChanged} from "../theme";

export const HISTORY_COLOR_CPU = "#38bdf8";
export const HISTORY_COLOR_GPU = "#f97316";
export const HISTORY_COLOR_DISK = "#10b981";

/** 与温度页默认系列（CPU/GPU/硬盘）同序，其后接扩展传感器色板 */
export const HISTORY_SERIES_COLORS = [
    HISTORY_COLOR_CPU,
    HISTORY_COLOR_GPU,
    HISTORY_COLOR_DISK,
    "#ef4444", // red
    "#eab308", // yellow
    "#d946ef", // fuchsia
    "#6366f1", // indigo
    "#84cc16", // lime
    "#14b8a6", // teal
    "#ec4899", // pink
    "#a855f7", // purple
    "#facc15", // amber
    "#e11d48", // rose
    "#22c55e", // green
    "#0891b2", // cyan-600
];

export const HISTORY_LINE_DEFAULTS = {
    type: "line",
    smooth: true,
    symbol: "none",
    sampling: "lttb",
    // 应用停止/卸载期间没有采集数据，历史曲线必须在该时段断开：null 点不连线
    connectNulls: false,
    animation: false,
    emphasis: {focus: "series"},
    tooltip: {show: true},
} as const;

/**
 * 断档检测基准：后端 historySampleInterval = 1 分钟（backend/internal/service/history_store.go），
 * 连续缺失 3 个采样周期、且不少于 3 分钟，才判定为"无数据断档"。
 * 单次采样轻微延迟（间隔 ≤ 2 个周期，即 1 分钟内抖动）不会断线，避免曲线破碎。
 */
export const HISTORY_SAMPLE_INTERVAL_MS = 60 * 1000;
export const HISTORY_GAP_MIN_THRESHOLD_MS = 3 * HISTORY_SAMPLE_INTERVAL_MS;
export const HISTORY_GAP_JITTER_TOLERANCE_MS = 60 * 1000;

/** 断档阈值覆盖值（毫秒），0 表示按视图跨度自适应；可通过 setHistoryGapThresholdMs 调整。 */
let historyGapThresholdOverrideMs = 0;

/** 手动指定断档阈值（毫秒）；传 0 恢复自适应。下限为「采样周期 + 抖动容差」，避免曲线破碎。 */
export function setHistoryGapThresholdMs(ms: number) {
    const min = HISTORY_SAMPLE_INTERVAL_MS + HISTORY_GAP_JITTER_TOLERANCE_MS;
    historyGapThresholdOverrideMs = Number.isFinite(ms) && ms > 0 ? Math.max(ms, min) : 0;
}

/** 风扇关联温度曲线专用色板：与转速色板（HISTORY_SERIES_COLORS）错开，便于温度栏内按风扇区分。 */
export const HISTORY_FAN_TEMP_COLORS = [
    "#a78bfa", // violet-400
    "#22d3ee", // cyan-400
    "#4ade80", // green-400
    "#fb7185", // rose-400
    "#fbbf24", // amber-400
    "#818cf8", // indigo-400
    "#f472b6", // pink-400
    "#34d399", // emerald-400
];

export const HISTORY_CHART_GRID = {left: 8, right: 16, top: 16, bottom: 20, containLabel: true};

export const HISTORY_CHART_ANIM = {animation: false, animationDurationUpdate: 0};

export function historyXAxisBase() {
    const p = getChartPalette();
    return {
        type: "time" as const,
        axisLine: {lineStyle: {color: p.axis}},
        axisTick: {alignWithLabel: true},
        axisLabel: {
            showMinLabel: true,
            showMaxLabel: true,
            hideOverlap: false,
            margin: 10,
            color: p.label,
        },
    };
}

export function historyYAxisBase() {
    const p = getChartPalette();
    return {
        type: "value" as const,
        axisLine: {lineStyle: {color: p.axis}},
        axisTick: {show: false},
        splitLine: {
            show: true,
            showMinLine: false,
            showMaxLine: false,
            lineStyle: {color: p.split},
        },
    };
}

let historyChart: echarts.ECharts | null = null;
let historyChartResizeRaf = 0;
let historyChartResizeObserver: IntersectionObserver | null = null;
let historyData: HistorySeries | null = null;
let historyRange: HistoryRange = "1h";
let historyRefreshTimer: number | null = null;
let historySpanHours = 1;
let historyTimeMin = 0;
let historyTimeMax = 0;
type HistoryView = "temp" | "fan";
let historyView: HistoryView = "temp";
const historyRangeOptions: HistoryRange[] = ["1h", "6h", "24h", "7d", "custom"];
export const historySensorSelected = new Set<string>();
export const historyFanSelected = new Set<string>();

export function syncHistoryPrefsToConfig() {
    store.getConfig().global.history_range = historyRange;
    store.getConfig().global.history_sensors = [...historySensorSelected];
    store.getConfig().global.history_fans = [...historyFanSelected];
    if (historyRange === "custom") {
        const fromEl = document.getElementById("history-from") as HTMLInputElement | null;
        const toEl = document.getElementById("history-to") as HTMLInputElement | null;
        if (fromEl?.value) store.getConfig().global.history_from = fromEl.value;
        if (toEl?.value) store.getConfig().global.history_to = toEl.value;
    }
}

async function persistHistoryPrefs() {
    syncHistoryPrefsToConfig();
    try {
        await setGlobalConfig(store.getConfig().global);
    } catch (e) {
        console.error(e);
    }
}

export function applyHistoryPrefsFromConfig() {
    const g = store.getConfig().global;
    if (g.history_range && historyRangeOptions.includes(g.history_range)) {
        historyRange = g.history_range;
    } else {
        historyRange = "1h";
    }

    const hiddenSensors = new Set(store.getConfig().global.sensor_hidden ?? []);
    const knownSensors = new Set((store.getTelemetry()?.sensors ?? []).map(s => s.id));
    historySensorSelected.clear();
    if (g.history_sensors == null) {
        // 从未配置：不强行勾选扩展传感器
    } else {
        for (const id of g.history_sensors) {
            if (hiddenSensors.has(id)) continue;
            if (knownSensors.size > 0 && !knownSensors.has(id)) continue;
            historySensorSelected.add(id);
        }
    }

    historyFanSelected.clear();
    if (g.history_fans == null) {
        // 从未配置：默认勾选前 5 个
        for (const fan of (store.getConfig().fans ?? []).slice(0, 5)) {
            historyFanSelected.add(fan.id);
        }
    } else {
        // 含 []：尊重用户选择（全不选也保留）
        const knownFanIds = new Set((store.getConfig().fans ?? []).map(f => f.id));
        for (const id of g.history_fans) {
            if (knownFanIds.has(id)) historyFanSelected.add(id);
        }
    }

    const rangeEl = document.getElementById("history-range") as HTMLSelectElement | null;
    if (rangeEl) rangeEl.value = historyRange;

    const panel = document.getElementById("history-custom-panel");
    panel?.classList.toggle("hidden", historyRange !== "custom");

    const fromEl = document.getElementById("history-from") as HTMLInputElement | null;
    const toEl = document.getElementById("history-to") as HTMLInputElement | null;
    if (g.history_from && fromEl) fromEl.value = g.history_from;
    if (g.history_to && toEl) toEl.value = g.history_to;

    setupHistoryRefreshTimer();
    updateHistorySensorsButtonLabel();
    updateHistoryFansButtonLabel();
    applyHistoryViewUI();
    renderHistoryLegend();
}

export function historyPointValue(p: HistoryPoint): number | null {
    return p.value != null ? p.value : null;
}

export function formatHistoryTemp(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${v.toFixed(1)}°C`;
}

export function formatHistoryPWMPercent(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${Math.round(v)}%`;
}

export function formatHistoryRPM(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${Math.round(v)} RPM`;
}

export function lookupHistoryValueAt(points: HistoryPoint[] | undefined, ts: number): number | null {
    if (!points?.length) return null;
    let best: number | null = null;
    let bestDiff = Infinity;
    for (const p of points) {
        const t = new Date(p.time).getTime();
        if (!Number.isFinite(t)) continue;
        const diff = Math.abs(t - ts);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = historyPointValue(p);
        }
    }
    // 允许与轴对齐后的时间有少量偏差（降采样/对齐）
    if (bestDiff > 5 * 60 * 1000) return null;
    return best;
}

export function historyTooltipValue(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (Array.isArray(raw) && raw.length >= 2) {
        const v = raw[1];
        if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
}

export function historyTooltipTime(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (Array.isArray(raw) && raw.length >= 1) {
        const t = raw[0];
        if (typeof t === "number" && Number.isFinite(t)) return t;
    }
    if (typeof raw === "string" && raw.includes("T")) {
        const t = new Date(raw).getTime();
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

export function historyTooltipFormatter(params: unknown): string {
    const items = (Array.isArray(params) ? params : [params]) as Array<{
        seriesName?: string;
        seriesId?: string;
        color?: string;
        value?: unknown;
        data?: unknown;
        axisValue?: unknown;
    }>;
    if (items.length === 0) return "";
    const rawHead = items[0].axisValue ?? items[0].value ?? items[0].data;
    const headTime = historyTooltipTime(rawHead);
    const head = headTime != null
        ? formatHistoryAxisTime(new Date(headTime).toISOString())
        : String(rawHead ?? "");
    const lines = items
        .map(it => {
            const val = historyTooltipValue(it.value) ?? historyTooltipValue(it.data);
            if (val == null) return null;
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${it.color};margin-right:6px"></span>`;
            const seriesId = it.seriesId ?? "";
            if (seriesId.startsWith("fan_pwm:")) {
                const fanId = seriesId.slice("fan_pwm:".length);
                const rpm = headTime != null
                    ? lookupHistoryValueAt(historyData?.fans_rpm?.[fanId], headTime)
                    : null;
                return `${dot}${it.seriesName}: ${formatHistoryPWMPercent(val)} · ${formatHistoryRPM(rpm)}`;
            }
            return `${dot}${it.seriesName}: ${formatHistoryTemp(val)}`;
        })
        .filter((line): line is string => line != null);
    if (lines.length === 0) return "";
    return `${head}<br/>${lines.join("<br/>")}`;
}

export function historyChartTooltip() {
    return {
        trigger: "axis" as const,
        formatter: historyTooltipFormatter,
        confine: true,
        backgroundColor: "rgba(15,23,42,0.92)",
        borderColor: "rgba(148,163,184,0.25)",
        textStyle: {color: "#e2e8f0"},
        extraCssText: "z-index: 10000; pointer-events: none;",
    };
}

export function applyHistoryViewUI() {
    const sensorsWrap = document.getElementById("history-sensors-wrap");
    const fansWrap = document.getElementById("history-fans-wrap");
    sensorsWrap?.classList.toggle("hidden", historyView !== "temp");
    fansWrap?.classList.toggle("hidden", historyView !== "fan");
    if (historyView !== "temp") {
        document.getElementById("history-sensor-dropdown")?.classList.add("hidden");
        document.getElementById("history-sensors-chevron")?.setAttribute("icon", "mdi:chevron-down");
    }
    if (historyView !== "fan") {
        document.getElementById("history-fan-dropdown")?.classList.add("hidden");
        document.getElementById("history-fans-chevron")?.setAttribute("icon", "mdi:chevron-down");
    }
    document.querySelectorAll<HTMLButtonElement>("#history-view-tabs [data-history-view]").forEach(btn => {
        const active = btn.dataset.historyView === historyView;
        btn.className = `history-view-tab px-3 py-1 rounded-md transition-colors ${
            active ? "bg-sky-600 text-white" : "text-slate-400 hover:text-white"
        }`;
    });
}

export function setHistoryView(view: HistoryView) {
    if (historyView === view) return;
    historyView = view;
    applyHistoryViewUI();
    renderHistoryLegend();
    updateHistoryChart();
    scheduleHistoryChartResize();
}

export function scheduleHistoryChartResize() {
    if (!historyChart) return;
    if (historyChartResizeRaf) cancelAnimationFrame(historyChartResizeRaf);
    historyChartResizeRaf = requestAnimationFrame(() => {
        historyChartResizeRaf = 0;
        historyChart?.resize();
    });
}

export function bindHistoryChartResizeObserver(el: HTMLElement) {
    historyChartResizeObserver?.disconnect();
    historyChartResizeObserver = new IntersectionObserver(
        entries => {
            if (entries.some(e => e.isIntersecting)) scheduleHistoryChartResize();
        },
        {threshold: 0.01},
    );
    historyChartResizeObserver.observe(el);
}

export function formatHistoryAxisTime(iso: string): string {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    if (historySpanHours <= 24) {
        return `${h}:${m}`;
    }
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    if (historySpanHours <= 7 * 24) {
        return `${mo}-${day} ${h}:${m}`;
    }
    return `${mo}-${day}`;
}

export function historyAxisLabelFormatter(val: number): string {
    return formatHistoryAxisTime(new Date(val).toISOString());
}

export function historyXAxisMinInterval(): number {
    if (historySpanHours <= 1.5) return 10 * 60 * 1000;
    if (historySpanHours <= 6) return 60 * 60 * 1000;
    if (historySpanHours <= 24) return 2 * 60 * 60 * 1000;
    if (historySpanHours <= 7 * 24) return 6 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
}

export function latestHistoryPointTime(h: HistorySeries): number {
    let max = 0;
    const groups = [
        h.cpu_temp,
        h.gpu_temp,
        h.disk_avg,
        ...Object.values(h.sensors ?? {}),
        ...Object.values(h.fans_pwm ?? {}),
        ...Object.values(h.fans_temp ?? {}),
    ];
    for (const pts of groups) {
        // 后端 json 序列化时 nil slice 会输出 null（如 cpu_temp），展开 null 会抛
        // "n is not iterable"，这里统一做防御。
        if (!Array.isArray(pts)) continue;
        for (const p of pts) {
            const t = new Date(p.time).getTime();
            if (Number.isFinite(t)) max = Math.max(max, t);
        }
    }
    return max;
}

export function applyHistoryTimeBounds(h: HistorySeries, windowEnd?: number, windowStart?: number) {
    const spanMs = historySpanHours * 3600000;
    const pad = Math.max(120_000, spanMs * 0.05);
    const dataMax = latestHistoryPointTime(h);
    const end = Math.max(windowEnd ?? Date.now(), dataMax);
    historyTimeMax = end + pad;
    historyTimeMin = (windowStart ?? end - spanMs) - pad * 0.2;
}

export function sensorHistoryColor(id: string): string {
    // 扩展传感器从第 4 色起，避免与 CPU/GPU/硬盘默认色撞车
    const palette = HISTORY_SERIES_COLORS.slice(3);
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
}

export function fanHistoryColor(id: string): string {
    const idx = (store.getConfig().fans ?? []).findIndex(f => f.id === id);
    const i = idx >= 0 ? idx : 0;
    return HISTORY_SERIES_COLORS[i % HISTORY_SERIES_COLORS.length];
}

export function fanTempHistoryColor(id: string): string {
    const idx = (store.getConfig().fans ?? []).findIndex(f => f.id === id);
    const i = idx >= 0 ? idx : 0;
    return HISTORY_FAN_TEMP_COLORS[i % HISTORY_FAN_TEMP_COLORS.length];
}

/** 将 #rrggbb 向白色混合变亮（同色系），用于温度曲线双色虚线间隔显示时的辅助虚线颜色。 */
function lightenHex(hex: string, amount = 0.35): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    const mix = (c: number) => Math.round(c + (255 - c) * amount);
    const v = (mix(r) << 16) | (mix(g) << 8) | mix(b);
    return `#${v.toString(16).padStart(6, "0")}`;
}

/** 历史曲线数据点：时间为真实时间戳，值为 null 表示断档占位（不绘制、不连线）。 */
export type HistorySeriesPoint = [number, number | null];

/**
 * 当前视图的采样粒度（毫秒），与后端 downsampleInterval 严格对齐：
 * ≤6h → 1min；≤24h → 5min；≤7d → 15min；更长 → span/800（30min~1h 夹紧）。
 */
export function historySampleGranularityMs(hours = historySpanHours): number {
    const span = Number.isFinite(hours) && hours > 0 ? hours : 1;
    if (span <= 6) return HISTORY_SAMPLE_INTERVAL_MS;
    if (span <= 24) return 5 * HISTORY_SAMPLE_INTERVAL_MS;
    if (span <= 7 * 24) return 15 * HISTORY_SAMPLE_INTERVAL_MS;
    const raw = (span * 3600000) / 800;
    const min = 30 * HISTORY_SAMPLE_INTERVAL_MS;
    const max = 60 * HISTORY_SAMPLE_INTERVAL_MS;
    return Math.min(max, Math.max(min, Math.ceil(raw / HISTORY_SAMPLE_INTERVAL_MS) * HISTORY_SAMPLE_INTERVAL_MS));
}

/**
 * 当前视图的断档阈值（毫秒）：连续缺失 3 个采样周期即视为无数据，且不少于 3 分钟。
 * 1 分钟内的单次抖动（间隔 ≤ 2 个周期）不会触发断线。
 */
export function historyGapThresholdMs(hours = historySpanHours): number {
    if (historyGapThresholdOverrideMs > 0) return historyGapThresholdOverrideMs;
    return Math.max(3 * historySampleGranularityMs(hours), HISTORY_GAP_MIN_THRESHOLD_MS);
}

/** 相邻采样点时间差超阈值时插入 null 占位点，使该时段曲线断开（不补点、不拉直线）。 */
function withHistoryGaps(items: [number, number][], threshold: number): HistorySeriesPoint[] {
    if (items.length === 0) return [];
    const sorted = items.length > 1 ? [...items].sort((a, b) => a[0] - b[0]) : items;
    const out: HistorySeriesPoint[] = [];
    let prevT: number | null = null;
    for (const [t, v] of sorted) {
        if (prevT != null && t - prevT > threshold) {
            out.push([prevT + (t - prevT) / 2, null]);
        }
        out.push([t, v]);
        prevT = t;
    }
    return out;
}

export function historySeriesHasGap(data: HistorySeriesPoint[]): boolean {
    return data.some(p => p[1] == null);
}

export function historyPointsToSeriesData(
    points: HistoryPoint[],
    threshold = historyGapThresholdMs(),
): HistorySeriesPoint[] {
    const items: [number, number][] = [];
    for (const p of points) {
        const v = historyPointValue(p);
        if (v == null || !Number.isFinite(v)) continue;
        const t = new Date(p.time).getTime();
        if (!Number.isFinite(t)) continue;
        items.push([t, v]);
    }
    return withHistoryGaps(items, threshold);
}

export function historyPWMPointsToPercentData(
    points: HistoryPoint[],
    threshold = historyGapThresholdMs(),
): HistorySeriesPoint[] {
    const items: [number, number][] = [];
    for (const p of points) {
        const v = historyPointValue(p);
        if (v == null || !Number.isFinite(v)) continue;
        const t = new Date(p.time).getTime();
        if (!Number.isFinite(t)) continue;
        items.push([t, Math.min(100, Math.max(0, v / 255 * 100))]);
    }
    return withHistoryGaps(items, threshold);
}

export function historyPointsStats(arr: HistoryPoint[] | undefined): {min: number; max: number} {
    if (!arr?.length) return {min: Infinity, max: -Infinity};
    const vals = arr.map(historyPointValue).filter((v): v is number => v !== null);
    if (vals.length === 0) return {min: Infinity, max: -Infinity};
    return {min: Math.min(...vals), max: Math.max(...vals)};
}

export function computeTempYAxisRange(h: HistorySeries, hidden: Set<string>): {min: number; max: number} {
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const arr of [h.cpu_temp, h.gpu_temp, h.disk_avg]) {
        const s = historyPointsStats(arr);
        dataMin = Math.min(dataMin, s.min);
        dataMax = Math.max(dataMax, s.max);
    }
    for (const id of historySensorSelected) {
        if (hidden.has(id)) continue;
        const s = historyPointsStats(h.sensors?.[id]);
        dataMin = Math.min(dataMin, s.min);
        dataMax = Math.max(dataMax, s.max);
    }
    if (!isFinite(dataMin) || !isFinite(dataMax)) {
        return {min: 0, max: 100};
    }
    return {
        min: Math.max(0, Math.floor((dataMin - 2) / 5) * 5),
        max: Math.ceil((dataMax + 2) / 5) * 5 + 5,
    };
}

export function historyLineSeries(
    id: string,
    name: string,
    points: HistoryPoint[] | undefined,
    color: string,
    asPWMPercent = false,
): SeriesOption {
    const threshold = historyGapThresholdMs();
    const data = asPWMPercent
        ? historyPWMPointsToPercentData(points ?? [], threshold)
        : historyPointsToSeriesData(points ?? [], threshold);
    return {
        ...HISTORY_LINE_DEFAULTS,
        id,
        name,
        data,
        color,
        // 存在断档时关闭 lttb 采样（sampling="none"），避免采样器跨过 null 占位点导致断档被"接上"
        sampling: historySeriesHasGap(data) ? "none" : HISTORY_LINE_DEFAULTS.sampling,
        lineStyle: {color, width: 2},
    };
}

export function historyChartXAxisOption() {
    return {
        ...historyXAxisBase(),
        min: historyTimeMin,
        max: historyTimeMax,
        minInterval: historyXAxisMinInterval(),
        axisLabel: {
            ...historyXAxisBase().axisLabel,
            formatter: historyAxisLabelFormatter,
        },
    };
}

export function updateHistoryChart() {
    if (!historyChart || !historyData) return;
    const h = historyData;
    const hidden = new Set(store.getConfig().global.sensor_hidden ?? []);
    const series: SeriesOption[] = [];
    let yAxis: YAXisComponentOption | YAXisComponentOption[];

    if (historyView === "temp") {
        const {min: yMin, max: yMax} = computeTempYAxisRange(h, hidden);
        series.push(
            historyLineSeries("cpu_temp", "CPU", h.cpu_temp, HISTORY_COLOR_CPU),
            historyLineSeries("gpu_temp", "GPU", h.gpu_temp, HISTORY_COLOR_GPU),
            historyLineSeries("disk_avg", "硬盘平均", h.disk_avg, HISTORY_COLOR_DISK),
        );
        for (const s of store.getTelemetry()?.sensors ?? []) {
            if (hidden.has(s.id) || !historySensorSelected.has(s.id)) continue;
            const pts = h.sensors?.[s.id];
            if (!pts?.length) continue;
            series.push(historyLineSeries(`sensor:${s.id}`, getSensorDisplayName(s.id), pts, sensorHistoryColor(s.id)));
        }
        yAxis = {
            ...historyYAxisBase(),
            min: yMin,
            max: yMax,
            axisLabel: {formatter: (v: number) => `${v.toFixed(0)}°`, margin: 8, color: getChartPalette().label},
        };
    } else {
        const fanTempSeries: SeriesOption[] = [];
        for (const fan of store.getConfig().fans ?? []) {
            if (!historyFanSelected.has(fan.id)) continue;
            const pts = h.fans_pwm?.[fan.id];
            if (!pts?.length) continue;
            const c = fanHistoryColor(fan.id);
            series.push(historyLineSeries(`fan_pwm:${fan.id}`, fan.name || fan.id, pts, c, true));
            const tpts = h.fans_temp?.[fan.id];
            if (!tpts?.length) continue;
            const tc = fanTempHistoryColor(fan.id);
            const tdata = historyPointsToSeriesData(tpts, historyGapThresholdMs());
            const tSampling = historySeriesHasGap(tdata) ? "none" : HISTORY_LINE_DEFAULTS.sampling;
            // 主曲线：自身颜色实线
            fanTempSeries.push({
                ...HISTORY_LINE_DEFAULTS,
                id: `fan_temp:${fan.id}`,
                name: `${fan.name || fan.id} 温度`,
                data: tdata,
                color: tc,
                sampling: tSampling,
                lineStyle: {color: tc, width: 2, type: "solid"},
                yAxisIndex: 1,
            });
            // 辅助虚线系列：同色系变亮颜色、虚线线型，与主实线叠加形成"双色虚线间隔"，
            // 重叠区域仍能看出层次；不参与 tooltip/图例/悬停，避免重复误导。
            fanTempSeries.push({
                ...HISTORY_LINE_DEFAULTS,
                id: `fan_temp_aux:${fan.id}`,
                name: "",
                data: tdata,
                color: lightenHex(tc),
                sampling: tSampling,
                lineStyle: {color: lightenHex(tc), width: 2, type: "dashed"},
                yAxisIndex: 1,
                silent: true,
                tooltip: {show: false},
                legendHoverLink: false,
            });
        }
        series.push(...fanTempSeries);
        yAxis = [
            {
                ...historyYAxisBase(),
                min: 0,
                max: 100,
                axisLabel: {formatter: (v: number) => `${v.toFixed(0)}%`, margin: 8, color: getChartPalette().label},
            },
            fanTempYAxisOption(fanTempSeries),
        ];
    }

    historyChart.setOption({
        xAxis: historyChartXAxisOption(),
        yAxis,
        series,
    }, {replaceMerge: ["series", "yAxis"], silent: true});
    scheduleHistoryChartResize();
}

/** 风扇温度组合曲线专用右轴：按 fan_temp 系列数据动态定界，无数据时退化为 0-100°。 */
function fanTempYAxisOption(fanTempSeries: SeriesOption[]): YAXisComponentOption {
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const s of fanTempSeries) {
        if (typeof s.id !== "string" || !s.id.startsWith("fan_temp:")) continue;
        for (const p of (s.data as HistorySeriesPoint[]) ?? []) {
            const v = p[1];
            if (v != null && Number.isFinite(v)) {
                dataMin = Math.min(dataMin, v);
                dataMax = Math.max(dataMax, v);
            }
        }
    }
    if (!isFinite(dataMin) || !isFinite(dataMax)) {
        return {
            ...historyYAxisBase(),
            min: 0,
            max: 100,
            axisLabel: {formatter: (v: number) => `${v.toFixed(0)}°`, margin: 8, color: getChartPalette().label},
        };
    }
    return {
        ...historyYAxisBase(),
        min: Math.max(0, Math.floor((dataMin - 2) / 5) * 5),
        max: Math.ceil((dataMax + 2) / 5) * 5 + 5,
        axisLabel: {formatter: (v: number) => `${v.toFixed(0)}°`, margin: 8, color: getChartPalette().label},
    };
}

export async function loadHistoryChart() {
    try {
        if (historyRange === "custom") {
            const fromEl = document.getElementById("history-from") as HTMLInputElement | null;
            const toEl = document.getElementById("history-to") as HTMLInputElement | null;
            const fromLocal = fromEl?.value;
            const toLocal = toEl?.value;
            if (!fromLocal || !toLocal) return;
            const from = new Date(fromLocal).toISOString();
            const to = new Date(toLocal).toISOString();
            historySpanHours = (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
            historyData = await fetchHistory({from, to});
            applyHistoryTimeBounds(historyData, new Date(to).getTime(), new Date(from).getTime());
        } else {
            const spanMap: Record<string, number> = {"1h": 1, "6h": 6, "24h": 24, "7d": 7 * 24};
            historySpanHours = spanMap[historyRange] ?? 1;
            historyData = await fetchHistory({range: historyRange});
            applyHistoryTimeBounds(historyData);
        }
        updateHistoryChart();
        renderHistoryLegend();
        refreshHistorySelectorsFromTelemetry();
    } catch (e: any) {
        console.error(e);
        toast(e?.message || "加载历史曲线失败", "error");
    }
}

export function renderHistoryLegend() {
    const root = document.getElementById("history-legend-fixed");
    if (!root) return;
    const items: {name: string; color: string}[] = [];

    if (historyView === "temp") {
        const hidden = new Set(store.getConfig().global.sensor_hidden ?? []);
        items.push(
            {name: "CPU", color: HISTORY_COLOR_CPU},
            {name: "GPU", color: HISTORY_COLOR_GPU},
            {name: "硬盘平均", color: HISTORY_COLOR_DISK},
        );
        // 与曲线一致：按 store.getTelemetry()!.sensors 顺序
        for (const s of store.getTelemetry()?.sensors ?? []) {
            if (hidden.has(s.id) || !historySensorSelected.has(s.id)) continue;
            items.push({name: getSensorDisplayName(s.id), color: sensorHistoryColor(s.id)});
        }
    } else {
        // 与曲线一致：按 store.getConfig().fans 顺序
        for (const fan of store.getConfig().fans ?? []) {
            if (!historyFanSelected.has(fan.id)) continue;
            items.push({name: fan.name || fan.id, color: fanHistoryColor(fan.id)});
            if (historyData?.fans_temp?.[fan.id]?.length) {
                items.push({name: `${fan.name || fan.id} 温度`, color: fanTempHistoryColor(fan.id)});
            }
        }
    }

    root.innerHTML = items.map(it =>
        `<span class="inline-flex items-center gap-1.5 text-slate-300 font-medium">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(it.color)}"></span>
            <span>${esc(it.name)}</span>
        </span>`
    ).join("");
}

export function updateHistorySensorsButtonLabel() {
    const label = document.getElementById("history-sensors-toggle-label");
    if (!label) return;
    const n = historySensorSelected.size;
    label.textContent = n > 0 ? `传感器 (${n})` : "传感器";
}

export function updateHistoryFansButtonLabel() {
    const label = document.getElementById("history-fans-toggle-label");
    if (!label) return;
    const n = historyFanSelected.size;
    label.textContent = n > 0 ? `风扇 (${n})` : "风扇";
}

export function refreshHistorySelectorsFromTelemetry() {
    const sensorsDropdown = document.getElementById("history-sensor-dropdown");
    const fansDropdown = document.getElementById("history-fan-dropdown");
    if (sensorsDropdown && !sensorsDropdown.classList.contains("hidden")) {
        renderHistorySensorToggles();
    } else {
        updateHistorySensorsButtonLabel();
    }
    if (fansDropdown && !fansDropdown.classList.contains("hidden")) {
        renderHistoryFanToggles();
    } else {
        updateHistoryFansButtonLabel();
    }
}

export function renderHistorySensorToggles() {
    const root = document.getElementById("history-sensor-toggles");
    if (!root) return;
    const hidden = new Set(store.getConfig().global.sensor_hidden ?? []);
    const sensors = (store.getTelemetry()?.sensors ?? []).filter(s => !hidden.has(s.id));
    if (sensors.length === 0) {
        root.innerHTML = `<span class="text-xs text-slate-500">暂无可用传感器</span>`;
        updateHistorySensorsButtonLabel();
        renderHistoryLegend();
        return;
    }
    root.innerHTML = sensors.map(s => {
        const color = sensorHistoryColor(s.id);
        const name = getSensorDisplayName(s.id);
        const on = historySensorSelected.has(s.id);
        return `<button type="button" data-history-sensor="${esc(s.id)}"
            class="w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left border transition-colors ${
            on
                ? "border-slate-500 bg-slate-700/80 text-slate-100"
                : "border-transparent bg-slate-800/40 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        }">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(color)}"></span>
            <span class="truncate flex-1" title="${esc(name)}">${esc(name)}</span>
        </button>`;
    }).join("");
    updateHistorySensorsButtonLabel();
    renderHistoryLegend();
}

export function renderHistoryFanToggles() {
    const root = document.getElementById("history-fan-toggles");
    if (!root) return;
    const fans = store.getConfig().fans ?? [];
    if (fans.length === 0) {
        root.innerHTML = `<span class="text-xs text-slate-500">暂无风扇</span>`;
        updateHistoryFansButtonLabel();
        renderHistoryLegend();
        return;
    }
    root.innerHTML = fans.map(f => {
        const color = fanHistoryColor(f.id);
        const name = f.name || f.id;
        const on = historyFanSelected.has(f.id);
        return `<button type="button" data-history-fan="${esc(f.id)}"
            class="w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left border transition-colors ${
            on
                ? "border-slate-500 bg-slate-700/80 text-slate-100"
                : "border-transparent bg-slate-800/40 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        }">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(color)}"></span>
            <span class="truncate flex-1" title="${esc(name)}">${esc(name)}</span>
        </button>`;
    }).join("");
    updateHistoryFansButtonLabel();
    renderHistoryLegend();
}

export function setupHistoryRefreshTimer() {
    if (historyRefreshTimer != null) {
        window.clearInterval(historyRefreshTimer);
        historyRefreshTimer = null;
    }
    if (historyRange !== "custom") {
        historyRefreshTimer = window.setInterval(() => loadHistoryChart(), 60_000);
    }
}

export function setupHistoryRangeControls() {
    const rangeEl = document.getElementById("history-range") as HTMLSelectElement | null;
    const panel = document.getElementById("history-custom-panel");
    const applyBtn = document.getElementById("history-apply");
    const toEl = document.getElementById("history-to") as HTMLInputElement | null;
    const fromEl = document.getElementById("history-from") as HTMLInputElement | null;

    document.getElementById("history-view-tabs")?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-history-view]");
        if (!btn) return;
        const view = btn.dataset.historyView as HistoryView | undefined;
        if (view === "temp" || view === "fan") setHistoryView(view);
    });

    const now = new Date();
    const fmt = (d: Date) => {
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    if (toEl) toEl.value = fmt(now);
    if (fromEl) fromEl.value = fmt(new Date(now.getTime() - 14 * 86400000));

    rangeEl?.addEventListener("change", () => {
        historyRange = (rangeEl.value as HistoryRange) || "1h";
        const isCustom = historyRange === "custom";
        panel?.classList.toggle("hidden", !isCustom);
        setupHistoryRefreshTimer();
        void persistHistoryPrefs();
        if (!isCustom) loadHistoryChart().catch(console.error);
    });

    applyBtn?.addEventListener("click", () => {
        void persistHistoryPrefs().then(() => loadHistoryChart().catch(console.error));
    });

    const sensorsWrap = document.getElementById("history-sensors-wrap");
    const sensorsToggle = document.getElementById("history-sensors-toggle");
    const sensorsDropdown = document.getElementById("history-sensor-dropdown");
    const sensorsPanel = document.getElementById("history-sensor-toggles");
    const sensorsChevron = document.getElementById("history-sensors-chevron");

    sensorsToggle?.addEventListener("click", e => {
        e.stopPropagation();
        document.getElementById("history-fan-dropdown")?.classList.add("hidden");
        const fansChevron = document.getElementById("history-fans-chevron");
        if (fansChevron) fansChevron.setAttribute("icon", "mdi:chevron-down");
        const hidden = sensorsDropdown?.classList.toggle("hidden") ?? true;
        if (sensorsChevron) {
            sensorsChevron.setAttribute("icon", hidden ? "mdi:chevron-down" : "mdi:chevron-up");
        }
        if (!hidden) renderHistorySensorToggles();
    });

    const fansWrap = document.getElementById("history-fans-wrap");
    const fansToggle = document.getElementById("history-fans-toggle");
    const fansDropdown = document.getElementById("history-fan-dropdown");
    const fansPanel = document.getElementById("history-fan-toggles");
    const fansChevron = document.getElementById("history-fans-chevron");

    fansToggle?.addEventListener("click", e => {
        e.stopPropagation();
        sensorsDropdown?.classList.add("hidden");
        if (sensorsChevron) sensorsChevron.setAttribute("icon", "mdi:chevron-down");
        const hidden = fansDropdown?.classList.toggle("hidden") ?? true;
        if (fansChevron) {
            fansChevron.setAttribute("icon", hidden ? "mdi:chevron-down" : "mdi:chevron-up");
        }
        if (!hidden) renderHistoryFanToggles();
    });

    document.addEventListener("click", e => {
        const target = e.target as Node;
        if (sensorsDropdown && !sensorsDropdown.classList.contains("hidden") && !sensorsWrap?.contains(target)) {
            sensorsDropdown.classList.add("hidden");
            if (sensorsChevron) sensorsChevron.setAttribute("icon", "mdi:chevron-down");
        }
        if (fansDropdown && !fansDropdown.classList.contains("hidden") && !fansWrap?.contains(target)) {
            fansDropdown.classList.add("hidden");
            if (fansChevron) fansChevron.setAttribute("icon", "mdi:chevron-down");
        }
    });

    sensorsPanel?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-history-sensor]");
        if (!btn) return;
        e.stopPropagation();
        const id = btn.dataset.historySensor!;
        if (historySensorSelected.has(id)) historySensorSelected.delete(id);
        else historySensorSelected.add(id);
        renderHistorySensorToggles();
        updateHistoryChart();
        void persistHistoryPrefs();
    });

    fansPanel?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-history-fan]");
        if (!btn) return;
        e.stopPropagation();
        const id = btn.dataset.historyFan!;
        if (historyFanSelected.has(id)) historyFanSelected.delete(id);
        else historyFanSelected.add(id);
        renderHistoryFanToggles();
        updateHistoryChart();
        void persistHistoryPrefs();
    });
}

export function initHistoryChart() {
    const el = $("history-chart");
    historyChart = echarts.init(el);
    historyChart.setOption({
        ...HISTORY_CHART_ANIM,
        backgroundColor: "transparent",
        textStyle: {color: getChartPalette().label},
        legend: {show: false},
        tooltip: historyChartTooltip(),
        grid: HISTORY_CHART_GRID,
        xAxis: {
            ...historyXAxisBase(),
            min: historyTimeMin || undefined,
            max: historyTimeMax || undefined,
            minInterval: historyXAxisMinInterval(),
            axisLabel: {
                ...historyXAxisBase().axisLabel,
                formatter: historyAxisLabelFormatter,
            },
        },
        yAxis: {
            ...historyYAxisBase(),
            axisLabel: {margin: 8, color: getChartPalette().label},
        },
        series: [],
    });
    bindHistoryChartResizeObserver(el);
    window.addEventListener("resize", () => scheduleHistoryChartResize());
    setupHistoryRangeControls();
    applyHistoryViewUI();
    renderHistoryLegend();
    onThemeChanged(() => {
        if (!historyChart) return;
        historyChart.setOption({xAxis: historyChartXAxisOption()}, {silent: true});
        updateHistoryChart();
        renderHistoryLegend();
    });
}
