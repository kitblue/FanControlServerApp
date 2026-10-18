// Package thermal 封装 Linux sysfs 温度读取逻辑（hwmon / thermal_zone），
// 所有路径白名单校验与温度解析集中于此，并通过 hwmonRoot 支持 fixture 单测。
package thermal

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// hwmonRoot 与 zoneRoot 为 sysfs 根路径变量，单测时替换为临时 fixture 目录；
// sysRoot 为 sysfs 挂载根（生产为空，测试时指向临时目录，fixture 结构为 <sysRoot>/sys/class/hwmon/...）。
var (
	hwmonRoot = "/sys/class/hwmon"
	zoneRoot  = "/sys/class/thermal"
	sysRoot   = ""
)

// ValidatePath 检查路径是否在允许的 sysfs 目录下，防止任意文件读写。
func ValidatePath(path string) error {
	if path == "" {
		return nil
	}
	cleaned := filepath.Clean(path)
	if strings.Contains(cleaned, "..") {
		return fmt.Errorf("路径不允许包含 '..'：%s", path)
	}
	norm := strings.ReplaceAll(cleaned, "\\", "/")
	sysPrefix := strings.ReplaceAll(sysRoot, "\\", "/")
	for _, prefix := range []string{sysPrefix + "/sys/class/hwmon/", sysPrefix + "/sys/devices/"} {
		if strings.HasPrefix(norm, prefix) {
			return nil
		}
	}
	return fmt.Errorf("路径不在允许范围内（需位于 /sys/class/hwmon/ 或 /sys/devices/ 下）：%s", path)
}

// TempChannel 描述一个 hwmon 温度通道的元数据。
type TempChannel struct {
	ID     string
	Chip   string
	Device string
	Key    string
	Label  string
	Path   string
}

// ScanTempChannels 通用扫描所有 hwmon 温度通道。
// 不做任何品牌识别，原样输出 chip / device / label，分类与展示完全交给上层。
func ScanTempChannels() ([]TempChannel, error) {
	entries, err := filepath.Glob(filepath.Join(hwmonRoot, "hwmon*/temp*_input"))
	if err != nil {
		return nil, err
	}
	out := make([]TempChannel, 0, len(entries))
	for _, p := range entries {
		dir := filepath.Dir(p)
		key := strings.TrimSuffix(filepath.Base(p), "_input")
		chip := readTrimmed(filepath.Join(dir, "name"), filepath.Base(dir))

		device := ""
		if link, err := os.Readlink(filepath.Join(dir, "device")); err == nil {
			device = filepath.Base(link)
		}

		label := readTrimmed(filepath.Join(dir, key+"_label"), "")

		out = append(out, TempChannel{
			ID:     chip + "/" + device + "/" + key,
			Chip:   chip,
			Device: device,
			Key:    key,
			Label:  label,
			Path:   p,
		})
	}
	return out, nil
}

// ReadTemp 读取单个温度通道（mC → °C），过滤明显异常值。
func ReadTemp(path string) (*float64, error) {
	if err := ValidatePath(path); err != nil {
		return nil, err
	}
	raw, err := readIntFile(path)
	if err != nil {
		return nil, err
	}
	t := float64(raw) / 1000.0
	if t < -10 || t > 130 {
		return nil, fmt.Errorf("温度异常：%.1f°C", t)
	}
	return &t, nil
}

// CPUTempFromSysfs 从 hwmon CPU 驱动（coretemp/k10temp/zenpower）读取 CPU 包温度，
// 兜底读取 thermal_zone0。返回最高温（Package/Tctl 代表整颗 CPU 的最高温状态）。
func CPUTempFromSysfs() (*float64, error) {
	dirs, err := filepath.Glob(filepath.Join(hwmonRoot, "hwmon*"))
	if err != nil {
		return nil, err
	}

	var best *float64
	for _, dir := range dirs {
		driverName := readTrimmed(filepath.Join(dir, "name"), "")
		isCPU := driverName == "coretemp" || driverName == "k10temp" || driverName == "zenpower"

		inputs, _ := filepath.Glob(filepath.Join(dir, "temp*_input"))
		for _, p := range inputs {
			baseName := filepath.Base(p)
			currentChannel := strings.Split(baseName, "_")[0]
			label := strings.ToLower(readTrimmed(filepath.Join(dir, currentChannel+"_label"), ""))

			if isCPU {
				if label != "" && !strings.Contains(label, "package") && !strings.Contains(label, "cpu") && !strings.Contains(label, "tdie") && !strings.Contains(label, "tctl") {
					continue
				}
				if label == "" && currentChannel != "temp1" {
					continue
				}
			} else {
				if label == "" || !strings.Contains(label, "cpu") {
					continue
				}
			}

			t, err := ReadTemp(p)
			if err != nil {
				continue
			}
			if best == nil || *t > *best {
				best = t
			}
		}
	}

	if best == nil {
		if raw, err := readIntFile(filepath.Join(zoneRoot, "thermal_zone0/temp")); err == nil {
			temp := float64(raw) / 1000.0
			if temp > 0 && temp <= 120 {
				best = &temp
			}
		}
	}
	return best, nil
}

func readIntFile(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
}

func readTrimmed(path, def string) string {
	if raw, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(raw)); s != "" {
			return s
		}
	}
	return def
}
