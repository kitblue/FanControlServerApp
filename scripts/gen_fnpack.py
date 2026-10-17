#!/usr/bin/env python3

"""

gen_fnpack.py — 基于本地构建产物生成 FnDepot V2 索引 fnpack.json



单应用模式：从 dist/ 下的 FPK 读取 manifest，计算 sha256/size，生成 fnpack.json。



用法

  CI（GitHub Actions）:

      python scripts/gen_fnpack.py

  本地:

      python scripts/gen_fnpack.py



输出

  <repo>/fnpack.json

"""



import hashlib

import json

import os

import re

import sys

import tarfile

from pathlib import Path



try:

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

except Exception:

    pass



# - 配置 -



REPO_SLUG = os.environ.get("GITHUB_REPOSITORY", "kitblue/FanControlServerApp")

RAW_BASE = f"https://raw.githubusercontent.com/{REPO_SLUG}/main"



ROOT = Path(__file__).resolve().parent.parent

OUTPUT = ROOT / "fnpack.json"

DIST = ROOT / "dist"



APP_VERSION = os.environ.get("APP_VERSION", "1.3.7.37")

APP_ASSET = os.environ.get("APP_ASSET", f"fancontrolserver-v{APP_VERSION}-linux-amd64-iframe.fpk")



# 复用 sync_app_desc 的 md-to-html 转换与 README 提取函数（项目介绍单一事实来源 README.md）

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sync_app_desc import md_to_html, extract_desc_from_readme  # noqa: E402



README_MD = ROOT / "README.md"



if not README_MD.exists():

    raise SystemExit(f"错误: 未找到 {README_MD}，项目介绍以该文件为唯一事实来源")



# 从 README.md 首个 ## 之前提取纯文本简介（去标题、logo 图片行、引用块行）

README_TEXT = README_MD.read_text(encoding="utf-8")

DESC_PLAIN = extract_desc_from_readme(README_TEXT)



SOURCE_INFO = {

    "name": "Fan Control Server（定制版）",

    "author": "Kitblue",

    "homepage": f"https://github.com/{REPO_SLUG}",

    "description": DESC_PLAIN,

}



APP_OVERRIDES = {

    "display_name": "Fan Control Server（定制版）",

    "desc": md_to_html(DESC_PLAIN),

}





# - 基础工具 -



def sha256_of(path: Path) -> str:

    h = hashlib.sha256()

    with open(path, "rb") as f:

        for chunk in iter(lambda: f.read(1 << 16), b""):

            h.update(chunk)

    return h.hexdigest()





def read_manifest(fp: Path) -> dict:

    with tarfile.open(fp, "r:gz") as t:

        raw = t.extractfile("manifest").read().decode("utf-8", errors="replace")

    out = {}

    for line in raw.splitlines():

        if "=" in line:

            k, v = line.split("=", 1)

            out[k.strip()] = v.strip()

    return out





def read_changelog_history() -> dict:

    """从 docs/CHANGELOG_SRC.md（回退 CHANGELOG.md）解析全量版本块，生成 FnDepot history 字段。



    FnDepot 商店详情页的“更新记录”读取 fnpack.json 应用条目下的 history 字段，

    格式为对象：键=版本号（带 v 前缀），值=该版本更新内容。

    单一事实来源仍为 CHANGELOG_SRC.md（CI 由 sync_changelog.py 自动维护），

    此处仅做解析，不写入、不修改日志源文件。

    """

    src = ROOT / "docs" / "CHANGELOG_SRC.md"

    if not src.exists():

        src = ROOT / "CHANGELOG.md"

    if not src.exists():

        return {}

    text = src.read_text(encoding="utf-8")

    blocks = re.split(r"^##\s+(v[\d.]+)\s*$", text, flags=re.M)

    history = {}

    for i in range(1, len(blocks), 2):

        ver = blocks[i]

        body = blocks[i + 1].strip()

        if body:

            history[ver] = body

    return history





# - 主逻辑 -



def main():

    if not DIST.is_dir():

        raise SystemExit(f"错误: 未找到构建产物目录 {DIST}，请先运行 scripts/build.sh 或 CI 构建步骤")



    fpk_path = DIST / APP_ASSET

    if not fpk_path.exists():

        raise SystemExit(f"错误: 未找到构建产物 {fpk_path}")



    manifest = read_manifest(fpk_path)

    version = manifest["version"]

    size = fpk_path.stat().st_size

    sha256 = sha256_of(fpk_path)

    download_url = f"https://github.com/{REPO_SLUG}/releases/download/v{version}/{APP_ASSET}"



    # platform 合法值仅 all/x86/arm；manifest 为空或非法时回退 x86

    raw_platform = (manifest.get("platform") or "x86").strip().lower()

    if raw_platform not in ("all", "x86", "arm"):

        raw_platform = "x86"



    entry = {

        "appname": "fancontrolserver",
        "display_name": manifest.get("display_name", "FanControlServer"),

        "desc": manifest.get("desc", ""),

        "platform": [raw_platform],

        "categories": ["系统工具"],

        "icon_url": f"{RAW_BASE}/icons/fancontrol.png",

        # FnDepot V2 预览图：应用目录 Preview/ 下的截图，商店详情页展示

        "preview_urls": [

            f"{RAW_BASE}/FanControlServer/Preview/01_overview.png",

            f"{RAW_BASE}/FanControlServer/Preview/02_fans.png",

            f"{RAW_BASE}/FanControlServer/Preview/03_settings.png",

        ],

        "run_as": "root",

        # FnDepot V2：install_type 仅允许空字符串（默认存储空间）或 root（系统空间）

        "install_type": (manifest.get("install_type") or ""),

        "is_docker": False,

        "maintainer": manifest.get("maintainer", "Kitblue"),

        "maintainer_url": manifest.get("maintainer_url", f"https://github.com/{REPO_SLUG}"),

        "distributor": manifest.get("distributor", "Kitblue"),

        "distributor_url": manifest.get("distributor_url", f"https://github.com/{REPO_SLUG}"),

        "desktop_uidir": manifest.get("desktop_uidir", ""),

        "desktop_applaunchname": manifest.get("desktop_applaunchname", ""),

        # FnDepot 商店详情页“更新记录”：对象格式，键=版本号（带 v），值=更新内容

        "history": read_changelog_history(),

        "releases": {

            version: {

                "packages": {

                    "x86": {

                        "download_url": download_url,

                        "sha256": sha256,

                        "size": size,

                    }

                }

            }

        },

    }

    entry.update(APP_OVERRIDES)



    fnpack = {

        "schema_version": "2",

        "source_info": SOURCE_INFO,

        "apps": {

            "fancontrolserver": entry,

        },

    }



    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as f:

        json.dump(fnpack, f, indent=2, ensure_ascii=False)

        f.write("\n")



    print(f"生成: {OUTPUT} ({OUTPUT.stat().st_size} bytes)")

    print(f"[FanControlServer] {APP_ASSET} ({size} bytes, sha256 {sha256[:12]}...)")





if __name__ == "__main__":

    main()

