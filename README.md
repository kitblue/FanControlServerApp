# Fan Control Server（定制版）— NAS 智能风扇与温度管理

![logo](ICON.PNG)

**Fan Control Server（定制版）** 基于开源 [FanControlServer](https://github.com/guan-ry/FanControlServerApp) 二次开发，专为飞牛 OS（fnOS）及 x86 主板设计：温控曲线、多风扇管理、实时硬件监控。与官方版名称明确区分，可并存安装、互不冲突。

**相对官方版的核心增强：**

- **驱动**：内置 IT8528 EC 专用 [qnap8528 驱动](https://github.com/iamiao/8528)，安装/升级时自动编译加载；IT87/NCT6775 等通用芯片由 fnOS 内置驱动直接支持
- **GPU**：NVIDIA/AMD/Intel 全平台温度与使用率，多卡自动取负载最高
- **硬盘温度**：优先 sysfs hwmon 直读 NVMe/SATA 盘温，零进程开销、不唤醒休眠硬盘，失败才回退 smartctl
- **CPU**：温度经 hwmon 传感器读取（可自定义），使用率由 /proc/stat 计算

适配飞牛 OS 应用中心，仓库自带 FnDepot V2 索引（fnpack.json），可直接作为第三方应用源添加，在商店中一键安装。

> README.md 为简介唯一事实来源，manifest desc 与 fnpack.json desc 由 CI 编译时自动同步。


## 与官方版的差异（本定制版 vs 官方版）



| 能力 | 官方版 Fan Control Server | 本定制版（本分支） |

|---|---|---|

| 名称 | Fan Control Server | **Fan Control Server（定制版）**（商店/桌面入口均不同，安装后互不冲突） |

| 驱动 | 仅依赖内核通用驱动（IT87/NCT6775 等由 fnOS 提供） | 同左 + 内置 **qnap8528 驱动**（IT8528 EC 机型安装/升级时自动编译加载，支持风扇控制、温度传感器、LED、按键、VPD 读取） |

| GPU 温度 | 仅 NVIDIA：`nvidia-smi --query-gpu=temperature.gpu` | NVIDIA/AMD/Intel 全覆盖：`nvidia-smi` → hwmon 独显（amdgpu/radeon/arc）→ hwmon 核显（i915/xe）→ 通用 gpu/drm 兜底 |

| GPU 使用率 | **不支持** | `nvidia-smi`（多卡取最大）→ sysfs `gpu_busy_percent` → i915 PMU 直读（perf_event_open，零阻塞）→ `intel_gpu_top` 后台监视兜底 |

| 硬盘温度 | `smartctl` 子进程读取 | 优先 sysfs hwmon 直读 NVMe/SATA 盘温（零进程开销、不唤醒休眠硬盘），失败回退 `smartctl`；带 standby 休眠检测 |

| CPU 温度 | hwmon 传感器（支持自定义传感器） | 与官方版一致 |

| CPU 使用率 | `/proc/stat` | 与官方版一致 |

| 版本更新检查 | GitHub API | GitHub API → releases/latest 302 → jsDelivr CDN 三级降级，规避 API 限流 |



## 功能特性



- 🌬️ 风扇控制：独立设置每个风扇的智能温控曲线，手动/自动随时切换，0‑255 精确 PWM

- 🌡️ 硬件监控：CPU/GPU/内存/硬盘温度与使用率、NVMe/SATA 温度、历史温度曲线图表

- 🔔 安全机制：可配置过热阈值超限强制全速、停转温差防频繁启停、系统登录态 + 管理员写保护

- 🎛️ 通用芯片支持：IT87/NCT6775 等主流 Super I/O 风扇芯片直接支持（fnOS 已内置驱动）；IT8528 EC 机型自动编译安装 qnap8528-kmod 备用驱动

- ⚙️ 深色 Web 界面：响应式、WebSocket 实时推送，经 fnOS 网关 `/app/FanControlServer` 访问



## 支持的 GPU



- **NVIDIA 独显**：通过 `nvidia-smi` 读取温度与利用率，多卡环境自动取负载最高的一张

- **AMD 独显**：通过内核 amdgpu 驱动读取温度（hwmon）与利用率（sysfs `gpu_busy_percent`）

- **Intel 核显 / Arc 独显**：通过 i915/xe 驱动读取温度（hwmon）与利用率（sysfs `gpu_busy_percent`，旧核显 i915 走 PMU 直读）



## 安装与使用（FnDepot 第三方源）



本仓库根目录自带 FnDepot V2 规范索引 `fnpack.json`，可直接作为第三方源添加，无需独立源仓库：



- **仓库模式**：添加源时填入仓库地址 `https://github.com/kitblue/FanControlServerApp`（V2 客户端对仓库名不强制为 FnDepot，仓库根目录含 `fnpack.json` 与 `FanControlServer/` 应用目录即可）

- **JSON 直链模式**（老版本即用此方式，兼容性最稳）：

  - `https://raw.githubusercontent.com/kitblue/FanControlServerApp/main/fnpack.json`

  - 国内加速：`https://cdn.jsdelivr.net/gh/kitblue/FanControlServerApp@main/fnpack.json`



添加步骤：



1. 在飞牛 OS 应用中心 → 第三方商店 → 添加源，填入上述任一地址

2. 同步后搜到 **Fan Control Server（定制版）** → 安装（内置 qnap8528 驱动，自动编译加载）

3. 首次启动会自动安装 IT8528 内核驱动（需联网编译）

4. 浏览器访问 `http://<NAS IP>:5666/app/FanControlServer`（或从 fnOS 应用中心点击图标进入）

5. 在「设置」页配置温控曲线与安全阈值，开启自动控制



> 注意：商店中的 **Fan Control Server（定制版）**（本定制分支）与 **Fan Control Server**（官方版）是两个可并存的独立应用，安装互不影响。



## 项目结构



```

├── backend/            # Go 后端：温度/风扇采集、GPU 探测（含 qnap8528 驱动加载）、WebSocket 推送

│   └── internal/driver/  # gpu.go（NVIDIA/AMD/Intel 探测链）、smartctl.go（sysfs 直读盘温）

├── frontend/           # Vite + TypeScript 前端（构建产物进入 backend/web）

├── app/qnap8528-src/   # IT8528 EC 内核驱动源码（DKMS，安装时自动编译）

├── scripts/            # 构建、简介同步、FnDepot 源生成脚本

├── .github/workflows/  # CI：发版同步 fnpack.json + FanControlServer/ 应用目录

├── manifest            # fnOS 应用清单（desc 由 CI 从 README 自动同步）

├── FanControlServer/   # FnDepot 应用目录（icon.png / Preview / README.md）

├── fnpack.json         # FnDepot 索引（desc 由 CI 从 README 自动同步）

└── README.md           # 项目简介唯一事实来源

```



## 本地构建



```bash

# 前端

cd frontend && npm install && npm run build

# 后端（Linux amd64）

cd backend && GOOS=linux GOARCH=amd64 go build -o ../app/server/fancontrolserver .

# 打包 FPK（需安装 fnpack）

fnpack build

# 生成 FnDepot 源内容（可选，本地预览）

python scripts/gen_fndepot.py

```



## 发布流程



每次 CI 运行会自动完成：跟随官方上游版本号 → 构建前端与后端 → 从 README.md 提取简介同步进 manifest 与 fnpack.json → 构建 FPK 并上传 Release（正文取 CHANGELOG.md）→ 运行 `scripts/gen_fndepot.py` 刷新 `FanControlServer/` 应用目录与 fnpack.json 图标相对路径 → 提交更新。修改 README.md 简介或 CHANGELOG.md 更新日志后触发 CI 即可全渠道同步，无需手动改各文件。



## 致谢与许可



- 基于 [FanControlServer](https://github.com/guan-ry/FanControlServerApp) 二次开发

- IT8528 内核驱动来自 [iamiao/8528](https://github.com/iamiao/8528)

- GPU 识别思路参考 [fan2go](https://github.com/markusressel/fan2go)（作者 markusressel，许可证 AGPL-3.0）

- 本项目为个人维护的第三方开源应用，与 QNAP 官方无关

