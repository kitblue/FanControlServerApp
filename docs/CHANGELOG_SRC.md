## v1.3.7.37

- fix: 净化 CHANGELOG/fnpack.json 噪音，CI 无变化时跳过构建并支持 npm 回退
- mark qnap8528 kernel source as vendored

## v1.3.7.35

- fix: zero-value null fans/sensors in Telemetry()
- default update interval from 2s to 1s
- fix: handle null fans in runtimeFor

## v1.3.7.34

- fix(icon): 主体放大撑满画布，解决桌面图标显示偏小（保持比例不扭曲）

## v1.3.7.33

- fix(icon): 重新生成去QFC图标，保持主体比例不扭曲

## v1.3.7.32

- icon: 移除图标底部 QFC 文字，主体图像铺满
- rename: QNAP Fan Control → FanTune (通用 NAS 风扇管理，去品牌化)

## v1.3.7.30

- fix: point fnpack.json icon_url to lowercase icon.png
- fix: use lowercase icon.png in FnDepot app dir, drop stale ICON.PNG

## v1.3.7.29

- feat: 应用图标全面换新——统一采用全新 Logo（立体风扇 + 主机 + QFC），替换商店图标、前端界面图标、README 及打包内全部图标资源
- feat: Intel GPU 使用率改为 i915 PMU 直读优先（rcs0/vcs0/bcs0 busy 差分实时计算），intel_gpu_top 降级为兜底，读数更精准、不再阻塞推送链路
- fix: GPU 使用率与 GPU 温度共用同一传感器选择——设置中手动切换 GPU 传感器后，温度与使用率实时跟随；按所选通道的芯片（NVIDIA/AMD/Intel）走对应探测路径

## v1.3.7.28

- feat: GPU 使用率与 GPU 温度共用同一传感器选择——设置中手动切换 GPU 传感器后，温度与使用率实时跟随；按所选通道的芯片（NVIDIA/AMD/Intel）走对应探测路径，多卡环境按 PCI 设备精确对应
- fix: intel_gpu_top 采集不再阻塞推送链路——改为后台监视循环每 4 秒刷新缓存，前端使用率实时刷新（修复上一版每帧同步阻塞 4 秒导致的"不实时"）
- fix: 精简环境无 timeout 命令时，intel_gpu_top 改用 CommandContext 超时兜底，避免 i915 核显探测失败
- docs: 设置页 GPU 传感器提示文案更新，README 补充 Intel 核显使用率依赖说明

## v1.3.7.27

- fix: 彻底修复 GPU 使用率不显示——intel_gpu_top 为持续流式进程，旧实现用 Output() 等待退出致超时后丢弃输出，i915 核显永远读取失败；改为 timeout 限时运行并解析已输出 JSON，取各引擎 busy 最大值
- fix: 修复 GPU 环形图传参——gpu_usage 为 0-100 百分比却被除以 100 当 0-1 小数传入，数字与环形图恢复同步显示
- feat: fnpack.json 补充 history 更新记录，FnDepot 商店可见历史版本日志

## v1.3.7.26

- fix: 商店六项体验修复（更新权限/预览图/GPU使用率兜底/版本号布局/名称图标统一/日志去重）

## v1.3.7.25

- fix: 商店六项体验修复（更新权限/预览图/GPU使用率兜底/版本号布局/名称图标统一/日志去重）

## v1.3.7.24

- 修复：FnDepot 源添加失败（platform 回退 x86、install_type 默认 fpk），商店可正常加源并拉取 FPK
- 修复：manifest desc 空置问题，sync_app_desc.py 补写入逻辑，README 简介自动同步进商店
- 修复：CI 版本递增请求增加 GITHUB_TOKEN 防限流，sync.yml 自身纳入自更新提交
- 修复：清理根目录遗留图标与 app/ui/images 重复图标，gen_fndepot.py 生成的应用文档过滤引用块
- 其他：默认版本号对齐 1.3.7.24，README 本地构建示例修正

## v1.3.7.21

- 修复：检查更新发现新版本后更新说明弹窗不弹出的问题（补回触发按钮）

## v1.3.7.20

- GPU 使用率支持扩展：NVIDIA 多卡取负载最高的一张；AMD 独显 / Intel 核显与 Arc 通过内核 sysfs gpu_busy_percent 读取利用率
- README.md 完整重写：补充功能特性、支持的 GPU、安装与使用、项目结构、本地构建与发布流程说明
- 简介单一事实来源收敛：manifest 与 fnpack.json 的 desc 由 CI 编译时从 README.md 自动同步，移除 docs/APP_DESC.md
