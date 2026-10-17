package driver

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/sirupsen/logrus"
)

// GPUDriver 提供 GPU 温度与使用率探测。
// intel 相关字段用于 intel_gpu_top 后台监视：intel_gpu_top 是持续流式进程，
// 每次启动需运行数秒才能产出数据，若在采集循环里同步调用会阻塞整个推送链路，
// 因此改为常驻后台按固定周期刷新缓存，Usage 读取缓存即时返回。
type GPUDriver struct {
	mu           sync.Mutex
	intelStop    chan struct{}
	intelVal     *float64
	intelValAt   time.Time
	intelLastErr error
	intelRunning bool
}

func NewGPUDriver() *GPUDriver {
	return &GPUDriver{}
}

// Temp 返回 GPU 温度（°C）。
// 探测顺序：1) nvidia-smi（NVIDIA 独显）；2) hwmon 独显芯片（amdgpu/radeon/arc 等）；3) hwmon 核显芯片（i915/xe）；4) 通用 gpu/drm 标签兜底。
// 优先识别独显，没有独显时默认使用核显；均不可用时返回 nil。
func (d *GPUDriver) Temp() (*float64, error) {
	// 1. NVIDIA 独显
	if t, err := d.tempFromNvidiaSMI(); err == nil && t != nil {
		return t, nil
	}
	// 2. 独显芯片（AMD/NVIDIA/Intel Arc 开源驱动）
	if t, err := d.tempFromHwmon(dGPUKeywords); err == nil && t != nil {
		return t, nil
	}
	// 3. 核显芯片（Intel i915/xe）
	if t, err := d.tempFromHwmon(iGPUKeywords); err == nil && t != nil {
		return t, nil
	}
	// 4. 通用 GPU 标签兜底（gpu/drm，覆盖未列出的专业卡与特殊型号）
	if t, err := d.tempFromHwmon(genericGPUKeywords); err == nil && t != nil {
		return t, nil
	}
	return nil, nil
}

// Usage 返回 GPU 使用率（0-100%）。
// 探测顺序：1) nvidia-smi（NVIDIA 独显，支持多卡，取所有卡 utilization.gpu 的最大值）；
//           2) sysfs gpu_busy_percent（由 amdgpu/xe 内核驱动直接暴露，覆盖 AMD 独显、Intel Arc 独显与部分核显）；
//           3) i915 PMU 直读（Intel 旧核显 i915 驱动首选，perf_event_open 读引擎 busy 计数，与 resmon/intel_gpu_top 同源且零阻塞）；
//           4) intel_gpu_top（PMU 不可用时兜底，解析工具输出）；
// 均不可用时返回 nil，并在日志记录各步失败原因便于诊断。
func (d *GPUDriver) Usage() (*float64, error) {
	// 1. NVIDIA 独显（多卡取最大值）
	if v, err := d.usageFromNvidiaSMI(); err == nil && v != nil {
		return v, nil
	} else if err != nil {
		logrus.Debugf("[GPU] nvidia-smi 不可用: %v", err)
	}
	// 2. sysfs gpu_busy_percent（AMD 独显 / Intel Arc / 支持的内核核显）
	if v, err := d.usageFromSysfs(); err == nil && v != nil {
		return v, nil
	} else if err != nil {
		logrus.Debugf("[GPU] sysfs gpu_busy_percent 不可用: %v", err)
	}
	// 3. Intel 后台监视缓存（i915 PMU 直读优先，失败降级 intel_gpu_top）
	if v, err := d.intelUsageWithMonitor(); err == nil && v != nil {
		return v, nil
	} else if err != nil {
		logrus.Debugf("[GPU] Intel 后台监视不可用: %v", err)
	}
	return nil, nil
}

