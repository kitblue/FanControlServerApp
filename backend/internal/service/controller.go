package service

import (
	"strconv"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/driver"
	"fancontrolserver/internal/metrics"
	"fancontrolserver/internal/model"
	"fancontrolserver/internal/service/config"
	"fancontrolserver/internal/service/fanctl"
	"fancontrolserver/internal/service/telemetry"
)

// Controller 温控服务编排核心：持有配置存储、遥测采集器、滞回跟踪器与 WebSocket 订阅。
// 职责边界：
//   - 采集：委托 telemetry.Collector（纯采集，无状态编辑）；
//   - 计算：委托 fanctl（纯函数 + HysteresisTracker）；
//   - 配置：config_api.go（SaveConfig/SetFan*/RemoveFan 等）；
//   - 本文件仅保留：生命周期、主循环、共享状态快照与订阅分发。
type Controller struct {
	store     *config.Store
	history   *HistoryStore
	hwmon     *driver.HWMONDriver
	collector *telemetry.Collector
	tracker   *fanctl.HysteresisTracker

	mu        sync.RWMutex
	telemetry model.Telemetry
	lastPWM   map[string]int
	subs      map[chan model.Telemetry]struct{}
	stopCh    chan struct{}
	stopped   bool
	loopDone  chan struct{}
	startTime time.Time
}

// NewController 创建控制器：绑定配置存储、历史存储与各硬件驱动。
func NewController(store *config.Store, history *HistoryStore) *Controller {
	hwmon := driver.NewHWMONDriver()
	return &Controller{
		store:     store,
		history:   history,
		hwmon:     hwmon,
		collector: telemetry.NewCollector(hwmon, driver.NewSystemDriver(), driver.NewSmartCtlDriver(), driver.NewGPUDriver()),
		tracker:   fanctl.NewHysteresisTracker(),
		lastPWM:   map[string]int{},
		subs:      map[chan model.Telemetry]struct{}{},
		stopCh:    make(chan struct{}),
		loopDone:  make(chan struct{}),
		startTime: time.Now(),
	}
}

// Start 启动控制循环。
func (c *Controller) Start() error {
	c.rebindFanPaths()
	c.autoDiscoverFansOnFirstRun()
	go c.loop()
	return nil
}

// Stop 停止控制循环，恢复风扇退出行为并关闭历史存储。
func (c *Controller) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	close(c.stopCh)
	c.mu.Unlock()

	<-c.loopDone
	c.applyStopBehavior()
	if c.history != nil {
		if err := c.history.Close(); err != nil {
			logrus.Warnf("[控制器] 保存温度历史失败：%v", err)
		}
	}
}

// Telemetry 返回当前遥测快照（零值兜底为空数组，避免前端收到 null）。
func (c *Controller) Telemetry() model.Telemetry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	t := c.telemetry
	if t.Fans == nil {
		t.Fans = []model.FanRuntime{}
	}
	if t.Sensors == nil {
		t.Sensors = []model.SensorReading{}
	}
	if t.Disks.Details == nil {
		t.Disks.Details = []model.DiskInfo{}
	}
	return t
}

// Subscribe 订阅遥测推送通道。
func (c *Controller) Subscribe() chan model.Telemetry {
	ch := make(chan model.Telemetry, 4)
	c.mu.Lock()
	c.subs[ch] = struct{}{}
	c.mu.Unlock()
	return ch
}

// Unsubscribe 取消订阅并关闭通道。
func (c *Controller) Unsubscribe(ch chan model.Telemetry) {
	c.mu.Lock()
	delete(c.subs, ch)
	close(ch)
	c.mu.Unlock()
}

// QueryHistory 查询温度历史。
func (c *Controller) QueryHistory(rangeParam, fromParam, toParam string) (model.HistorySeries, error) {
	if c.history == nil {
		return model.HistorySeries{Sensors: map[string][]model.HistoryPoint{}}, nil
	}
	q, err := ParseHistoryQuery(rangeParam, fromParam, toParam, time.Now())
	if err != nil {
		return model.HistorySeries{}, err
	}
	return c.history.Query(q), nil
}

// loop 主循环：按配置周期全量采集、落库并广播。
// 采集与落库不依赖 UI 是否有查看者，关闭窗口期间历史曲线连续，重开窗口即恢复完整展示。
func (c *Controller) loop() {
	defer close(c.loopDone)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
		case <-c.stopCh:
			return
		}

		cfg := c.store.Get()
		collectStart := time.Now()
		t := c.collectFullTelemetry(cfg)
		if c.history != nil {
			dbStart := time.Now()
			c.history.RecordSnapshot(t)
			metrics.ObserveDBWrite(time.Since(dbStart))
		}
		metrics.ObserveCollect(t, time.Since(collectStart))
		c.mu.Lock()
		c.telemetry = t
		for sub := range c.subs {
			select {
			case sub <- t:
			default:
			}
		}
		c.mu.Unlock()

		wait := time.Duration(cfg.Global.UpdateIntervalMS) * time.Millisecond
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
	}
}

// collectFullTelemetry 采集遥测并执行风扇闭环，返回完整快照。
func (c *Controller) collectFullTelemetry(cfg model.Config) model.Telemetry {
	t := c.collector.Collect(cfg, c.startTime)
	c.maybeMigrateDiskSources(t.Disks)
	cfg = c.store.Get()
	t.Fans = c.computeFans(cfg, cfg.Global, t.CPUTemp, t.GPUTemp, t.Disks, t.Sensors)
	return t
}

