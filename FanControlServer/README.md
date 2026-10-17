# FanControlServer

<b>FanTune</b> 是基于开源项目 <a href="https://github.com/guan-ry/FanControlServerApp" target="_blank">FanControlServer</a>（guan-ry/FanControlServerApp）品牌定制的智能风扇与温度管理工具，专为飞牛私有云及 x86 主板设计：温控曲线、多风扇管理、实时硬件监控。商店中的 FanTune 与官方版 Fan Control Server 名称明确区分、可并存安装、互不冲突。

<b>与官方版的差异：</b>

- <b>驱动</b>：官方版仅依赖内核通用驱动；FanTune 额外内置 IT8528 EC 机型专用 <a href="https://github.com/iamiao/8528" target="_blank">qnap8528 驱动</a>，安装/升级时自动编译加载，支持风扇控制、温度传感器、LED、按键和 VPD 读取（IT87/NCT6775 等通用 Super I/O 芯片由 fnOS 内置驱动直接支持）

- <b>GPU 信息</b>：官方版仅支持 NVIDIA 独显温度读取（nvidia-smi）；FanTune 支持 NVIDIA/AMD/Intel 全平台 GPU 温度与使用率，探测链 nvidia-smi → hwmon（amdgpu/radeon/i915/xe）→ sysfs gpu_busy_percent → i915 PMU 直读 → intel_gpu_top 兜底，多卡自动取负载最高

- <b>硬盘温度</b>：官方版调用 smartctl 子进程；FanTune 优先 sysfs hwmon 直读 NVMe/SATA 盘温，零进程开销、不唤醒休眠硬盘（带 standby 检测），读取失败才回退 smartctl

- <b>CPU 信息</b>：温度经 hwmon 传感器读取（可在设置中自定义传感器），使用率由 /proc/stat 计算，与官方版一致

适配飞牛 OS（fnOS）应用中心，本仓库即 FnDepot 第三方源（仓库模式或 JSON 直链均可添加），可在商店一键安装。

- 主页：https://github.com/kitblue/FanControlServerApp
- 问题反馈：https://github.com/kitblue/FanControlServerApp/issues