// UsageForChannel 按用户手动指定的 hwmon 传感器通道（chip/device）选择使用率探测路径，
// 使 GPU 使用率与 GPU 温度共用同一传感器选择逻辑：
//   - NVIDIA（nvidia/nouveau）：nvidia-smi；
//   - AMD（amdgpu/radeon）：sysfs gpu_busy_percent，并按 device（PCI 地址）精确匹配该卡；
//   - Intel（i915/xe）：sysfs gpu_busy_percent 按 device 匹配，无节点时走 intel_gpu_top 后台监视缓存；
//   - 其它芯片：回退到默认探测链 Usage()。
func (d *GPUDriver) UsageForChannel(chip, device string) (*float64, error) {
	lc := strings.ToLower(chip)
	switch {
	case strings.Contains(lc, "nvidia") || strings.Contains(lc, "nouveau"):
		return d.usageFromNvidiaSMI()
	case strings.Contains(lc, "amdgpu") || strings.Contains(lc, "radeon"):
		if v, err := d.usageFromSysfsForDevice(device); err == nil && v != nil {
			return v, nil
		}
		return d.usageFromSysfs()
	case strings.Contains(lc, "i915") || strings.Contains(lc, "xe"):
		if v, err := d.usageFromSysfsForDevice(device); err == nil && v != nil {
			return v, nil
		}
		return d.intelUsageWithMonitor()
	default:
		return d.Usage()
	}
}

// StopIntelMonitor 停止 intel_gpu_top 后台监视循环（服务退出时调用）。
func (d *GPUDriver) StopIntelMonitor() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.intelStop != nil {
		close(d.intelStop)
		d.intelStop = nil
	}
}

// intelUsageWithMonitor 返回缓存的 Intel 后台监视使用率；首次调用会启动后台监视。
// 若首个采样尚未完成，则同步等待一帧（PMU 直读约 1 秒，intel_gpu_top 约 4 秒），此后读取缓存即时返回。
func (d *GPUDriver) intelUsageWithMonitor() (*float64, error) {
	d.ensureIntelMonitor()
	d.mu.Lock()
	if d.intelVal != nil {
		v := d.intelVal
		err := d.intelLastErr
		d.mu.Unlock()
		return v, err
	}
	if d.intelRunning {
		v := d.intelVal
		err := d.intelLastErr
		d.mu.Unlock()
		return v, err
	}
	d.intelRunning = true
	d.mu.Unlock()

	v, err := d.usageFromPMU()
	if err != nil || v == nil {
		v, err = d.usageFromIntelGPUTop()
	}

	d.mu.Lock()
	d.intelVal = v
	d.intelValAt = time.Now()
	d.intelLastErr = err
	d.intelRunning = false
	d.mu.Unlock()
	return v, err
}

// ensureIntelMonitor 惰性启动 Intel 后台监视循环（每 4 秒刷新一次缓存）。
func (d *GPUDriver) ensureIntelMonitor() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.intelStop != nil {
		return
	}
	d.intelStop = make(chan struct{})
	go d.intelLoop(d.intelStop)
}

// intelLoop 后台循环：每 4 秒执行一次 GPU 采样并刷新缓存，避免采集循环阻塞。
// 采样优先 i915 PMU 直读（1 秒窗口），PMU 不可用时降级 intel_gpu_top。
func (d *GPUDriver) intelLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			v, err := d.usageFromPMU()
			if err != nil || v == nil {
				v, err = d.usageFromIntelGPUTop()
			}
			d.mu.Lock()
			d.intelVal = v
			d.intelValAt = time.Now()
			d.intelLastErr = err
			d.mu.Unlock()
			if err != nil {
				logrus.Debugf("[GPU] Intel 后台采样失败: %v", err)
			}
		}
	}
}

// ---- i915 PMU 直读 ----
// perf_event_open 直读 i915 PMU 引擎 busy 事件，差分计数计算 GPU 使用率。
// 数据源与 fnOS resmon_service / intel_gpu_top 同源（i915 PMU），精度一致但：
// 不依赖 intel-gpu-tools 包、无外部进程、无 3-5 秒阻塞（1 秒采样窗口后台刷新）。
// 实测：fnOS 定制内核 6.18（i915 无 sysfs gpu_busy_percent）type=12，空闲 count=0，
// ffmpeg vaapi 转码下 rcs0/vcs0 busy 27%/29% 增长，数据有效。

// sysPerfEventOpen 为 linux/amd64 下 perf_event_open 的系统调用号。
const sysPerfEventOpen = 298

