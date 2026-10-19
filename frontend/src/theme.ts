/**
 * 主题模块：跟随系统 / 明亮 / 暗黑 三模式。
 * - 通过 <html data-theme="light|dark"> 驱动 index.html 内的 CSS 覆盖实现明暗样式；
 * - 模式持久化到后端 GlobalConfig.theme_mode，重启后保持；
 * - 跟随系统模式下监听 prefers-color-scheme 变化实时切换；
 * - 图表配色统一经 getChartPalette() 获取，主题变化通过 onThemeChanged 通知图表刷新。
 */
import { store } from "./store";
import { setGlobalConfig } from "./api";
import { toast } from "./ui/core";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ChartPalette {
    label: string;  // 轴标签 / 刻度文字
    axis: string;   // 轴线
    split: string;  // 分割线
    name: string;   // 轴名称
}

let currentMode: ThemeMode = "system";
let resolvedTheme: ResolvedTheme = "dark";
let systemMedia: MediaQueryList | null = null;
let systemMediaHandler: ((ev: MediaQueryListEvent) => void) | null = null;
const listeners = new Set<() => void>();

export function resolveSystemTheme(): ResolvedTheme {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function getThemeMode(): ThemeMode {
    return currentMode;
}

export function getResolvedTheme(): ResolvedTheme {
    return resolvedTheme;
}

/** 订阅主题变化；返回取消订阅函数 */
export function onThemeChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notifyThemeChanged(): void {
    listeners.forEach((fn) => {
        try {
            fn();
        } catch (e) {
            console.error("[主题] 回调执行失败", e);
        }
    });
}

function detachSystemListener(): void {
    if (systemMedia && systemMediaHandler) {
        systemMedia.removeEventListener?.("change", systemMediaHandler);
        systemMediaHandler = null;
    }
}

/** 应用主题：写 data-theme、必要时挂载系统主题监听、通知图表刷新 */
export function applyTheme(mode: ThemeMode): void {
    detachSystemListener();
    currentMode = mode;
    resolvedTheme = mode === "system" ? resolveSystemTheme() : mode;
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    if (mode === "system") {
        systemMedia ??= window.matchMedia("(prefers-color-scheme: light)");
        systemMediaHandler = (ev: MediaQueryListEvent): void => {
            resolvedTheme = ev.matches ? "light" : "dark";
            document.documentElement.setAttribute("data-theme", resolvedTheme);
            notifyThemeChanged();
        };
        systemMedia.addEventListener?.("change", systemMediaHandler);
    }
    notifyThemeChanged();
}

export function getChartPalette(): ChartPalette {
    if (resolvedTheme === "light") {
        return {
            label: "#334155",
            axis: "rgba(100, 116, 139, 0.55)",
            split: "rgba(100, 116, 139, 0.18)",
            name: "#475569",
        };
    }
    return {
        label: "#cbd5e1",
        axis: "rgba(148, 163, 184, 0.4)",
        split: "rgba(148, 163, 184, 0.12)",
        name: "#64748b",
    };
}

/** 刷新顶部主题切换器按钮的选中态 */
export function renderThemeSwitcher(): void {
    document.querySelectorAll<HTMLButtonElement>("#theme-switcher [data-theme-mode]").forEach((btn) => {
        const active = btn.dataset.themeMode === currentMode;
        btn.classList.toggle("bg-sky-600", active);
        btn.classList.toggle("text-white", active);
        btn.classList.toggle("text-slate-400", !active);
        btn.classList.toggle("hover:text-white", !active);
    });
}

/** 切换主题并持久化到后端配置 */
export async function setThemeMode(mode: ThemeMode): Promise<void> {
    applyTheme(mode);
    renderThemeSwitcher();
    try {
        store.getConfig().global.theme_mode = mode;
        await setGlobalConfig(store.getConfig().global);
    } catch (e) {
        console.error("[主题]", e);
        toast("主题保存失败，请检查后端连接后重试", "error");
    }
}

/** 从后端配置应用持久化主题（config 加载完成后调用） */
export function applyThemeFromConfig(mode?: ThemeMode): void {
    const m = mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
    applyTheme(m);
    renderThemeSwitcher();
}

/** 初始化顶部主题切换器交互；启动时先按系统偏好渲染避免闪屏 */
export function initThemeSwitcher(): void {
    document.getElementById("theme-switcher")?.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-mode]");
        if (!btn) return;
        const m = btn.dataset.themeMode;
        if (m === "system" || m === "light" || m === "dark") void setThemeMode(m);
    });
    applyTheme("system");
    renderThemeSwitcher();
}
