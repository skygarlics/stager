#!/usr/bin/env python3
import csv
import json
import os
import re
import sys
from collections import OrderedDict

CSV_PATH = os.path.join('csvs', 'DrumTower.csv')
OUT_DIR = os.path.join('data')
JSONL_OUT = os.path.join(OUT_DIR, 'drumtower.jsonl')
FLOOR_JSON_OUT = os.path.join(OUT_DIR, 'drumtower_floors.json')
FLOOR_APP_JSON_OUT = os.path.join(OUT_DIR, 'drumtower_floors_app.json')
SUMMARY_OUT = os.path.join(OUT_DIR, 'drumtower_summary.txt')
FLOOR_SUMMARY_OUT = os.path.join(OUT_DIR, 'drumtower_floor_summary.txt')


def find_header_index(lines):
    keywords = ['패턴', '이름', '난이도', '레벨']
    for i, line in enumerate(lines):
        if all(k in line for k in keywords):
            return i
    return None


def normalize(h):
    return h.strip().replace('\ufeff', '')


def try_parse_level(s):
    if not s:
        return None
    s = s.replace('\ufeff', '').strip()
    m = re.search(r"([0-9]+\.?[0-9]*)", s)
    if m:
        try:
            return float(m.group(1))
        except Exception:
            return None
    return None


def extract_tags(*cells):
    tags = set()
    for c in cells:
        if not c:
            continue
        cc = c.lower()
        if '왼발' in c:
            tags.add('왼발')
        if '체력' in c:
            tags.add('체력곡')
        if 'dk' in cc or cc.strip() == 'dk':
            tags.add('DK')
        if '보스' in c:
            tags.add('보스곡')
        if '해금' in c or 'dx' in cc:
            tags.add('DX 해금곡')
        if '처리력' in c:
            tags.add('처리력')
        if '셔플' in c:
            tags.add('셔플')
        if '고bpm' in cc or '고bpm' in c:
            tags.add('고BPM')
        if '오른발' in c:
            tags.add('오른발')
    return list(tags)


def bucket_level(lvl):
    if lvl is None:
        return 'Unknown'
    if lvl < 6.0:
        return 'Beginner'
    if lvl < 7.0:
        return 'Basic'
    if lvl < 8.0:
        return 'Advanced'
    if lvl < 9.0:
        return 'Expert'
    return 'Master'


def floor_sort_key(floor_value):
    if not floor_value:
        return (10**9, '')
    m = re.match(r'^(\d{1,3})F$', floor_value)
    if m:
        return (int(m.group(1)), floor_value)
    return (10**9, floor_value)


def build_floor_groups(parsed_rows):
    floors = {}
    for item in parsed_rows:
        floor_key = item.get('floor') or 'Unknown'
        floors.setdefault(floor_key, []).append(item)

    grouped = []
    for floor_name in sorted(floors.keys(), key=floor_sort_key):
        songs = list(floors[floor_name])
        grouped.append({
            'floor': floor_name,
            'songCount': len(songs),
            'songs': songs,
        })
    return grouped


def build_app_floor_groups(parsed_rows):
    floors = {}
    for item in parsed_rows:
        floor_key = item.get('floor') or 'Unknown'
        floors.setdefault(floor_key, []).append(item)

    grouped = []
    for floor_name in sorted(floors.keys(), key=floor_sort_key):
        songs = []
        for index, item in enumerate(floors[floor_name], start=1):
            tags = item.get('tags', []) or []
            song = {
                'idx': index,
                'displayName': item.get('song_name') or '',
                'songName': item.get('song_name') or '',
                'version': item.get('version') or '',
                'difficultyLabel': item.get('difficulty_label') or '',
                'level': item.get('level'),
                'tags': tags,
                'dxFlag': bool(item.get('dx_flag')),
            }
            if '보스곡' in tags:
                song['clearType'] = 'boss'
            songs.append(song)
        grouped.append({
            'floor': floor_name,
            'songCount': len(songs),
            'songs': songs,
        })
    return grouped


