package driver

import (
	"errors"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"

	"fancontrolserver/internal/thermal"
)

// SystemDriver 通过 gopsutil 采集 CPU/内存信息；CPU 温度走 thermal 包（sysfs hwmon）。
type SystemDriver struct{}

func NewSystemDriver() *SystemDriver {
	return &SystemDriver{}
}

// CPUUsage 返回整体 CPU 使用率（%），基于 gopsutil 跨平台实现，替代手写 /proc/stat 解析。
func (d *SystemDriver) CPUUsage() (float64, error) {
	percents, err := cpu.Percent(0, false)
	if err != nil {
		return 0, err
	}
	if len(percents) == 0 {
		return 0, errors.New("无 CPU 采样数据")
	}
	return percents[0], nil
}

// MemInfo 返回内存使用率（%）与总量（GB），替代手写 /proc/meminfo 解析。
func (d *SystemDriver) MemInfo() (usage float64, totalGB *float64, err error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return 0, nil, err
	}
	gb := float64(vm.Total) / 1024 / 1024 / 1024
	return vm.UsedPercent, &gb, nil
}

// CPUTemp 委托 thermal 包读取 hwmon CPU 温度（sysfs 解析逻辑已集中）。
func (d *SystemDriver) CPUTemp() (*float64, error) {
	return thermal.CPUTempFromSysfs()
}
