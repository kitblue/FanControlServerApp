package service

import (
	"os"
	"time"

	"github.com/sirupsen/logrus"
)

// StorageStats 温度历史数据库的只读概览，供界面底部状态栏展示。
// 仅统计主数据库文件（history.db）的磁盘占用，不包含 -wal / -shm 等附属文件。
type StorageStats struct {
	Available bool   `json:"available"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
	UpdatedAt string `json:"updated_at"`
}

// StorageStats 读取历史数据库文件大小。文件不存在或尚未落盘时返回 available=false。
// 该接口为只读操作，仅调用 os.Stat，不触碰数据库连接。
func (h *HistoryStore) StorageStats() StorageStats {
	now := time.Now().UTC().Format(time.RFC3339)
	stats := StorageStats{UpdatedAt: now}
	if h == nil {
		return stats
	}
	stats.Path = h.dbPath
	if h.db != nil {
		stats.Available = true
	}
	if h.dbPath == "" || h.dbPath == ":memory:" {
		return stats
	}
	info, err := os.Stat(h.dbPath)
	if err != nil {
		if !os.IsNotExist(err) {
			logrus.Warnf("[历史] 读取数据库文件大小失败：%v", err)
		}
		return stats
	}
	stats.SizeBytes = info.Size()
	return stats
}

// StorageStats 返回历史数据库的存储概览（供界面底部状态栏展示）。
func (c *Controller) StorageStats() StorageStats {
	if c == nil || c.history == nil {
		return StorageStats{UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	}
	return c.history.StorageStats()
}
