#!/usr/bin/env python3
"""Parse the 4 Buddhist sutta markdown files into a JSON data file."""
import json, re, sys
from pathlib import Path

FILES = {
    "buddha": {
        "title": "佛陀个人经历与经验",
        "title_en": "The Buddha's Life & Experience",
        "icon": "☸️",
        "path": "巴利三藏中佛陀个人经历与经验相关经文整理.md",
    },
    "concepts": {
        "title": "术语与概念",
        "title_en": "Key Terms & Concepts",
        "icon": "📖",
        "path": "巴利三藏术语概念相关经文整理.md",
    },
    "laypeople": {
        "title": "在家众相关",
        "title_en": "For Lay Practitioners",
        "icon": "🏠",
        "path": "巴利三藏在家众相关经文整理.md",
    },
    "meditation": {
        "title": "禅修相关",
        "title_en": "Meditation Practice",
        "icon": "🧘",
        "path": "巴利三藏禅修相关经文整理.md",
    },
}

BASE = Path("/Users/xiebeichen/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault/🧠 Learnings/☸️ Buddhism")

def extract_uid_from_url(url):
    m = re.search(r'suttacentral\.net/([^/]+)/', url)
    if m:
        return m.group(1).lower()
    m = re.search(r'suttacentral\.net/([^/\?]+)', url)
    if m:
        return m.group(1).lower()
    return ""

def extract_link_url(cell):
    m = re.search(r'\[([^\]]*)\]\(([^)]+)\)', cell)
    if m:
        return m.group(2)
    return ""

def parse_table_row(row):
    cells = [c.strip() for c in row.split('|')]
    cells = [c for c in cells if c != '']
    return cells

def parse_markdown(filepath, category_key):
    text = filepath.read_text(encoding='utf-8')
    lines = text.split('\n')

    sections = []
    current_section = ""
    current_subsection = ""
    suttas = []

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        if line.startswith('## ') and not line.startswith('## 收录口径') and not line.startswith('## 总体线索') and not line.startswith('## 主题索引') and not line.startswith('## 阅读顺序'):
            current_section = line[3:].strip()
            current_subsection = ""
        elif line.startswith('### '):
            current_subsection = line[4:].strip()
        elif line.startswith('|') and i + 1 < len(lines) and '---' in lines[i + 1]:
            header_cells = parse_table_row(line)
            i += 1  # skip separator
            i += 1  # start data rows

            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = parse_table_row(lines[i].strip())
                if len(cells) < 3:
                    i += 1
                    continue

                sutta_name = cells[0].strip()

                en_url = ""
                zh_url = ""
                focus = ""
                summary = ""

                for ci, cell in enumerate(cells):
                    url = extract_link_url(cell)
                    if url:
                        if '/en/' in url or ('suttacentral' in url and '/zh/' not in url and 'lang=zh' not in url and not en_url):
                            en_url = url
                        if '/zh/' in url or 'lang=zh' in url:
                            zh_url = url

                # Detect column mapping from headers
                col_map = {}
                for ci, hdr in enumerate(header_cells):
                    h = hdr.strip()
                    if h in ('阶段',):
                        col_map['name'] = ci
                    if h in ('主要材料',):
                        col_map['materials'] = ci
                    if h in ('内容主轴',):
                        col_map['axis'] = ci

                if 'materials' in col_map:
                    # 总体线索 table: 阶段 | 主要材料 | 内容主轴
                    focus = cells[col_map['axis']] if 'axis' in col_map and len(cells) > col_map['axis'] else ""
                    summary = cells[col_map['materials']] if len(cells) > col_map['materials'] else ""
                elif len(header_cells) >= 5:
                    if any(k in header_cells[1] for k in ['重点', '概念重点', '禅修重点']):
                        focus = cells[1] if len(cells) > 1 else ""
                        summary = cells[2] if len(cells) > 2 else ""
                    elif '内容总结' in header_cells[1]:
                        summary = cells[1] if len(cells) > 1 else ""
                elif len(header_cells) >= 4:
                    if '内容总结' in header_cells[1]:
                        summary = cells[1] if len(cells) > 1 else ""
                    elif any(k in header_cells[1] for k in ['重点', '概念重点', '禅修重点']):
                        focus = cells[1] if len(cells) > 1 else ""
                        summary = cells[2] if len(cells) > 2 else ""
                elif len(header_cells) >= 3:
                    summary = cells[1] if len(cells) > 1 else ""

                # clean markdown links from summary/focus
                summary = re.sub(r'\[([^\]]*)\]\([^)]+\)', r'\1', summary)
                focus = re.sub(r'\[([^\]]*)\]\([^)]+\)', r'\1', focus)

                uid = extract_uid_from_url(en_url) or extract_uid_from_url(zh_url)

                # Extract English translator from URL
                en_author = "sujato"
                m = re.search(r'/en/(\w+)', en_url)
                if m:
                    en_author = m.group(1)

                zh_author = "zhuang"
                m = re.search(r'/zh/(\w+)', zh_url)
                if m:
                    zh_author = m.group(1)

                if uid or sutta_name:
                    suttas.append({
                        "uid": uid,
                        "name": sutta_name,
                        "focus": focus,
                        "summary": summary,
                        "en_url": en_url,
                        "zh_url": zh_url,
                        "en_author": en_author,
                        "zh_author": zh_author,
                        "section": current_section,
                        "subsection": current_subsection,
                    })

                i += 1
            continue

        i += 1

    # Extract theme index if present
    themes = []
    theme_section = re.search(r'## 主题索引\s*\n([\s\S]*?)(?=\n## |\Z)', text)
    if theme_section:
        for line in theme_section.group(1).split('\n'):
            if line.strip().startswith('|') and '---' not in line:
                cells = parse_table_row(line.strip())
                if len(cells) >= 2 and cells[0] not in ('主题', '术语/概念'):
                    themes.append({"topic": cells[0], "suttas": cells[1]})

    return suttas, themes


def main():
    all_data = {"categories": {}}

    for key, info in FILES.items():
        filepath = BASE / info["path"]
        if not filepath.exists():
            print(f"WARNING: {filepath} not found")
            continue

        suttas, themes = parse_markdown(filepath, key)
        print(f"{key}: {len(suttas)} suttas, {len(themes)} themes")

        # Group by section
        sections_order = []
        sections_map = {}
        for s in suttas:
            sec_key = s["subsection"] or s["section"]
            if sec_key not in sections_map:
                sections_map[sec_key] = {
                    "title": sec_key,
                    "section": s["section"],
                    "suttas": []
                }
                sections_order.append(sec_key)
            sections_map[sec_key]["suttas"].append({
                k: v for k, v in s.items() if k not in ("section", "subsection")
            })

        all_data["categories"][key] = {
            "title": info["title"],
            "title_en": info["title_en"],
            "icon": info["icon"],
            "sections": [sections_map[k] for k in sections_order],
            "themes": themes,
        }

    out = Path(__file__).parent / "docs" / "suttas.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)

    total = sum(sum(len(sec["suttas"]) for sec in cat["sections"]) for cat in all_data["categories"].values())
    print(f"\nTotal: {total} suttas → {out}")


if __name__ == "__main__":
    main()
