/**
 * 风扇曲线编辑器模块（建议8/9 拆分产物）。
 */
import {store, DEFAULT_CURVE} from "../store";
import {echarts} from "../echarts-setup";
import type {EChartsOption} from "../echarts-setup";
import {$, toast} from "./core";
import {CurvePoint} from "../types";
import {getChartPalette, onThemeChanged} from "../theme";

export const CURVE_POINT_HIT_PX = 28;

export const symbolSize = 14;

export let fanCurveChart: echarts.ECharts | null = null;
let fanCurveChartBound = false;
let curveData: number[][] = [];
let selectedCurveFanId = "";

export function setSelectedCurveFanId(id: string) {
    selectedCurveFanId = id;
}
let editingCurvePointIndex = -1;
let curvePointDragMoved = false;
let curvePointsDraft: number[][] = [];

export function curveToPairs(curve: CurvePoint[]): number[][] {
    return curve.map(p => [p.temp, p.pwm]);
}

export function pairsToCurve(pairs: number[][]): CurvePoint[] {
    return pairs
        .map(([temp, pwm]) => ({
            temp: Math.round(Math.max(0, Math.min(100, temp)) * 10) / 10,
            pwm: Math.max(0, Math.min(255, Math.round(pwm)))
        }))
        .sort((a, b) => a.temp - b.temp);
}

export function findCurvePointIndexByPixel(offsetX: number, offsetY: number, threshold = CURVE_POINT_HIT_PX): number {
    if (!fanCurveChart) return -1;
    let best = -1;
    let bestDist = threshold;
    for (let i = 0; i < curveData.length; i++) {
        const px = fanCurveChart.convertToPixel("grid", curveData[i]) as number[];
        if (!px || px.length < 2) continue;
        const dist = Math.hypot(px[0] - offsetX, px[1] - offsetY);
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}

export function suggestCurvePointForDraft(draft: number[][]): [number, number] {
    if (draft.length === 0) return [50, 128];
    const sorted = [...draft].sort((a, b) => a[0] - b[0]);
    if (sorted.length === 1) {
        const [t, p] = sorted[0];
        return [Math.min(100, t + 10), p];
    }
    let bestI = 0;
    let bestGap = -1;
    for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1][0] - sorted[i][0];
        if (gap > bestGap) {
            bestGap = gap;
            bestI = i;
        }
    }
    const [t0, p0] = sorted[bestI];
    const [t1, p1] = sorted[bestI + 1];
    const temp = Math.round((t0 + t1) / 2);
    const pwm = t1 === t0 ? p0 : Math.round(p0 + (p1 - p0) * ((temp - t0) / (t1 - t0)));
    return [
        Math.max(0, Math.min(100, temp)),
        Math.max(0, Math.min(255, pwm)),
    ];
}

export function syncCurvePointsDraftFromInputs() {
    const list = document.getElementById("curve-points-list");
    if (!list) return;
    const rows = list.querySelectorAll<HTMLElement>("[data-curve-point-row]");
    const next: number[][] = [];
    rows.forEach(row => {
        const tempEl = row.querySelector<HTMLInputElement>("input[data-curve-temp]");
        const pwmEl = row.querySelector<HTMLInputElement>("input[data-curve-pwm]");
        const temp = Math.round(Number(tempEl?.value));
        const pwm = Math.round(Number(pwmEl?.value));
        next.push([
            Number.isFinite(temp) ? Math.max(0, Math.min(100, temp)) : 0,
            Number.isFinite(pwm) ? Math.max(0, Math.min(255, pwm)) : 0,
        ]);
    });
    curvePointsDraft = next;
}

