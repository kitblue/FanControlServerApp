package driver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"fancontrolserver/internal/model"
)

var (
	reTempWithParen = regexp.MustCompile(`\s+([0-9]{1,3})\s*\(`)
	reTempEndOfLine = regexp.MustCompile(`([0-9]{1,3})\s*$`)
	reTempColon     = regexp.MustCompile(`:\s+([0-9]{1,3})`)
	reSATASerial    = regexp.MustCompile(`(?i)serial number:\s+(\S+)`)
)

type SmartCtlDriver struct {
	serialMu    sync.RWMutex
	serialCache map[string]string
}

func NewSmartCtlDriver() *SmartCtlDriver {
	return &SmartCtlDriver{
		serialCache: map[string]string{},
	}
}

func (d *SmartCtlDriver) ScanDisks() ([]string, error) {
	var names []string
	entries, err := os.ReadDir("/sys/block")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		switch {
		case strings.HasPrefix(name, "loop"), strings.HasPrefix(name, "ram"), strings.HasPrefix(name, "dm-"), strings.HasPrefix(name, "sr"), strings.HasPrefix(name, "md"):
			continue
		default:
			// 过滤虚拟设备和 raid 设备
			if _, err = os.Stat(filepath.Join("/dev", name)); err == nil {
				// 检查是否是物理硬盘 (sd*, nvme*, vd*)
				if strings.HasPrefix(name, "sd") || strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "vd") {
					names = append(names, name)
				}
			}
		}
	}
	sort.Strings(names)
	return names, nil
}

func (d *SmartCtlDriver) ReadDisk(name string) model.DiskInfo {
	serial := d.getSerial(name)
	isNVMe := strings.HasPrefix(name, "nvme")
	device := "/dev/" + name

	// 先检查是否休眠（sysfs 直读，不唤醒硬盘；读不到才 fallback hdparm）
	isSleep := d.checkStandby(name, device)
	if isSleep {
		return model.DiskInfo{Name: name, Serial: serial, Status: model.DiskStatusSleep}
	}

	// 只有非休眠状态才读取温度（sysfs hwmon 直读优先，无进程创建开销）
	var temp *float64
	if isNVMe {
		temp = d.readNVMeTemp(name, device)
	} else {
		temp, serial = d.readSATAInfo(name, device, serial)
		if serial != "" {
			d.cacheSerial(name, serial)
		}
	}

	if temp == nil {
		return model.DiskInfo{Name: name, Serial: serial, Status: model.DiskStatusActive}
	}
	return model.DiskInfo{Name: name, Serial: serial, Temp: temp, Status: model.DiskStatusActive}
}

// getSerial 从 sysfs 读取序列号并缓存；不访问磁盘，不影响休眠状态。
func (d *SmartCtlDriver) getSerial(name string) string {
	d.serialMu.RLock()
	if s, ok := d.serialCache[name]; ok {
		d.serialMu.RUnlock()
		return s
	}
	d.serialMu.RUnlock()

	s := readSerialFromSysfs(name)
	d.serialMu.Lock()
	d.serialCache[name] = s
	d.serialMu.Unlock()
	return s
}

func (d *SmartCtlDriver) cacheSerial(name, serial string) {
	if serial == "" {
		return
	}
	d.serialMu.Lock()
	if d.serialCache[name] == "" {
		d.serialCache[name] = serial
	}
	d.serialMu.Unlock()
}

func readSerialFromSysfs(blockName string) string {
	paths := serialSysfsPaths(blockName)
	for _, p := range paths {
		if s := readTrimmedFile(p); s != "" {
			return s
		}
	}
	return readSerialFromDiskByID(blockName)
}

func serialSysfsPaths(blockName string) []string {
	paths := []string{
		filepath.Join("/sys/block", blockName, "device", "serial"),
		filepath.Join("/sys/block", blockName, "device", "device", "serial"),
	}
	deviceDir := filepath.Join("/sys/block", blockName, "device")
	if globs, _ := filepath.Glob(filepath.Join(deviceDir, "scsi_disk", "*", "device", "serial")); len(globs) > 0 {
		paths = append(paths, globs...)
	}
	if globs, _ := filepath.Glob(filepath.Join(deviceDir, "ata_device", "dev*", "id_serial")); len(globs) > 0 {
		paths = append(paths, globs...)
	}
	if strings.HasPrefix(blockName, "nvme") {
		rest := blockName[len("nvme"):]
		if i := strings.IndexByte(rest, 'n'); i > 0 {
			ctrl := "nvme" + rest[:i]
			paths = append(paths, filepath.Join("/sys/class/nvme", ctrl, "serial"))
		}
	}
	return paths
}

func readTrimmedFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// readSerialFromDiskByID 通过 /dev/disk/by-id 软链匹配块设备，不访问磁盘。
func readSerialFromDiskByID(blockName string) string {
	blockDev, err := filepath.EvalSymlinks(filepath.Join("/dev", blockName))
	if err != nil {
		blockDev = filepath.Join("/dev", blockName)
	}
	entries, err := os.ReadDir("/dev/disk/by-id")
	if err != nil {
		return ""
	}

	var fallback string
	for _, entry := range entries {
		name := entry.Name()
		if strings.Contains(name, "-part") || strings.HasPrefix(name, "wwn-") || strings.HasPrefix(name, "dm-") {
			continue
		}
		link := filepath.Join("/dev/disk/by-id", name)
		target, err := filepath.EvalSymlinks(link)
		if err != nil || target != blockDev {
			continue
		}
		serial := parseSerialFromDiskID(name)
		if serial == "" {
			continue
		}
		if strings.HasPrefix(name, "ata-") || strings.HasPrefix(name, "nvme-") {
			return serial
		}
		if fallback == "" {
			fallback = serial
		}
	}
	return fallback
}

