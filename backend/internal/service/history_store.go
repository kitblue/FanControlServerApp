package service

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"

	"fancontrolserver/internal/model"
)

const (
	historyRetentionDays  = 7
	historySampleInterval = time.Minute
)

var (
	ErrHistoryRangeConflict = errors.New("range 与 from/to 不能同时使用")
	ErrHistoryRangeInvalid  = errors.New("range 参数无效，可选：1h、6h、24h、7d")
	ErrHistoryFromToPair    = errors.New("from 与 to 必须同时提供")
	ErrHistoryFromAfterTo   = errors.New("开始时间必须早于结束时间")
	ErrHistoryCustomTooLong = errors.New("自定义范围不能超过 7 天")
	ErrHistoryFromTooOld    = errors.New("开始时间不能早于 7 天前")
	ErrHistoryToFuture      = errors.New("结束时间不能晚于当前时间")
)

type HistoryStore struct {
	db              *sql.DB
	mu              sync.Mutex
	lastAppendTimes map[string]time.Time
	lastPrune       time.Time

	// dbPath 为数据库文件的展示路径（尽可能绝对化），供界面底部状态栏展示。
	dbPath string
}

func NewHistoryStore(dbPath string) (*HistoryStore, error) {
	if dbPath != "" && dbPath != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err = db.Exec(`
CREATE TABLE IF NOT EXISTS temp_history (
	series TEXT NOT NULL,
	ts     INTEGER NOT NULL,
	value  REAL,
	PRIMARY KEY (series, ts)
);
CREATE INDEX IF NOT EXISTS idx_temp_history_ts ON temp_history(ts);
`); err != nil {
		_ = db.Close()
		return nil, err
	}
	logrus.Infof("[历史] SQLite 温度历史已就绪：%q", dbPath)
	return &HistoryStore{
		db:              db,
		lastAppendTimes: map[string]time.Time{},
		dbPath:          displayDBPath(dbPath),
	}, nil
}

// displayDBPath 返回用于界面展示的数据库路径：尽可能转为绝对路径，内存库保持原值。
func displayDBPath(dbPath string) string {
	if dbPath == "" || dbPath == ":memory:" {
		return dbPath
	}
	abs, err := filepath.Abs(dbPath)
	if err != nil {
		return dbPath
	}
	return abs
}

func (h *HistoryStore) Close() error {
	if h.db == nil {
		return nil
	}
	return h.db.Close()
}

func (h *HistoryStore) RecordSnapshot(t model.Telemetry) {
	if h.db == nil {
		return
	}
	ts := t.Timestamp
	points := make([]historyPoint, 0, 16)
	points = h.collectPoint(points, "cpu_temp", ts, t.CPUTemp)
	points = h.collectPoint(points, "gpu_temp", ts, t.GPUTemp)
	points = h.collectPoint(points, "disk_avg", ts, t.Disks.AvgTemp)
	for _, s := range t.Sensors {
		points = h.collectPoint(points, s.ID, ts, s.Temp)
	}
	for _, f := range t.Fans {
		pwm := float64(f.PWM)
		rpm := float64(f.RPM)
		points = h.collectPoint(points, "fan_pwm:"+f.ID, ts, &pwm)
		points = h.collectPoint(points, "fan_rpm:"+f.ID, ts, &rpm)
		points = h.collectPoint(points, "fan_temp:"+f.ID, ts, f.Temp)
	}
	if err := h.flushPoints(points); err != nil {
		logrus.Warnf("[历史] 批量写入 %d 个点失败：%v", len(points), err)
	}
	h.maybePrune(ts)
}

type historyPoint struct {
	series string
	ts     int64
	value  sql.NullFloat64
}

