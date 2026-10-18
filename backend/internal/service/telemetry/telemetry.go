// Package telemetry 负责系统遥测采集：hwmon 传感器、CPU/内存/磁盘/GPU 温度与使用率。
// 采集结果与硬件无关地交给上层（Controller）做风扇闭环与对外发布。
package telemetry

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
	"golang.org/x/sync/singleflight"

	"fancontrolserver/internal/driver"
	"fancontrolserver/internal/model"
)

// Collector 聚合各硬件探测驱动，提供一次完整遥测采集。
// sensorChans 缓存由自身锁保护，采集入口用 singleflight 合并并发请求。
type Collector struct {
	hwmon    *driver.HWMONDriver
	system   *driver.SystemDriver
	smartctl *driver.SmartCtlDriver
	gpu      *driver.GPUDriver

	mu             sync.Mutex
	sensorChans    []driver.TempChannel
	lastSensorScan time.Time

	sf singleflight.Group
}

// NewCollector 创建遥测采集器。
func NewCollector(hwmon *driver.HWMONDriver, system *driver.SystemDriver, smartctl *driver.SmartCtlDriver, gpu *driver.GPUDriver) *Collector {
	return &Collector{
		hwmon:    hwmon,
		system:   system,
		smartctl: smartctl,
		gpu:      gpu,
	}
}

// Collect 执行一次完整遥测采集。并发调用同一 key 时由 singleflight 合并，
// 内部以 context.WithTimeout 兜底慢驱动，避免采集循环被阻塞。
func (c *Collector) Collect(cfg model.Config, startTime time.Time) model.Telemetry {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	v, _, _ := c.sf.Do("full-collect", func() (any, error) {
		return c.collect(ctx, cfg, startTime), nil
	})
	return v.(model.Telemetry)
}

// collect 实际采集实现（singleflight 保护，同一时刻只执行一次）。
func (c *Collector) collect(ctx context.Context, cfg model.Config, startTime time.Time) model.Telemetry {
	now := time.Now()
	// 先采集传感器列表，避免 readCPUTemp/readGPUTemp 重复调用 readSensors
	sensors := c.ReadSensors()
	cpuTemp := c.readCPUTemp(ctx, cfg.Global)
	cpuUsage, _ := c.system.CPUUsage()
	memUsage, memTotal, _ := c.system.MemInfo()
	gpuTemp := c.readGPUTemp(ctx, cfg.Global)
	gpuUsage, _ := c.gpu.Usage()
	logrus.Debugf("[温度] CPU=%.1f°C GPU=%.1f°C", ptrOrNil(cpuTemp), ptrOrNil(gpuTemp))

	disks := c.readDisks()

	return model.Telemetry{
		CPUTemp:        cpuTemp,
		CPUUsage:       round(cpuUsage),
		MemUsage:       round(memUsage),
		MemTotal:       memTotal,
		GPUTemp:        gpuTemp,
		GPUUsage:       gpuUsage,
		CPUSensorLabel: ResolveSensorLabel(cfg.Global.CPUSensor, sensors, "CPU"),
		GPUSensorLabel: ResolveSensorLabel(cfg.Global.GPUSensor, sensors, "GPU"),
		Uptime:         int64(now.Sub(startTime).Seconds()),
		Disks:          disks,
		Sensors:        sensors,
		Timestamp:      now,
	}
}

// ReadSensors 读取所有 hwmon 温度通道。通道列表每分钟刷新一次，避免每秒 Glob。
func (c *Collector) ReadSensors() []model.SensorReading {
	chans := c.ensureSensorChans()
	out := make([]model.SensorReading, 0, len(chans))
	for _, ch := range chans {
		v, _ := c.hwmon.ReadTemp(ch.Path)
		out = append(out, model.SensorReading{
			ID:     ch.ID,
			Chip:   ch.Chip,
			Device: ch.Device,
			Key:    ch.Key,
			Label:  ch.Label,
			Temp:   v,
		})
	}
	return out
}

