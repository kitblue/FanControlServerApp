/**
 * 应用入口（建议8/9 拆分产物）：
 * - 只保留生命周期编排、刷新、更新检查与 WebSocket 连接管理；
 * - 业务渲染已拆至 ui/（core、sources、fancards、curve、history、settings）；
 * - WebSocket 仅写 store，视图经 store.subscribe() 统一渲染。
 */
import "iconify-icon";
import "./style.css";
import {$, toast, formatTemp, updateRingProgress, onTelemetryReceived, updateSubtitleDate, renderStorageList, showDiskSerial, setDiskSerialVisible} from "./ui/core";
import {refreshOpenSourceDisplays, bindSourceModeSwitcher, bindSourceDropdown, bindFallbackSourceDropdown} from "./ui/sources";
import {syncFanCardsFromTelemetryOrRender, bindFanRoot, runHardwareScan, addScannedFansFromSelection} from "./ui/fancards";
import {bindCurveDialogEvents} from "./ui/curve";
import {
    initHistoryChart,
    renderHistorySensorToggles,
    renderHistoryFanToggles,
    loadHistoryChart,
    applyHistoryPrefsFromConfig,
    syncHistoryPrefsToConfig,
    refreshHistorySelectorsFromTelemetry,
    scheduleHistoryChartResize,
} from "./ui/history";
import {updateStopPWMRow, bindCollapsible, bindCPUGPUSensorMenus, bindFanEditDialogEvents, readSensorMgrIntoConfig, readGlobalForm, fillGlobalForm, updateGlobalTuningRowVisibility, renderSensorMgrTable, updateSensorMgrTemps} from "./ui/settings";
import {connectWs} from "./ws";
import {store} from "./store";
import {initAuthMode, fetchInfo, fetchConfig, setGlobalConfig, checkUpdate, fetchStorageStats} from "./api";
import type {Telemetry, UpdateCheckResult} from "./types";
import {initThemeSwitcher, applyThemeFromConfig, getThemeMode} from "./theme";

/** 底部状态栏刷新间隔：1 小时（不做高频轮询） */
const STORAGE_STATUS_INTERVAL_MS = 3_600_000;

/** 将字节数格式化为 MB（保留 1 位小数），无效值返回占位 */
function formatDBSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "-- MB";
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 刷新底部状态栏中的数据库文件大小；失败或不可用时显示占位，不抛错 */
async function refreshStorageStatus(): Promise<void> {
    const el = document.getElementById("storage-status-text");
    if (!el) return;
    try {
        const stats = await fetchStorageStats();
        el.textContent = stats && stats.available
            ? `数据库 ${formatDBSize(stats.size_bytes)}`
            : "数据库 -- MB";
        el.parentElement?.setAttribute("title", stats?.path ? `${stats.path}` : "温度历史数据库文件大小");
    } catch {
        el.textContent = "数据库 -- MB";
    }
}

/** 初始化底部状态栏：加载时取一次，之后每小时更新一次 */
function initStorageStatus(): void {
    void refreshStorageStatus();
    window.setInterval(() => {
        void refreshStorageStatus();
    }, STORAGE_STATUS_INTERVAL_MS);
}

function updateDiskSerialToggleIcon() {
    const btn = $("disk-serial-toggle");
    const icon = $("disk-serial-toggle-icon");
    icon.setAttribute("icon", showDiskSerial ? "mdi:eye" : "mdi:eye-off");
    const label = showDiskSerial ? "隐藏序列号" : "显示序列号";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("text-sky-400", showDiskSerial);
    btn.classList.toggle("text-slate-500", !showDiskSerial);
}


