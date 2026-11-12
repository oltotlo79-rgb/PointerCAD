"""統括（Claude Fable）が Write・Edit・MultiEdit で道具やコードのファイルを書くことを止める（rules/06 §10.495、rules/01 §1。候補）。

利用者の指示（2026-11-11）「あなたは作業しないでね。サブエージェントに作業させてね」。統括は指示書・報告記録・規約・印の JSON を
書くが、道具やコード（.py・.mjs・.js・.ts・.ps1・.sh など）は書かない。2026-11-12 10:48、統括が全体検査の終わりを待つ小道具
scratchpad/claude/root-runtime/wait-gate-terminal-1112.py を自分で書いた（orchestrator_scope_guard.py は Bash・PowerShell だけを
見るので止まらなかった）。

- 対象: 統括のセッション（workers_pause_guard.caller と同じ判定で main）の PreToolUse（Write・Edit・MultiEdit）。
- 拒否: tool_input.file_path の拡張子が CODE_SUFFIXES のどれか（大文字小文字を区別しない）。理由は 1 行（標準出力の JSON、
  permissionDecision=deny、終了コード 0）。「担当へ指示書で出す」と返す。
- 通す: 担当のセッション、呼出し元が分からない時（警告）、file_path が無い・文字列でない時、コードでない拡張子
  （.md・.json・.txt・.yml など）。緊急時は orchestrator_scope_guard と同じ印
  scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json（reason・placedAt・until、30 分以内）が有効な間だけ通し、
  scratchpad/claude/state/orchestrator-scope-exceptions.jsonl に 1 行追記する（区分 W1）。

子プロセスは起こさない。印が要る時だけ印を読む。入力の JSON が読めない時は POINTERCAD_HOOK_FAIL_OPEN を標準エラーに出して通す。
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
TOOLS = ("Write", "Edit", "MultiEdit")
CODE_SUFFIXES = (".py", ".pyw", ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts",
                 ".ps1", ".psm1", ".sh", ".bash", ".bat", ".cmd")
MARKER = "scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json"
EXCEPTION_LOG = "scratchpad/claude/state/orchestrator-scope-exceptions.jsonl"
MARKER_MAX_WINDOW = timedelta(minutes=30)
SUBAGENT_TRANSCRIPT_PATTERN = r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
RULE = "rules/06 §10.495"


def caller(payload: dict) -> str | None:
    """subagent・main・None(分からない)。workers_pause_guard.caller と同じ判定。"""
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


def read_marker(root: str, now: datetime) -> tuple[str, object]:
    """(none | valid | invalid, 中身 か 無効の訳)。orchestrator_scope_guard.read_marker と同じ条件。"""
    path = os.path.join(root, *MARKER.split("/"))
    try:
        with open(path, encoding="utf-8-sig") as handle:
            data = json.loads(handle.read())
    except FileNotFoundError:
        return "none", ""
    except (OSError, UnicodeError, ValueError) as exc:
        return "invalid", f"読めない（{type(exc).__name__}）"
    if not isinstance(data, dict) or not isinstance(data.get("reason"), str) or not data["reason"].strip():
        return "invalid", "reason が空"
    try:
        placed, until = local_time(data.get("placedAt")), local_time(data.get("until"))
    except (ValueError, TypeError):
        return "invalid", "placedAt か until が ISO 時刻ではない"
    if until <= placed or until - placed > MARKER_MAX_WINDOW:
        return "invalid", "期間が 0 以下か 30 分を超える"
    if now < placed:
        return "invalid", "placedAt が未来"
    if now >= until:
        return "invalid", f"期限切れ（until {data['until']}）"
    return "valid", data


def hook(payload: dict, now: datetime, root: str | None = None) -> tuple[str | None, list[str]]:
    """(拒否の 1 行 か None, 警告の list)。"""
    root = ROOT if root is None else root
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") not in TOOLS:
        return None, []
    entry = payload.get("tool_input")
    path = entry.get("file_path") if isinstance(entry, dict) else None
    if not isinstance(path, str) or not path.strip():
        return None, []
    if not path.strip().lower().endswith(CODE_SUFFIXES):
        return None, []
    role = caller(payload)
    if role == "subagent":
        return None, []
    if role is None:
        return None, ["transcript_path と agent_id から呼出し元を判定できないので通す"]
    status, detail = read_marker(root, now)
    if status == "valid":
        try:
            log = os.path.join(root, *EXCEPTION_LOG.split("/"))
            os.makedirs(os.path.dirname(log), exist_ok=True)
            with open(log, "a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps({"at": now.isoformat(timespec="seconds"), "category": "W1", "word": path[:200],
                                         "command": payload["tool_name"], "reason": detail["reason"]},
                                        ensure_ascii=False) + "\n")
        except OSError as exc:
            return None, [f"印で通したが {EXCEPTION_LOG} へ記録できない（{type(exc).__name__}: {exc}）"]
        return None, []
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    line = (f"統括は道具やコードを書かない（rules/01 §1、利用者 2026-11-11「あなたは作業しないでね」、{RULE}）。"
            f"{name} は担当へ指示書で出す（読むだけの小道具も同じ）。")
    if status == "invalid":
        line += f"印は無効（{detail}）"
    return line, []


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON のオブジェクトが必要です")
        line, warnings = hook(payload, datetime.now())
    except Exception as exc:  # 判定の不具合で統括を止めない（他のフックと同じく通す）
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 統括の書込みの判定不能: {exc}", file=sys.stderr)
        return 0
    if warnings:
        print("orchestrator_code_write_guard の警告: " + " / ".join(warnings), file=sys.stderr)
    if line is not None:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": line,
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
