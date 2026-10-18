/**
 * 温度源（source）解析/渲染/绑定模块（建议8/9 拆分产物）。
 * 纯渲染 + 菜单交互，数据从 store 读取。
 */
import {store} from "../store";
import {esc, formatDiskLabel, diskSourceValue, findDiskBySourceKey} from "./core";


export type SourceMode = "simple" | "advanced";

/** 两个温度源标识是否等价（combo 按元素集合比较，忽略顺序） */
export function sourcesMatch(a: string, b: string): boolean {
    const na = a.trim();
    const nb = b.trim();
    if (na === nb) return true;
    if (na.startsWith("combo_") && nb.startsWith("combo_")) {
        const ka = na.slice(na.indexOf(":") + 1).split(",").map(s => s.trim()).sort().join(",");
        const kb = nb.slice(nb.indexOf(":") + 1).split(",").map(s => s.trim()).sort().join(",");
        return ka === kb;
    }
    return false;
}

/** combo 选中态判断：key 是否在已选集合中（忽略首尾空白） */
export function isComboKeySelected(selected: Set<string>, key: string): boolean {
    const nk = key.trim();
    for (const s of selected) {
        if (s.trim() === nk) return true;
    }
    return false;
}

interface SourceItem {
    v: string;
    name: string;
    temp?: number;
    sleep?: boolean;
}

interface SourceGroup {
    label: string;
    items: SourceItem[];
}

export function refreshOpenSourceDisplays() {
    const feInput = document.getElementById("fe-source") as HTMLInputElement | null;
    if (feInput?.value) {
        setSourceValue(feInput.value);
    }
    const fbInput = document.getElementById("fe-fb-source") as HTMLInputElement | null;
    if (fbInput?.value) {
        setFallbackSourceValue(fbInput.value);
    }
    applySourceModeUI(resolveSourceMode());
}

