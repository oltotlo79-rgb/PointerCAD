"""説明書の PDF の全巻で、同梱でない字体（OS の字体へ落ちた文字）が0件かを判定する（読むだけ）。

scripts/manual/generate-pdf.mjs で作った PDF のフォルダーを渡す。PyMuPDF（import fitz）が要る。
（w118a の scratchpad/claude/agents/w118a-manual-font-coverage/font_scan.py を、同梱の字体の既定を
説明書で埋め込む3本に変えて置いた版。判定の中身は同じ。）

使い方:
  python -B -X utf8 scripts/manual/font_scan.py dist/<PDF の出力名> [--bundled <字体ファイル> ...] [--allow <字体名> ...]

判定:
- 同梱の字体の既定は、アプリの字体 apps/web/public/fonts/NotoSansJP-Regular.otf と、
  scripts/manual/fonts/font-notices.json に記録した説明書だけの字体（Noto Sans・Noto Sans Math）。
- 名前の付いた字体（Type0・TrueType 等）は、`--allow` に挙げた名前（部分集合の接頭辞 `ABCDEF+` を除く）だけを同梱とみなす。
  既定の許可は空。説明書は同梱の字体（data: URL の OTF）を Chromium が名前の無い Type3 として埋め込むため。
- 名前の無い Type3 の字体は、その字体で描いた全ての文字が同梱の字体のどれかにあるときだけ同梱とみなす
  （システムの CFF 字体が Type3 で入った場合を見逃さないため）。字体に無い文字は NFD に分解し、合成で描いた文字
  （例 ẏ = y + 結合用の上点）は部品が全て同梱の字体にあれば同梱とみなす。
- 1件でも同梱でない字体があれば FAIL（終了コード 1）。全巻で0件なら PASS（終了コード 0）。
  PDF が1つも無い・同梱の字体の記録が読めないときも FAIL（終了コード 2）。
"""
import argparse
import collections
import json
import sys
import unicodedata
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[2]
MANUAL_FONT_NOTICES = ROOT / 'scripts/manual/fonts/font-notices.json'


def default_bundled():
    notices = json.loads(MANUAL_FONT_NOTICES.read_text(encoding='utf-8'))
    fonts = notices.get('fonts') if isinstance(notices, dict) else None
    if not fonts:
        raise ValueError('説明書の字体の記録が空です: ' + str(MANUAL_FONT_NOTICES))
    return [ROOT / 'apps/web/public/fonts/NotoSansJP-Regular.otf'] + [MANUAL_FONT_NOTICES.parent / font['file'] for font in fonts]


def base_name(name):
    return name.split('+', 1)[-1] if '+' in name else name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('--bundled', type=Path, action='append', default=None,
                        help='同梱の字体ファイル（OTF/TTF）。複数可。省略時は NotoSansJP と scripts/manual/fonts の記録の字体')
    parser.add_argument('--allow', action='append', default=[], help='同梱とみなす名前付きの字体（例 NotoSansMath-Regular）')
    args = parser.parse_args()
    try:
        bundled_files = args.bundled or default_bundled()
        bundled = [fitz.Font(fontfile=str(path)) for path in bundled_files]
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print('FAIL: 同梱の字体を読めません:', error)
        return 2
    allowed = set(args.allow)

    def has(char):
        return any(font.has_glyph(ord(char)) for font in bundled)

    def covered(char):
        if has(char):
            return True
        parts = unicodedata.normalize('NFD', char)
        return len(parts) > 1 and all(has(part) for part in parts)

    pdfs = sorted(args.folder.glob('*.pdf'))
    if not pdfs:
        print('FAIL: PDF がありません:', args.folder)
        return 2
    offenders_total = 0
    for path in pdfs:
        pdf = fitz.open(path)
        fonts = collections.Counter()
        backslash_pages = 0
        # (字体, 理由) -> {'pages': set, 'chars': set}
        offenders = collections.defaultdict(lambda: {'pages': set(), 'chars': set()})
        for number, page in enumerate(pdf, 1):
            for font in {entry[3] for entry in page.get_fonts() if entry[3]}:
                fonts[base_name(font)] += 1
            if chr(0x5C) in page.get_text():
                backslash_pages += 1
            for block in page.get_text('rawdict')['blocks']:
                for line in block.get('lines', []):
                    for span in line['spans']:
                        chars = [c['c'] for c in span['chars'] if c['c'].strip()]
                        if not chars:
                            continue
                        font = span['font']
                        if font.startswith('Type3'):
                            missing = {c for c in chars if not covered(c)}
                            if missing:
                                entry = offenders[('Type3', '同梱の字体に無い文字')]
                                entry['pages'].add(number)
                                entry['chars'] |= missing
                        elif base_name(font) not in allowed:
                            entry = offenders[(base_name(font), '同梱でない名前付きの字体')]
                            entry['pages'].add(number)
                            entry['chars'] |= set(chars)
        print(path.name, len(pdf), 'pages; backslash pages', backslash_pages, dict(fonts))
        for (font, reason), entry in sorted(offenders.items()):
            pages = sorted(entry['pages'])
            shown = ', '.join(map(str, pages[:15])) + (' …' if len(pages) > 15 else '')
            chars = ''.join(sorted(entry['chars']))
            print(f'  非同梱: {font}（{reason}） {len(pages)} ページ [{shown}] 文字: {chars[:80]}')
        offenders_total += len(offenders)
    if offenders_total:
        print(f'FAIL: 非同梱の字体が {offenders_total} 件（巻ごとの字体の数の合計）')
        return 1
    print(f'PASS: 全{len(pdfs)}巻の全ページで非同梱の字体の一覧は空')
    return 0


if __name__ == '__main__':
    sys.exit(main())
