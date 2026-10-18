/**
 * 设置面板模块（建议8/9 拆分产物）：全局设置表单、传感器管理、CPU/GPU 菜单、风扇编辑对话框。
 */
import {store} from "../store";
import {$, esc, toast} from "./core";
import {closeSourceMenu, closeFallbackSourceMenu, resolveSourceMode, setSourceValue, setFallbackSourceValue, getSensorDisplayName, applySourceModeUI, type SourceMode} from "./sources";
import {initFanCurveChartShell, loadCurveIntoEditor, updateFanCurveGraphic, fanCurveChart, setSelectedCurveFanId} from "./curve";
import {syncCurveToConfig} from "./curve";
import {syncFanCardsFromTelemetryOrRender} from "./fancards";
import {renderHistoryFanToggles, updateHistoryChart} from "./history";
import {saveConfig} from "../api";
import {FanConfig, GlobalConfig} from "../types";

let editFanIdx: number | null = null;
let originalSourceMode: SourceMode | null = null;
const fanEditDialog = $<HTMLDialogElement>("fan-edit-dialog");

export function updateGlobalTuningRowVisibility() {
    const fans = store.getConfig().fans;
    const n = fans.length;
    const allDz = n > 0 && fans.every(f => f.pwm_deadzone != null);
    const allH = n > 0 && fans.every(f => f.stop_hysteresis != null);
    const allE = n > 0 && fans.every(f => f.emergency_temp != null);
    document.getElementById("g-row-deadzone")?.classList.toggle("hidden", allDz);
    document.getElementById("g-row-hysteresis")?.classList.toggle("hidden", allH);
    document.getElementById("g-row-emergency")?.classList.toggle("hidden", allE);
}

export function fillGlobalForm() {
    const g = store.getConfig().global;
    const dz = document.getElementById("g-deadzone") as HTMLInputElement | null;
    if (dz) dz.value = String(g.pwm_deadzone);
    const hy = document.getElementById("g-hysteresis") as HTMLInputElement | null;
    if (hy) hy.value = String(g.stop_hysteresis);
    const em = document.getElementById("g-emergency") as HTMLInputElement | null;
    if (em) em.value = String(g.emergency_temp);
    ($("g-interval") as HTMLInputElement).value = String(Math.round(g.update_interval_ms / 1000));
    ($("g-stop-beh") as HTMLSelectElement).value = g.stop_behavior;
    ($("g-stop-pwm") as HTMLInputElement).value = String(g.stop_pwm);
    updateStopPWMRow();
    updateGlobalTuningRowVisibility();

    // 填充 CPU/GPU 传感器映射
    const cpuSensorValue = document.getElementById("cpu-sensor-value") as HTMLInputElement | null;
    if (cpuSensorValue) cpuSensorValue.value = g.cpu_sensor || "";
    const cpuSensorDisplay = document.getElementById("cpu-sensor-display");
    if (cpuSensorDisplay) {
        cpuSensorDisplay.textContent = g.cpu_sensor ? getSensorDisplayName(g.cpu_sensor) : "-- 使用默认检测 --";
    }

    const gpuSensorValue = document.getElementById("gpu-sensor-value") as HTMLInputElement | null;
    if (gpuSensorValue) gpuSensorValue.value = g.gpu_sensor || "";
    const gpuSensorDisplay = document.getElementById("gpu-sensor-display");
    if (gpuSensorDisplay) {
        gpuSensorDisplay.textContent = g.gpu_sensor ? getSensorDisplayName(g.gpu_sensor) : "-- 使用默认检测 --";
    }
}

export function renderSensorMgrTable() {
    const tbody = document.getElementById("sensor-mgr-tbody");
    if (!tbody) return;
    const sensors = store.getTelemetry()?.sensors ?? [];
    const aliases = store.getConfig().global.sensor_aliases ?? {};
    const hiddenSet = new Set(store.getConfig().global.sensor_hidden ?? []);
    if (sensors.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">暂无传感器数据（等待后端推送）</td></tr>`;
        return;
    }
    tbody.innerHTML = sensors.map(s => {
        const chipLabel = s.device ? `${s.chip} · ${s.device}` : s.chip;
        const label = s.label || s.key;
        const temp = s.temp != null ? `${s.temp.toFixed(1)}°C` : "—";
        const alias = aliases[s.id] ?? "";
        const hidden = hiddenSet.has(s.id);
        return `
<tr class="border-b border-slate-700/30 ${hidden ? "opacity-50" : ""}" data-sensor-id="${esc(s.id)}">
    <td class="p-2 text-sky-400 font-mono whitespace-nowrap">${esc(chipLabel)}</td>
    <td class="p-2 text-slate-300 whitespace-nowrap">${esc(label)}</td>
    <td class="p-2 font-mono tabular-nums text-slate-400">${esc(temp)}</td>
    <td class="p-2">
        <input type="text" data-sensor-alias
               class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500 placeholder-slate-600"
               value="${esc(alias)}" placeholder="${esc(label)}"/>
    </td>
    <td class="p-2 text-center">
        <input type="checkbox" data-sensor-hidden ${hidden ? "checked" : ""}
               class="accent-sky-500 w-4 h-4 cursor-pointer"/>
    </td>
</tr>`;
    }).join("");
}