export function renderCurvePointsList() {
    const list = document.getElementById("curve-points-list");
    if (!list) return;
    if (curvePointsDraft.length === 0) {
        list.innerHTML = `<p class="text-sm text-slate-500 text-center py-4">暂无点位，请点击下方添加</p>`;
        return;
    }
    list.innerHTML = curvePointsDraft.map((pt, i) => {
        const canRemove = curvePointsDraft.length > 2;
        return `
<div class="flex items-center gap-2" data-curve-point-row="${i}">
    <span class="w-8 text-xs text-slate-500 tabular-nums shrink-0">${i + 1}</span>
    <input type="number" data-curve-temp min="0" max="100" step="1" value="${Math.round(pt[0])}"
           class="flex-1 min-w-0 rounded-lg bg-slate-800 border border-slate-600 px-2.5 py-2 text-sm text-white focus:border-sky-400 outline-none"/>
    <input type="number" data-curve-pwm min="0" max="255" step="1" value="${Math.round(pt[1])}"
           class="flex-1 min-w-0 rounded-lg bg-slate-800 border border-slate-600 px-2.5 py-2 text-sm text-white focus:border-sky-400 outline-none"/>
    <button type="button" data-curve-remove="${i}" ${canRemove ? "" : "disabled"}
            class="w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-lg text-red-300 ${
            canRemove ? "bg-red-900/40 hover:bg-red-900/60" : "bg-slate-800 text-slate-600 cursor-not-allowed"
        }" title="移除">
        <iconify-icon icon="mdi:trash-can-outline" class="text-lg"></iconify-icon>
    </button>
</div>`;
    }).join("");
}

export function openCurvePointsDialog() {
    curvePointsDraft = curveData.map(p => [p[0], p[1]]);
    renderCurvePointsList();
    const dialog = document.getElementById("curve-points-dialog") as HTMLDialogElement | null;
    dialog?.showModal();
}

export function applyCurvePointsDialog() {
    syncCurvePointsDraftFromInputs();
    if (curvePointsDraft.length < 2) {
        toast("至少需要 2 个曲线点", "error");
        return false;
    }
    for (const [temp, pwm] of curvePointsDraft) {
        if (!Number.isFinite(temp) || !Number.isFinite(pwm)) {
            toast("请输入有效的温度与 PWM", "error");
            return false;
        }
    }
    curveData = curvePointsDraft
        .map(([t, p]) => [Math.round(Math.max(0, Math.min(100, t))), Math.round(Math.max(0, Math.min(255, p)))])
        .sort((a, b) => a[0] - b[0]);
    syncCurveToConfig();
    updateFanCurveDataAndGraphic();
    return true;
}

export function openCurvePointEditDialog(dataIndex: number) {
    if (dataIndex < 0 || dataIndex >= curveData.length) return;
    editingCurvePointIndex = dataIndex;
    const [temp, pwm] = curveData[dataIndex];
    const dialog = document.getElementById("curve-point-edit-dialog") as HTMLDialogElement | null;
    const tempInput = document.getElementById("curve-point-temp") as HTMLInputElement | null;
    const pwmInput = document.getElementById("curve-point-pwm") as HTMLInputElement | null;
    if (!dialog || !tempInput || !pwmInput) return;
    tempInput.value = String(Math.round(temp));
    pwmInput.value = String(Math.round(pwm));
    dialog.showModal();
    window.setTimeout(() => tempInput.focus(), 0);
}

export function applyCurvePointEditFromDialog() {
    if (editingCurvePointIndex < 0 || editingCurvePointIndex >= curveData.length) return;
    const tempInput = document.getElementById("curve-point-temp") as HTMLInputElement | null;
    const pwmInput = document.getElementById("curve-point-pwm") as HTMLInputElement | null;
    if (!tempInput || !pwmInput) return;
    const newTemp = Math.round(Math.max(0, Math.min(100, Number(tempInput.value))));
    const newPwm = Math.round(Math.max(0, Math.min(255, Number(pwmInput.value))));
    if (!Number.isFinite(newTemp) || !Number.isFinite(newPwm)) {
        toast("请输入有效的温度与 PWM", "error");
        return;
    }
    curveData[editingCurvePointIndex] = [newTemp, newPwm];
    curveData.sort((a, b) => a[0] - b[0]);
    editingCurvePointIndex = -1;
    syncCurveToConfig();
    updateFanCurveDataAndGraphic();
}

