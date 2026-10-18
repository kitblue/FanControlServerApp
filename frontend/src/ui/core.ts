/**
 * 通用 UI 工具（建议8/9 拆分产物）：
 * DOM 查询、转义、toast、时间/温度格式化、环形进度、系统信息概览、磁盘列表。
 * 数据统一从 store 读取，不持有业务状态。
 */
import {store} from "../store";
import type {DiskInfo, Telemetry} from "../types";

export type ToastKind = "info" | "success" | "error" | "warning";

export const TOAST_CLASS: Record<ToastKind, string> = {
    info: "bg-slate-800/95 border-slate-600 text-slate-100",
    success: "bg-emerald-900/95 border-emerald-600 text-emerald-100",
    error: "bg-red-900/95 border-red-600 text-red-100",
    warning: "bg-amber-900/95 border-amber-600 text-amber-100",
};

export const TOAST_ICON: Record<ToastKind, string> = {
    info: "mdi:information",
    success: "mdi:check-circle",
    error: "mdi:alert-circle",
    warning: "mdi:alert",
};

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
}

export function esc(value: unknown): string {
    return String(value).replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c] as string));
}

export function formatTemp(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return "--";
    return String(Math.round(value));
}

export function setDiskSerialVisible(visible: boolean) {
    showDiskSerial = visible;
    try {
        localStorage.setItem(DISK_SERIAL_VISIBLE_KEY, visible ? "1" : "0");
    } catch { /* ignore */ }
}

export const DISK_SERIAL_VISIBLE_KEY = "fc-show-disk-serial";

export function loadDiskSerialVisible(): boolean {
    try {
        return localStorage.getItem(DISK_SERIAL_VISIBLE_KEY) === "1";
    } catch {
        return false;
    }
}

export let showDiskSerial = loadDiskSerialVisible();

// 与 index.html 环形 SVG circle r=15.5（stroke-dasharray="97.4"）严格匹配：
// 周长 = 2π×15.5 ≈ 97.39。旧值 2π×54≈339 与 SVG 实际 dasharray 不符，
// 导致 0% 显示约 1/3 圈且比例跳脱。
export const RING_CIRCUMFERENCE = 2 * Math.PI * 15.5;

let lastUptime = 0;
let lastUptimeReceived = 0;

export function formatTime(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${min}:${s}`;
}

export function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}年${m}月${day}日`;
}

export function updateSystemTime() {
    const now = new Date();
    $("system-date").textContent = formatDate(now);
    $("system-time").textContent = formatTime(now);
}

export function formatUptime(seconds?: number): string {
    if (seconds === undefined || seconds <= 0) return "--";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

    return parts.join(" ");
}

export function updateRingProgress(ringId: string, percentage: number) {
    const ring = document.getElementById(ringId) as SVGCircleElement | null;
    if (ring) {
        const offset = RING_CIRCUMFERENCE - (percentage / 100) * RING_CIRCUMFERENCE;
        ring.style.strokeDashoffset = String(offset);
    }
}

export function updateSubtitleDate() {
    updateSystemTime();
    updateUptimeFromServer();
}

export function updateUptimeFromServer() {
    if (lastUptime > 0) {
        const elapsed = Math.floor((Date.now() - lastUptimeReceived) / 1000);
        const currentUptime = lastUptime + elapsed;
        $("uptime-text").textContent = formatUptime(currentUptime);
    }
}

export function onTelemetryReceived(t: Telemetry) {
    lastUptime = t.uptime ?? 0;
    lastUptimeReceived = Date.now();
}

export function maskDiskSerial(_serial: string): string {
    return "*".repeat(8);
}

export function formatDiskSerialDisplay(serial: string): string {
    if (!showDiskSerial) {
        return maskDiskSerial(serial);
    }
    return serial;
}

export function formatDiskLabel(disk: Pick<DiskInfo, "name" | "serial">): string {
    if (!disk.serial) {
        return disk.name;
    }
    return `${disk.name} · ${formatDiskSerialDisplay(disk.serial)}`;
}

export function diskSourceValue(disk: Pick<DiskInfo, "name" | "serial">): string {
    const serial = disk.serial?.trim();
    return serial ? `disk:${serial}` : `disk:${disk.name}`;
}

export function findDiskBySourceKey(key: string): DiskInfo | undefined {
    const k = key.trim();
    if (!k) return undefined;
    return (store.getTelemetry()?.disks?.details ?? []).find(
        d => (d.serial?.trim() === k) || d.name === k,
    );
}