// perfEventAttr 与内核 include/uapi/linux/perf_event.h 布局一致（112 字节）。
// 必须按内核实际布局定义，手写紧凑结构（如 176 字节）会导致内核解析错位返回 EINVAL。
type perfEventAttr struct {
	Type             uint32 // 事件源 type，i915 来自 /sys/bus/event_source/devices/i915/type
	Size             uint32 // 结构体大小，必须等于内核布局 sizeof
	Config           uint64 // 引擎事件 config：rcs0-busy=0x0、vcs0-busy=0x2000、bcs0-busy=0x1000
	SamplePeriod     uint64
	SampleType       uint64
	ReadFormat       uint64 // PERF_FORMAT_TOTAL_TIME_ENABLED|TOTAL_TIME_RUNNING=0x03
	Flags            uint64
	WakeupEvents     uint32
	BpType           uint32
	Config1          uint64
	Config2          uint64
	BranchSampleType uint64
	SampleRegsUser   uint64
	SampleStackUser  uint32
	Clockid          int32
	SampleRegsIntr   uint64
	AuxWatermark     uint32
	SampleMaxStack   uint16
	Reserved2        uint16
}

// perfCount 为 read_format=0x03 时单事件读取结果：count, enabled, running。
type perfCount struct {
	count   uint64
	enabled uint64
	running uint64
}

