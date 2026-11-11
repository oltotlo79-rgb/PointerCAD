"""Agent の Sonnet 起動を、統括が印を置くまで拒否する。"""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
MARKER = 'scratchpad/claude/root-runtime/sonnet-allowed.json'
REASON = '利用者の指示 2026-11-01 19:3x: Sonnet は出さない'


def hook(payload: dict, root: Path | None = None) -> str | None:
    if payload.get('hook_event_name') != 'PreToolUse' or payload.get('tool_name') != 'Agent':
        return None
    entry = payload.get('tool_input')
    if not isinstance(entry, dict) or 'sonnet' not in str(entry.get('model', '')).lower():
        return None
    path = (ROOT if root is None else root) / MARKER
    try:
        if path.is_file():
            return None
    except OSError:
        pass
    return f'{REASON}。統括が {MARKER} を置くまで起動できません。'


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError('入力は JSON のオブジェクトが必要です')
        reason = hook(payload)
    except (OSError, UnicodeError, ValueError, TypeError) as exc:
        reason = f'{REASON}。起動条件を確認できません: {exc}'
    if reason:
        print(' '.join(reason.split()), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