export function renderDiskNameHtml(disk: Pick<DiskInfo, "name" | "serial">): string {
    const name = esc(disk.name);
    if (!disk.serial) {
        return `<iconify-icon icon="mdi:harddisk" class="shrink-0"></iconify-icon><span class="font-mono">${name}</span>`;
    }
    const serialText = esc(formatDiskSerialDisplay(disk.serial));
    const title = showDiskSerial ? esc(disk.serial) : "序列号已隐藏";
    return `<iconify-icon icon="mdi:harddisk" class="shrink-0"></iconify-icon><span class="font-mono truncate min-w-0" title="${title}">${name} · <span class="text-slate-500">${serialText}</span></span>`;
}

export function toast(message: string, kind: ToastKind = "info") {
    const root = document.getElementById("toast-root");
    if (!root) {
        console.error("[toast]", message);
        return;
    }
    const el = document.createElement("div");
    el.setAttribute("role", "status");
    el.className = `toast-item pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur-sm ${TOAST_CLASS[kind]}`;
    const icon = document.createElement("iconify-icon");
    icon.className = "text-xl flex-shrink-0 mt-0.5";
    icon.setAttribute("icon", TOAST_ICON[kind]);
    const p = document.createElement("p");
    p.className = "flex-1 min-w-0 break-words leading-snug";
    p.textContent = message;
    el.append(icon, p);
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast-item-visible"));
    const ms = kind === "error" ? 6000 : 4200;
    window.setTimeout(() => {
        el.classList.remove("toast-item-visible");
        el.classList.add("toast-item-exit");
        window.setTimeout(() => el.remove(), 220);
    }, ms);
}

export function renderStorageList() {
    const list = $("storage-list");
    const d = store.getTelemetry()?.disks.details ?? [];
    if (d.length === 0) {
        if (list.children.length === 0) return;
        list.innerHTML = "";
        return;
    }
    if (list.children.length !== d.length) {
        list.innerHTML = d
            .map(disk => `
      <div class="flex justify-between items-center gap-2 text-xs" data-disk-name="${esc(disk.name)}">
        <span class="text-slate-400 flex items-center gap-2 min-w-0">${renderDiskNameHtml(disk)}</span>
        <span class="disk-temp font-mono">${
                disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
            }</span>
      </div>`)
            .join("");
        return;
    }
    d.forEach((disk, idx) => {
        const item = list.children[idx] as HTMLElement;
        if (item.dataset.diskName !== disk.name) {
            list.innerHTML = d
                .map(disk => `
        <div class="flex justify-between items-center gap-2 text-xs" data-disk-name="${esc(disk.name)}">
          <span class="text-slate-400 flex items-center gap-2 min-w-0">${renderDiskNameHtml(disk)}</span>
          <span class="disk-temp font-mono">${
                    disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
                }</span>
        </div>`)
                .join("");
            return;
        }
        const tempSpan = item.querySelector(".disk-temp");
        if (tempSpan) {
            const isSleep = disk.status === "sleep";
            const iconEl = item.querySelector("iconify-icon") as HTMLElement | null;
            if (iconEl) {
                iconEl.setAttribute("icon", isSleep ? "mdi:harddisk" : "mdi:harddisk");
                iconEl.className = isSleep ? "text-slate-500" : "text-slate-400";
            }
            tempSpan.innerHTML = isSleep
                ? '<span class="text-slate-500 uppercase">休眠</span>'
                : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`;
        }
    });
}
export function openConfirm(message: string): Promise<boolean> {
    return new Promise(resolve => {
        const dialog = document.getElementById("confirm-dialog") as HTMLDialogElement | null;
        const text = document.getElementById("confirm-text");
        const okBtn = document.getElementById("confirm-ok") as HTMLButtonElement | null;
        const cancelBtn = document.getElementById("confirm-cancel") as HTMLButtonElement | null;
        if (!dialog || !text || !okBtn || !cancelBtn) {
            resolve(false);
            return;
        }
        text.textContent = message;
        dialog.showModal();
        const onOk = () => { resolve(true); dialog.close(); };
        const onCancel = () => { resolve(false); dialog.close(); };
        const onClose = () => resolve(false);
        const onClick = (ev: MouseEvent) => { if (ev.target === dialog) { resolve(false); dialog.close(); } };
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        dialog.addEventListener("close", onClose);
        dialog.addEventListener("cancel", onCancel);
        dialog.addEventListener("click", onClick);
    });
}

