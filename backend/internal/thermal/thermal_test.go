package thermal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setupSysRoot 在临时目录构造 <root>/sys/class/hwmon|thermal 的 sysfs fixture 并覆盖包级根变量。
func setupSysRoot(t *testing.T) {
	t.Helper()
	root := t.TempDir()
	hwmonRoot = filepath.Join(root, "sys", "class", "hwmon")
	zoneRoot = filepath.Join(root, "sys", "class", "thermal")
	sysRoot = root
	t.Cleanup(func() {
		hwmonRoot = "/sys/class/hwmon"
		zoneRoot = "/sys/class/thermal"
		sysRoot = ""
	})
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadTemp(t *testing.T) {
	setupSysRoot(t)
	p := filepath.Join(hwmonRoot, "hwmon0", "temp1_input")
	writeFixture(t, p, "55000\n")
	got, err := ReadTemp(p)
	if err != nil {
		t.Fatalf("ReadTemp: %v", err)
	}
	if got == nil || *got != 55.0 {
		t.Fatalf("ReadTemp = %v, want 55.0", got)
	}

	bad := filepath.Join(hwmonRoot, "hwmon0", "temp2_input")
	writeFixture(t, bad, "999999\n")
	if _, err := ReadTemp(bad); err == nil {
		t.Fatal("ReadTemp should reject abnormal temp value")
	}
}

func TestScanTempChannels(t *testing.T) {
	setupSysRoot(t)
	writeFixture(t, filepath.Join(hwmonRoot, "hwmon0", "temp1_input"), "45000\n")
	writeFixture(t, filepath.Join(hwmonRoot, "hwmon0", "name"), "coretemp\n")
	writeFixture(t, filepath.Join(hwmonRoot, "hwmon0", "temp1_label"), "Package id 0\n")

	chs, err := ScanTempChannels()
	if err != nil {
		t.Fatal(err)
	}
	if len(chs) != 1 {
		t.Fatalf("ScanTempChannels got %d channels, want 1", len(chs))
	}
	if chs[0].Chip != "coretemp" || chs[0].Key != "temp1" || !strings.Contains(chs[0].Label, "Package") {
		t.Fatalf("unexpected channel: %+v", chs[0])
	}
	if chs[0].Path == "" {
		t.Fatal("channel path should not be empty")
	}
}

func TestCPUTempFromSysfs(t *testing.T) {
	setupSysRoot(t)
	writeFixture(t, filepath.Join(hwmonRoot, "hwmon0", "name"), "coretemp\n")
	writeFixture(t, filepath.Join(hwmonRoot, "hwmon0", "temp1_input"), "50000\n")
	writeFixture(t, filepath.Join(hwmonRoot, "hwmon0", "temp1_label"), "Package id 0\n")

	got, err := CPUTempFromSysfs()
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || *got != 50.0 {
		t.Fatalf("CPUTempFromSysfs = %v, want 50.0", got)
	}
}

func TestCPUTempFromSysfsFallsBackToZone(t *testing.T) {
	setupSysRoot(t)
	writeFixture(t, filepath.Join(zoneRoot, "thermal_zone0", "temp"), "58000\n")

	got, err := CPUTempFromSysfs()
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || *got != 58.0 {
		t.Fatalf("CPUTempFromSysfs(zone) = %v, want 58.0", got)
	}
}

func TestValidatePath(t *testing.T) {
	setupSysRoot(t)
	okHwmon := filepath.Join(sysRoot, "sys", "class", "hwmon", "hwmon0", "temp1_input")
	if err := ValidatePath(okHwmon); err != nil {
		t.Fatalf("ValidatePath(%q) err=%v want ok", okHwmon, err)
	}
	okDevices := filepath.Join(sysRoot, "sys", "devices", "pci0000:00", "hwmon0", "temp1_input")
	if err := ValidatePath(okDevices); err != nil {
		t.Fatalf("ValidatePath(%q) err=%v want ok", okDevices, err)
	}
	if err := ValidatePath(filepath.Join(sysRoot, "etc", "passwd")); err == nil {
		t.Fatal("ValidatePath should reject out-of-range path")
	}
	if err := ValidatePath(filepath.Join(sysRoot, "sys", "class", "hwmon0", "..", "secret")); err == nil {
		t.Fatal("ValidatePath should reject path traversal")
	}
	if err := ValidatePath(""); err != nil {
		t.Fatal("ValidatePath should accept empty path")
	}
}
