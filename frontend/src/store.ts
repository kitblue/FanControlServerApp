/**
 * 轻量自研状态层（建议9）：
 * - WebSocket 只写 store：ws.ts 收到遥测帧后仅调用 store.setTelemetry()；
 * - 视图订阅状态：main.ts 通过 store.subscribe() 注册渲染回调，状态变更后统一重绘；
 * - config / telemetry 为全局共享数据状态（原 main.ts 中的模块级变量收敛于此）。
 */
import type {ConfigPayload, CurvePoint, Telemetry} from "./types";

export const DEFAULT_CURVE: CurvePoint[] = [
    {temp: 45, pwm: 120},
    {temp: 60, pwm: 180},
    {temp: 75, pwm: 255},
];

function createInitialConfig(): ConfigPayload {
    return {
        version: 3,
        fans: [],
        global: {
            pwm_deadzone: 5,
            update_interval_ms: 2000,
            emergency_temp: 80,
            stop_behavior: "set",
            stop_pwm: 200,
            stop_hysteresis: 2,
            log_level: "info",
        },
    };
}

type Listener = () => void;

class Store {
    private state: {config: ConfigPayload; telemetry: Telemetry | undefined} = {
        config: createInitialConfig(),
        telemetry: undefined,
    };
    private listeners = new Set<Listener>();

    getConfig(): ConfigPayload {
        return this.state.config;
    }

    getTelemetry(): Telemetry | undefined {
        return this.state.telemetry;
    }

    setConfig(config: ConfigPayload): void {
        this.state.config = config;
        this.emit();
    }

    /** 原地修改 getConfig() 返回的共享对象后调用，通知订阅者状态已变化 */
    commitConfig(): void {
        this.emit();
    }

    setTelemetry(telemetry: Telemetry): void {
        this.state.telemetry = telemetry;
        this.emit();
    }

    /** 视图订阅状态变更；返回取消订阅函数 */
    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    }

    private emit(): void {
        for (const fn of [...this.listeners]) {
            try {
                fn();
            } catch (e) {
                console.error("[store] subscriber error", e);
            }
        }
    }
}

export const store = new Store();