// collectPoint 内存防抖：同一 series 在采样间隔内只收录一次，避免无效写入。
func (h *HistoryStore) collectPoint(points []historyPoint, series string, now time.Time, value *float64) []historyPoint {
	h.mu.Lock()
	last := h.lastAppendTimes[series]
	if !last.IsZero() && now.Sub(last) < historySampleInterval {
		h.mu.Unlock()
		return points
	}
	h.lastAppendTimes[series] = now
	h.mu.Unlock()

	var v sql.NullFloat64
	if value != nil {
		v = sql.NullFloat64{Float64: *value, Valid: true}
	}
	return append(points, historyPoint{series: series, ts: now.UTC().Unix(), value: v})
}

// flushPoints 在单个事务内批量 upsert 所有点（每采集周期一次事务）。
func (h *HistoryStore) flushPoints(points []historyPoint) error {
	if len(points) == 0 || h.db == nil {
		return nil
	}
	tx, err := h.db.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO temp_history (series, ts, value) VALUES (?, ?, ?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, p := range points {
		if _, err = stmt.Exec(p.series, p.ts, p.value); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (h *HistoryStore) maybePrune(now time.Time) {
	h.mu.Lock()
	if !h.lastPrune.IsZero() && now.Sub(h.lastPrune) < time.Hour {
		h.mu.Unlock()
		return
	}
	h.lastPrune = now
	h.mu.Unlock()

	cutoff := now.Add(-historyRetentionDays * 24 * time.Hour).UTC().Unix()
	if _, err := h.db.Exec(`DELETE FROM temp_history WHERE ts < ?`, cutoff); err != nil {
		logrus.Warnf("[历史] 清理过期数据失败：%v", err)
	}
}

type HistoryQuery struct {
	From time.Time
	To   time.Time
}

func ParseHistoryQuery(rangeParam, fromParam, toParam string, now time.Time) (HistoryQuery, error) {
	hasRange := strings.TrimSpace(rangeParam) != ""
	hasFrom := strings.TrimSpace(fromParam) != ""
	hasTo := strings.TrimSpace(toParam) != ""

	if hasRange && (hasFrom || hasTo) {
		return HistoryQuery{}, ErrHistoryRangeConflict
	}
	if hasFrom != hasTo {
		return HistoryQuery{}, ErrHistoryFromToPair
	}
	if hasFrom {
		return parseCustomHistoryQuery(fromParam, toParam, now)
	}
	if !hasRange {
		rangeParam = "1h"
	}
	return parsePresetHistoryQuery(rangeParam, now)
}

func parsePresetHistoryQuery(rangeParam string, now time.Time) (HistoryQuery, error) {
	var dur time.Duration
	switch rangeParam {
	case "1h":
		dur = time.Hour
	case "6h":
		dur = 6 * time.Hour
	case "24h":
		dur = 24 * time.Hour
	case "7d":
		dur = 7 * 24 * time.Hour
	default:
		return HistoryQuery{}, ErrHistoryRangeInvalid
	}
	return HistoryQuery{From: now.Add(-dur), To: now}, nil
}

func parseCustomHistoryQuery(fromParam, toParam string, now time.Time) (HistoryQuery, error) {
	from, err := time.Parse(time.RFC3339, fromParam)
	if err != nil {
		return HistoryQuery{}, fmt.Errorf("from 时间格式无效，请使用 RFC3339")
	}
	to, err := time.Parse(time.RFC3339, toParam)
	if err != nil {
		return HistoryQuery{}, fmt.Errorf("to 时间格式无效，请使用 RFC3339")
	}
	if !from.Before(to) {
		return HistoryQuery{}, ErrHistoryFromAfterTo
	}
	span := to.Sub(from)
	if span > historyRetentionDays*24*time.Hour {
		return HistoryQuery{}, ErrHistoryCustomTooLong
	}
	oldest := now.Add(-historyRetentionDays * 24 * time.Hour)
	if from.Before(oldest) {
		return HistoryQuery{}, ErrHistoryFromTooOld
	}
	if to.After(now) {
		return HistoryQuery{}, ErrHistoryToFuture
	}
	return HistoryQuery{From: from, To: to}, nil
}

func (h *HistoryStore) Query(q HistoryQuery) model.HistorySeries {
	empty := model.HistorySeries{}
	if h.db == nil {
		return empty
	}
	fromTS := q.From.UTC().Unix()
	toTS := q.To.UTC().Unix()
	rows, err := h.db.Query(
		`SELECT series, ts, value FROM temp_history WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
		fromTS, toTS,
	)
	if err != nil {
		logrus.Warnf("[历史] 查询失败：%v", err)
		return empty
	}
	defer func() { _ = rows.Close() }()

	bySeries := map[string][]model.HistoryPoint{}
	for rows.Next() {
		var series string
		var ts int64
		var value sql.NullFloat64
		if err = rows.Scan(&series, &ts, &value); err != nil {
			continue
		}
		pt := model.HistoryPoint{Time: time.Unix(ts, 0).UTC()}
		if value.Valid {
			v := value.Float64
			pt.Value = &v
		}
		bySeries[series] = append(bySeries[series], pt)
	}
	if err = rows.Err(); err != nil {
		logrus.Warnf("[历史] 遍历查询结果失败：%v", err)
		return empty
	}

	interval := downsampleInterval(q.To.Sub(q.From))
	out := model.HistorySeries{
		Sensors:  map[string][]model.HistoryPoint{},
		FansPWM:  map[string][]model.HistoryPoint{},
		FansRPM:  map[string][]model.HistoryPoint{},
		FansTemp: map[string][]model.HistoryPoint{},
	}
	for series, pts := range bySeries {
		pts = downsampleSeries(pts, interval)
		switch {
		case series == "cpu_temp":
			out.CPUTemp = pts
		case series == "gpu_temp":
			out.GPUTemp = pts
		case series == "disk_avg":
			out.DiskAvg = pts
		case strings.HasPrefix(series, "fan_pwm:"):
			out.FansPWM[strings.TrimPrefix(series, "fan_pwm:")] = pts
		case strings.HasPrefix(series, "fan_rpm:"):
			out.FansRPM[strings.TrimPrefix(series, "fan_rpm:")] = pts
		case strings.HasPrefix(series, "fan_temp:"):
			out.FansTemp[strings.TrimPrefix(series, "fan_temp:")] = pts
		default:
			out.Sensors[series] = pts
		}
	}
	if len(out.Sensors) == 0 {
		out.Sensors = nil
	}
	if len(out.FansPWM) == 0 {
		out.FansPWM = nil
	}
	if len(out.FansRPM) == 0 {
		out.FansRPM = nil
	}
	if len(out.FansTemp) == 0 {
		out.FansTemp = nil
	}
	return out
}

func downsampleInterval(duration time.Duration) time.Duration {
	switch {
	case duration <= time.Hour:
		return time.Minute
	case duration <= 6*time.Hour:
		return time.Minute
	case duration <= 24*time.Hour:
		return 5 * time.Minute
	case duration <= 7*24*time.Hour:
		return 15 * time.Minute
	default:
		interval := duration / 800
		if interval < 30*time.Minute {
			return 30 * time.Minute
		}
		if interval > time.Hour {
			return time.Hour
		}
		return interval
	}
}

func downsampleSeries(points []model.HistoryPoint, interval time.Duration) []model.HistoryPoint {
	if len(points) == 0 || interval <= 0 {
		return points
	}
	out := make([]model.HistoryPoint, 0, len(points))
	var curBucket time.Time
	var last model.HistoryPoint
	hasLast := false
	for _, p := range points {
		bucket := p.Time.Truncate(interval)
		if !hasLast || !bucket.Equal(curBucket) {
			if hasLast {
				out = append(out, last)
			}
			curBucket = bucket
			last = p
			hasLast = true
			continue
		}
		last = p
	}
	if hasLast {
		out = append(out, last)
	}
	return out
}