export function initFanCurveChartShell() {
    if (fanCurveChart) return;
    const chartDom = $("fan-curve-editor");
    fanCurveChart = echarts.init(chartDom);
    const p = getChartPalette();
    const option: EChartsOption = {
        backgroundColor: "transparent",
        tooltip: {
            triggerOn: "none", formatter: (p: unknown) => {
                const item = p as { data: [number, number] };
                const d = item.data;
                return `温度: ${d[0].toFixed(1)}°C\nPWM: ${d[1].toFixed(0)}`;
            }
        },
        grid: {top: "10%", bottom: "15%", left: "10%", right: "10%"},
        xAxis: {
            min: 30,
            max: 80,
            type: "value",
            axisLine: {lineStyle: {color: p.axis}},
            splitLine: {lineStyle: {color: p.split, type: "dashed"}},
            name: "温度 (°C)",
            nameLocation: "middle",
            nameGap: 35,
            nameTextStyle: {color: p.name, fontSize: 12}
        },
        yAxis: {
            min: 0,
            max: 255,
            type: "value",
            axisLine: {lineStyle: {color: p.axis}},
            splitLine: {lineStyle: {color: p.split, type: "dashed"}},
            name: "PWM 值",
            nameLocation: "middle",
            nameGap: 45,
            nameTextStyle: {color: p.name, fontSize: 12}
        },
        series: [
            {
                id: "curve",
                type: "line",
                smooth: false,
                symbolSize,
                data: curveData,
                lineStyle: {color: "#0ea5e9", width: 4, shadowBlur: 15, shadowColor: "rgba(14, 165, 233, 0.4)"},
                itemStyle: {color: "#fff", borderColor: "#0ea5e9", borderWidth: 3},
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{
                        offset: 0,
                        color: "rgba(14, 165, 233, 0.3)"
                    }, {offset: 1, color: "rgba(14, 165, 233, 0)"}])
                }
            }
        ]
    };
    fanCurveChart.setOption(option);
    updateFanCurveGraphic();
    onThemeChanged(() => {
        if (!fanCurveChart) return;
        const cp = getChartPalette();
        fanCurveChart.setOption({
            xAxis: {
                axisLine: {lineStyle: {color: cp.axis}},
                splitLine: {lineStyle: {color: cp.split, type: "dashed"}},
                nameTextStyle: {color: cp.name, fontSize: 12}
            },
            yAxis: {
                axisLine: {lineStyle: {color: cp.axis}},
                splitLine: {lineStyle: {color: cp.split, type: "dashed"}},
                nameTextStyle: {color: cp.name, fontSize: 12}
            }
        }, {silent: true});
    });
    if (!fanCurveChartBound) {
        fanCurveChartBound = true;
        window.addEventListener("resize", () => {
            fanCurveChart?.resize();
            updateFanCurveGraphic();
        });
        fanCurveChart.getZr().on("dblclick", (params: { offsetX: number; offsetY: number }) => {
            if (!fanCurveChart) return;
            // 双击已有点位：只打开编辑，不新增
            const nearIdx = findCurvePointIndexByPixel(params.offsetX, params.offsetY);
            if (nearIdx !== -1) {
                openCurvePointEditDialog(nearIdx);
                return;
            }
            const pt = fanCurveChart.convertFromPixel("grid", [params.offsetX, params.offsetY]) as number[];
            if (pt[0] >= 0 && pt[0] <= 100 && pt[1] >= 0 && pt[1] <= 255) {
                curveData.push([
                    Math.round(Math.max(0, Math.min(100, pt[0]))),
                    Math.round(Math.max(0, Math.min(255, pt[1]))),
                ]);
                curveData.sort((a, b) => a[0] - b[0]);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });
        // 触屏长按也会触发 contextmenu；仅真正的鼠标右键才删点
        let curveLastTouchAt = 0;
        chartDom.addEventListener("touchstart", () => {
            curveLastTouchAt = Date.now();
        }, {passive: true});
        chartDom.addEventListener("contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            if (!fanCurveChart) return;
            if (Date.now() - curveLastTouchAt < 1000) return;
            if (window.matchMedia("(pointer: coarse)").matches) return;
            const idx = findCurvePointIndexByPixel(e.offsetX, e.offsetY);
            if (idx !== -1 && curveData.length > 2) {
                curveData.splice(idx, 1);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });
    }
}

export function updateFanCurveDataAndGraphic() {
    if (!fanCurveChart) return;
    fanCurveChart.setOption({series: [{id: "curve", data: curveData}]});
    updateFanCurveGraphic();
}

