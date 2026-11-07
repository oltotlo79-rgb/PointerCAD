"""統括の印がある間、担当（サブエージェント）のシェル・編集の呼出しを止める（rules/06 §10.465）。

統括が scratchpad/claude/root-runtime/workers-pause.json（{"reason": …, "placedAt": …, "until": …}）を置くと、その until まで、
担当のセッションからの Bash・PowerShell・Edit・Write・MultiEdit を拒否する（理由に印の reason と until）。統括のセッションは通す。
担当の見分け方は subagent_background_guard.py と同じ（agent_id がある、または transcript_path が …/subagents/agent-*.jsonl）。
印が無い・until を過ぎた（警告）・印が壊れている（警告）・呼出し元が分からない（警告）時は通す。Read は止めない（担当は
orchestrator-message.md を Read で読んで再開を待つ）。入出力は opus_concurrency_guard.py と同じ（拒否は標準出力の JSON、終了コード 0）。
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MARKER = "scratchpad/claude/root-runtime/workers-pause.json"
TOOLS = ("Bash", "PowerShell", "Edit", "Write", "MultiEdit")
SUBAGENT_TRANSCRIPT_PATTERN = r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
RULE = "rules/06 §10.465"


def caller(payload: dict) -> str | None:
    """subagent・main・None(分からない)。subagent_background_guard.caller と同じ判定。"""
    agent_id = payload.get("agent_id")
    if isinstance(agent_id, str) and agent_id.strip():
        return "subagent"
    transcript = payload.get("transcript_path")
    if not isinstance(transcript, str) or not transcript.strip():
        return None
    if re.search(SUBAGENT_TRANSCRIPT_PATTERN, transcript):
        return "subagent"
    parts = re.split(r"[/\\]", transcript)
    if "subagents" in parts or not parts[-1].endswith(".jsonl"):
        return None
    return "main"


def local_time(value) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"時刻が文字列ではありません: {value!r}")
    parsed = datetime.fromisoformat(value.strip())
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def read_marker(root: Path) -> tuple[str, dict | None, str]:
    """(none | valid | broken, 中身, 説明)。"""
    path = root / MARKER
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return "none", None, ""
    except (OSError, UnicodeError) as exc:
        return "broken", None, f"{MARKER} を読めません（{type(exc).__name__}: {exc}）"
    try:
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("最上位が JSON のオブジェクトではありません")
        if not isinstance(data.get("reason"), str) or not data["reason"].strip():
            raise ValueError("reason が空です")
        local_time(data.get("placedAt"))
        data["_until"] = local_time(data.get("until"))
    except (ValueError, TypeError) as exc:
        return "broken", None, f"{MARKER} が正しくありません（{type(exc).__name__}: {exc}）"
    return "valid", data, ""


def hook(payload: dict, now: datetime, root: Path | None = None) -> tuple[dict | None, list[str]]:
    root = ROOT if root is None else root
    warnings: list[str] = []
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") not in TOOLS:
        return None, warnings
    status, marker, detail = read_marker(root)
    if status == "none":
        return None, warnings
    if status == "broken":
        warnings.append(detail + "。担当の停止を判定できないので通す")
        return None, warnings
    if now >= marker["_until"]:
        warnings.append(f"{MARKER} の until（{marker['until']}）を過ぎているので通す。統括が消すこと")
        return None, warnings
    role = caller(payload)
    if role is None:
        warnings.append("transcript_path と agent_id から呼出し元を判定できないので通す")
        return None, warnings
    if role == "main":
        return None, warnings
    reason = (f"統括が担当を止めている（{MARKER}: {' '.join(marker['reason'].split())}、until {marker['until']}）。"
              "until まで、または統括の再開の連絡まで、Bash・PowerShell・Edit・Write を使わずに待つ。"
              f"orchestrator-message.md は Read で読む（{RULE}）")
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
    }}, warnings


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON のオブジェクトが必要です")
        result, warnings = hook(payload, datetime.now())
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 担当の停止の判定不能: {exc}", file=sys.stderr)
        return 0
    if warnings:
        text = "workers_pause_guard の警告: " + " / ".join(warnings)
        print(text, file=sys.stderr)
        if result is None:
            result = {"systemMessage": text}
    if result is not None:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
