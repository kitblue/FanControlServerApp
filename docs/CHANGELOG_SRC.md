## v1.3.8

- refactor: 后端按领域模块化拆分（服务/驱动/热管理/指标/更新/配置独立包），消除大控制器内聚
- perf: 采集与落库引入 singleflight 并发合并与 SQLite WAL，历史曲线连续可靠
- refactor: 硬件采集改用 gopsutil，替代手写 /proc 解析
- refactor: 前端 main.ts 模块化拆分（ws/store/ui 分层），echarts 按需引入
- ci: 接入构建门禁（tsc/eslint 静态检查、golangci-lint、单元测试、setup-go 构建缓存）
- test: 新增版本比较、热管理、fnpack schema 单元测试
- chore: fpk 瘦身与产物命名规范化，清理旧打包产物与冗余二进制
- refactor: 移除后台闭环分流与活跃检测，后端始终全量采集落库，关窗期间历史曲线连续完整
- fix: 应用标识全链路统一小写 fancontrolserver，修复聚合源版本更新无法识别的问题
- fix: 修复前端启动报错（历史曲线对空温度序列崩溃）
- fix: 修复扫描风扇列表不显示传感器
- fix: 修复 CPU/GPU/内存环形占用图比例跳脱与 0% 显示异常
- feat: 风扇温度源支持用户所选传感器组合（max/avg），历史曲线增加对应聚合温度曲线
- feat: 项目分类调整为"系统工具"
- docs: 重建简介与更新日志，同步发布文档
- version: 脱离上游版本线，独立发版 v1.3.8

## v1.3.7.1

- rebrand: FanTune 更名为 Fan Control Server（定制版），与官方版名称区分、可并存安装
- feat: 内置 qnap8528 驱动（IT8528 EC 机型自动编译加载），官方版仅依赖内核通用驱动
- feat: GPU 探测覆盖 NVIDIA/AMD/Intel 全平台温度与使用率，官方版仅支持 NVIDIA 独显温度
- feat: 硬盘温度优先 sysfs hwmon 直读（零进程开销、不唤醒休眠盘），失败回退 smartctl，官方版仅走 smartctl 子进程
- feat: 版本更新检查增加 CDN 降级，规避 GitHub API 限流
- feat: 支持自定义 CPU/GPU 传感器温度读取
- feat: 风扇稳定 ID 与路径自动同步，重启免重扫
- feat: 历史曲线持久化
- feat: 风扇独立配置、降级策略与滞回修复
- feat: 启动延时、调速曲线点位列表编辑
- feat: 接入 fnOS 统一网关与登录认证
- refactor: 移除 API Key 鉴权，统一走飞牛网关
- docs: 商店介绍标明与官方版差异