function applyTelemetry(t: Telemetry) {
    $("cpu-temp-text").textContent = formatTemp(t.cpu_temp);
    updateRingProgress("cpu-ring", t.cpu_usage);
    $("cpu-ring-text").textContent = `${t.cpu_usage.toFixed(0)}%`;
    $("gpu-temp-text").textContent = formatTemp(t.gpu_temp);
    const gpuUsage = t.gpu_usage != null ? t.gpu_usage : 0;
    updateRingProgress("gpu-ring", Math.max(0, Math.min(100, gpuUsage)));
    $("gpu-ring-text").textContent = t.gpu_usage != null ? `${t.gpu_usage.toFixed(0)}%` : "--%";
    updateRingProgress("mem-ring", t.mem_usage);
    $("mem-ring-text").textContent = `${t.mem_usage.toFixed(0)}%`;
    if (t.mem_total && t.mem_total > 0) {
        const available = (t.mem_total * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = available;
    } else {
        const estimated = (t.mem_usage * 0.01 * 16 * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = estimated;
    }
    $("disk-avg-text").textContent = formatTemp(t.disks.avg_temp);
    onTelemetryReceived(t);
    syncFanCardsFromTelemetryOrRender();
    renderStorageList();
    updateSensorMgrTemps();
    refreshHistorySelectorsFromTelemetry();
    scheduleHistoryChartResize();
}

async function refresh() {
    const [info, cfg] = await Promise.all([fetchInfo(), fetchConfig()]);
    store.setConfig(cfg);
    store.setTelemetry(info);
    applyThemeFromConfig(cfg.global.theme_mode);
    fillGlobalForm();
    applyHistoryPrefsFromConfig();
    renderHistorySensorToggles();
    renderHistoryFanToggles();
    loadHistoryChart().catch(console.error);
}

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_THROTTLE_MS = 2500;

let lastUpdateResult: UpdateCheckResult | null = null;
let lastUpdateCheckAt = 0;
let updateCheckInFlight = false;
let lastManualCheckAt = 0;

function applyUpdateCheckResult(res: UpdateCheckResult, opts?: { toastOnResult?: boolean }) {
    lastUpdateResult = res;
    lastUpdateCheckAt = Date.now();
    const btn = document.getElementById("btn-update-available") as HTMLButtonElement | null;
    if (btn) {
        btn.classList.toggle("hidden", !res.has_update);
    }
    if (opts?.toastOnResult) {
        if (!res.check_ok) {
            toast(res.error || "检查更新失败", "error");
        } else if (res.has_update) {
            toast(`发现新版本 v${res.latest || "?"}`, "success");
        } else {
            toast("当前已是最新版本", "info");
        }
    }
}

function openUpdateNotesDialog() {
    const res = lastUpdateResult;
    if (!res?.has_update) return;
    const dialog = document.getElementById("update-notes-dialog") as HTMLDialogElement | null;
    const title = document.getElementById("update-notes-title");
    const body = document.getElementById("update-notes-body");
    const link = document.getElementById("update-notes-link") as HTMLAnchorElement | null;
    if (!dialog || !title || !body || !link) return;
    title.textContent = `新版本 v${res.latest || "?"}`;
    body.textContent = (res.notes && res.notes.trim()) ? res.notes : "暂无更新说明";
    if (res.url) {
        link.href = res.url;
        link.classList.remove("hidden");
    } else {
        link.href = "#";
        link.classList.add("hidden");
    }
    dialog.showModal();
}

async function runUpdateCheck(force: boolean, toastOnResult: boolean) {
    if (updateCheckInFlight) return;
    updateCheckInFlight = true;
    const btn = document.getElementById("btn-check-update") as HTMLButtonElement | null;
    if (btn && force) btn.disabled = true;
    try {
        const res = await checkUpdate(force);
        applyUpdateCheckResult(res, {toastOnResult});
    } catch (e) {
        console.error("[更新检查]", e);
        if (toastOnResult) toast("检查更新失败", "error");
    } finally {
        updateCheckInFlight = false;
        if (btn && force) btn.disabled = false;
    }
}

function setupUpdateCheck() {
    const availableBtn = document.getElementById("btn-update-available");
    const checkBtn = document.getElementById("btn-check-update") as HTMLButtonElement | null;
    const dialog = document.getElementById("update-notes-dialog") as HTMLDialogElement | null;
    availableBtn?.addEventListener("click", () => openUpdateNotesDialog());
    checkBtn?.addEventListener("click", () => {
        const now = Date.now();
        if (now - lastManualCheckAt < UPDATE_CHECK_THROTTLE_MS) return;
        lastManualCheckAt = now;
        void runUpdateCheck(true, true);
    });
    document.getElementById("update-notes-close")?.addEventListener("click", () => dialog?.close());
    document.getElementById("update-notes-ok")?.addEventListener("click", () => dialog?.close());

    void runUpdateCheck(false, false);
    window.setInterval(() => {
        void runUpdateCheck(false, false);
    }, UPDATE_CHECK_INTERVAL_MS);

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
        void runUpdateCheck(false, false);
    });
}