export function resolveSourceTemp(source: string): number | undefined {
    const t = store.getTelemetry();
    if (!t) return undefined;
    if (source === "cpu") return t.cpu_temp;
    if (source === "gpu") return t.gpu_temp;
    if (source === "disk_avg") return t.disks?.avg_temp;
    if (source === "disk_max") {
        let best: number | undefined;
        for (const d of t.disks?.details ?? []) if (d.temp != null && (best === undefined || d.temp > best)) best = d.temp;
        return best;
    }
    if (source === "max") {
        const all: number[] = [];
        if (t.cpu_temp != null) all.push(t.cpu_temp);
        if (t.gpu_temp != null) all.push(t.gpu_temp);
        if (t.disks?.avg_temp != null) all.push(t.disks.avg_temp);
        for (const d of t.disks?.details ?? []) if (d.temp != null) all.push(d.temp);
        for (const s of t.sensors ?? []) if (s.temp != null) all.push(s.temp);
        return all.length ? Math.max(...all) : undefined;
    }
    if (source.startsWith("disk:")) {
        return findDiskBySourceKey(source.slice(5))?.temp;
    }
    if (source.startsWith("sensor:")) {
        const id = source.slice(7);
        return (t.sensors ?? []).find(s => s.id === id)?.temp;
    }
    if (source.startsWith("combo_avg:")) {
        const vals = source.slice("combo_avg:".length).split(",").map(k => resolveSourceTemp(k.trim())).filter((v): v is number => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
    }
    if (source.startsWith("combo_max:")) {
        const vals = source.slice("combo_max:".length).split(",").map(k => resolveSourceTemp(k.trim())).filter((v): v is number => v != null);
        return vals.length ? Math.max(...vals) : undefined;
    }
    return undefined;
}

export function fmtTemp(t: number | undefined, sleep?: boolean): string {
    if (sleep) return "休眠";
    return t != null ? `${t.toFixed(1)}°C` : "—";
}

export function collectSourceGroups(mode: "simple" | "advanced"): SourceGroup[] {
    const disks = store.getTelemetry()?.disks.details ?? [];
    const allSensors = store.getTelemetry()?.sensors ?? [];
    const hidden = new Set(store.getConfig().global.sensor_hidden ?? []);
    const aliases = store.getConfig().global.sensor_aliases ?? {};
    const sensors = allSensors.filter(s => !hidden.has(s.id));
    if (mode === "simple") {
        const cpuSensor = store.getConfig().global.cpu_sensor;
        const gpuSensor = store.getConfig().global.gpu_sensor;
        const cpuLabel = cpuSensor ? `CPU · ${getSensorDisplayName(cpuSensor)}` : "CPU";
        const gpuLabel = gpuSensor ? `GPU · ${getSensorDisplayName(gpuSensor)}` : "GPU";
        const items: SourceItem[] = [
            {v: cpuSensor ? `sensor:${cpuSensor}` : "cpu", name: cpuLabel},
            {v: gpuSensor ? `sensor:${gpuSensor}` : "gpu", name: gpuLabel},
        ];
        disks.forEach(d => items.push({v: diskSourceValue(d), name: `硬盘 ${formatDiskLabel(d)}`, sleep: d.status === "sleep"}));
        items.push({v: "disk_avg", name: "硬盘平均"});
        items.push({v: "disk_max", name: "硬盘最大"});
        items.forEach(it => {
            if (!it.sleep) it.temp = resolveSourceTemp(it.v);
        });
        return [{label: "常用温度源", items}];
    }
    const groups = new Map<string, SourceItem[]>();
    for (const s of sensors) {
        const key = s.device ? `${s.chip} · ${s.device}` : s.chip;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({
            v: `sensor:${s.id}`,
            name: aliases[s.id] || s.label || s.key,
            temp: s.temp,
        });
    }
    return [...groups.entries()].map(([label, items]) => ({label, items}));
}

export function renderSourceOptions(current: string, mode: "simple" | "advanced", comboStrategyRadioName = "combo-strategy"): string {
    const groups = collectSourceGroups(mode);
    let html = "";
    let currentInList = false;
    for (const g of groups) {
        html += `<div class="px-3 py-1 text-[10px] uppercase tracking-wider text-sky-400 bg-slate-900 sticky top-0 z-10 border-b border-slate-700/50">${esc(g.label)}</div>`;
        for (const it of g.items) {
            if (sourcesMatch(it.v, current)) currentInList = true;
            const active = sourcesMatch(it.v, current);
            const nameCls = active ? "text-sky-300 font-medium" : "text-slate-200";
            const sleepCls = it.sleep ? "text-slate-500 italic" : (active ? "text-sky-400" : "text-slate-400");
            const checkIcon = active ? `<iconify-icon class="text-sky-400 ml-2 flex-shrink-0" icon="mdi:check"></iconify-icon>` : "";
            const tempText = fmtTemp(it.temp, it.sleep);
            html += `
<button type="button" data-source-value="${esc(it.v)}"
        class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-700/70 ${active ? "bg-slate-700/40" : ""}">
    <span class="${nameCls} truncate">${esc(it.name)}</span>
    <span class="flex items-center gap-1 flex-shrink-0">
        <span class="${sleepCls} font-mono tabular-nums text-xs">${esc(tempText)}</span>
        ${checkIcon}
    </span>
</button>`;
        }
    }
    const isCombo = current.startsWith("combo_avg:") || current.startsWith("combo_max:");
    if (isCombo) currentInList = true;
    if (current && !currentInList) {
        const tip = `（当前选中：${esc(getSourceLabel(current))}）`;
        html = `<div class="px-3 py-2 text-xs text-amber-400 italic bg-amber-500/5 border-b border-amber-500/30">${tip}</div>` + html;
    }
    if (mode === "advanced") {
        html += renderComboSection(current, comboStrategyRadioName);
    }
    return html;
}

export function renderComboSection(currentSource: string, comboStrategyRadioName: string): string {
    const items = collectAllSourceItems();
    const combo = parseComboSource(currentSource);
    const selected = new Set<string>(combo?.keys ?? []);
    const strategy = combo?.strategy ?? "avg";
    const isComboActive = combo !== null;
    const computedTemp = isComboActive ? resolveSourceTemp(currentSource) : undefined;
    const countSelected = selected.size;
    let html = `
<div class="border-t-2 border-sky-500/30 mt-1" data-combo-radio-name="${esc(comboStrategyRadioName)}">
    <div class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-sky-400 bg-slate-900 sticky top-0 z-10 border-b border-slate-700/50 flex items-center justify-between">
        <span>组合温度源</span>
        <div class="flex items-center gap-3 normal-case tracking-normal">
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="${esc(comboStrategyRadioName)}" value="avg" ${strategy === "avg" ? "checked" : ""}
                       class="accent-sky-500 w-3 h-3"/>
                <span class="text-[11px] text-slate-300">平均</span>
            </label>
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="${esc(comboStrategyRadioName)}" value="max" ${strategy === "max" ? "checked" : ""}
                       class="accent-sky-500 w-3 h-3"/>
                <span class="text-[11px] text-slate-300">最大</span>
            </label>
        </div>
    </div>`;
    for (const it of items) {
        const checked = isComboKeySelected(selected, it.v);
        html += `
<label data-combo-key="${esc(it.v)}"
       class="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-sm hover:bg-slate-700/70 cursor-pointer ${checked ? "bg-slate-700/40" : ""}">
    <span class="flex items-center gap-2 truncate">
        <input type="checkbox" data-combo-cb value="${esc(it.v)}" ${checked ? "checked" : ""}
               class="accent-sky-500 flex-shrink-0 w-3.5 h-3.5"/>
        <span class="${checked ? "text-sky-300" : "text-slate-200"} truncate text-xs">${esc(it.name)}</span>
    </span>
    <span class="${it.sleep ? "text-slate-500 italic" : "text-slate-400"} font-mono tabular-nums text-xs flex-shrink-0">${esc(fmtTemp(it.temp, it.sleep))}</span>
</label>`;
    }
    html += `
<div class="sticky bottom-0 bg-slate-900 border-t border-slate-700/50 px-3 py-2 flex items-center justify-between gap-3">
    <div class="text-xs text-slate-400">
        已选 <span data-combo-count class="text-sky-400 font-bold">${countSelected}</span> 个
        <span class="mx-1">·</span>
        计算值: <span data-combo-preview class="text-sky-400 font-mono">${esc(fmtTemp(computedTemp))}</span>
    </div>
    <button type="button" data-combo-confirm
            class="px-4 py-1.5 rounded-lg text-xs font-medium ${countSelected >= 2 ? "bg-sky-600 text-white hover:bg-sky-500" : "bg-slate-700 text-slate-500 cursor-not-allowed"}"
            ${countSelected < 2 ? "disabled" : ""}>
        确定组合
    </button>
</div>
</div>`;
    return html;
}

export function setSourceValue(value: string) {
    const input = document.getElementById("fe-source") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("fe-source-display");
    if (display) {
        const t = resolveSourceTemp(value);
        const tempPart = t != null ? ` · ${t.toFixed(1)}°C` : "";
        display.textContent = `${getSourceLabel(value)}${tempPart}`;
    }
}

export function setFallbackSourceValue(value: string) {
    const input = document.getElementById("fe-fb-source") as HTMLInputElement | null;
    if (input) input.value = value;
    const display = document.getElementById("fe-fb-source-display");
    if (display) {
        const t = resolveSourceTemp(value);
        const tempPart = t != null ? ` · ${t.toFixed(1)}°C` : "";
        display.textContent = `${getSourceLabel(value)}${tempPart}`;
    }
}

export function getSensorDisplayName(sensorId: string): string {
    const sensors = store.getTelemetry()?.sensors ?? [];
    const aliases = store.getConfig().global.sensor_aliases ?? {};
    const alias = aliases[sensorId]?.trim();
    if (alias) return alias;
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return sensorId;
    const name = s.label || s.key;
    return s.device ? `${s.device}·${name}` : name;
}

export function getSourceLabel(source: string): string {
    const sensors = store.getTelemetry()?.sensors ?? [];
    const aliases = store.getConfig().global.sensor_aliases ?? {};
    const cpuSensor = store.getConfig().global.cpu_sensor;
    const gpuSensor = store.getConfig().global.gpu_sensor;
    // 当 source 是由 CPUSensor/GPUSensor 映射生成的传感器源时，显示为 CPU/GPU
    if (cpuSensor && source === `sensor:${cpuSensor}`) return "CPU";
    if (gpuSensor && source === `sensor:${gpuSensor}`) return "GPU";
    if (source === "cpu") return "CPU";
    if (source === "gpu") return "GPU";
    if (source === "disk_avg") return "硬盘平均";
    if (source === "disk_max") return "硬盘最大";
    if (source === "max") return "全部最大";
    if (source.startsWith("disk:")) {
        const key = source.slice(5);
        const disk = findDiskBySourceKey(key);
        return disk ? `硬盘 ${formatDiskLabel(disk)}` : key;
    }
    if (source.startsWith("sensor:")) {
        const id = source.slice(7);
        const alias = aliases[id]?.trim();
        if (alias) return alias;
        const s = sensors.find(x => x.id === id);
        if (!s) return id;
        const name = s.label || s.key;
        return s.device ? `${s.chip}·${s.device}·${name}` : `${s.chip}·${name}`;
    }
    if (source.startsWith("combo_avg:")) {
        const keys = source.slice("combo_avg:".length).split(",").map(k => k.trim());
        return `平均(${keys.map(k => getSourceLabel(k)).join(", ")})`;
    }
    if (source.startsWith("combo_max:")) {
        const keys = source.slice("combo_max:".length).split(",").map(k => k.trim());
        return `最大(${keys.map(k => getSourceLabel(k)).join(", ")})`;
    }
    return source;
}

export function resolveSourceMode(): SourceMode {
    return store.getConfig().global.source_mode === "advanced" ? "advanced" : "simple";
}

export function collectAllSourceItems(): SourceItem[] {
    const simpleGroups = collectSourceGroups("simple");
    const advancedGroups = collectSourceGroups("advanced");
    const seen = new Set<string>();
    const out: SourceItem[] = [];
    for (const g of [...simpleGroups, ...advancedGroups]) {
        for (const it of g.items) {
            if (!seen.has(it.v)) {
                seen.add(it.v);
                out.push(it);
            }
        }
    }
    return out;
}

export function parseComboSource(source: string): { strategy: "avg" | "max"; keys: string[] } | null {
    if (source.startsWith("combo_avg:")) {
        return {strategy: "avg", keys: source.slice("combo_avg:".length).split(",").map(k => k.trim()).filter(Boolean)};
    }
    if (source.startsWith("combo_max:")) {
        return {strategy: "max", keys: source.slice("combo_max:".length).split(",").map(k => k.trim()).filter(Boolean)};
    }
    return null;
}

export function buildComboSourceFromPanel(menu: HTMLElement): string {
    const boxes = menu.querySelectorAll<HTMLInputElement>("input[data-combo-cb]:checked");
    const keys = Array.from(boxes).map(cb => cb.value);
    const radioName = menu.querySelector("[data-combo-radio-name]")?.getAttribute("data-combo-radio-name") ?? "combo-strategy";
    const strategyRadio = menu.querySelector<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radioName)}"]:checked`);
    const strategy = strategyRadio?.value === "max" ? "max" : "avg";
    if (keys.length < 2) return "";
    return `combo_${strategy}:${keys.join(",")}`;
}