export function onFanPointDrag(dataIndex: number, pos: number[]) {
    if (!fanCurveChart) return;
    const pt = fanCurveChart.convertFromPixel("grid", pos) as number[];
    const newTemp = Math.round(Math.max(0, Math.min(100, pt[0])));
    const newPwm = Math.round(Math.max(0, Math.min(255, pt[1])));
    curveData[dataIndex] = [newTemp, newPwm];
    curveData.sort((a, b) => a[0] - b[0]);
    const newDataIndex = curveData.findIndex(p => p[0] === newTemp && p[1] === newPwm);
    syncCurveToConfig();
    updateFanCurveDataAndGraphic();
    if (newDataIndex !== -1) fanCurveChart.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex: newDataIndex});
}

export function updateFanCurveGraphic() {
    if (!fanCurveChart) return;
    const g: any[] = curveData.map((item, dataIndex) => ({
        type: "circle",
        position: fanCurveChart!.convertToPixel("grid", item) as number[],
        shape: {r: Math.max(symbolSize / 1.5, 18)},
        invisible: true,
        draggable: true,
        z: 100,
        cursor: "pointer",
        onmousedown() {
            curvePointDragMoved = false;
        },
        ondrag(this: any) {
            curvePointDragMoved = true;
            onFanPointDrag(dataIndex, [this.x, this.y]);
        },
        onclick() {
            if (curvePointDragMoved) {
                curvePointDragMoved = false;
                return;
            }
            openCurvePointEditDialog(dataIndex);
        },
        onmousemove() {
            fanCurveChart?.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex});
        },
        onmouseout() {
            fanCurveChart?.dispatchAction({type: "hideTip"});
        }
    }));
    fanCurveChart.setOption({graphic: g}, {replaceMerge: ["graphic"]});
}

export function syncCurveToConfig() {
    const fan = store.getConfig().fans.find(f => f.id === selectedCurveFanId);
    if (fan) fan.curve = pairsToCurve(curveData);
}

export function loadCurveIntoEditor() {
    const fan = store.getConfig().fans.find(f => f.id === selectedCurveFanId);
    curveData = fan ? curveToPairs(fan.curve?.length ? fan.curve : DEFAULT_CURVE) : [[35, 80], [75, 255]];
    updateFanCurveDataAndGraphic();
}
export function bindCurveDialogEvents() {
    document.getElementById("curve-point-edit-form")?.addEventListener("submit", ev => {
        const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === "ok") {
            applyCurvePointEditFromDialog();
        } else {
            editingCurvePointIndex = -1;
        }
    });
    document.getElementById("curve-point-edit-dialog")?.addEventListener("cancel", () => {
        editingCurvePointIndex = -1;
    });
    const curvePointsDialog = document.getElementById("curve-points-dialog") as HTMLDialogElement | null;
    document.getElementById("curve-points-edit-btn")?.addEventListener("click", () => openCurvePointsDialog());
    document.getElementById("curve-points-cancel")?.addEventListener("click", () => curvePointsDialog?.close());
    document.getElementById("curve-points-apply")?.addEventListener("click", () => {
        if (applyCurvePointsDialog()) curvePointsDialog?.close();
    });
    document.getElementById("curve-points-add")?.addEventListener("click", () => {
        syncCurvePointsDraftFromInputs();
        curvePointsDraft.push(suggestCurvePointForDraft(curvePointsDraft));
        renderCurvePointsList();
    });
    document.getElementById("curve-points-list")?.addEventListener("click", e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-curve-remove]");
        if (!btn || btn.disabled) return;
        const idx = Number(btn.dataset.curveRemove);
        if (!Number.isFinite(idx)) return;
        syncCurvePointsDraftFromInputs();
        if (curvePointsDraft.length <= 2) {
            toast("至少保留 2 个曲线点", "info");
            return;
        }
        curvePointsDraft.splice(idx, 1);
        renderCurvePointsList();
    });
    curvePointsDialog?.addEventListener("click", e => {
        if (e.target === curvePointsDialog) curvePointsDialog.close();
    });
}