export function readSensorMgrIntoConfig() {
    const tbody = document.getElementById("sensor-mgr-tbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll<HTMLTableRowElement>("tr[data-sensor-id]");
    // 面板未打开或尚无传感器行时不要整表覆盖，否则会清空已保存的别名/隐藏列表
    if (rows.length === 0) return;

    const aliases: Record<string, string> = {...(store.getConfig().global.sensor_aliases ?? {})};
    const hiddenSet = new Set(store.getConfig().global.sensor_hidden ?? []);
    rows.forEach(row => {
        const id = row.dataset.sensorId!;
        const aliasInput = row.querySelector<HTMLInputElement>("input[data-sensor-alias]");
        const hiddenCb = row.querySelector<HTMLInputElement>("input[data-sensor-hidden]");
        const alias = aliasInput?.value.trim() ?? "";
        if (alias) aliases[id] = alias;
        else delete aliases[id];

        if (hiddenCb?.checked) hiddenSet.add(id);
        else hiddenSet.delete(id);
    });
    store.getConfig().global.sensor_aliases = aliases;
    store.getConfig().global.sensor_hidden = [...hiddenSet];
}

export function updateSensorMgrTemps() {
    const panel = document.getElementById("sensor-mgr-panel");
    if (!panel || panel.classList.contains("hidden")) return;
    const sensors = store.getTelemetry()?.sensors ?? [];
    const sensorMap = new Map(sensors.map(s => [s.id, s]));
    const rows = panel.querySelectorAll<HTMLTableRowElement>("tr[data-sensor-id]");
    rows.forEach(row => {
        const id = row.dataset.sensorId!;
        const s = sensorMap.get(id);
        const td = row.children[2] as HTMLElement | undefined;
        if (td) td.textContent = s?.temp != null ? `${s.temp.toFixed(1)}°C` : "—";
    });
}

export function renderCPUGPUSensorMenu(type: "cpu" | "gpu"): string {
    const sensors = store.getTelemetry()?.sensors ?? [];
    const current = type === "cpu" ? (store.getConfig().global.cpu_sensor || "") : (store.getConfig().global.gpu_sensor || "");
    const items = sensors.filter(s => !store.getConfig().global.sensor_hidden?.includes(s.id));

    let html = `
<div class="px-3 py-2 text-xs text-slate-400 border-b border-slate-700/50">
    选择一个 hwmon 传感器作为${type === "cpu" ? "CPU" : "GPU"}温度源
</div>
<button type="button" data-sensor-value=""
        class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-700/70 ${!current ? "bg-slate-700/40" : ""}">
    <span class="${!current ? "text-sky-300 font-medium" : "text-slate-200"} truncate">使用默认检测</span>
    ${!current ? '<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>' : ""}
</button>`;

    for (const s of items) {
        const isSelected = s.id === current;
        const name = store.getConfig().global.sensor_aliases?.[s.id] || s.label || s.key;
        const chipLabel = s.device ? `${s.chip}·${s.device}` : s.chip;
        const displayName = `${chipLabel}·${name}`;
        const tempText = s.temp != null ? `${s.temp.toFixed(1)}°C` : "—";

        html += `
<button type="button" data-sensor-value="${esc(s.id)}"
        class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-700/70 ${isSelected ? "bg-slate-700/40" : ""}">
    <span class="${isSelected ? "text-sky-300 font-medium" : "text-slate-200"} truncate">${esc(displayName)}</span>
    <span class="flex items-center gap-1 flex-shrink-0">
        <span class="${isSelected ? "text-sky-400" : "text-slate-400"} font-mono tabular-nums text-xs">${esc(tempText)}</span>
        ${isSelected ? '<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>' : ""}
    </span>
</button>`;
    }

    return html;
}

export function openCPUSensorMenu() {
    const menu = document.getElementById("cpu-sensor-menu");
    const chevron = document.getElementById("cpu-sensor-chevron");
    if (!menu) return;
    menu.innerHTML = renderCPUGPUSensorMenu("cpu");
    menu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

export function closeCPUSensorMenu() {
    const menu = document.getElementById("cpu-sensor-menu");
    const chevron = document.getElementById("cpu-sensor-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

export function openGPUSensorMenu() {
    const menu = document.getElementById("gpu-sensor-menu");
    const chevron = document.getElementById("gpu-sensor-chevron");
    if (!menu) return;
    menu.innerHTML = renderCPUGPUSensorMenu("gpu");
    menu.classList.remove("hidden");
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

export function closeGPUSensorMenu() {
    const menu = document.getElementById("gpu-sensor-menu");
    const chevron = document.getElementById("gpu-sensor-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

export function setCPUSensor(value: string) {
    const input = document.getElementById("cpu-sensor-value") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("cpu-sensor-display");
    if (display) {
        display.textContent = value ? getSensorDisplayName(value) : "-- 使用默认检测 --";
    }
}

export function setGPUSensor(value: string) {
    const input = document.getElementById("gpu-sensor-value") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("gpu-sensor-display");
    if (display) {
        display.textContent = value ? getSensorDisplayName(value) : "-- 使用默认检测 --";
    }
}

export function bindCollapsible(toggleId: string, panelId: string, chevronId: string, onOpen?: () => void) {
    const toggle = document.getElementById(toggleId);
    const panel = document.getElementById(panelId);
    const chevron = document.getElementById(chevronId);
    if (!toggle || !panel || !chevron) return;
    toggle.addEventListener("click", () => {
        const wasHidden = panel.classList.contains("hidden");
        panel.classList.toggle("hidden");
        chevron.style.transform = wasHidden ? "rotate(90deg)" : "";
        if (wasHidden && onOpen) onOpen();
    });
}

export function bindCPUGPUSensorMenus() {
    // CPU 传感器按钮
    const cpuBtn = document.getElementById("cpu-sensor-btn");
    if (cpuBtn) {
        cpuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeGPUSensorMenu();
            openCPUSensorMenu();
        });
    }

    // GPU 传感器按钮
    const gpuBtn = document.getElementById("gpu-sensor-btn");
    if (gpuBtn) {
        gpuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeCPUSensorMenu();
            openGPUSensorMenu();
        });
    }

    // 点击外部关闭菜单
    document.addEventListener("click", () => {
        closeCPUSensorMenu();
        closeGPUSensorMenu();
    });

    // CPU 菜单项点击委托
    const cpuMenu = document.getElementById("cpu-sensor-menu");
    if (cpuMenu) {
        cpuMenu.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("button[data-sensor-value]");
            if (btn) {
                const value = btn.getAttribute("data-sensor-value") || "";
                setCPUSensor(value);
                closeCPUSensorMenu();
            }
        });
    }

    // GPU 菜单项点击委托
    const gpuMenu = document.getElementById("gpu-sensor-menu");
    if (gpuMenu) {
        gpuMenu.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest("button[data-sensor-value]");
            if (btn) {
                const value = btn.getAttribute("data-sensor-value") || "";
                setGPUSensor(value);
                closeGPUSensorMenu();
            }
        });
    }
}