// computeFans 执行所有风扇的闭环控制，返回运行时状态。
func (c *Controller) computeFans(cfg model.Config, global model.GlobalConfig, cpuTemp, gpuTemp *float64, disks model.DiskPayload, sensors []model.SensorReading) []model.FanRuntime {
	fans := make([]model.FanRuntime, 0, len(cfg.Fans))
	for _, fan := range cfg.Fans {
		target, resolvedTemp := fanctl.CalculateTargetPWM(c.tracker, fan, global, cpuTemp, gpuTemp, disks, sensors)
		var applied int
		if target < 0 {
			// 温度源不可用且策略为 keep_last：保持上次 PWM 不动
			if v, ok := c.lastPWM[fan.ID]; ok {
				applied = v
			}
		} else {
			applied = c.applyPWM(fan, target, fanctl.EffectivePWMDeadzone(fan, global))
		}
		var rpm int
		if fan.RPMPath != "" {
			if value, err := c.hwmon.ReadRPM(fan.RPMPath); err == nil {
				rpm = value
			}
		}
		status := fanctl.EvaluateFanStatus(rpm)
		fans = append(fans, model.FanRuntime{
			ID:        fan.ID,
			Name:      fan.Name,
			PWM:       applied,
			RPM:       rpm,
			Status:    status,
			Source:    fan.Source,
			Mode:      fan.Mode,
			TargetPWM: target,
			Temp:      resolvedTemp,
		})
	}
	return fans
}

// applyPWM 计算并写入风扇 PWM。deadzone 为阈值死区（差值小于阈值不写）。
func (c *Controller) applyPWM(fan model.FanConfig, target int, deadzone int) int {
	target = fanctl.ClampPWM(target)

	// 获取真实当前 PWM（从缓存或硬件读取，加锁避免与 RemoveFan 竞态）
	c.mu.Lock()
	current, ok := c.lastPWM[fan.ID]
	c.mu.Unlock()
	if !ok {
		if val, err := c.hwmon.ReadPWM(fan.PWMPath); err == nil {
			current = val
		} else {
			current = 0 // 读取失败时保守设为0
		}
		c.mu.Lock()
		c.lastPWM[fan.ID] = current
		c.mu.Unlock()
	}

	if deadzone < 0 {
		deadzone = 0
	}
	if abs(current-target) < deadzone {
		return current
	}

	if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, target); err != nil {
		logrus.Warnf("[PWM] 风扇 %s 写入失败: %v", fan.ID, err)
		return current
	}

	c.mu.Lock()
	c.lastPWM[fan.ID] = target
	c.mu.Unlock()
	logrus.Infof("[PWM] 风扇 %s: PWM %d(%d%%) → %d(%d%%)", fan.Name, current, current*100/255, target, target*100/255)
	return target
}

// applyStopBehavior 停止时按全局退出行为设置风扇。
func (c *Controller) applyStopBehavior() {
	cfg := c.store.Get()
	if cfg.Global.StopBehavior != model.StopBehaviorSet {
		logrus.Info("[控制器] 退出行为：保持当前 PWM")
		return
	}
	targetPWM := fanctl.ClampPWM(cfg.Global.StopPWM)
	logrus.Infof("[控制器] 退出行为：将所有风扇设为 PWM=%d", targetPWM)
	for _, fan := range cfg.Fans {
		if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, targetPWM); err != nil {
			logrus.Warnf("[控制器] 退出写入 PWM 失败，风扇 %s（%s）：%v", fan.Name, fan.ID, err)
		} else {
			logrus.Infof("[控制器] 退出写入成功，风扇 %s → PWM=%d", fan.Name, targetPWM)
		}
	}
}

// rebindFanPaths 启动时用当前 hwmon 扫描结果重绑定风扇路径。
func (c *Controller) rebindFanPaths() {
	cfg := c.store.Get()
	scanned, err := c.hwmon.ScanFans()
	if err != nil || len(scanned) == 0 {
		return
	}
	idx := make(map[string]map[string]string, len(scanned))
	for _, s := range scanned {
		key := s["chip"] + "|" + s["device"] + "|" + s["pwm_index"]
		idx[key] = s
	}
	changed := false
	for i := range cfg.Fans {
		f := &cfg.Fans[i]
		if f.Chip == "" || f.PWMIndex <= 0 {
			logrus.Warnf("[路径重绑定] 风扇 %s 缺少 chip/pwm_index，请删除后重新扫描添加", f.ID)
		}
		key := f.Chip + "|" + f.Device + "|" + strconv.Itoa(f.PWMIndex)
		if cur, ok := idx[key]; ok {
			if f.PWMPath != cur["pwm_path"] || f.RPMPath != cur["rpm_path"] || f.EnablePath != cur["enable_path"] {
				logrus.Infof("[路径重绑定] %s: %s -> %s", f.ID, f.PWMPath, cur["pwm_path"])
				f.PWMPath, f.RPMPath, f.EnablePath = cur["pwm_path"], cur["rpm_path"], cur["enable_path"]
				changed = true
			}
		} else {
			logrus.Warnf("[路径重绑定] 风扇 %s 在当前hwmon 中未找到对应芯片，保留旧路径", f.ID)
		}
	}
	if changed {
		_ = c.store.Save(cfg)
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
