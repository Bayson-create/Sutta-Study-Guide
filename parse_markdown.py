#!/usr/bin/env python3
"""Parse Buddhist sutta guide markdown files into a JSON data file."""
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
    "expression": {
        "title": "表达、表现与修辞手法",
        "title_en": "Expression & Rhetoric",
        "icon": "🎭",
        "path": "巴利三藏中佛陀表达方式、表现手法与修辞手法相关经文整理.md",
    },
    "language_traps": {
        "title": "语言陷阱与处理方式",
        "title_en": "Language Traps & Responses",
        "icon": "🧩",
        "path": "巴利三藏中佛陀遇到的语言陷阱与处理方式整理.md",
    },
}

# H2 headings whose tables are framework/overview mappings (type -> function ->
# example suttas as plain text), not individual sutta reference rows. Their
# rows are captured separately as `framework_tables` instead of being folded
# into `suttas`, so they don't pollute categories with fake zero-link entries.
FRAMEWORK_HEADINGS = {
    "三部分区分",
    "一、表达方式总览",
    "二、表现手法总览",
    "三、修辞手法总览",
    "三层关系地图",
    "总体地图：语言陷阱与佛陀处理方式",
    "按表达方式索引",
    "按表现手法索引",
    "按修辞手法索引",
    "按处理方式索引",
}

import os
BASE = Path(os.environ.get("SUTTA_NOTES_DIR", ""))

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
    # Only strip the leading/trailing empty artifacts produced by a row that
    # starts and ends with '|'; preserve genuinely empty cells in between
    # (e.g. a blank 中文链接 column) so column indices stay aligned.
    row = row.strip()
    if row.startswith('|'):
        row = row[1:]
    if row.endswith('|'):
        row = row[:-1]
    return [c.strip() for c in row.split('|')]

def parse_markdown(filepath, category_key):
    text = filepath.read_text(encoding='utf-8')
    lines = text.split('\n')

    sections = []
    current_section = ""
    current_subsection = ""
    current_heading_raw = ""  # exact H2 heading text, tracked regardless of skip-list
    suttas = []
    section_intros = {}  # key: subsection or section title -> intro text
    framework_tables = []  # overview/mapping tables (type -> function -> example refs)

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        if line.startswith('## '):
            current_heading_raw = line[3:].strip()
            if not line.startswith('## 收录口径') and not line.startswith('## 总体线索') and not line.startswith('## 主题索引') and not line.startswith('## 阅读顺序'):
                current_section = line[3:].strip()
                current_subsection = ""
        elif line.startswith('### '):
            current_subsection = line[4:].strip()
            # Capture intro paragraph: scan ahead past blank lines until a table or another heading
            j = i + 1
            intro_lines = []
            while j < len(lines):
                nxt = lines[j].strip()
                if not nxt:
                    j += 1
                    continue
                if nxt.startswith('|') or nxt.startswith('#'):
                    break
                intro_lines.append(nxt)
                j += 1
            if intro_lines:
                section_intros[current_subsection] = ' '.join(intro_lines)
        elif line.startswith('|') and i + 1 < len(lines) and '---' in lines[i + 1]:
            header_cells = parse_table_row(line)
            i += 1  # skip separator
            i += 1  # start data rows

            if current_heading_raw in FRAMEWORK_HEADINGS:
                # Overview/mapping table: capture rows as-is, don't scrape as sutta entries.
                fw_rows = []
                while i < len(lines) and lines[i].strip().startswith('|'):
                    fw_rows.append(parse_table_row(lines[i].strip()))
                    i += 1
                framework_tables.append({
                    "heading": current_heading_raw,
                    "headers": header_cells,
                    "rows": fw_rows,
                })
                continue

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
                    elif any(k in header_cells[1] for k in ['与本主题的关系', '概念重点', '内容']):
                        summary = cells[1] if len(cells) > 1 else ""
                    elif any(k in header_cells[1] for k in ['重点', '禅修重点']):
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

    return suttas, themes, section_intros, framework_tables