// openPerfEvent 打开一个 PMU 事件（pid=-1 当前进程，cpu=0，创建即启用）。
func openPerfEvent(pmuType uint32, config uint64) (int, error) {
	attr := perfEventAttr{
		Type:       pmuType,
		Size:       uint32(unsafe.Sizeof(perfEventAttr{})),
		Config:     config,
		ReadFormat: 0x03, // TOTAL_TIME_ENABLED | TOTAL_TIME_RUNNING
		Clockid:    -1,
	}
	// perf_event_open(attr, pid=-1, cpu=0, group_fd=-1, flags=0)
	r1, _, errno := syscall.Syscall6(sysPerfEventOpen,
		uintptr(unsafe.Pointer(&attr)),
		^uintptr(0), // pid=-1
		0,           // cpu=0
		^uintptr(0), // group_fd=-1
		0, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(r1), nil
}

// readPerfCount 读取事件的 count/enabled/running 三元组。
// read_format=0x03 时内核按 count(enabled(running) 顺序写入 24 字节，小端。
func readPerfCount(fd int) perfCount {
	var buf [24]byte
	if _, err := syscall.Read(fd, buf[:]); err != nil {
		return perfCount{}
	}
	return perfCount{
		count:   binary.LittleEndian.Uint64(buf[0:8]),
		enabled: binary.LittleEndian.Uint64(buf[8:16]),
		running: binary.LittleEndian.Uint64(buf[16:24]),
	}
}

// usageFromPMU 通过 perf_event_open 直读 i915 PMU 引擎 busy 计数计算 GPU 使用率（0-100%）。
// 打开 rcs0/vcs0/bcs0 引擎事件，1 秒采样窗口后差分，busy% = Δcount/Δenabled×100，取引擎最大值。
// 返回 nil 表示当前环境不支持（非 i915、无 PMU 事件源或权限不足），上层应降级 intel_gpu_top。
func (d *GPUDriver) usageFromPMU() (*float64, error) {
	// 1. 读取 i915 PMU 事件源 type（不能硬编码，不同内核可能不同）
	data, err := os.ReadFile("/sys/bus/event_source/devices/i915/type")
	if err != nil {
		return nil, fmt.Errorf("i915 PMU 事件源不存在: %v", err)
	}
	pmuType, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
	if err != nil {
		return nil, fmt.Errorf("读取 i915 PMU type 失败: %v", err)
	}
	// 2. 打开引擎 busy 事件（渲染/视频/BitBlit，覆盖转码场景主要负载）
	engines := []struct {
		name   string
		config uint64
	}{
		{"rcs0-busy", 0x0},
		{"vcs0-busy", 0x2000},
		{"bcs0-busy", 0x1000},
	}
	var fds []int
	for _, e := range engines {
		fd, err := openPerfEvent(uint32(pmuType), e.config)
		if err != nil {
			continue
		}
		fds = append(fds, fd)
	}
	if len(fds) == 0 {
		return nil, fmt.Errorf("无法打开 i915 PMU 引擎事件（可能权限不足，需要 root/CAP_PERFMON）")
	}
	defer func() {
		for _, fd := range fds {
			syscall.Close(fd)
		}
	}()
	// 3. 基线读数
	base := make([]perfCount, len(fds))
	for i, fd := range fds {
		base[i] = readPerfCount(fd)
	}
	time.Sleep(1 * time.Second)
	// 4. 差分计算 busy%
	maxBusy := 0.0
	found := false
	for i, fd := range fds {
		cur := readPerfCount(fd)
		dc := cur.count - base[i].count
		de := cur.enabled - base[i].enabled
		if de == 0 {
			continue
		}
		busy := float64(dc) / float64(de) * 100.0
		if !found || busy > maxBusy {
			maxBusy = busy
			found = true
		}
	}
	if !found {
		return nil, nil
	}
	if maxBusy < 0 {
		maxBusy = 0
	}
	if maxBusy > 100 {
		maxBusy = 100
	}
	return &maxBusy, nil
}

// usageFromIntelGPUTop 通过 intel-gpu-tools 的 intel_gpu_top -J 解析 Intel GPU 使用率。
// 覆盖 i915 旧驱动（无 gpu_busy_percent sysfs 节点）的 Intel 核显与 Arc 独显。
// 取输出 JSON 中所有引擎 busy 字段的最大值（单位 %）。
func (d *GPUDriver) usageFromIntelGPUTop() (*float64, error) {
	// intel_gpu_top 是持续流式输出工具（非交互 stdout 下不会自行退出），
	// 必须限定运行时长：优先用 timeout 命令（timeout 到期以 124 退出属于预期行为，
	// 不能因非零退出码丢弃已产生的输出——旧实现因此导致 i915 核显永远探测失败）；
	// 精简环境无 timeout 命令时退化为 CommandContext 超时杀进程，同样保留已输出内容。
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if _, err := exec.LookPath("timeout"); err == nil {
		cmd = exec.CommandContext(ctx, "timeout", "-s", "TERM", "4", "intel_gpu_top", "-J")
	} else {
		cmd = exec.CommandContext(ctx, "intel_gpu_top", "-J")
	}
	out, _ := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("intel_gpu_top 运行超时")
	}
	text := strings.TrimSpace(string(out))
	if text == "" {
		return nil, fmt.Errorf("intel_gpu_top 无输出（请确认已安装 intel-gpu-tools 包）")
	}
	// 形如 {"period":{...},"engines":{"Render/3D":{"busy":12.5,...},...}}，
	// busy 为各引擎使用率 %；取最大值（NAS 视频转码时 Video 引擎负载才是真实 GPU 占用）
	m := regexp.MustCompile(`"busy"\s*:\s*([\d.]+)`).FindAllStringSubmatch(text, -1)
	maxVal := 0.0
	found := false
	for _, mm := range m {
		v, err := strconv.ParseFloat(mm[1], 64)
		if err != nil {
			continue
		}
		if v < 0 || v > 100 {
			continue
		}
		if !found || v > maxVal {
			maxVal = v
			found = true
		}
	}
	if !found {
		return nil, nil
	}
	return &maxVal, nil
}

// usageFromNvidiaSMI 通过 nvidia-smi 读取所有 NVIDIA GPU 的利用率，取最大值。
// 多卡环境返回负载最高的一张卡的 utilization.gpu。
func (d *GPUDriver) usageFromNvidiaSMI() (*float64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var maxVal float64
	found := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		value, err := strconv.ParseFloat(line, 64)
		if err != nil {
			continue
		}
		if !found || value > maxVal {
			maxVal = value
			found = true
		}
	}
	if !found {
		return nil, nil
	}
	return &maxVal, nil
}

