//go:build !linux

package driver

// GPUDriver 非 Linux 平台编译占位实现：GPU 探测依赖 Linux sysfs / NVML / i915 PMU，
// 在 Windows 等平台仅提供空实现以保证包可编译（Linux 产物使用真实实现 gpu.go）。
type GPUDriver struct{}

func NewGPUDriver() *GPUDriver { return &GPUDriver{} }

func (d *GPUDriver) Temp() (*float64, error) { return nil, nil }

func (d *GPUDriver) Usage() (*float64, error) { return nil, nil }

func (d *GPUDriver) UsageForChannel(chip, device string) (*float64, error) { return nil, nil }
