/**
 * 风扇卡片渲染与绑定模块（建议8/9 拆分产物）。
 */
import {store, DEFAULT_CURVE} from "../store";
import {$, esc, toast, openConfirm} from "./core";
import {getSourceLabel} from "./sources";
import {openFanSettingsDialog} from "./settings";
import {removeFan, setFanMode, setFanManualPWM, fetchScanFans, saveConfig, fetchInfo, fetchConfig} from "../api";
import {FanConfig, ScannedFan} from "../types";

let lastScanResults: ScannedFan[] = [];

/** 保存/变更后重新拉取最新配置与遥测（视图经 store 订阅自动重绘） */
async function refresh() {
    const [info, cfg] = await Promise.all([fetchInfo(), fetchConfig()]);
    store.setConfig(cfg);
    store.setTelemetry(info);
}

export function runtimeFor(id: string) {
    return store.getTelemetry()?.fans?.find(f => f.id === id);
}

export function fanPWMPercent(pwm: number | null | undefined): number {
    if (pwm == null || !Number.isFinite(pwm) || pwm < 0) return 0;
    return Math.round(Math.min(255, pwm) / 255 * 100);
}

export function syncFanCardsFromTelemetryOrRender() {
    const root = $("fan-root");
    const fans = store.getConfig().fans;
    const cards = root.querySelectorAll(":scope > [data-fan-id]");
    if (fans.length === 0) {
        if (root.innerHTML !== "") root.innerHTML = "";
        return;
    }
    if (cards.length !== fans.length) {
        renderFanCards();
        return;
    }
    for (let i = 0; i < fans.length; i++) {
        if ((cards[i] as HTMLElement).dataset.fanId !== fans[i].id) {
            renderFanCards();
            return;
        }
    }
    fans.forEach((fan, idx) => {
        const card = cards[idx] as HTMLElement;
        const rt = runtimeFor(fan.id);
        const rpm = rt?.rpm ?? 0;
        const stopped = rpm <= 0 || rt?.status === "stopped";
        const manual = fan.mode === "manual";
        const pwmVal = fan.manual_pwm;
        const pwmPct = fanPWMPercent(rt?.pwm ?? (manual ? fan.manual_pwm : undefined));
        const fanName = card.querySelector("[data-fan-name]") as HTMLElement | null;
        if (fanName) fanName.textContent = fan.name;
        const pwmPath = card.querySelector("[data-fan-pwm-path]") as HTMLElement | null;
        if (pwmPath) {
            pwmPath.textContent = fan.pwm_path || "未配置 PWM";
            pwmPath.setAttribute("title", fan.pwm_path || "");
        }
        const iconBg = card.querySelector("[data-fan-icon-bg]") as HTMLElement | null;
        const iconEl = card.querySelector("[data-fan-icon]") as HTMLElement | null;
        if (iconBg) {
            iconBg.className = `w-9 h-9 rounded-full ${stopped ? "bg-slate-700" : "bg-sky-500/10"} flex items-center justify-center flex-shrink-0`;
        }
        if (iconEl) {
            iconEl.setAttribute("icon", stopped ? "mdi:fan-off" : "mdi:fan");
            iconEl.className = stopped ? "text-slate-500" : "text-sky-400 animate-spin-slow";
        }
        const rpmRow = card.querySelector("[data-fan-rpm-row]") as HTMLElement | null;
        const rpmNum = card.querySelector("[data-fan-rpm]") as HTMLElement | null;
        const rpmUnit = card.querySelector("[data-fan-rpm-unit]") as HTMLElement | null;
        const rpmPct = card.querySelector("[data-fan-pwm-pct]") as HTMLElement | null;
        if (rpmNum) rpmNum.textContent = String(rpm);
        if (rpmUnit) rpmUnit.textContent = stopped ? "STOPPED" : "RPM";
        if (rpmPct) {
            rpmPct.textContent = ` · ${pwmPct}%`;
            rpmPct.classList.toggle("hidden", stopped);
        }
        if (rpmRow) {
            rpmRow.className = `text-2xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}`;
        }
        const curveBtn = card.querySelector('[data-mode="curve"]') as HTMLElement | null;
        const manualBtn = card.querySelector('[data-mode="manual"]') as HTMLElement | null;
        if (curveBtn) {
            curveBtn.className = `px-2.5 py-0.5 text-xs rounded-md ${!manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        }
        if (manualBtn) {
            manualBtn.className = `px-2.5 py-0.5 text-xs rounded-md ${manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        }
        const manualUi = card.querySelector("[data-manual-ui]") as HTMLElement | null;
        const autoUi = card.querySelector("[data-auto-ui]") as HTMLElement | null;
        if (manualUi) manualUi.classList.toggle("hidden", !manual);
        if (autoUi) autoUi.classList.toggle("hidden", manual);
        const fanSource = card.querySelector("[data-fan-source]") as HTMLElement | null;
        if (fanSource) {
            fanSource.textContent = getSourceLabel(fan.source);
            fanSource.setAttribute("data-source", fan.source);
        }
        const pwmDisplay = card.querySelector("[data-fan-pwm-display]") as HTMLElement | null;
        const range = card.querySelector('input[data-field="pwm-range"]') as HTMLInputElement | null;
        if (pwmDisplay) pwmDisplay.textContent = `${pwmVal} / 255`;
        if (range && document.activeElement !== range) {
            range.value = String(pwmVal);
        }
    });
}

export function renderFanCards() {
    const root = $("fan-root");
    const fans = store.getConfig().fans;
    root.innerHTML = fans
        .map((fan, idx) => {
            const rt = runtimeFor(fan.id);
            const rpm = rt?.rpm ?? 0;
            const stopped = rpm <= 0 || rt?.status === "stopped";
            const manual = fan.mode === "manual";
            const pwmVal = fan.manual_pwm;
            const pwmPct = fanPWMPercent(rt?.pwm ?? (manual ? fan.manual_pwm : undefined));
            return `
<div class="bg-slate-900 rounded-xl p-4 border border-slate-700/60" data-fan-idx="${idx}" data-fan-id="${esc(fan.id)}">
  <div class="flex justify-between items-start mb-3">
    <div class="flex items-center gap-2.5 min-w-0">
      <div data-fan-icon-bg class="w-9 h-9 rounded-full ${stopped ? "bg-slate-700" : "bg-sky-500/10"} flex items-center justify-center flex-shrink-0">
        <iconify-icon data-fan-icon class="${stopped ? "text-slate-500" : "text-sky-400 animate-spin-slow"}" icon="${stopped ? "mdi:fan-off" : "mdi:fan"}"></iconify-icon>
      </div>
      <div class="min-w-0">
        <h4 data-fan-name class="font-bold text-white text-sm truncate">${esc(fan.name)}</h4>
        <p data-fan-pwm-path class="text-[10px] text-slate-500 font-mono truncate leading-tight" title="${esc(fan.pwm_path)}">${esc(fan.pwm_path || "未配置 PWM")}</p>
      </div>
    </div>
    <div class="flex items-center gap-0.5 flex-shrink-0">
      <button type="button" class="p-1.5 hover:bg-red-900/40 rounded-md text-slate-400 hover:text-red-300 flex-shrink-0" data-act="fan-delete" title="从配置中删除此风扇">
        <iconify-icon class="text-lg" icon="mdi:delete-outline"></iconify-icon>
      </button>
      <button type="button" class="p-1.5 hover:bg-slate-700 rounded-md text-slate-400 flex-shrink-0" data-act="fan-settings" title="风扇设置">
        <iconify-icon class="text-lg" icon="mdi:cog-outline"></iconify-icon>
      </button>
    </div>
  </div>
  <div class="flex items-center justify-between mb-3">
    <div data-fan-rpm-row class="text-2xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}">
      <span data-fan-rpm>${rpm}</span> <span data-fan-rpm-unit class="text-sm text-slate-500 font-normal not-italic">${stopped ? "STOPPED" : "RPM"}</span><span data-fan-pwm-pct class="text-base text-slate-400 font-semibold not-italic ${stopped ? "hidden" : ""}"> · ${pwmPct}%</span>
    </div>
    <div class="flex items-center p-0.5 bg-slate-800 rounded-lg">
      <button type="button" data-mode="curve" class="px-2.5 py-0.5 text-xs rounded-md ${!manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}">自动</button>
      <button type="button" data-mode="manual" class="px-2.5 py-0.5 text-xs rounded-md ${manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}">手动</button>
    </div>
  </div>
  <div class="${manual ? "" : "hidden"}" data-manual-ui>
    <div class="flex justify-between text-[10px] text-slate-500 mb-1.5 uppercase tracking-tighter">
      <span>PWM 输出</span>
      <span data-fan-pwm-display class="text-sky-400 font-bold">${pwmVal} / 255</span>
    </div>
    <input data-field="pwm-range" class="w-full" type="range" min="0" max="255" value="${pwmVal}" />
  </div>
  <div class="${manual ? "hidden" : ""} flex items-center gap-2 text-xs text-slate-400 bg-slate-800/40 py-1.5 px-2 rounded-lg mt-1" data-auto-ui>
    <iconify-icon class="text-sky-400 flex-shrink-0" icon="mdi:chart-bell-curve"></iconify-icon>
    <span class="leading-tight">温度源: </span>
    <span data-fan-source class="leading-tight text-sky-300" data-source="${fan.source}">${getSourceLabel(fan.source)}</span>
    <span class="leading-tight text-slate-500">· 齿轮编辑曲线</span>
  </div>
</div>`;
        })
        .join("");
}

export function bindFanRoot() {
    const root = $("fan-root");
    root.addEventListener("click", async (ev: MouseEvent) => {
        const t = ev.target as HTMLElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        const del = t.closest("[data-act=fan-delete]");
        if (del && row) {
            const id = row.dataset.fanId!;
            const name = store.getConfig().fans.find(f => f.id === id)?.name ?? id;
            if (!(await openConfirm(`确定从配置中删除风扇「${name}」吗？`))) return;
            try {
                await removeFan(id);
                await refresh();
                toast("已删除该风扇配置", "success");
            } catch (e) {
                toast(String(e), "error");
            }
            return;
        }
        const gear = t.closest("[data-act=fan-settings]");
        if (gear && row) {
            openFanSettingsDialog(Number(row.dataset.fanIdx));
            return;
        }
        const modeBtn = t.closest("[data-mode]") as HTMLElement | null;
        if (modeBtn && row) {
            const id = row.dataset.fanId!;
            const mode = modeBtn.dataset.mode as "manual" | "curve";
            const fan = store.getConfig().fans.find(f => f.id === id);
            if (!fan || fan.mode === mode) return;
            fan.mode = mode;
            try {
                await setFanMode(id, mode);
                await refresh();
            } catch (e) {
                toast(String(e), "error");
            }
        }
    });
    root.addEventListener("input", (ev: Event) => {
        const t = ev.target as HTMLInputElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const fan = store.getConfig().fans.find(f => f.id === row.dataset.fanId);
        if (!fan) return;
        if (t.dataset.field === "pwm-range") {
            const v = Number(t.value);
            fan.manual_pwm = v;
            const span = row.querySelector("[data-fan-pwm-display]");
            if (span) span.textContent = `${v} / 255`;
        }
    });
    root.addEventListener("pointerup", async (ev: PointerEvent) => {
        const t = ev.target as HTMLInputElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.fanId!;
        const fan = store.getConfig().fans.find(f => f.id === id);
        if (!fan) return;
        if (t.dataset.field === "pwm-range") {
            const v = Number(t.value);
            try {
                await setFanManualPWM(id, v);
            } catch (e) {
                toast(String(e), "error");
            }
        }
    });
}

export function fanIdentityTaken(chip: string, device: string, pwmIndex: number): boolean {
    return store.getConfig().fans.some(
        f => f.chip === chip && f.device === device && f.pwm_index === pwmIndex
    )
}

export async function runHardwareScan() {
    const status = $("scan-status");
    status.textContent = "正在扫描…";
    try {
        lastScanResults = await fetchScanFans();
        status.textContent = `共发现 ${lastScanResults?.length ?? 0} 个 PWM 通道`;
        renderScanTable();
    } catch (e) {
        status.textContent = `扫描失败：${String(e)}`;
        ($("scan-fans-tbody") as HTMLElement).innerHTML = "";
    }
}

export function renderScanTable() {
    const tbody = $("scan-fans-tbody") as HTMLElement;
    tbody.innerHTML = lastScanResults.map((s, i) => {
        const pwmIndex = Number(s.pwm_index)
        const taken = fanIdentityTaken(s.chip, s.device, pwmIndex);
        const sensors = parseScannedSensors(s);
        const sensorCell = sensors.length > 0
            ? `<div class="space-y-0.5">${sensors.map(x => `<div class="text-[10px] text-sky-300/90 break-all"><span class="text-slate-500 font-mono">${esc(x.key)}</span> ${esc(x.label)}</div>`).join("")}</div>`
            : `<span class="text-[10px] text-slate-500">—</span>`;
        return `
<tr class="border-b border-slate-800 ${taken ? "opacity-50" : ""}">
  <td class="p-2 align-top"><input type="checkbox" data-scan-idx="${i}" class="scan-cb rounded border-slate-600" ${taken ? "disabled" : ""} /></td>
  <td class="p-2 align-top text-slate-300">${esc(s.name)}<div class="text-[10px] text-slate-500 font-mono mt-1">${esc(s.id)}</div></td>
  <td class="p-2 align-top">${sensorCell}</td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.pwm_path)}</td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.rpm_path || "—")}</td>
</tr>`;
    }).join("");
}

/** 解析 ScanFans 返回的 sensors JSON 字符串（后端 hwmon 扫描附加的 temp 通道元数据）。 */
function parseScannedSensors(s: ScannedFan): {key: string; label: string}[] {
    if (!s.sensors) return [];
    try {
        const arr = JSON.parse(s.sensors) as {key: string; label: string}[];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export async function addScannedFansFromSelection() {
    const boxes = document.querySelectorAll<HTMLInputElement>(".scan-cb:checked:not(:disabled)");
    const newFans: FanConfig[] = [];
    let n = 0;
    boxes.forEach(box => {
        const i = Number(box.dataset.scanIdx);
        const s = lastScanResults[i];
        const pwmIndex = Number(s.pwm_index)
        if (!s || !s.chip || !Number.isFinite(pwmIndex) || pwmIndex <= 0) return;
        if (fanIdentityTaken(s.chip, s.device, pwmIndex)) return;
        let id = s.id;
        if (store.getConfig().fans.some(f => f.id === id)) id = `${s.id}-${Date.now().toString(36)}`;
        const fan: FanConfig = {
            id,
            name: s.name,
            pwm_path: s.pwm_path,
            rpm_path: s.rpm_path,
            enable_path: s.enable_path,
            chip: s.chip,
            device: s.device,
            pwm_index: Number(s.pwm_index),
            mode: "curve",
            source: "cpu",
            manual_pwm: 120,
            curve: DEFAULT_CURVE.map(c => ({...c})),
            // 从全局配置读取当前值，显式写入风扇配置
            pwm_deadzone: store.getConfig().global.pwm_deadzone,
            stop_hysteresis: store.getConfig().global.stop_hysteresis,
            emergency_temp: store.getConfig().global.emergency_temp,
        };
        newFans.push(fan);
        n++;
    });
    if (n === 0) {
        toast("请勾选尚未加入配置的项。", "info");
        return;
    }
    try {
        // 先保存到服务端
        const tempConfig = {...store.getConfig(), fans: [...store.getConfig().fans, ...newFans]};
        await saveConfig(tempConfig);
        // 保存成功后才更新本地配置
        store.setConfig(tempConfig);
        ($("scan-fans-dialog") as HTMLDialogElement).close();
        await refresh();
        toast(`已添加 ${n} 个风扇并已保存到服务端。`, "success");
    } catch (e: any) {
        const msg = e.response?.data?.error || e.message || "保存失败，请检查权限或网络";
        toast(msg, "error");
    }
}