def parse_blocks_from_header_and_rows(header, rows):
    header = [normalize(h) for h in header]
    name_indices = [i for i, h in enumerate(header) if h == '이름']
    blocks = []
    for ni in name_indices:
        base = ni - 2
        def idx(off):
            return base + off
        blocks.append({
            'floor_i': idx(-1),
            'pattern_i': idx(0),
            'jacket_i': idx(1),
            'name_i': idx(2),
            'version_i': idx(3),
            'diff_i': idx(4),
            'level_i': idx(5),
            'dx_i': idx(6),
        })

    results = []
    floor_re = re.compile(r"(\d{1,3}F)")
    active_floors = [None] * len(blocks)

    for row in rows:
        if len(row) < len(header):
            row += [''] * (len(header) - len(row))
        for block_index, b in enumerate(blocks):
            if 0 <= b['floor_i'] < len(row):
                floor_cell = row[b['floor_i']].strip()
                if floor_cell and floor_re.fullmatch(floor_cell):
                    active_floors[block_index] = floor_cell
                elif floor_cell:
                    m = floor_re.search(floor_cell)
                    if m:
                        active_floors[block_index] = m.group(1)
        for block_index, b in enumerate(blocks):
            try:
                name = row[b['name_i']].strip()
            except Exception:
                name = ''
            if not name:
                continue
            floor = active_floors[block_index]
            version = row[b['version_i']].strip() if b['version_i'] < len(row) else ''
            diff_label = row[b['diff_i']].strip() if b['diff_i'] < len(row) else ''
            level_raw = row[b['level_i']].strip() if b['level_i'] < len(row) else ''
            dx_raw = row[b['dx_i']].strip() if b['dx_i'] < len(row) else ''
            lvl = try_parse_level(level_raw)
            tags = extract_tags(diff_label, dx_raw, row[b['pattern_i']] if b['pattern_i'] < len(row) else '')
            dx_flag = False
            if 'DX' in dx_raw or '해금' in dx_raw or 'dx' in dx_raw.lower():
                dx_flag = True

            item = OrderedDict()
            item['song_name'] = name
            item['version'] = version
            item['difficulty_label'] = diff_label
            item['level'] = lvl
            item['tags'] = tags
            item['dx_flag'] = dx_flag
            item['tower'] = None
            item['floor'] = floor
            item['raw_level'] = level_raw
            results.append(item)

    return results


def main():
    if not os.path.exists(CSV_PATH):
        print(f'File not found: {CSV_PATH}', file=sys.stderr)
        sys.exit(1)

    with open(CSV_PATH, 'r', encoding='utf-8-sig', errors='replace') as f:
        reader = csv.reader(f)
        rows = list(reader)

    if not rows:
        print('Empty CSV', file=sys.stderr)
        sys.exit(1)

    header_idx = find_header_index([','.join(r) for r in rows])
    if header_idx is None:
        header_idx = 0

    header = rows[header_idx]
    data_rows = rows[header_idx + 1:]

    parsed = parse_blocks_from_header_and_rows(header, data_rows)

    if not parsed:
        print('No parsed rows found.', file=sys.stderr)
        sys.exit(1)

    os.makedirs(OUT_DIR, exist_ok=True)

    with open(JSONL_OUT, 'w', encoding='utf-8') as outj:
        for it in parsed:
            it['difficulty_bucket'] = bucket_level(it.get('level'))
            outj.write(json.dumps(it, ensure_ascii=False) + '\n')

    floor_groups = build_floor_groups(parsed)

    with open(FLOOR_JSON_OUT, 'w', encoding='utf-8') as outjson:
        json.dump(
            {
                'source': os.path.basename(CSV_PATH),
                'floorCount': len(floor_groups),
                'songCount': len(parsed),
                'floors': floor_groups,
            },
            outjson,
            ensure_ascii=False,
            indent=2,
        )

    app_floor_groups = build_app_floor_groups(parsed)

    with open(FLOOR_APP_JSON_OUT, 'w', encoding='utf-8') as outjson:
        json.dump(
            {
                'source': os.path.basename(CSV_PATH),
                'floorCount': len(app_floor_groups),
                'songCount': len(parsed),
                'floors': app_floor_groups,
            },
            outjson,
            ensure_ascii=False,
            indent=2,
        )

    buckets = {}
    for it in parsed:
        b = bucket_level(it.get('level'))
        buckets.setdefault(b, []).append(it)

    with open(SUMMARY_OUT, 'w', encoding='utf-8') as s:
        for bname in ['Master', 'Expert', 'Advanced', 'Basic', 'Beginner', 'Unknown']:
            items = buckets.get(bname, [])
            if not items:
                continue
            s.write(f'=== {bname} ({len(items)} songs) ===\n')
            for it in items:
                lvl = it.get('level') if it.get('level') is not None else it.get('raw_level')
                s.write(f"{it.get('song_name')} — {it.get('difficulty_label')} — {lvl} — {', '.join(it.get('tags', []))}\n")
            s.write('\n')

    with open(FLOOR_SUMMARY_OUT, 'w', encoding='utf-8') as s:
        for group in floor_groups:
            s.write(f"=== {group['floor']} ({group['songCount']} songs) ===\n")
            for it in group['songs']:
                lvl = it.get('level') if it.get('level') is not None else it.get('raw_level')
                s.write(f"{it.get('song_name')} — {it.get('difficulty_label')} — {lvl} — {', '.join(it.get('tags', []))}\n")
            s.write('\n')

    print('Wrote:', JSONL_OUT, FLOOR_JSON_OUT, FLOOR_APP_JSON_OUT, SUMMARY_OUT, FLOOR_SUMMARY_OUT)


if __name__ == '__main__':
    main()