export function updateStopPWMRow() {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    const row = $("g-stop-pwm-row");
    if (row) row.classList.toggle("hidden", stopBeh !== "set");
}

export function clampPWM(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

export function readGlobalForm(): GlobalConfig {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    const out: GlobalConfig = {
        ...store.getConfig().global,
        update_interval_ms: Math.max(1000, Number(($("g-interval") as HTMLInputElement).value) * 1000) || 2000,
        stop_behavior: stopBeh === "set" ? "set" : "keep",
        stop_pwm: clampPWM(Number(($("g-stop-pwm") as HTMLInputElement).value) || 200),
    };
    const dzEl = document.getElementById("g-deadzone") as HTMLInputElement | null;
    const dzRow = document.getElementById("g-row-deadzone");
    if (dzEl && dzRow && !dzRow.classList.contains("hidden")) out.pwm_deadzone = clampPWM(Number(dzEl.value) || 0);
    const hyEl = document.getElementById("g-hysteresis") as HTMLInputElement | null;
    const hyRow = document.getElementById("g-row-hysteresis");
    if (hyEl && hyRow && !hyRow.classList.contains("hidden")) out.stop_hysteresis = Math.max(0, Number(hyEl.value) || 2);
    const emEl = document.getElementById("g-emergency") as HTMLInputElement | null;
    const emRow = document.getElementById("g-row-emergency");
    if (emEl && emRow && !emRow.classList.contains("hidden")) out.emergency_temp = Math.max(0, Number(emEl.value) || 80);

    // 读取 CPU/GPU 传感器映射
    const cpuSensorEl = document.getElementById("cpu-sensor-value") as HTMLInputElement | null;
    if (cpuSensorEl) out.cpu_sensor = cpuSensorEl.value.trim() || undefined;
    const gpuSensorEl = document.getElementById("gpu-sensor-value") as HTMLInputElement | null;
    if (gpuSensorEl) out.gpu_sensor = gpuSensorEl.value.trim() || undefined;

    return out;
}

export function updateFallbackPolicyVisibility() {
    const pol = ($("fe-fallback-policy") as HTMLSelectElement).value;
    ($("fe-fallback-min-row") as HTMLElement).classList.toggle("hidden", pol !== "min_pwm");
    ($("fe-fallback-follow-row") as HTMLElement).classList.toggle("hidden", pol !== "follow_other");
}

export function safeCloseFanEditDialog() {
    fanEditDialog.close();
    closeFallbackSourceMenu();
    closeSourceMenu();
    editFanIdx = null;
    if (originalSourceMode !== null) {
        store.getConfig().global.source_mode = originalSourceMode;
        originalSourceMode = null;
    }
}

export function openFanEditDialogWithLock() {
    if (fanEditDialog.open) fanEditDialog.close();
    fanEditDialog.showModal();
    requestAnimationFrame(() => {
        const scrollArea = fanEditDialog.querySelector('.flex-1.min-h-0.overflow-y-auto');
        if (scrollArea) scrollArea.scrollTop = 0;
    });
}

export function openFanSettingsDialog(idx: number) {
    editFanIdx = idx;
    const fan = store.getConfig().fans[idx];
    if (!fan) return;
    setSelectedCurveFanId(fan.id);
    ($("fan-edit-title") as HTMLElement).textContent = `风扇设置 · ${fan.name}`;
    ($("fe-name") as HTMLInputElement).value = fan.name;
    ($("fe-pwm") as HTMLInputElement).value = fan.pwm_path;
    ($("fe-rpm") as HTMLInputElement).value = fan.rpm_path;
    ($("fe-en") as HTMLInputElement).value = fan.enable_path;
    setSourceValue(fan.source);
    closeSourceMenu();
    originalSourceMode = resolveSourceMode();
    const isCombo = fan.source.startsWith("combo_avg:") || fan.source.startsWith("combo_max:");
    const displayMode: SourceMode = isCombo ? "advanced" : originalSourceMode;
    applySourceModeUI(displayMode);
    initFanCurveChartShell();
    loadCurveIntoEditor();
    const dzEl = $("fe-deadzone") as HTMLInputElement;
    dzEl.value = fan.pwm_deadzone != null ? String(fan.pwm_deadzone) : "";
    dzEl.placeholder = `留空=默认${store.getConfig().global.pwm_deadzone}`;
    const hysEl = $("fe-hysteresis") as HTMLInputElement;
    hysEl.value = fan.stop_hysteresis != null ? String(fan.stop_hysteresis) : "";
    hysEl.placeholder = `留空=默认${store.getConfig().global.stop_hysteresis}`;
    const emEl = $("fe-emergency") as HTMLInputElement;
    emEl.value = fan.emergency_temp != null ? String(fan.emergency_temp) : "";
    emEl.placeholder = `留空=默认${store.getConfig().global.emergency_temp}`;
    const polRaw = fan.fallback_policy;
    const pol = (polRaw === "stop" || polRaw === "min_pwm" || polRaw === "full_speed" || polRaw === "follow_other") ? polRaw : "keep_last";
    ($("fe-fallback-policy") as HTMLSelectElement).value = pol;
    ($("fe-fallback-min-pwm") as HTMLInputElement).value = (fan.fallback_min_pwm != null && fan.fallback_min_pwm > 0) ? String(fan.fallback_min_pwm) : "80";
    setFallbackSourceValue((fan.fallback_follow_source ?? "").trim() || "cpu");
    closeFallbackSourceMenu();
    updateFallbackPolicyVisibility();
    openFanEditDialogWithLock();
    requestAnimationFrame(() => {
        fanCurveChart?.resize();
        updateFanCurveGraphic();
    });
}

export function readFanFormIntoConfig(): FanConfig | null {
    if (editFanIdx === null) return null;
    const fan = store.getConfig().fans[editFanIdx];
    if (!fan) return null;
    fan.name = ($("fe-name") as HTMLInputElement).value;
    fan.pwm_path = ($("fe-pwm") as HTMLInputElement).value.trim();
    fan.rpm_path = ($("fe-rpm") as HTMLInputElement).value.trim();
    fan.enable_path = ($("fe-en") as HTMLInputElement).value.trim();
    fan.source = ($("fe-source") as HTMLInputElement).value;
    const dz = ($("fe-deadzone") as HTMLInputElement).value.trim();
    if (dz === "") delete fan.pwm_deadzone;
    else {
        const n = Number(dz);
        if (Number.isFinite(n)) fan.pwm_deadzone = clampPWM(n); else delete fan.pwm_deadzone;
    }
    const hy = ($("fe-hysteresis") as HTMLInputElement).value.trim();
    if (hy === "") delete fan.stop_hysteresis;
    else {
        const n = Number(hy);
        if (Number.isFinite(n)) fan.stop_hysteresis = Math.max(0, Math.min(30, n)); else delete fan.stop_hysteresis;
    }
    const em = ($("fe-emergency") as HTMLInputElement).value.trim();
    if (em === "") delete fan.emergency_temp;
    else {
        const n = Number(em);
        if (Number.isFinite(n)) fan.emergency_temp = Math.max(1, Math.min(120, n)); else delete fan.emergency_temp;
    }
    const pol = ($("fe-fallback-policy") as HTMLSelectElement).value;
    if (pol === "keep_last") {
        delete fan.fallback_policy;
        delete fan.fallback_min_pwm;
        delete fan.fallback_follow_source;
    } else {
        fan.fallback_policy = pol;
        if (pol === "min_pwm") {
            const n = Number(($("fe-fallback-min-pwm") as HTMLInputElement).value);
            fan.fallback_min_pwm = Number.isFinite(n) ? clampPWM(n) : 80;
            if (fan.fallback_min_pwm <= 0) fan.fallback_min_pwm = 80;
        } else delete fan.fallback_min_pwm;
        if (pol === "follow_other") fan.fallback_follow_source = ($("fe-fb-source") as HTMLInputElement).value.trim() || "cpu";
        else delete fan.fallback_follow_source;
    }
    return fan;
}
export function bindFanEditDialogEvents() {
    const closeBtn = document.getElementById("fe-close");
    if (closeBtn) {
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode?.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            safeCloseFanEditDialog();
        });
    }
    const cancelBtn = document.getElementById("fe-cancel");
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode?.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            safeCloseFanEditDialog();
        });
    }
    fanEditDialog.addEventListener("cancel", (e: Event) => {
        e.preventDefault();
        safeCloseFanEditDialog();
    });
    fanEditDialog.addEventListener("close", () => {
        closeFallbackSourceMenu();
        closeSourceMenu();
        editFanIdx = null;
        if (originalSourceMode !== null) {
            store.getConfig().global.source_mode = originalSourceMode;
            store.commitConfig();
            originalSourceMode = null;
        }
    });
    $("fe-save").addEventListener("click", async () => {
        const originalConfig = JSON.parse(JSON.stringify(store.getConfig()));

        syncCurveToConfig();
        const fan = readFanFormIntoConfig();
        if (!fan) return;

        try {
            await saveConfig(store.getConfig());
            // 曲线已随 saveConfig 写入，无需再单独调曲线接口
            originalSourceMode = null;
            editFanIdx = null;
            syncFanCardsFromTelemetryOrRender();
            // 改名后同步历史曲线图例、下拉与系列名称
            renderHistoryFanToggles();
            updateHistoryChart();
            safeCloseFanEditDialog();
            toast("已保存", "success");
        } catch (e: any) {
            store.setConfig(originalConfig);
            const msg = e.response?.data?.error || e.message || "保存失败，请检查权限或网络";
            toast(msg, "error");
            safeCloseFanEditDialog();
        }
    });
    ($("fe-fallback-policy") as HTMLSelectElement).addEventListener("change", updateFallbackPolicyVisibility);
}

