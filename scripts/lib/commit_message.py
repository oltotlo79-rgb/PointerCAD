"""Enforce the mechanically checkable subject rules in rules/03 section 6."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

JAPANESE = re.compile(r'[\u3041-\u3096\u30a1-\u30fa\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f]')
PREFIX = re.compile(r'^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n)]*\))?!?\s*[:：]', re.IGNORECASE)


def validate_message(data: bytes) -> str | None:
    if data.startswith(b'\xef\xbb\xbf'):
        return '先頭に UTF-8 BOM があります。BOM なし UTF-8 で保存してください。'
    try:
        message = data.decode('utf8')
    except UnicodeDecodeError:
        return 'UTF-8 として読めません。BOM なし UTF-8 で保存してください。'
    if any(ord(char) < 32 and char not in '\r\n\t' for char in message):
        return 'コミットメッセージに無効な制御文字があります。'
    # Git removes blank lines and comments when finalizing an edited message.
    lines = [line.strip() for line in message.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if not lines:
        return '変更内容が分かる日本語の件名を記載してください。'
    subject = lines[0]
    if PREFIX.match(subject):
        return 'feat:、fix: 等の接頭辞は禁止されています。変更内容を日本語で記載してください。'
    if subject.startswith(('fixup!', 'squash!', 'amend!')):
        return '自動整理用の接頭辞を外し、変更内容を日本語で記載してください。'
    if not JAPANESE.search(subject):
        return '件名に日本語がありません。何を変え、何ができるようになったかを日本語で記載してください。'
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('message_file', type=Path)
    args = parser.parse_args()
    try:
        error = validate_message(args.message_file.read_bytes())
    except OSError:
        error = 'コミットメッセージのファイルを読めません。'
    if error:
        print('[NG] ' + error + '（rules/03-品質ゲート.md §6）', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
