package driver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"fancontrolserver/internal/thermal"
)

// ValidateHwmonPath 检查路径是否在允许的 sysfs 目录下（白名单逻辑集中在 thermal 包）。
func ValidateHwmonPath(path string) error {
	return thermal.ValidatePath(path)
}

type HWMONDriver struct{}

func NewHWMONDriver() *HWMONDriver {
	return &HWMONDriver{}
}

func (d *HWMONDriver) ReadRPM(path string) (int, error) {
	if err := ValidateHwmonPath(path); err != nil {
		return 0, err
	}
	return readIntFile(path)
}

func (d *HWMONDriver) ReadPWM(path string) (int, error) {
	if err := ValidateHwmonPath(path); err != nil {
		return 0, err
	}
	return readIntFile(path)
}

func (d *HWMONDriver) WritePWM(enablePath, pwmPath string, pwm int) error {
	if err := ValidateHwmonPath(enablePath); err != nil {
		return err
	}
	if err := ValidateHwmonPath(pwmPath); err != nil {
		return err
	}
	if enablePath != "" {
		if err := os.WriteFile(enablePath, []byte("1\n"), 0o644); err != nil {
			return fmt.Errorf("写入 PWM 使能路径失败：%w", err)
		}
	}
	return os.WriteFile(pwmPath, []byte(fmt.Sprintf("%d\n", pwm)), 0o644)
}

func (d *HWMONDriver) ScanFans() ([]map[string]string, error) {
	fans := make([]map[string]string, 0)
	entries, _ := filepath.Glob("/sys/class/hwmon/hwmon*")

	for _, hwmon := range entries {
		chip := readTrimmed(filepath.Join(hwmon, "name"), filepath.Base(hwmon))
		device := ""
		if link, err := os.Readlink(filepath.Join(hwmon, "device")); err == nil {
			device = filepath.Base(link)
		}

		// 枚举同 hwmon 目录的温度通道元数据（不读值），供前端展示"该 PWM 风扇可用的传感器"。
		sensorsJSON := "[]"
		if sensors := scanDirTempSensors(hwmon, chip, device); len(sensors) > 0 {
			if raw, err := json.Marshal(sensors); err == nil {
				sensorsJSON = string(raw)
			}
		}

		pwmFiles, _ := filepath.Glob(filepath.Join(hwmon, "pwm[0-9]"))
		for _, pwmFile := range pwmFiles {
			idx := strings.TrimPrefix(filepath.Base(pwmFile), "pwm")
			stableId := fmt.Sprintf("%s/%s/pwm%s", chip, device, idx)
			rpmPath := filepath.Join(hwmon, "fan"+idx+"_input")
			if _, err := os.Stat(rpmPath); err != nil {
				rpmPath = ""
			}
			enablePath := filepath.Join(hwmon, "pwm"+idx+"_enable")
			if _, err := os.Stat(enablePath); err != nil {
				enablePath = ""
			}

			fans = append(fans, map[string]string{
				"id":          stableId,
				"name":        fmt.Sprintf("%s 风扇 %s", chip, idx),
				"chip":        chip,
				"device":      device,
				"pwm_index":   idx,
				"pwm_path":    pwmFile,
				"rpm_path":    rpmPath,
				"enable_path": enablePath,
				"sensors":     sensorsJSON,
			})
		}
	}
	return fans, nil
}

// scanDirTempSensors 枚举单个 hwmon 目录的温度通道元数据（temp*_input + temp*_label），
// 只读元数据不读值，输出给 ScanFans 作为传感器的 JSON 字符串字段。
func scanDirTempSensors(hwmon, chip, device string) []map[string]string {
	inputs, _ := filepath.Glob(filepath.Join(hwmon, "temp*_input"))
	out := make([]map[string]string, 0, len(inputs))
	for _, p := range inputs {
		key := strings.TrimSuffix(filepath.Base(p), "_input")
		out = append(out, map[string]string{
			"id":    fmt.Sprintf("%s/%s/%s", chip, device, key),
			"chip":  chip,
			"key":   key,
			"label": readTrimmed(filepath.Join(hwmon, key+"_label"), key),
			"path":  p,
		})
	}
	return out
}

func readIntFile(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
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

// ScanTempChannels 通用扫描所有 hwmon 温度通道（委托 thermal 包，sysfs 解析集中且可单测）。
func (d *HWMONDriver) ScanTempChannels() ([]TempChannel, error) {
	chs, err := thermal.ScanTempChannels()
	if err != nil {
		return nil, err
	}
	out := make([]TempChannel, 0, len(chs))
	for _, c := range chs {
		out = append(out, TempChannel{
			ID:     c.ID,
			Chip:   c.Chip,
			Device: c.Device,
			Key:    c.Key,
			Label:  c.Label,
			Path:   c.Path,
		})
	}
	return out, nil
}

// ReadTemp 读取单个温度通道（mC → °C，委托 thermal 包实现）。
func (d *HWMONDriver) ReadTemp(path string) (*float64, error) {
	return thermal.ReadTemp(path)
}

func readTrimmed(path, def string) string {
	if raw, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(raw)); s != "" {
			return s
		}
	}
	return def
}
