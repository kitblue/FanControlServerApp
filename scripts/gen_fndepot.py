#!/usr/bin/env python3
"""
gen_fndepot.py — 生成 FnDepot 仓库模式所需的目录结构（在当前仓库内）

FnDepot 客户端"仓库模式"要求源仓库满足：
  - 根目录存在 fnpack.json（大小写敏感，固定读根目录该文件名）
  - 每个应用拥有独立目录 {app_name}/，内含：
      icon.png   # 应用图标（统一小写命名）
      README.md  # 应用详情文档
      Preview/   # 预览图目录（可选）

V2 客户端不再强制仓库名为 FnDepot，因此本仓库（kitblue/FanControlServerApp）
可直接作为第三方源添加（老版本即以 JSON 直链 / 仓库模式添加成功）。

本脚本：
  1. 将 icons/fancontrol.png 镜像为 FanControlServer/icon.png（应用目录，小写）
  2. 生成 FanControlServer/README.md（应用详情，与 README.md 简介同源）
  3. 将 fnpack.json 的 icon_url 改写为相对路径 FanControlServer/icon.png
     （V2 规范支持相对 URL，相对 JSON 所在地址解析，便于国内 CDN 加速）

用法
  CI:  python scripts/gen_fndepot.py
  本地: python scripts/gen_fndepot.py
"""

import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "FanControlServer"  # 与 fnpack.json apps 键名 / manifest appname 一致

# 图标候选（按优先级）
ICON_CANDIDATES = [
    ROOT / "icons" / "fancontrol.png",
    ROOT / "ICON.PNG",
    ROOT / "icon_64.png",
    ROOT / "logo.png",
]


def find_icon() -> Path:
    for cand in ICON_CANDIDATES:
        if cand.exists():
            return cand
    raise SystemExit(f"错误: 未找到可用图标（尝试 {[c.name for c in ICON_CANDIDATES]}）")


def main() -> None:
    fnpack_path = ROOT / "fnpack.json"
    if not fnpack_path.exists():
        raise SystemExit(f"错误: 未找到 {fnpack_path}，请先运行 CI 或 scripts/gen_fnpack.py")

    with open(fnpack_path, "r", encoding="utf-8") as f:
        fnpack = json.load(f)

    app_dir = ROOT / APP_NAME
    app_dir.mkdir(parents=True, exist_ok=True)

    # 1) 图标镜像：FanControlServer/icon.png（统一小写命名）
    icon_src = find_icon()
    icon_dst = app_dir / "icon.png"
    icon_dst.write_bytes(icon_src.read_bytes())
    print(f"图标: {icon_src.name} -> {icon_dst.relative_to(ROOT)}")

    # 2) 应用详情 README（以仓库 README 简介为来源，去标题行）
    readme_src = ROOT / "README.md"
    if readme_src.exists():
        text = readme_src.read_text(encoding="utf-8")
        # 取首个 "## " 之前的内容，去掉一级标题行、logo 图片行与引用块行（> ...），作为应用简介
        desc = text.split("\n## ", 1)[0]
        lines = [ln for ln in desc.splitlines() if not ln.startswith("# ") and not ln.startswith("![") and not ln.lstrip().startswith(">")]
        intro = "\n".join(lines).strip()
        app_readme = f"# {APP_NAME}\n\n{intro}\n\n- 主页：https://github.com/kitblue/FanControlServerApp\n- 问题反馈：https://github.com/kitblue/FanControlServerApp/issues\n"
        (app_dir / "README.md").write_text(app_readme, encoding="utf-8")
        print(f"应用详情: {app_dir / 'README.md'}")

    # 3) fnpack.json icon_url 改相对路径（V2 支持相对 URL，统一小写）
    for entry in fnpack.get("apps", {}).values():
        entry["icon_url"] = f"{APP_NAME}/icon.png"
    with open(fnpack_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(fnpack, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"fnpack.json icon_url 已改为相对路径: {APP_NAME}/icon.png")

    print("完成：FnDepot 仓库模式结构已就绪")


if __name__ == "__main__":
    main()