export function updateComboPreview(menu: HTMLElement) {
    const source = buildComboSourceFromPanel(menu);
    const countEl = menu.querySelector("[data-combo-count]");
    const previewEl = menu.querySelector("[data-combo-preview]");
    const confirmBtn = menu.querySelector("[data-combo-confirm]") as HTMLButtonElement | null;
    const boxes = menu.querySelectorAll<HTMLInputElement>("input[data-combo-cb]:checked");
    const count = boxes.length;
    if (countEl) countEl.textContent = String(count);
    if (previewEl) {
        const temp = source ? resolveSourceTemp(source) : undefined;
        previewEl.textContent = fmtTemp(temp);
    }
    if (confirmBtn) {
        const ok = count >= 2;
        confirmBtn.disabled = !ok;
        confirmBtn.className = `px-4 py-1.5 rounded-lg text-xs font-medium ${ok ? "bg-sky-600 text-white hover:bg-sky-500" : "bg-slate-700 text-slate-500 cursor-not-allowed"}`;
    }
}

export function applySourceModeUI(mode: SourceMode) {
    const switcher = document.getElementById("fe-source-mode");
    if (switcher) {
        switcher.querySelectorAll<HTMLButtonElement>("button[data-source-mode]").forEach(btn => {
            const active = btn.dataset.sourceMode === mode;
            btn.className = `px-3 py-1 text-xs rounded-md transition-colors ${active ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        });
    }
    const menu = document.getElementById("fe-source-menu");
    const input = document.getElementById("fe-source") as HTMLInputElement | null;
    if (menu && input) {
        menu.innerHTML = renderSourceOptions(input.value, mode);
    }
    const fbMenu = document.getElementById("fe-fb-source-menu");
    const fbInput = document.getElementById("fe-fb-source") as HTMLInputElement | null;
    if (fbMenu && fbInput) {
        fbMenu.innerHTML = renderSourceOptions(fbInput.value, mode, "combo-strategy-fb");
    }
}

export function openSourceMenu() {
    const menu = document.getElementById("fe-source-menu");
    const chevron = document.getElementById("fe-source-chevron");
    if (menu) {
        menu.classList.remove("hidden");
        menu.scrollTop = 0;
    }
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

export function closeSourceMenu() {
    const menu = document.getElementById("fe-source-menu");
    const chevron = document.getElementById("fe-source-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

export function isSourceMenuOpen(): boolean {
    return !!document.getElementById("fe-source-menu")?.classList.contains("hidden") === false;
}

export function openFallbackSourceMenu() {
    const menu = document.getElementById("fe-fb-source-menu");
    const chevron = document.getElementById("fe-fb-source-chevron");
    if (menu) {
        menu.classList.remove("hidden");
        menu.scrollTop = 0;
    }
    if (chevron) chevron.style.transform = "rotate(180deg)";
}

export function closeFallbackSourceMenu() {
    const menu = document.getElementById("fe-fb-source-menu");
    const chevron = document.getElementById("fe-fb-source-chevron");
    if (menu) menu.classList.add("hidden");
    if (chevron) chevron.style.transform = "";
}

export function isFallbackSourceMenuOpen(): boolean {
    return !!document.getElementById("fe-fb-source-menu")?.classList.contains("hidden") === false;
}

export function bindSourceDropdown() {
    const btn = document.getElementById("fe-source-btn");
    const menu = document.getElementById("fe-source-menu");
    const wrapper = document.getElementById("fe-source-wrapper");
    if (!btn || !menu || !wrapper) return;
    btn.addEventListener("click", ev => {
        ev.stopPropagation();
        if (isSourceMenuOpen()) closeSourceMenu();
        else {
            closeFallbackSourceMenu();
            const mode = resolveSourceMode();
            const input = document.getElementById("fe-source") as HTMLInputElement | null;
            menu.innerHTML = renderSourceOptions(input?.value ?? "", mode);
            openSourceMenu();
        }
    });
    menu.addEventListener("click", ev => {
        const target = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-value]");
        if (target) {
            const v = target.dataset.sourceValue;
            if (v !== undefined) {
                setSourceValue(v);
                const mode = resolveSourceMode();
                menu.innerHTML = renderSourceOptions(v, mode);
                closeSourceMenu();
            }
            return;
        }
        const confirm = (ev.target as HTMLElement).closest("[data-combo-confirm]") as HTMLButtonElement | null;
        if (confirm && !confirm.disabled) {
            const src = buildComboSourceFromPanel(menu);
            if (src) {
                setSourceValue(src);
                closeSourceMenu();
            }
        }
    });
    menu.addEventListener("change", ev => {
        const t = ev.target as HTMLInputElement;
        if (t.dataset.comboCb !== undefined || (t.type === "radio" && t.name.startsWith("combo-strat"))) updateComboPreview(menu);
    });
    document.addEventListener("click", ev => {
        if (isSourceMenuOpen() && !wrapper.contains(ev.target as Node)) closeSourceMenu();
    });
    document.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && isSourceMenuOpen()) {
            closeSourceMenu();
            ev.stopPropagation();
        }
    });
}

export function bindFallbackSourceDropdown() {
    const btn = document.getElementById("fe-fb-source-btn");
    const menu = document.getElementById("fe-fb-source-menu");
    const wrapper = document.getElementById("fe-fb-source-wrapper");
    if (!btn || !menu || !wrapper) return;
    btn.addEventListener("click", ev => {
        ev.stopPropagation();
        if (isFallbackSourceMenuOpen()) closeFallbackSourceMenu();
        else {
            closeSourceMenu();
            const mode = resolveSourceMode();
            const input = document.getElementById("fe-fb-source") as HTMLInputElement | null;
            menu.innerHTML = renderSourceOptions(input?.value ?? "", mode, "combo-strategy-fb");
            openFallbackSourceMenu();
        }
    });
    menu.addEventListener("click", ev => {
        const target = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-value]");
        if (target) {
            const v = target.dataset.sourceValue;
            if (v !== undefined) {
                setFallbackSourceValue(v);
                const mode = resolveSourceMode();
                menu.innerHTML = renderSourceOptions(v, mode, "combo-strategy-fb");
                closeFallbackSourceMenu();
            }
            return;
        }
        const confirm = (ev.target as HTMLElement).closest("[data-combo-confirm]") as HTMLButtonElement | null;
        if (confirm && !confirm.disabled) {
            const src = buildComboSourceFromPanel(menu);
            if (src) {
                setFallbackSourceValue(src);
                closeFallbackSourceMenu();
            }
        }
    });
    menu.addEventListener("change", ev => {
        const t = ev.target as HTMLInputElement;
        if (t.dataset.comboCb !== undefined || (t.type === "radio" && t.name.startsWith("combo-strat"))) updateComboPreview(menu);
    });
    document.addEventListener("click", ev => {
        if (isFallbackSourceMenuOpen() && !wrapper.contains(ev.target as Node)) closeFallbackSourceMenu();
    });
    document.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && isFallbackSourceMenuOpen()) {
            closeFallbackSourceMenu();
            ev.stopPropagation();
        }
    });
}

export function bindSourceModeSwitcher() {
    const switcher = document.getElementById("fe-source-mode");
    if (!switcher) return;
    switcher.addEventListener("click", ev => {
        const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-source-mode]");
        if (!btn) return;
        const mode: SourceMode = btn.dataset.sourceMode === "advanced" ? "advanced" : "simple";
        if (store.getConfig().global.source_mode === mode) return;
        store.getConfig().global.source_mode = mode;
        applySourceModeUI(mode);
    });
}
