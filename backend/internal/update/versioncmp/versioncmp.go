// Package versioncmp 提供纯语义版本比较函数，不依赖任何 IO，便于单测与复用。
package versioncmp

import (
	"strconv"
	"strings"
)

// Normalize 规范化版本号：去空格、去 v/V 前缀、截断 -beta 等后缀。
func Normalize(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	return v
}

// Parse 解析版本号点分段，非法输入返回 ok=false。
func Parse(v string) (parts []int, ok bool) {
	v = Normalize(v)
	if v == "" {
		return nil, false
	}
	segs := strings.Split(v, ".")
	parts = make([]int, len(segs))
	for i, s := range segs {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return nil, false
		}
		parts[i] = n
	}
	return parts, true
}

// IsNewer 当 latest > current 时返回 true（按点分段从左到右比较，支持 1.3.6.1 这类四段版本）。
func IsNewer(latest, current string) bool {
	lp, ok1 := Parse(latest)
	cp, ok2 := Parse(current)
	if !ok1 || !ok2 {
		return false
	}
	n := len(lp)
	if len(cp) > n {
		n = len(cp)
	}
	for i := 0; i < n; i++ {
		var a, b int
		if i < len(lp) {
			a = lp[i]
		}
		if i < len(cp) {
			b = cp[i]
		}
		if a != b {
			return a > b
		}
	}
	return false
}