// usageFromSysfs 通过 sysfs 的 gpu_busy_percent 文件读取 GPU 利用率（0-100%）。
// 该文件由 amdgpu/i915/xe 内核驱动直接暴露，可覆盖 AMD 独显、Intel i915/xe 核显与 Arc 独显。
// 用 filepath.Glob 遍历 /sys/class/drm/card*/device/gpu_busy_percent，取第一个可读有效值。
func (d *GPUDriver) usageFromSysfs() (*float64, error) {
	matches, err := filepath.Glob("/sys/class/drm/card*/device/gpu_busy_percent")
	if err != nil {
		return nil, err
	}
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
		if err != nil {
			continue
		}
		return &value, nil
	}
	return nil, nil
}

// usageFromSysfsForDevice 从 sysfs gpu_busy_percent 中读取指定 PCI 设备（如 0000:00:02.0）的利用率，
// 用于多卡/多 GPU 环境按用户选择的传感器精确对应。device 为空或匹配不到时返回 nil。
func (d *GPUDriver) usageFromSysfsForDevice(device string) (*float64, error) {
	if device == "" {
		return nil, nil
	}
	matches, err := filepath.Glob("/sys/class/drm/card*/device/gpu_busy_percent")
	if err != nil {
		return nil, err
	}
	for _, path := range matches {
		cardDev := filepath.Dir(path) // /sys/class/drm/cardN/device
		if link, lerr := os.Readlink(cardDev); lerr == nil && filepath.Base(link) == device {
			data, rerr := os.ReadFile(path)
			if rerr != nil {
				continue
			}
			value, perr := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
			if perr != nil {
				continue
			}
			return &value, nil
		}
	}
	return nil, nil
}

// tempFromNvidiaSMI 通过 nvidia-smi 读取 NVIDIA GPU 温度。
func (d *GPUDriver) tempFromNvidiaSMI() (*float64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return nil, nil
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(lines[0]), 64)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// gpuHwmonKeywords 识别 GPU 驱动的 hwmon 芯片关键字。
// 独显：NVIDIA（nvidia/nouveau，含 Quadro/RTX 专业卡）、AMD（amdgpu/radeon，含 Radeon Pro/FirePro 专业卡）、
// Intel 独显 Arc（arc/dg1/dg2，Arc Pro 专业卡同）。
// 核显：Intel i915/xe（UHD/Iris 核显；部分 Arc 独显亦暴露 i915/xe，作为兜底仍可识别）。
var (
	dGPUKeywords = []string{"nvidia", "nouveau", "amdgpu", "radeon", "arc", "dg1", "dg2"}
	iGPUKeywords = []string{"i915", "xe"}
	// genericGPUKeywords 通用 GPU 标签兜底：独显/核显关键词均未命中时，
	// 匹配含 gpu/drm/gpu_core 等标签的 hwmon 节点（覆盖未列出的专业卡与特殊型号）。
	genericGPUKeywords = []string{"gpu", "drm", "gpu_core"}
)

// tempFromHwmon 扫描 hwmon 温度通道，按给定关键词识别 GPU 相关芯片并读取第一个有效温度。
// 通道列表缓存 60 秒，避免每轮采集重复 Glob 扫描。
func (d *GPUDriver) tempFromHwmon(keywords []string) (*float64, error) {
	hw := NewHWMONDriver()
	d.mu.Lock()
	if time.Since(d.hwmonScannedAt) > time.Minute || d.hwmonChans == nil {
		if chans, err := hw.ScanTempChannels(); err == nil {
			d.hwmonChans = chans
			d.hwmonScannedAt = time.Now()
		} else {
			d.mu.Unlock()
			return nil, err
		}
	}
	chans := d.hwmonChans
	d.mu.Unlock()
	for _, ch := range chans {
		if !isGPUChannel(ch.Chip, ch.Label, ch.Device, keywords) {
			continue
		}
		if t, err := hw.ReadTemp(ch.Path); err == nil {
			return t, nil
		}
	}
	return nil, nil
}

// isGPUChannel 判断 hwmon 温度通道是否属于 GPU 芯片（按 chip/label/device 文本匹配）。
func isGPUChannel(chip, label, device string, keywords []string) bool {
	hay := strings.ToLower(strings.Join([]string{chip, label, device}, " "))
	for _, k := range keywords {
		if strings.Contains(hay, k) {
			return true
		}
	}
	return false
}
