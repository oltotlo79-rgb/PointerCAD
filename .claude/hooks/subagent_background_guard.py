"""Reject Claude subagents' background shell calls and Monitor calls."""

from __future__ import annotations

import json
import re
import sys

# 2026-09-24 OPS-26(速度): モジュール読込み時のre.compileをやめ、パターン文字列の定数に
# した(caller()の中でre.search(パターン, ...)を直接呼ぶ。reの内部キャッシュにより2回目
# 以降は再コンパイルされない)。この変更で判定結果は変わらない。
SUBAGENT_TRANSCRIPT_PATTERN = (
    r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
)
REASON = (
    "担当は run_in_background と Monitor を使わない。"
    "長い検査は `diag.py … --bg` と前景の `diag.py wait --timeout 540`"
    "（呼出しの時間上限 600000 ms）で待つ（rules/06 §10.324・共通規律 §2）。"
)


def caller(payload: dict) -> str | None:
    agent_id = payload.get("agent_id")
    if isinstance(agent_id, str) and agent_id.strip():
        return "subagent"
    transcript = payload.get("transcript_path")
    if not isinstance(transcript, str) or not transcript.strip():
        return None
    if re.search(SUBAGENT_TRANSCRIPT_PATTERN, transcript):
        return "subagent"
    # A malformed path inside subagents is not evidence of a main call.
    parts = re.split(r"[/\\]", transcript)
    if "subagents" in parts or not parts[-1].endswith(".jsonl"):
        return None
    return "main"


def hook(payload: object) -> dict | None:
    if not isinstance(payload, dict):
        raise ValueError("フック入力がオブジェクトではない")
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    tool = payload.get("tool_name")
    if tool not in ("Bash", "PowerShell", "Monitor"):
        return None
    if tool != "Monitor":
        entry = payload.get("tool_input")
        if not isinstance(entry, dict):
            raise ValueError("tool_input を読めない")
        if entry.get("run_in_background") is not True:
            return None
    role = caller(payload)
    if role is None:
        raise ValueError("transcript_path と agent_id から呼出元を判定できない")
    if role == "main":
        return None
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": REASON,
    }}


def main() -> int:
    try:
        result = hook(json.load(sys.stdin))
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 背景実行の判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
