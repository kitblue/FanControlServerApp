#!/usr/bin/env python3
"""
sync_app_desc.py — 从 README.md 提取简介（首个 ## 之前，去掉一级标题行、logo 图片行、引用块行）经 md_to_html 转 HTML 写入 manifest desc 字段。
"""


import sys
from pathlib import Path


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


ROOT = Path(__file__).resolve().parent.parent




def md_to_html(text: str) -> str:
    text = text.strip()
    text = text.replace("\r\n", "\n")
    text = text.replace("\n\n", "<br><br>")
    text = text.replace("\n", "<br>")
    return text




def extract_desc_from_readme(raw: str) -> str:
    lines = raw.splitlines()
    end = 0
    for i, line in enumerate(lines):
        if line.startswith("## "):
            end = i
            break
    block = lines[:end]
    if not block:
        return "\n".join(block)
    block = block[1:]  # 去掉第一行 # ... 一级标题

    # 去掉 logo 图片行（![...](...)）与引用块行（> ...），只保留纯文本介绍段落
    kept = []
    for line in block:
        s = line.strip()
        if s.startswith("![") or s.startswith(">"):
            continue
        kept.append(line)

    # 折叠连续空行，保留段落间的单个空行
    out = []
    prev_blank = False
    for line in kept:
        if line.strip() == "":
            if prev_blank:
                continue
            prev_blank = True
        else:
            prev_blank = False
        out.append(line)
    return "\n".join(out).strip()


def main() -> None:
    manifest_path = ROOT / "manifest"
    if not manifest_path.exists():
        raise SystemExit(f"错误: 未找到 {manifest_path}，manifest 为唯一写入目标")
    readme_path = ROOT / "README.md"
    if not readme_path.exists():
        raise SystemExit(f"错误: 未找到 {readme_path}，项目介绍以该文件为唯一事实来源")
    desc = md_to_html(extract_desc_from_readme(readme_path.read_text(encoding="utf-8")))
    lines = manifest_path.read_text(encoding="utf-8").splitlines(keepends=True)
    replaced = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("desc"):
            lines[i] = f"desc                  = {desc}\n"
            replaced = True
            break
    if not replaced:
        raise SystemExit("错误: manifest 中未找到 desc 字段")
    manifest_path.write_text("".join(lines), encoding="utf-8")
    print(f"manifest desc 已同步（{len(desc)} 字符）")


if __name__ == "__main__":
    main()
