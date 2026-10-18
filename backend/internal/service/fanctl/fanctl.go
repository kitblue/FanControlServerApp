// Package fanctl 提供温控闭环的纯计算逻辑：
// 温度源解析、曲线插值、紧急温度、滞回停转与降级策略。
// 不直接访问硬件或配置存储，便于单元测试与复用。
package fanctl

import (
	"math"
	"strings"
	"sync"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/model"
)

// HysteresisTracker 维护各风扇滞回停转的「最后有效 PWM」记忆。
type HysteresisTracker struct {
	mu           sync.Mutex
	lastValidPWM map[string]int
}

// NewHysteresisTracker 创建滞回跟踪器。
func NewHysteresisTracker() *HysteresisTracker {
	return &HysteresisTracker{lastValidPWM: map[string]int{}}
}

// ApplyStopHysteresis 滞回停转逻辑：
// interpolateCurve 在温度 < 首点时输出 0。本函数在 [首点−滞回, 首点) 内维持「曾在首点以上」时的最后有效 PWM，
// 直到温度 < 首点−滞回 才真正停转并清除记忆。温度 ≥ 首点时完全按曲线 basePWM 运行。
func (t *HysteresisTracker) ApplyStopHysteresis(fanID string, curve []model.CurvePoint, temp float64, basePWM int, hysteresis float64) int {
	if len(curve) == 0 || hysteresis <= 0 {
		return basePWM
	}

	firstTemp := curve[0].Temp
	stopThreshold := firstTemp - hysteresis

	// 1. 低于停转阈值（首点 − 滞回）：停转并清除滞回记忆，避免低温回升误用旧 PWM
	if temp < stopThreshold {
		t.mu.Lock()
		delete(t.lastValidPWM, fanID)
		t.mu.Unlock()
		logrus.Debugf("[滞回] 温度%.1f°C < 停转阈值%.1f°C（首点%.1f°C − 滞回%.1f°C），停转并清除记忆", temp, stopThreshold, firstTemp, hysteresis)
		return 0
	}

	// 2. [停转阈值, 首点)：曲线 basePWM 为 0；若曾在首点以上运行过则维持 lastValid，否则跟随曲线（通常为停）
	if temp < firstTemp {
		t.mu.Lock()
		lastValid, has := t.lastValidPWM[fanID]
		t.mu.Unlock()
		if has && lastValid > 0 {
			logrus.Debugf("[滞回] 温度%.1f°C ∈ [%.1f, %.1f)℃，维持最后有效PWM=%d", temp, stopThreshold, firstTemp, lastValid)
			return lastValid
		}
		logrus.Debugf("[滞回] 温度%.1f°C ∈ [%.1f, %.1f)℃ 无滞回历史，曲线PWM=%d", temp, stopThreshold, firstTemp, basePWM)
		return basePWM
	}

	// 3. 温度 ≥ 首点：按曲线；有转速则记入供降温滞回，曲线为 0 则清记忆以免脏数据
	t.mu.Lock()
	if basePWM > 0 {
		t.lastValidPWM[fanID] = basePWM
	} else {
		delete(t.lastValidPWM, fanID)
	}
	t.mu.Unlock()
	return basePWM
}

// ForgetFan 清除指定风扇的滞回记忆（风扇被移除时调用）。
func (t *HysteresisTracker) ForgetFan(fanID string) {
	t.mu.Lock()
	delete(t.lastValidPWM, fanID)
	t.mu.Unlock()
}

// CalculateTargetPWM 计算风扇目标 PWM。
// 手动模式直接返回 ManualPWM；曲线模式解析温度源后计算。
// 返回 target（-1 表示温度源不可用且策略为 keep_last）与来源温度（nil 表示无有效读数）。
func CalculateTargetPWM(t *HysteresisTracker, fan model.FanConfig, global model.GlobalConfig,
	cpuTemp, gpuTemp *float64, disks model.DiskPayload, sensors []model.SensorReading) (int, *float64) {
	if fan.Mode == model.FanModeManual {
		logrus.Debugf("[控制器] 风扇 %s 手动模式 PWM=%d", fan.Name, fan.ManualPWM)
		return ClampPWM(fan.ManualPWM), nil
	}

	temp := ResolveSourceTemp(fan.Source, cpuTemp, gpuTemp, disks, sensors)
	if temp == nil {
		return targetWhenSourceUnavailable(t, fan, global, cpuTemp, gpuTemp, disks, sensors)
	}
	return curvePWMFromResolvedTemp(t, fan, global, temp)
}

// EffectiveFallbackPolicy 返回风扇实际生效的降级策略。
func EffectiveFallbackPolicy(fan model.FanConfig) string {
	switch strings.TrimSpace(fan.FallbackPolicy) {
	case model.FallbackStop, model.FallbackMinPWM, model.FallbackFullSpeed, model.FallbackFollowOther:
		return strings.TrimSpace(fan.FallbackPolicy)
	default:
		return model.FallbackKeepLast
	}
}

