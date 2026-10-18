package service

import (
	"errors"
	"fmt"
	"strings"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/model"
	"fancontrolserver/internal/service/fanctl"
)

var ErrFanNotFound = errors.New("风扇未找到")

// SaveConfig 保存完整配置：校验风扇 ID 非空、移除未引用风扇的滞回记忆，保存后重绑定路径。
func (c *Controller) SaveConfig(cfg model.Config) error {
	for _, fan := range cfg.Fans {
		if strings.TrimSpace(fan.ID) == "" {
			return errors.New("风扇 ID 不能为空")
		}
	}
	if err := c.store.Save(cfg); err != nil {
		return err
	}
	c.rebindFanPaths()
	// 清除已不存在风扇的滞回记忆
	for _, fan := range c.store.Get().Fans {
		c.tracker.ForgetFan(fan.ID)
	}
	return nil
}

// SetFanManualPWM 设置指定风扇手动 PWM 并切换为手动模式。
func (c *Controller) SetFanManualPWM(id string, pwm int) error {
	cfg := c.store.Get()
	found := false
	for i := range cfg.Fans {
		if cfg.Fans[i].ID != id {
			continue
		}
		if pwm < 0 || pwm > 255 {
			return fmt.Errorf("PWM 必须在 0-255 之间")
		}
		cfg.Fans[i].ManualPWM = pwm
		cfg.Fans[i].Mode = model.FanModeManual
		found = true
		break
	}
	if !found {
		return ErrFanNotFound
	}
	return c.store.Save(cfg)
}

// SetFanMode 切换风扇模式（curve/manual）。
func (c *Controller) SetFanMode(id string, mode model.FanMode) error {
	if mode != model.FanModeCurve && mode != model.FanModeManual {
		return fmt.Errorf("无效的风扇模式：%s", mode)
	}
	cfg := c.store.Get()
	found := false
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Mode = mode
			found = true
			break
		}
	}
	if !found {
		return ErrFanNotFound
	}
	return c.store.Save(cfg)
}

// SetFanCurve 设置指定风扇的调速曲线。
func (c *Controller) SetFanCurve(id string, curve []model.CurvePoint) error {
	if len(curve) == 0 {
		return errors.New("曲线至少需要一个点")
	}
	for _, p := range curve {
		if p.Temp <= 0 || p.Temp > 150 {
			return errors.New("曲线温度必须在 0-150 之间")
		}
		if p.PWM < 0 || p.PWM > 255 {
			return errors.New("曲线 PWM 必须在 0-255 之间")
		}
	}
	cfg := c.store.Get()
	found := false
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Curve = curve
			found = true
			break
		}
	}
	if !found {
		return ErrFanNotFound
	}
	return c.store.Save(cfg)
}

// RemoveFan 删除风扇：同时清空其他风扇对该风扇的 follow_other 引用与滞回记忆。
func (c *Controller) RemoveFan(id string) error {
	cfg := c.store.Get()
	idx := -1
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrFanNotFound
	}
	fanName := cfg.Fans[idx].Name
	cfg.Fans = append(cfg.Fans[:idx], cfg.Fans[idx+1:]...)
	// 清理其他风扇对此风扇的 follow_other 引用
	for i := range cfg.Fans {
		if cfg.Fans[i].FallbackPolicy == model.FallbackFollowOther && cfg.Fans[i].FallbackFollowSource == id {
			cfg.Fans[i].FallbackFollowSource = ""
			logrus.Warnf("[配置] 风扇 %s 的降级跟随目标已被删除，已清空引用", cfg.Fans[i].Name)
		}
	}
	c.tracker.ForgetFan(id)
	if err := c.store.Save(cfg); err != nil {
		return err
	}
	logrus.Infof("[配置] 已移除风扇：%s（%s）", fanName, id)
	return nil
}

// ScanFans 扫描系统风扇并返回未加入配置的候选（不自动写入配置）。
func (c *Controller) ScanFans() ([]map[string]string, error) {
	scanned, err := c.hwmon.ScanFans()
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for _, fan := range c.store.Get().Fans {
		if fan.Chip != "" && fan.PWMIndex > 0 {
			existing[fan.Chip+"|"+fan.Device+"|"+fmt.Sprint(fan.PWMIndex)] = true
		}
	}
	out := make([]map[string]string, 0, len(scanned))
	for _, s := range scanned {
		key := s["chip"] + "|" + s["device"] + "|" + s["pwm_index"]
		if existing[key] {
			continue
		}
		out = append(out, s)
	}
	return out, nil
}

// autoDiscoverFansOnFirstRun 首次运行时自动扫描并加入风扇。
func (c *Controller) autoDiscoverFansOnFirstRun() {
	if !c.store.IsFirstRun() {
		return
	}
	cfg := c.store.Get()
	if len(cfg.Fans) > 0 {
		return
	}
	fans, err := c.hwmon.ScanFans()
	if err != nil || len(fans) == 0 {
		logrus.Warn("[首跑] 未发现可自动添加的风扇，可在页面手动扫描添加")
		return
	}
	for _, f := range fans {
		cfg.Fans = append(cfg.Fans, model.FanConfig{
			ID:             f["chip"] + "/" + f["device"] + "/pwm" + f["pwm_index"],
			Name:           f["name"],
			Chip:           f["chip"],
			Device:         f["device"],
			PWMIndex:       mustAtoi(f["pwm_index"]),
			PWMPath:        f["pwm_path"],
			RPMPath:        f["rpm_path"],
			EnablePath:     f["enable_path"],
			Mode:           model.FanModeCurve,
			Source:         "cpu",
			ManualPWM:      0,
			Curve:          []model.CurvePoint{{Temp: 50, PWM: 100}, {Temp: 70, PWM: 255}},
			FallbackPolicy: model.FallbackKeepLast,
		})
	}
	if err = c.store.Save(cfg); err != nil {
		logrus.Warnf("[首跑] 保存自动发现风扇失败：%v", err)
		return
	}
	logrus.Infof("[首跑] 已自动添加 %d 个风扇", len(fans))
}

// maybeMigrateDiskSources 将磁盘温度源从设备名迁移到序列号（兼容旧配置 disk:sda）。
func (c *Controller) maybeMigrateDiskSources(disks model.DiskPayload) {
	nameToSerial := map[string]string{}
	for _, d := range disks.Details {
		if d.Serial != "" && d.Name != "" && d.Serial != d.Name {
			nameToSerial[d.Name] = d.Serial
		}
	}
	if len(nameToSerial) == 0 {
		return
	}
	cfg := c.store.Get()
	changed := false
	for i := range cfg.Fans {
		if newSrc, ok := fanctl.RemapDiskRefInSource(cfg.Fans[i].Source, nameToSerial); ok {
			logrus.Infof("[磁盘迁移] 风扇 %s 温度源 %s → %s", cfg.Fans[i].Name, cfg.Fans[i].Source, newSrc)
			cfg.Fans[i].Source = newSrc
			changed = true
		}
	}
	if changed {
		_ = c.store.Save(cfg)
	}
}

func mustAtoi(s string) int {
	n := 0
	if s == "" {
		return 0
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0
		}
		n = n*10 + int(ch-'0')
	}
	return n
}