# Manually composed concise "focus" tags for entries whose source tables
# have no 重点/禅修重点/概念重点 column. Keyed by exact sutta name.
FOCUS_PATCH = {
    # buddha: 阿毗达摩 Abhidhamma Piṭaka
    "Dhammasaṅgaṇī": "法的分类背景，非个人叙事",
    "Vibhaṅga": "蕴处界谛根缘起念处分析",
    "Paṭṭhāna": "二十四缘、缘起思想展开",
    # laypeople: SN 41 Citta Saṁyutta
    "SN 41.1 Saṁyojana Sutta": "结与被结缚之法",
    "SN 41.2 Isidatta 1": "界的多样性",
    "SN 41.3 Isidatta 2": "十种无记见、有身见",
    "SN 41.4 Mahaka": "神通示现、居士信心",
    "SN 41.5 Kāmabhū 1": "一轮车譬喻",
    "SN 41.6 Kāmabhū 2": "身语心行、灭尽定",
    "SN 41.7 Godatta": "无量、空、无相解脱",
    "SN 41.8 Nigaṇṭha Nātaputta": "信与知、亲证经验",
    "SN 41.9 Kassapa": "苦行无果",
    "SN 41.10 Gilānadassana": "临终安慰、死亡观",
    # laypeople: SN 42 Gāmaṇi Saṁyutta
    "SN 42.1 Caṇḍa Sutta": "止息愤怒",
    "SN 42.2 Tālapuṭa Sutta": "表演职业与业",
    "SN 42.3 Yodhājīva Sutta": "战死与业",
    "SN 42.6 Asibandhakaputta Sutta": "仪式与业的譬喻",
    "SN 42.7 Khettūpama Sutta": "说法深浅、教化次第",
    "SN 42.8 Saṅkhadhamā Sutta": "罪感、戒行、心解脱",
    "SN 42.9 Kula Sutta": "家族衰败的因缘",
    "SN 42.10 Maṇicūḷaka Sutta": "比丘受金银、僧俗经济",
    "SN 42.11 Bhadraka Sutta": "爱取与苦",
    "SN 42.12 Rāsiya Sutta": "中道、苦行误解",
    "SN 42.13 Pāṭaliya Sutta": "神通与可验证的转化",
    # laypeople: SN 55 Sotāpatti Saṁyutta
    "SN 55.16 Mittāmacca 1": "入流四支、亲友",
    "SN 55.17 Mittāmacca 2": "入流四支、亲友责任",
    "SN 55.21 Mahānāma 1": "临终失念、信戒闻施慧",
    "SN 55.22 Mahānāma 2": "善法倾向、树喻",
    "SN 55.23 Godhā Sakka": "入流三支或四支",
    "SN 55.24 Sarakāni 1": "法随行者、信随行者",
    "SN 55.25 Sarakāni 2": "不轻率否定圣道进展",
    "SN 55.26 Anāthapiṇḍika 1": "病中入流四支",
    "SN 55.27 Anāthapiṇḍika 2": "佛法僧戒不坏净",
    "SN 55.28 Bhayaverūpasanta 1": "五怖畏、入流四支、缘起",
    "SN 55.29 Bhayaverūpasanta 2": "戒信正见、无畏",
    "SN 55.30 Nandaka Licchavi": "入流四支、闻法优先",
    # laypeople: 律藏主题
    "受戒、依止、供养关系": "居士供养与僧俗信心",
    "金钱、交易、资具": "比丘金钱戒律、僧俗经济边界",
    "僧团公共程序与在家信众": "僧团制度与在家护法",
    # meditation: SN 40 Moggallāna Saṁyutta
    "SN 40.1-4": "四禅心不稳之指导",
    "SN 40.5-8": "四无色定障碍与指导",
    "SN 40.9": "无相定",
    "SN 40.10-11": "深定、神通与教化",
    # meditation: SN 46 Bojjhaṅga Saṁyutta
    "SN 46.2 Kāya": "七觉支之食",
    "SN 46.3 Sīla": "闻法忆持思惟修习路径",
    "SN 46.14-16 Gilāna": "病中诵念七觉支",
    "SN 46.51 Āhāra": "五盖七觉支滋养条件",
    "SN 46.52 Pariyāya": "佛教与外道说五盖七觉支之别",
    "SN 46.53 Aggi": "调节精进与定力",
    "SN 46.54 Mettāsahagata": "四无量与七觉支",
    "SN 46.55 Saṅgārava": "五盖譬喻、去盖",
    # meditation: SN 47 Satipaṭṭhāna Saṁyutta
    "SN 47.1-4": "四念处一乘道",
    "SN 47.6 Sakuṇagghi": "鹰鹌鹑譬喻、安住自境",
    "SN 47.8 Sūda": "厨师譬喻、反馈调整",
    "SN 47.10 Bhikkhunupassaya": "念处修习层层增上",
    "SN 47.20 Janapadakalyāṇī": "头顶油钵譬喻、正念",
    "SN 47.35 Sati": "正念与正知之别",
    "SN 47.40 Vibhaṅga": "四念处定义",
    "SN 47.42 Samudaya": "四念处集灭",
    "SN 47.43 Magga": "梵天劝请、念处为道",
    "SN 47.44-47": "发展四念处之基础训练",
    # meditation: SN 48/51/54
    "SN 48.10 Vibhaṅga 2": "五根分析",
    "SN 48.38-40": "五受根",
    "SN 48.50 Āpaṇa": "不疑三宝、五根",
    "SN 51.13 Chandasamādhi": "欲定勤行成就神足",
    "SN 51.15 Uṇṇābha": "欲在禅修中的善用",
    "SN 51.20 Vibhaṅga": "四神足详细分析",
    "SN 54.1-5": "安般念利益与果位",
    "SN 54.6 Ariṭṭha": "安般念理解不完整",
    "SN 54.7-11": "安般念安稳清明",
    "SN 54.13-16": "安般念圆满念处觉支",
    "SN 54.17-20": "安般念断结漏尽",
    # meditation: 律藏主题
    "住处、安居、独处": "住处规则与禅修环境",
    "坐卧具与资具节制": "资具节制与少欲知足",
    "羯磨与僧团清净": "僧团清净制度",
}


def main():
    all_data = {"categories": {}}

    for key, info in FILES.items():
        filepath = BASE / info["path"]
        if not filepath.exists():
            print(f"WARNING: {filepath} not found")
            continue

        suttas, themes, section_intros, framework_tables = parse_markdown(filepath, key)
        for s in suttas:
            if not s["focus"] and s["name"] in FOCUS_PATCH:
                s["focus"] = FOCUS_PATCH[s["name"]]
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
                    "intro": section_intros.get(sec_key, ""),
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
            "framework_tables": framework_tables,
        }

    out = Path(__file__).parent / "docs" / "suttas.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)

    total = sum(sum(len(sec["suttas"]) for sec in cat["sections"]) for cat in all_data["categories"].values())
    print(f"\nTotal: {total} suttas → {out}")


if __name__ == "__main__":
    main()