// curvePWMFromResolvedTemp 在已有有效温度读数时，按紧急阈值、曲线与滞回计算 PWM。
func curvePWMFromResolvedTemp(t *HysteresisTracker, fan model.FanConfig, global model.GlobalConfig, temp *float64) (int, *float64) {
	emergency := EffectiveEmergencyTemp(fan, global)
	if *temp >= emergency {
		logrus.Warnf("[控制器] 风扇 %s 温度%.1f°C ≥ 紧急温度%.1f°C，全速!", fan.Name, *temp, emergency)
		return 255, temp
	}
	basePWM := InterpolateCurve(fan.Curve, *temp)
	hys := EffectiveStopHysteresis(fan, global)
	pwm := t.ApplyStopHysteresis(fan.ID, fan.Curve, *temp, basePWM, hys)
	logrus.Debugf("[控制器] 风扇 %s | 温度=%.1f°C | 曲线PWM=%d | 最终PWM=%d", fan.Name, *temp, basePWM, pwm)
	return ClampPWM(pwm), temp
}

// targetWhenSourceUnavailable 主温度源不可用时的降级目标计算。
func targetWhenSourceUnavailable(t *HysteresisTracker, fan model.FanConfig, global model.GlobalConfig,
	cpuTemp, gpuTemp *float64, disks model.DiskPayload, sensors []model.SensorReading) (int, *float64) {
	policy := EffectiveFallbackPolicy(fan)
	logrus.Debugf("[控制器] 风扇 %s 主温度源不可用(源=%s)，降级策略=%s", fan.Name, fan.Source, policy)

	switch policy {
	case model.FallbackKeepLast:
		return -1, nil
	case model.FallbackStop:
		logrus.Debugf("[控制器] 风扇 %s 降级=停转 PWM=0", fan.Name)
		return 0, nil
	case model.FallbackMinPWM:
		v := ClampPWM(fan.FallbackMinPWM)
		if v <= 0 {
			v = 80
		}
		logrus.Debugf("[控制器] 风扇 %s 降级=最低安全 PWM=%d", fan.Name, v)
		return v, nil
	case model.FallbackFullSpeed:
		logrus.Debugf("[控制器] 风扇 %s 降级=全速", fan.Name)
		return 255, nil
	case model.FallbackFollowOther:
		src := strings.TrimSpace(fan.FallbackFollowSource)
		if src == "" || src == fan.Source {
			logrus.Debugf("[控制器] 风扇 %s follow_other 后备源无效，保持上次 PWM", fan.Name)
			return -1, nil
		}
		t2 := ResolveSourceTemp(src, cpuTemp, gpuTemp, disks, sensors)
		if t2 == nil {
			logrus.Debugf("[控制器] 风扇 %s follow_other 后备源仍无温度，保持上次 PWM", fan.Name)
			return -1, nil
		}
		logrus.Debugf("[控制器] 风扇 %s follow_other → 后备源 %s", fan.Name, src)
		return curvePWMFromResolvedTemp(t, fan, global, t2)
	default:
		return -1, nil
	}
}

// ResolveSourceTemp 解析温度源：cpu / gpu / disk_avg / disk_max / max /
// disk:<key> / sensor:<id> / combo_avg:<list> / combo_max:<list>。
func ResolveSourceTemp(source string, cpuTemp, gpuTemp *float64,
	disks model.DiskPayload, sensors []model.SensorReading) *float64 {
	switch {
	case source == "cpu":
		return cpuTemp
	case source == "gpu":
		return gpuTemp
	case source == "disk_avg":
		return disks.AvgTemp
	case source == "disk_max":
		var best *float64
		for _, disk := range disks.Details {
			if disk.Temp != nil && (best == nil || *disk.Temp > *best) {
				v := *disk.Temp
				best = &v
			}
		}
		return best
	case source == "max":
		var best *float64
		consider := func(v *float64) {
			if v != nil && (best == nil || *v > *best) {
				cp := *v
				best = &cp
			}
		}
		consider(cpuTemp)
		consider(gpuTemp)
		consider(disks.AvgTemp)
		for _, disk := range disks.Details {
			consider(disk.Temp)
		}
		for _, s := range sensors {
			consider(s.Temp)
		}
		return best
	case strings.HasPrefix(source, "disk:"):
		key := source[len("disk:"):]
		for _, disk := range disks.Details {
			if !DiskMatchesKey(disk, key) {
				continue
			}
			if disk.Status == model.DiskStatusActive && disk.Temp != nil {
				v := *disk.Temp
				return &v
			}
		}
	case strings.HasPrefix(source, "sensor:"):
		id := source[len("sensor:"):]
		for _, s := range sensors {
			if s.ID == id && s.Temp != nil {
				v := *s.Temp
				return &v
			}
		}
	case strings.HasPrefix(source, "combo_avg:"):
		keys := strings.Split(source[len("combo_avg:"):], ",")
		var sum float64
		var count int
		for _, k := range keys {
			if t := ResolveSourceTemp(strings.TrimSpace(k), cpuTemp, gpuTemp, disks, sensors); t != nil {
				sum += *t
				count++
			}
		}
		if count == 0 {
			return nil
		}
		v := sum / float64(count)
		return &v
	case strings.HasPrefix(source, "combo_max:"):
		keys := strings.Split(source[len("combo_max:"):], ",")
		var best *float64
		for _, k := range keys {
			if t := ResolveSourceTemp(strings.TrimSpace(k), cpuTemp, gpuTemp, disks, sensors); t != nil {
				if best == nil || *t > *best {
					v := *t
					best = &v
				}
			}
		}
		return best
	}
	return nil
}

