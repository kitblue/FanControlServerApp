// Package fnpack provides validation for the FnDepot V2 application index
// (fnpack.json) consumed by fnOS app center.
package fnpack

import (
	"encoding/json"
	"fmt"
)

// FnPackIndex is the root document of the FnDepot V2 index.
type FnPackIndex struct {
	SchemaVersion string               `json:"schema_version"`
	SourceInfo    *SourceInfo          `json:"source_info,omitempty"`
	Apps          map[string]FnPackApp `json:"apps"`
}

// SourceInfo describes the source repository.
type SourceInfo struct {
	Name        string `json:"name"`
	Author      string `json:"author"`
	Homepage    string `json:"homepage"`
	Description string `json:"description"`
}

// FnPackApp is a single application entry in the index.
type FnPackApp struct {
	Appname       string                   `json:"appname"`
	DisplayName   string                   `json:"display_name"`
	Desc          string                   `json:"desc"`
	Platform      []string                 `json:"platform"`
	IconURL       string                   `json:"icon_url"`
	RunAs         string                   `json:"run_as"`
	DesktopUIDir  string                   `json:"desktop_uidir"`
	DesktopLaunch string                   `json:"desktop_applaunchname"`
	History       map[string]string        `json:"history"`
	Releases      map[string]FnPackRelease `json:"releases"`
}

// FnPackRelease is a versioned release entry.
type FnPackRelease struct {
	Packages map[string]FnPackPackage `json:"packages"`
}

// FnPackPackage is a platform package entry.
type FnPackPackage struct {
	DownloadURL string `json:"download_url"`
	Sha256      string `json:"sha256"`
	Size        int64  `json:"size"`
}

// ValidateIndex parses raw fnpack.json bytes and validates the V2 schema
// invariants. It returns a descriptive error when the document is not a
// valid FnDepot V2 index.
func ValidateIndex(raw []byte) error {
	var idx FnPackIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return fmt.Errorf("fnpack: invalid json: %w", err)
	}
	if idx.SchemaVersion != "2" {
		return fmt.Errorf("fnpack: unsupported schema_version %q, want \"2\"", idx.SchemaVersion)
	}
	if len(idx.Apps) == 0 {
		return fmt.Errorf("fnpack: apps must not be empty")
	}
	for name, app := range idx.Apps {
		if app.Appname == "" || app.Appname != name {
			return fmt.Errorf("fnpack: app %q has invalid appname %q", name, app.Appname)
		}
		if app.DisplayName == "" {
			return fmt.Errorf("fnpack: app %q display_name is required", name)
		}
		if len(app.Platform) == 0 {
			return fmt.Errorf("fnpack: app %q platform is required", name)
		}
		if len(app.Releases) == 0 {
			return fmt.Errorf("fnpack: app %q releases must not be empty", name)
		}
		for ver, rel := range app.Releases {
			if len(rel.Packages) == 0 {
				return fmt.Errorf("fnpack: app %q release %q has no packages", name, ver)
			}
			for plat, pkg := range rel.Packages {
				if pkg.DownloadURL == "" {
					return fmt.Errorf("fnpack: app %q release %q platform %q download_url is required", name, ver, plat)
				}
				if len(pkg.Sha256) != 64 {
					return fmt.Errorf("fnpack: app %q release %q platform %q sha256 must be 64 hex chars", name, ver, plat)
				}
				if pkg.Size <= 0 {
					return fmt.Errorf("fnpack: app %q release %q platform %q size must be positive", name, ver, plat)
				}
			}
		}
	}
	return nil
}
