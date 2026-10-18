// Package update 检查 GitHub Release 是否有新版本。
package update

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
	"golang.org/x/sync/singleflight"

	"fancontrolserver/internal/metrics"
	"fancontrolserver/internal/update/versioncmp"
	"fancontrolserver/internal/version"
)

const (
	githubLatestURL  = "https://api.github.com/repos/kitblue/FanControlServerApp/releases/latest"
	githubPageURL    = "https://github.com/kitblue/FanControlServerApp/releases/latest"           // 无 API 限流的 HTML 重定向
	jsDelivrURL      = "https://cdn.jsdelivr.net/gh/kitblue/FanControlServerApp@main/fnpack.json" // CDN 直读 fnpack.json
	successCacheTTL  = 6 * time.Hour
	failureCacheTTL  = 10 * time.Minute
	forceMinInterval = 30 * time.Second
	httpTimeout      = 8 * time.Second
	maxNotesBytes    = 8 * 1024
	userAgent        = "FanControlServer"
)

// Result 检查更新结果（始终可 JSON 序列化返回给前端）。
type Result struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest,omitempty"`
	HasUpdate bool      `json:"has_update"`
	URL       string    `json:"url,omitempty"`
	Notes     string    `json:"notes,omitempty"`
	CheckedAt time.Time `json:"checked_at"`
	CheckOK   bool      `json:"check_ok"`
	Error     string    `json:"error,omitempty"`
}

type cacheEntry struct {
	result    Result
	expiresAt time.Time
	ok        bool // 成功拉取过 GitHub
}

// Checker 进程内单例检查器：缓存 + singleflight 合并并发请求。
// 纯版本比较逻辑（Normalize/IsNewer）已抽取到 versioncmp 包，便于独立单测。
type Checker struct {
	client *http.Client

	mu            sync.Mutex
	cache         *cacheEntry
	lastForceOKAt time.Time

	sf singleflight.Group
}

// NewChecker 创建检查器。
func NewChecker() *Checker {
	return &Checker{
		client: &http.Client{Timeout: httpTimeout},
	}
}

// Check 检查是否有新版本。force 时尽量跳过成功缓存（仍受 singleflight 合并与 30s 最短间隔约束）。
func (c *Checker) Check(force bool) Result {
	now := time.Now()
	current := strings.TrimSpace(version.Version)

	// 非 force：命中未过期缓存
	c.mu.Lock()
	if !force && c.cache != nil && now.Before(c.cache.expiresAt) {
		out := c.cache.result
		c.mu.Unlock()
		metrics.ObserveUpdateCheck(true)
		out.Current = current
		out.HasUpdate = versioncmp.IsNewer(out.Latest, current)
		return out
	}

	// force：成功后 30s 内仍用刚写入的成功缓存，避免连点
	if force && c.cache != nil && c.cache.ok && !c.lastForceOKAt.IsZero() && now.Sub(c.lastForceOKAt) < forceMinInterval {
		out := c.cache.result
		c.mu.Unlock()
		metrics.ObserveUpdateCheck(true)
		out.Current = current
		out.HasUpdate = versioncmp.IsNewer(out.Latest, current)
		return out
	}
	c.mu.Unlock()

	metrics.ObserveUpdateCheck(false)
	// singleflight：并发同 key 请求合并为一次网络调用，共享同一结果
	v, _, _ := c.sf.Do("update-check", func() (any, error) {
		return c.fetchLatest(current), nil
	})
	res := v.(Result)

	c.mu.Lock()
	ttl := failureCacheTTL
	if res.CheckOK {
		ttl = successCacheTTL
		if force {
			c.lastForceOKAt = time.Now()
		}
	}
	c.cache = &cacheEntry{result: res, expiresAt: time.Now().Add(ttl), ok: res.CheckOK}
	c.mu.Unlock()

	return res
}