// InterpolateCurve 线性插值计算曲线 PWM。温度 < 首点时输出 0，≥ 末点时输出末点 PWM。
func InterpolateCurve(points []model.CurvePoint, temp float64) int {
	if len(points) == 0 {
		return 0
	}
	if temp < points[0].Temp {
		logrus.Debugf("[曲线] 温度%.1f°C < 首点%.1f°C，停转", temp, points[0].Temp)
		return 0
	}
	for i := 1; i < len(points); i++ {
		if temp <= points[i].Temp {
			prev := points[i-1]
			next := points[i]
			if next.Temp == prev.Temp {
				return prev.PWM
			}
			ratio := (temp - prev.Temp) / (next.Temp - prev.Temp)
			result := int(math.Round(float64(prev.PWM) + ratio*float64(next.PWM-prev.PWM)))
			logrus.Debugf("[曲线] %.1f°C → [%d%%, %d%%] 插值 → PWM=%d", temp, prev.PWM, next.PWM, result)
			return result
		}
	}
	result := points[len(points)-1].PWM
	return result
}

// EvaluateFanStatus 根据转速判断风扇运行状态。
func EvaluateFanStatus(rpm int) model.FanStatus {
	if rpm == 0 {
		return model.FanStatusStopped
	}
	return model.FanStatusNormal
}

// EffectivePWMDeadzone 返回风扇生效的 PWM 死区。
func EffectivePWMDeadzone(fan model.FanConfig, global model.GlobalConfig) int {
	if fan.PWMDeadzone != nil {
		return ClampPWM(*fan.PWMDeadzone)
	}
	return ClampPWM(global.PWMDeadzone)
}

// EffectiveStopHysteresis 返回风扇生效的停转滞回温差。
func EffectiveStopHysteresis(fan model.FanConfig, global model.GlobalConfig) float64 {
	if fan.StopHysteresis != nil {
		return *fan.StopHysteresis
	}
	return global.StopHysteresis
}

// EffectiveEmergencyTemp 返回风扇生效的紧急温度。
func EffectiveEmergencyTemp(fan model.FanConfig, global model.GlobalConfig) float64 {
	if fan.EmergencyTemp != nil && *fan.EmergencyTemp > 0 {
		return *fan.EmergencyTemp
	}
	return global.EmergencyTemp
}

// ClampPWM 将 PWM 限制在 0-255。
func ClampPWM(v int) int {
	return maxInt(0, minInt(255, v))
}

// DiskMatchesKey 匹配磁盘：优先序列号，其次设备名（兼容旧配置 disk:sda）。
func DiskMatchesKey(disk model.DiskInfo, key string) bool {
	key = strings.TrimSpace(key)
	if key == "" {
		return false
	}
	if serial := strings.TrimSpace(disk.Serial); serial != "" && serial == key {
		return true
	}
	return disk.Name == key
}

// RemapDiskRefInSource 将 source 中的 disk:设备名 改为 disk:序列号（combo 内子项一并处理）。
func RemapDiskRefInSource(source string, nameToSerial map[string]string) (string, bool) {
	source = strings.TrimSpace(source)
	if source == "" || len(nameToSerial) == 0 {
		return source, false
	}
	if strings.HasPrefix(source, "disk:") {
		name := source[len("disk:"):]
		if serial, ok := nameToSerial[name]; ok && serial != "" && serial != name {
			return "disk:" + serial, true
		}
		return source, false
	}
	for _, prefix := range []string{"combo_avg:", "combo_max:"} {
		if !strings.HasPrefix(source, prefix) {
			continue
		}
		parts := strings.Split(source[len(prefix):], ",")
		changed := false
		for i, p := range parts {
			p = strings.TrimSpace(p)
			n, ok := RemapDiskRefInSource(p, nameToSerial)
			if ok {
				parts[i] = n
				changed = true
			} else {
				parts[i] = p
			}
		}
		if !changed {
			return source, false
		}
		return prefix + strings.Join(parts, ","), true
	}
	return source, false
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