async function main() {
    updateSubtitleDate();
    window.setInterval(updateSubtitleDate, 1000);

    await initAuthMode();
    initThemeSwitcher();
    setupUpdateCheck();

    const refreshBtn = $("btn-refresh") as HTMLButtonElement;
    const refreshIcon = $("btn-refresh-icon");
    refreshBtn.addEventListener("click", async () => {
        if (refreshBtn.disabled) return;
        refreshBtn.disabled = true;
        refreshIcon.classList.add("animate-spin");
        try {
            await refresh();
        } catch (e) {
            console.error(e);
            toast("刷新失败，请检查网络或权限", "error");
        } finally {
            refreshIcon.classList.remove("animate-spin");
            refreshBtn.disabled = false;
        }
    });

    bindCurveDialogEvents();

    $("btn-scan-fans").addEventListener("click", () => {
        ($("scan-fans-dialog") as HTMLDialogElement).showModal();
        runHardwareScan().catch(console.error);
    });
    $("scan-close").addEventListener("click", () => ($("scan-fans-dialog") as HTMLDialogElement).close());
    $("scan-refresh").addEventListener("click", () => runHardwareScan().catch(console.error));
    $("scan-add-selected").addEventListener("click", () => addScannedFansFromSelection().catch(console.error));

    $("btn-global-save").addEventListener("click", async () => {
        const originalGlobal = JSON.parse(JSON.stringify(store.getConfig().global));

        readSensorMgrIntoConfig();
        store.getConfig().global = readGlobalForm();
        store.getConfig().global.theme_mode = getThemeMode();
        store.commitConfig();
        syncHistoryPrefsToConfig();

        try {
            await setGlobalConfig(store.getConfig().global);
            toast("全局设置已保存", "success");
            await refresh();
        } catch (e: any) {
            store.getConfig().global = originalGlobal;
            store.commitConfig();
            const msg = e.response?.data?.error || e.message || "保存失败，请检查权限或网络";
            toast(msg, "error");
            await refresh();
            return;
        }
    });
    $("btn-global-discard").addEventListener("click", () => refresh().catch(console.error));
    $("g-stop-beh").addEventListener("change", updateStopPWMRow);

    bindFanEditDialogEvents();

    bindFanRoot();
    bindSourceModeSwitcher();
    bindSourceDropdown();
    bindFallbackSourceDropdown();
    bindCollapsible("fan-params-toggle", "fan-params-panel", "fan-params-chevron", updateGlobalTuningRowVisibility);
    bindCollapsible("sensor-mgr-toggle", "sensor-mgr-panel", "sensor-mgr-chevron", renderSensorMgrTable);
    bindCollapsible("cpu-gpu-sensor-toggle", "cpu-gpu-sensor-panel", "cpu-gpu-sensor-chevron");
    bindCPUGPUSensorMenus();
    initHistoryChart();
    initStorageStatus();
    updateDiskSerialToggleIcon();
    $("disk-serial-toggle").addEventListener("click", () => {
        setDiskSerialVisible(!showDiskSerial);
        updateDiskSerialToggleIcon();
        $("storage-list").innerHTML = "";
        renderStorageList();
        syncFanCardsFromTelemetryOrRender();
        refreshOpenSourceDisplays();
    });

    // WebSocket 只写 store：视图通过订阅驱动渲染，避免消息处理与 UI 直接耦合
    store.subscribe(() => {
        const t = store.getTelemetry();
        if (t) applyTelemetry(t);
    });

    await refresh();
    const legacy = store.getConfig().fans.filter(f => !f.chip);
    if (legacy.length > 0) {
        toast(`检测到 ${legacy.length} 个旧版本风扇配置缺少稳定标识，建议删除后重新扫描添加避免重启错乱`, "info");
    }

    connectWs({
        onStatus: s => {
            $("ws-text").textContent = s.connected ? "已连接" : "重连中…";
            ($("ws-text") as HTMLElement).className = s.connected ? "text-sky-400 text-sm font-mono" : "text-amber-400 text-sm font-mono";
        },
    });
}

main().catch(err => {
    console.error(err);
    toast(`启动失败: ${err}`, "error");
});