func parseSerialFromDiskID(idName string) string {
	switch {
	case strings.HasPrefix(idName, "nvme-"):
		if strings.HasPrefix(idName, "nvme-eui.") || strings.HasPrefix(idName, "nvme-uuid.") {
			return ""
		}
		body := strings.TrimPrefix(idName, "nvme-")
		if idx := strings.LastIndex(body, "_"); idx >= 0 && idx < len(body)-1 {
			return body[idx+1:]
		}
	case strings.HasPrefix(idName, "ata-"):
		body := strings.TrimPrefix(idName, "ata-")
		if idx := strings.LastIndex(body, "_"); idx >= 0 && idx < len(body)-1 {
			return body[idx+1:]
		}
	case strings.HasPrefix(idName, "usb-"):
		body := strings.TrimPrefix(idName, "usb-")
		if idx := strings.LastIndex(body, "_"); idx >= 0 && idx < len(body)-1 {
			candidate := body[idx+1:]
			if dash := strings.Index(candidate, "-"); dash > 0 {
				candidate = candidate[:dash]
			}
			return candidate
		}
	}
	return ""
}

// checkStandby 优先从 sysfs 直读电源状态（/sys/block/<dev>/device/state），
// 不创建外部进程、不唤醒硬盘；sysfs 无该节点时 fallback 到 hdparm -C。
// state 取值为 running / standby / sleeping 等（SCSI/SATA）。
func (d *SmartCtlDriver) checkStandby(name, dev string) bool {
	if s := readTrimmedFile(filepath.Join("/sys/block", name, "device", "state")); s != "" {
		low := strings.ToLower(s)
		return strings.Contains(low, "standby") || strings.Contains(low, "sleep")
	}
	// fallback：hdparm -C，输出 standby 表示休眠，active/idle 表示活动
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "hdparm", "-C", dev)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "standby")
}

// readSATAInfo 优先 sysfs hwmon 直读 SATA/SAS 盘温（零进程开销），
// 失败时 fallback 到 smartctl -a（保留序列号兜底解析）。
func (d *SmartCtlDriver) readSATAInfo(name, dev, knownSerial string) (*float64, string) {
	if temp := readDiskTempFromSysfs(name); temp != nil {
		return temp, knownSerial
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "smartctl", "-a", dev)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil, knownSerial
	}
	serial := knownSerial
	if serial == "" {
		serial = parseSATASerial(out)
	}
	return parseSATATemperature(out), serial
}

// readNVMeTemp 优先 sysfs hwmon 直读 NVMe 盘温（零进程开销），
// 失败时 fallback 到 smartctl -a。
func (d *SmartCtlDriver) readNVMeTemp(name, dev string) *float64 {
	if temp := readDiskTempFromSysfs(name); temp != nil {
		return temp
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "smartctl", "-a", dev)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil
	}
	return parseNVMeTemperature(out)
}

func parseSATASerial(out []byte) string {
	fields := reSATASerial.FindSubmatch(out)
	if len(fields) == 2 {
		return strings.TrimSpace(string(fields[1]))
	}
	return ""
}

// readDiskTempFromSysfs 从 /sys/block/<name>/device/hwmon*/temp1_input 读取盘温。
// NVMe 与部分 SATA 控制器内核都会导出 hwmon 温度节点；值单位毫摄氏度。
// 返回 nil 表示内核未导出该节点（调用方再走 smartctl fallback）。
func readDiskTempFromSysfs(blockName string) *float64 {
	hwmonDirs := []string{
		filepath.Join("/sys/block", blockName, "device", "hwmon"),
	}
	// NVMe 控制器层级：/sys/class/nvme/nvme0/hwmon*
	if strings.HasPrefix(blockName, "nvme") {
		rest := blockName[len("nvme"):]
		if i := strings.IndexByte(rest, 'n'); i > 0 {
			ctrl := "nvme" + rest[:i]
			hwmonDirs = append(hwmonDirs, filepath.Join("/sys/class/nvme", ctrl, "hwmon"))
		}
	}
	for _, dir := range hwmonDirs {
		subs, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, sub := range subs {
			if !strings.HasPrefix(sub.Name(), "hwmon") {
				continue
			}
			tempPath := filepath.Join(dir, sub.Name(), "temp1_input")
			data, err := os.ReadFile(tempPath)
			if err != nil {
				continue
			}
			milli, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil || milli <= 0 {
				continue
			}
			v := float64(milli) / 1000.0
			if v > 0 && v < 150 {
				return &v
			}
		}
	}
	return nil
}

// parseSATATemperature 从 smartctl -a 输出中提取 SATA/SAS 磁盘温度。
func parseSATATemperature(out []byte) *float64 {
	text := strings.ToLower(string(out))
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, "temperature") || strings.Contains(line, "airflow_temperature") {
			fields := reTempWithParen.FindStringSubmatch(line)
			if len(fields) == 2 {
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil && v > 0 && v < 150 {
					return &v
				}
			}
			fields = reTempEndOfLine.FindStringSubmatch(line)
			if len(fields) == 2 {
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil && v > 0 && v < 150 {
					return &v
				}
			}
		}
	}
	return nil
}

// parseNVMeTemperature 从 smartctl -a 输出中提取 NVMe 磁盘温度。
func parseNVMeTemperature(out []byte) *float64 {
	text := strings.ToLower(string(out))
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, "temperature") {
			fields := reTempColon.FindStringSubmatch(line)
			if len(fields) == 2 {
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil && v > 0 && v < 150 {
					return &v
				}
			}
		}
	}
	return nil
}