type githubRelease struct {
	TagName    string `json:"tag_name"`
	HTMLURL    string `json:"html_url"`
	Body       string `json:"body"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

func (c *Checker) fetchLatest(current string) Result {
	now := time.Now()
	base := Result{
		Current:   current,
		CheckedAt: now,
		CheckOK:   false,
		HasUpdate: false,
	}

	req, err := http.NewRequest(http.MethodGet, githubLatestURL, nil)
	if err != nil {
		base.Error = err.Error()
		logrus.Warnf("[更新检查] 创建请求失败：%v", err)
		return base
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", userAgent)
	// 优先读取环境变量中的 GITHUB_TOKEN，避免未认证调用触发 403 限流
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		logrus.Warnf("[更新检查] API 请求失败，尝试降级源：%v", err)
		return c.fetchFallback(current, base)
	}
	defer func(Body io.ReadCloser) {
		_ = Body.Close()
	}(resp.Body)

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxNotesBytes+64*1024))
	if err != nil {
		base.Error = "读取响应失败：" + err.Error()
		logrus.Warnf("[更新检查] 读取响应失败：%v", err)
		return base
	}
	if resp.StatusCode != http.StatusOK {
		logrus.Warnf("[更新检查] API 返回 HTTP %d，尝试降级源", resp.StatusCode)
		return c.fetchFallback(current, base)
	}

	var rel githubRelease
	if err := json.Unmarshal(body, &rel); err != nil {
		base.Error = "解析 Release 失败"
		logrus.Warnf("[更新检查] JSON 解析失败：%v", err)
		return base
	}
	if rel.Draft || rel.Prerelease {
		base.Error = "最新 Release 为预发布/草稿，已忽略"
		base.CheckOK = true
		base.Latest = versioncmp.Normalize(rel.TagName)
		base.URL = rel.HTMLURL
		return base
	}

	latest := versioncmp.Normalize(rel.TagName)
	notes := rel.Body
	if len(notes) > maxNotesBytes {
		notes = notes[:maxNotesBytes] + "\n…"
	}
	if strings.TrimSpace(notes) == "" {
		notes = "暂无更新说明"
	}

	base.CheckOK = true
	base.Latest = latest
	base.URL = rel.HTMLURL
	base.Notes = notes
	base.HasUpdate = versioncmp.IsNewer(latest, current)
	base.Error = ""
	logrus.Debugf("[更新检查] current=%s latest=%s has_update=%v", current, latest, base.HasUpdate)
	return base
}

// fetchFallback API 限流/失败时的降级检查：HTML 页面重定向 → jsDelivr CDN 读 fnpack.json。
// 两个源均不依赖 GitHub API 配额，可规避未认证 60 次/小时的 403 限制。
func (c *Checker) fetchFallback(current string, base Result) Result {
	if res := c.fetchLatestFromPage(current); res.CheckOK {
		return res
	}
	if res := c.fetchLatestFromCDN(current); res.CheckOK {
		return res
	}
	base.Error = "GitHub API 与降级源均不可用"
	logrus.Warnf("[更新检查] %s", base.Error)
	return base
}

// fetchLatestFromPage 通过 releases/latest 的 302 重定向拿到最新 tag（HTML 通道无 API 限流）。
func (c *Checker) fetchLatestFromPage(current string) Result {
	now := time.Now()
	base := Result{Current: current, CheckedAt: now, CheckOK: false}

	req, err := http.NewRequest(http.MethodGet, githubPageURL, nil)
	if err != nil {
		return base
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.client.Do(req)
	if err != nil {
		logrus.Debugf("[更新检查] 降级源页面请求失败：%v", err)
		return base
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))

	// 跟随重定向后的最终 URL 形如 .../releases/tag/v1.3.7.24
	u := resp.Request.URL
	segs := strings.Split(u.Path, "/")
	for i, seg := range segs {
		if seg == "tag" && i+1 < len(segs) {
			tag := versioncmp.Normalize(segs[i+1])
			if tag == "" {
				return base
			}
			base.CheckOK = true
			base.Latest = tag
			base.URL = u.String()
			base.Notes = "暂无更新说明"
			base.HasUpdate = versioncmp.IsNewer(tag, current)
			logrus.Debugf("[更新检查] 降级源(页面) latest=%s", tag)
			return base
		}
	}
	return base
}

// fetchLatestFromCDN 通过 jsDelivr CDN 直读仓库 fnpack.json 的 releases 版本列表，取最高版本。
func (c *Checker) fetchLatestFromCDN(current string) Result {
	now := time.Now()
	base := Result{Current: current, CheckedAt: now, CheckOK: false}

	req, err := http.NewRequest(http.MethodGet, jsDelivrURL, nil)
	if err != nil {
		return base
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.client.Do(req)
	if err != nil {
		logrus.Debugf("[更新检查] 降级源 CDN 请求失败：%v", err)
		return base
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return base
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return base
	}

	var pack struct {
		Apps map[string]struct {
			Releases map[string]struct {
				Packages map[string]struct {
					DownloadURL string `json:"download_url"`
				} `json:"packages"`
			} `json:"releases"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(body, &pack); err != nil {
		return base
	}
	best := ""
	var bestPkgURL string
	for _, app := range pack.Apps {
		for ver := range app.Releases {
			// 仅选择带有实际下载包的正式版本号
			pkg, ok := app.Releases[ver]
			if !ok || len(pkg.Packages) == 0 {
				continue
			}
			v := versioncmp.Normalize(ver)
			if v == "" {
				continue
			}
			if best == "" || versioncmp.IsNewer(v, best) {
				best = v
				for _, p := range pkg.Packages {
					if p.DownloadURL != "" {
						bestPkgURL = p.DownloadURL
						break
					}
				}
			}
		}
	}
	if best == "" {
		return base
	}
	base.CheckOK = true
	base.Latest = best
	base.URL = bestPkgURL
	base.Notes = "暂无更新说明"
	base.HasUpdate = versioncmp.IsNewer(best, current)
	logrus.Debugf("[更新检查] 降级源(CDN) latest=%s", best)
	return base
}
