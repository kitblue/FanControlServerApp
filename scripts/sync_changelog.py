#!/usr/bin/env python3
"""
sync_changelog.py — 自动为当前版本生成更新日志（不再写死旧版本内容）

流程:
1. 读取 manifest 中当前版本号 V（CI Auto-increment 已把新版本写入 manifest）
2. 若 docs/CHANGELOG_SRC.md 顶部已存在 ## v{V} 块，直接复用（人工可编辑补充）
3. 否则基于 git 提交历史自动生成 v{V} 块：
   - 取上一个发布 tag（按版本号排序的最高 tag，通常为 v{上一版}）
   - git log <prev_tag>..HEAD 提取提交信息，过滤噪音提交
4. 将 v{V} 块写入 CHANGELOG.md（作为 Release 正文），并同步插入 CHANGELOG_SRC.md 顶部
"""

import re
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest"
SRC = ROOT / "docs" / "CHANGELOG_SRC.md"
OUT = ROOT / "CHANGELOG.md"

NOISE_PATTERNS = [
    r"^chore(\([^)]*\))?:",
    r"^ci(:|\()",
    r"^merge (pull request|branch|remote-tracking)",
    r"\[skip ci\]",
    r"^auto-increment version",
    r"^update (manifest|fnpack\.json)",
]


def current_version() -> str:
    text = MANIFEST.read_text(encoding="utf-8")
    m = re.search(r"^version\s*=\s*([\d.]+)", text, re.MULTILINE)
    if not m:
        raise SystemExit("错误: manifest 中未找到 version 字段")
    return m.group(1)


def get_tags() -> list[str]:
    """返回按版本号升序排序的 v* tag 列表"""
    out = subprocess.run(["git", "tag", "-l", "v*"], capture_output=True, text=True)
    tags = [t.strip() for t in out.stdout.splitlines() if t.strip()]

    def key(t):
        nums = re.findall(r"\d+", t)
        return tuple(int(n) for n in nums)

    return sorted(tags, key=key)


def gen_block(version: str) -> str:
    tags = get_tags()
    if tags:
        prev = tags[-1]
        # 若最高 tag 恰好等于当前版本（重跑场景），取次高 tag
        if prev.lstrip("vV") == version and len(tags) >= 2:
            prev = tags[-2]
        commits = subprocess.run(
            ["git", "log", f"{prev}..HEAD", "--pretty=format:%s"],
            capture_output=True, text=True,
        ).stdout.splitlines()
    else:
        commits = subprocess.run(
            ["git", "log", "--pretty=format:%s", "-n", "30"],
            capture_output=True, text=True,
        ).stdout.splitlines()

    items = []
    seen = set()
    for c in commits:
        c = c.strip()
        if not c:
            continue
        if any(re.search(p, c, re.IGNORECASE) for p in NOISE_PATTERNS):
            continue
        # 去重：同一提交信息（如重复 merge/同步提交）只显示一遍，保持出现顺序
        if c in seen:
            continue
        seen.add(c)
        items.append(f"- {c}")

    if not items:
        items = ["- 本次发布包含构建、依赖与 CI 流程更新"]

    return f"## v{version}\n\n" + "\n".join(items)


def main() -> None:
    version = current_version()
    header = f"## v{version}"

    # 1) 优先复用 SRC 顶部已有同版本块（人工可编辑）
    src_lines = SRC.read_text(encoding="utf-8").splitlines() if SRC.exists() else []
    start = next((i for i, l in enumerate(src_lines) if l.startswith("## ")), None)
    if start is not None and src_lines[start] == header:
        end = next(
            (i for i in range(start + 1, len(src_lines)) if src_lines[i].startswith("## ")),
            len(src_lines),
        )
        block = "\n".join(src_lines[start:end]).strip()
        print(f"复用 CHANGELOG_SRC.md 中已有 {header} 块")
    else:
        # 2) 从 git 提交历史自动生成当前版本日志
        block = gen_block(version)
        # 3) 同步写入 CHANGELOG_SRC.md 顶部（保留历史块）
        rest = "\n".join(src_lines).strip()
        new_src = block + ("\n\n" + rest if rest else "") + "\n"
        SRC.write_text(new_src, encoding="utf-8", newline="\n")
        print(f"已自动生成 {header} 并写入 CHANGELOG_SRC.md 顶部")

    OUT.write_text(block + "\n", encoding="utf-8", newline="\n")
    print(f"CHANGELOG.md 已更新为 {header}（{len(block)} 字符）")


if __name__ == "__main__":
    main()
