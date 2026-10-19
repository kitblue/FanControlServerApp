export interface CurvePoint {
    temp: number;
    pwm: number;
}

/** GET /api/device/scan 单条结果（与后端 hwmon.ScanFans 字段一致） */
export interface ScannedFan {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
    chip: string;
    device: string;
    pwm_index: number
    /** 后端扫描附带：同 hwmon 温度通道元数据 JSON 数组字符串，如 [{"id":"coretemp/0000:00:04.0/temp1","key":"temp1","label":"Package id 0","path":"/sys/.../temp1_input"}] */
    sensors?: string;
}

export interface FanConfig {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
    chip: string;
    device: string;
    pwm_index: number
    mode: "manual" | "curve";
    source: string;
    manual_pwm: number;
    curve: CurvePoint[];
    /** 非空则覆盖全局：最小 PWM 调整死区（0–255） */
    pwm_deadzone?: number;
    /** 非空则覆盖全局：停转滞回温差（°C） */
    stop_hysteresis?: number;
    /** 非空则覆盖全局：过热全速阈值（°C） */
    emergency_temp?: number;
    /** 主温度源无读数时：keep_last | stop | min_pwm | full_speed | follow_other */
    fallback_policy?: string;
    fallback_min_pwm?: number;
    fallback_follow_source?: string;
}

export interface GlobalConfig {
    cpu_sensor?: string;
    gpu_sensor?: string;
    pwm_deadzone: number;
    update_interval_ms: number;
    emergency_temp: number;
    stop_behavior: "keep" | "set";
    stop_pwm: number;
    stop_hysteresis: number;
    log_level: string;
    source_mode?: "simple" | "advanced";
    sensor_aliases?: Record<string, string>;
    sensor_hidden?: string[];
    history_range?: HistoryRange;
    history_sensors?: string[] | null;
    history_fans?: string[] | null;
    history_from?: string;
    history_to?: string;
    theme_mode?: "system" | "light" | "dark";
}

export interface SensorReading {
    id: string;
    chip: string;
    device?: string;
    key: string;
    label: string;
    temp?: number;
}

export interface ConfigPayload {
    version?: number;
    fans: FanConfig[];
    global: GlobalConfig;
}

export interface DiskInfo {
    name: string;
    serial?: string;
    temp?: number;
    status: "active" | "sleep";
}

export interface FanRuntime {
    id: string;
    name: string;
    pwm: number;
    rpm: number;
    status: "normal" | "stopped";
    source: string;
    mode: "manual" | "curve";
    target_pwm: number;
}

export interface HistoryPoint {
    time: string;
    value?: number;
}

export interface HistorySeries {
    cpu_temp: HistoryPoint[];
    gpu_temp: HistoryPoint[];
    disk_avg: HistoryPoint[];
    sensors?: Record<string, HistoryPoint[]>;
    fans_pwm?: Record<string, HistoryPoint[]>;
    fans_rpm?: Record<string, HistoryPoint[]>;
    /** 每风扇温度源聚合温度曲线（与 fans_pwm 同键） */
    fans_temp?: Record<string, HistoryPoint[]>;
}

export type HistoryRange = "1h" | "6h" | "24h" | "7d" | "custom";

/** GET /api/system/storage 历史数据库只读概览（仅主库文件大小） */
export interface StorageStats {
    available: boolean;
    path: string;
    size_bytes: number;
    updated_at: string;
}

export interface UpdateCheckResult {
    current: string;
    latest?: string;
    has_update: boolean;
    url?: string;
    notes?: string;
    checked_at: string;
    check_ok: boolean;
    error?: string;
}

export interface Telemetry {
    cpu_temp?: number;
    cpu_usage: number;
    mem_usage: number;
    mem_total?: number;  // 内存总量（GB）
    gpu_temp?: number;
    gpu_usage?: number;
    cpu_sensor_label?: string;
    gpu_sensor_label?: string;
    disks: {
        avg_temp?: number;
        details: DiskInfo[];
    };
    fans: FanRuntime[];
    sensors: SensorReading[];
    timestamp: string;
    uptime?: number;  // 系统运行时间（秒）
}
