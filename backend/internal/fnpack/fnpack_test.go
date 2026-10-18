package fnpack

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoRoot walks up from this package to the repository root
// (backend/internal/fnpack -> repo root).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "fnpack.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("fnpack.json not found above %v", dir)
		}
		dir = parent
	}
}

func TestValidateIndexFromRepoRoot(t *testing.T) {
	root := repoRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, "fnpack.json"))
	if err != nil {
		t.Fatalf("read fnpack.json: %v", err)
	}
	if err := ValidateIndex(raw); err != nil {
		t.Fatalf("repo fnpack.json must be valid: %v", err)
	}
}

func TestValidateIndexRejectsBadSchema(t *testing.T) {
	err := ValidateIndex([]byte(`{"schema_version":"1","apps":{"a":{"appname":"a","display_name":"A","platform":["x86"],"releases":{}}}}`))
	if err == nil || !strings.Contains(err.Error(), "schema_version") {
		t.Fatalf("want schema_version error, got %v", err)
	}
}

func TestValidateIndexRejectsMissingSha(t *testing.T) {
	raw := `{"schema_version":"2","apps":{"fancontrolserver":{"appname":"fancontrolserver","display_name":"Fan Control Server","platform":["x86"],"releases":{"1.0.0":{"packages":{"x86":{"download_url":"https://example.com/x.fpk","size":100}}}}}}}`
	err := ValidateIndex([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("want sha256 error, got %v", err)
	}
}

func TestValidateIndexRejectsEmptyApps(t *testing.T) {
	err := ValidateIndex([]byte(`{"schema_version":"2","apps":{}}`))
	if err == nil || !strings.Contains(err.Error(), "apps") {
		t.Fatalf("want apps error, got %v", err)
	}
}
