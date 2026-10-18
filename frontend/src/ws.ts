/**
 * WebSocket 客户端模块（建议8/9 拆分产物）：
 * - 只负责连接、重连与把服务端推送写入 store；
 * - 视图通过 store.subscribe() 订阅，不再直接依赖 ws 消息。
 */
import {store} from "./store";
import type {Telemetry} from "./types";

export interface WSStatus {
    connected: boolean;
    lastError?: string;
}

export interface WSOptions {
    /** 需要 WS 就绪后触发的回调（如首次拉取配置） */
    onOpen?: () => void;
    /** 连接状态变化回调（用于 UI 状态灯/日志） */
    onStatus?: (status: WSStatus) => void;
}

const wsStatus: WSStatus = {connected: false};

let ws: WebSocket | null = null;
let wsTimer: number | null = null;
let wsManualClosed = false;
let wsRetryCount = 0;

function wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
    return `${proto}//${location.host}${base}/api/ws`;
}

function emitStatus() {
    // 连接状态 UI 更新逻辑由订阅者处理；此处通过回调通知
}

function notifyStatus(onStatus?: (s: WSStatus) => void) {
    wsStatus.connected = ws !== null && ws.readyState === WebSocket.OPEN;
    onStatus?.({...wsStatus});
}

export function connectWs(options: WSOptions = {}): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }
    wsManualClosed = false;
    if (wsTimer !== null) {
        window.clearTimeout(wsTimer);
        wsTimer = null;
    }
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
        wsRetryCount = 0;
        emitStatus();
        notifyStatus(options.onStatus);
        options.onOpen?.();
    };
    ws.onmessage = ev => {
        try {
            // 服务端推送的是裸 Telemetry JSON（非 {type,data} 包裹）
            const telemetry = JSON.parse(String(ev.data)) as Telemetry;
            store.setTelemetry(telemetry);
        } catch {
            // 忽略无法解析的帧
        }
    };
    ws.onclose = () => {
        notifyStatus(options.onStatus);
        if (wsManualClosed) return;
        scheduleReconnect(options);
    };
    ws.onerror = () => {
        wsStatus.lastError = "ws-error";
        notifyStatus(options.onStatus);
    };
}

function scheduleReconnect(options: WSOptions): void {
    if (wsTimer !== null) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(wsRetryCount, 5));
    wsRetryCount += 1;
    wsTimer = window.setTimeout(() => {
        wsTimer = null;
        connectWs(options);
    }, delay);
}

export function closeWs(): void {
    wsManualClosed = true;
    if (wsTimer !== null) {
        window.clearTimeout(wsTimer);
        wsTimer = null;
    }
    ws?.close();
    ws = null;
}

export function isWsConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}
