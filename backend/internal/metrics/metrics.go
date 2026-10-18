// Package metrics 基于 prometheus/client_golang 暴露温控服务运行指标：
// 采集周期/耗时、传感器温度、风扇 PWM/RPM、DB 写入延迟、更新检查命中率。
package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"fancontrolserver/internal/model"
)

var (
	reg = prometheus.NewRegistry()

	collectCycles = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "fancontrol_collect_cycles_total",
		Help: "遥测采集周期总数",
	})
	collectDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "fancontrol_collect_duration_seconds",
		Help:    "单次完整采集耗时（秒）",
		Buckets: prometheus.DefBuckets,
	})
	temperatureC = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fancontrol_temperature_celsius",
		Help: "传感器温度（℃）",
	}, []string{"sensor", "kind"})
	fanPWM = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fancontrol_fan_pwm",
		Help: "风扇当前 PWM 输出（0-255）",
	}, []string{"fan_id", "fan_name"})
	fanRPM = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fancontrol_fan_rpm",
		Help: "风扇当前转速（RPM）",
	}, []string{"fan_id", "fan_name"})
	dbWriteDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "fancontrol_db_write_duration_seconds",
		Help:    "历史落库耗时（秒）",
		Buckets: prometheus.DefBuckets,
	})
	updateCheckTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "fancontrol_update_check_total",
		Help: "版本检查次数（按缓存命中与否区分）",
	}, []string{"cache"})
)

func init() {
	reg.MustRegister(collectCycles, collectDuration, temperatureC, fanPWM, fanRPM, dbWriteDuration, updateCheckTotal)
}

// Handler 返回 /metrics 暴露端点使用的 HTTP Handler。
func Handler() http.Handler {
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}

// ObserveCollect 上报一次完整采集：周期计数、耗时、温度与风扇状态。
func ObserveCollect(t model.Telemetry, dur time.Duration) {
	collectCycles.Inc()
	collectDuration.Observe(dur.Seconds())

	if t.CPUTemp != nil {
		temperatureC.WithLabelValues(t.CPUSensorLabel, "cpu").Set(*t.CPUTemp)
	}
	if t.GPUTemp != nil {
		temperatureC.WithLabelValues(t.GPUSensorLabel, "gpu").Set(*t.GPUTemp)
	}
	if t.Disks.AvgTemp != nil {
		temperatureC.WithLabelValues("disk_avg", "disk").Set(*t.Disks.AvgTemp)
	}
	for _, s := range t.Sensors {
		if s.Temp != nil {
			temperatureC.WithLabelValues(s.Label, "sensor").Set(*s.Temp)
		}
	}
	for _, f := range t.Fans {
		fanPWM.WithLabelValues(f.ID, f.Name).Set(float64(f.PWM))
		fanRPM.WithLabelValues(f.ID, f.Name).Set(float64(f.RPM))
	}
}

// ObserveDBWrite 上报一次历史落库耗时。
func ObserveDBWrite(dur time.Duration) {
	dbWriteDuration.Observe(dur.Seconds())
}

// ObserveUpdateCheck 上报一次版本检查（cache 是否命中）。
func ObserveUpdateCheck(hit bool) {
	if hit {
		updateCheckTotal.WithLabelValues("hit").Inc()
	} else {
		updateCheckTotal.WithLabelValues("miss").Inc()
	}
}