// ensureSensorChans 确保 hwmon 通道列表已扫描（每分钟刷新一次），加锁返回当前缓存。
func (c *Collector) ensureSensorChans() []driver.TempChannel {
	c.mu.Lock()
	if time.Since(c.lastSensorScan) > time.Minute || c.sensorChans == nil {
		if chans, err := c.hwmon.ScanTempChannels(); err == nil {
			c.sensorChans = chans
			c.lastSensorScan = time.Now()
		} else {
			logrus.Debugf("[传感器] 扫描温度通道失败：%v", err)
		}
	}
	chans := c.sensorChans
	c.mu.Unlock()
	return chans
}

// readCPUTemp 读取 CPU 温度：优先使用自定义传感器，否则使用默认逻辑。
func (c *Collector) readCPUTemp(ctx context.Context, global model.GlobalConfig) *float64 {
	if global.CPUSensor != "" {
		chans := c.ensureSensorChans()
		for _, ch := range chans {
			if ch.ID == global.CPUSensor {
				temp, err := c.hwmon.ReadTemp(ch.Path)
				if err == nil {
					logrus.Debugf("[温度] 使用自定义 CPU 传感器 %s: %.1f°C", global.CPUSensor, *temp)
					return temp
				}
				logrus.Warnf("[温度] 读取自定义 CPU 传感器 %s 失败: %v", global.CPUSensor, err)
				break
			}
		}
		logrus.Warnf("[温度] 未找到自定义 CPU 传感器 %s 的路径，回退到默认方式", global.CPUSensor)
	}
	temp, _ := c.system.CPUTemp()
	return temp
}

// readGPUTemp 读取 GPU 温度：优先使用自定义传感器，否则使用默认逻辑。
func (c *Collector) readGPUTemp(ctx context.Context, global model.GlobalConfig) *float64 {
	if global.GPUSensor != "" {
		chans := c.ensureSensorChans()
		for _, ch := range chans {
			if ch.ID == global.GPUSensor {
				temp, err := c.hwmon.ReadTemp(ch.Path)
				if err == nil {
					logrus.Debugf("[温度] 使用自定义 GPU 传感器 %s: %.1f°C", global.GPUSensor, *temp)
					return temp
				}
				logrus.Warnf("[温度] 读取自定义 GPU 传感器 %s 失败: %v", global.GPUSensor, err)
				break
			}
		}
		logrus.Warnf("[温度] 未找到自定义 GPU 传感器 %s 的路径，回退到默认方式", global.GPUSensor)
	}
	temp, _ := c.gpu.Temp()
	return temp
}

// readDisks 扫描磁盘并计算平均温度。
func (c *Collector) readDisks() model.DiskPayload {
	names, err := c.smartctl.ScanDisks()
	if err != nil {
		logrus.Debugf("[磁盘] 扫描磁盘失败: %v", err)
		return model.DiskPayload{}
	}
	details := make([]model.DiskInfo, 0, len(names))
	var sum float64
	var count int
	for _, name := range names {
		info := c.smartctl.ReadDisk(name)
		details = append(details, info)
		if info.Status == model.DiskStatusActive && info.Temp != nil {
			sum += *info.Temp
			count++
		}
	}
	var avg *float64
	if count > 0 {
		v := round(sum / float64(count))
		avg = &v
		logrus.Debugf("[磁盘] 发现%d个活跃磁盘，平均温度%.1f°C", count, *avg)
	}
	return model.DiskPayload{AvgTemp: avg, Details: details}
}

// ResolveSensorLabel 生成温度来源的显示标签。
func ResolveSensorLabel(sensorID string, sensors []model.SensorReading, fallback string) string {
	if sensorID == "" {
		return fallback
	}
	for _, s := range sensors {
		if s.ID == sensorID {
			label := s.Label
			if label == "" {
				label = s.Key
			}
			if s.Device != "" {
				return fmt.Sprintf("%s\u00b7%s", s.Device, label)
			}
			return label
		}
	}
	return fallback
}

func round(v float64) float64 {
	return math.Round(v*10) / 10
}

func ptrOrNil(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}
