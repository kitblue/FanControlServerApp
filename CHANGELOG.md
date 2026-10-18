## v1.3.8

- feat: 后台风扇闭环模式，无 UI 查看时仅采集风扇温控最小数据，闲置 CPU/IO 占用大幅下降
- feat: 90s UI 活跃窗口自动切换全量采集与后台闭环，恢复查看即时切回
- perf: 采集拆分为全量与温控两套流程，CPU/GPU 温度通道 60s 缓存，消除每秒 sysfs 重复扫描
- perf: 后台模式停止 intel_gpu_top 常驻进程，恢复查看时按需重启
- perf: RPM 读取低频采样（10s 缓存），消除每轮每风扇 hwmon 文件读取热点，pprof 定位的 84.6% IO 热点清零
- perf: 后台周期自适应（温度平稳时轮询周期拉长至 3s，温度变化超 2℃ 即时退回基础周期）
- perf: PWM 写入增加 2s 时间窗去抖，与 PWM deadzone 组成二级防抖，紧急高温时跳过
- refactor: readSensors 拆为通道缓存与子集读取，消除并发竞态与重复扫描
- fix: 后台模式 Telemetry 磁盘详情零值兜底，不再返回空列表
- fix: 应用标识全链路统一小写 fancontrolserver（FnDepot V2 规范），修复聚合源版本更新无法识别的问题
- refactor: 网关路由 /app/fancontrolserver 与桌面入口 fancontrolserver.main 对齐包内 manifest
- refactor: 移除 viewer 活跃检测体系（MarkViewerActive/hasActiveViewers/90s 活跃窗口）与 backgroundMode 后台闭环分流（collectFanControlOnly/resolveFanTempNeeds/后台周期自适应），后端回归"始终全量采集、始终落库"，关窗期间历史曲线连续
- refactor: 移除配套性能补丁（RPM 低频采样缓存、PWM 写入时间窗去抖、intel_gpu_top 后台监视开关），采集逻辑回归简单直接
- chore: 清理旧打包产物与冗余二进制（根目录 fpk、dist 旧版 fpk、app/server 旧二进制与官方对照二进制）
- ci: fpk 产物命名规范化为 fancontrolserver-v*.*.*-linux-amd64-{url,iframe}.fpk
- version: 脱离上游版本线，独立发版 v1.3.8（含轻量化回归修订）

## v1.3.7.1

- ui: rebrand page title & status text to Fan Control Server（定制版）
- docs: polish README to align with community conventions (wording, sources, version-follow-upstream)
- rebrand: FanTune → Fan Control Server（定制版）; align version to official v1.3.7.1; fix README logo dead link; align asset name with upstream format
- feat: 迁移 FanTune 定制层至 FanControlServerApp fork（qnap8528 驱动/全平台 GPU 探测/sysfs 盘温 + 商店介绍标明差异）
- 迁移 fantune 资源: FanControlServer/Preview/03_settings.png
- 迁移 fantune 资源: FanControlServer/Preview/02_fans.png
- 迁移 fantune 资源: FanControlServer/Preview/01_overview.png
- 迁移 fantune 资源: FanControlServer/icon.png
- feat: 添加启动延时 (#40)
- feat: 调速曲线增加点位列表编辑，修复手机长按误删 (#36)
- fix: 保存全局设置时不再清空传感器别名与隐藏列表 (#35)
- feat: 检查 GitHub 更新提示，并支持曲线点单击输入 (#34)
- Feat/history persist (#32)
- feat: 硬盘序列号展示与隐私隐藏,Release 支持双架构打包 (#29)
- refactor: 移除APIKey鉴权，统一走飞牛网关并清理无用代码 (#24)
- fix: 修复风扇绑定错误，前端去重改用稳定标识 (#23)
- fix: 修复传参类型错误 (#22)
- feat: 引入风扇稳定ID与路径自动同步，重启免重扫，隐藏前端路径项 (#21)
- fix: 统一默认曲线，修复新风扇参数缺失 (#20)
- feat: 支持自定义 CPU/GPU 传感器温度读取，CI 构建 url/iframe 双版本 (#19)
- 接入 fnOS 统一网关与登录认证 (#18)
- fix: 修复 CPU 温度读取失败问题 & 完善文档 & 升级版本至 1.2.3 (#13)
- 删除风扇时恢复硬件自动调速
- feat: 风扇独立配置、降级策略、UI优化及健壮性提升 (#10)
- 风扇独立配置、降级策略、UI优化及滞回修复 (#9)
