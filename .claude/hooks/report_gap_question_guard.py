"""統括が利用者への質問（AskUserQuestion）を出す前に、定期の報告が空いていないかを確かめる（rules/06 §10.493。候補）。

2026-11-12 12:56〜13:49、統括が選択肢の質問を出して回答を待つ間、docs/報告記録2.md の定期の報告（15〜20 分に 1 回）が 53 分
書かれなかった（利用者の指摘「直近で報告記録2に記載がない」）。質問の画面を開いている間、統括は報告を書けない。

- PreToolUse（AskUserQuestion）: 統括のセッションで、報告記録2 の最新の見出し「## YYYY-MM-DD HH:MM JST」から今までが
  ASK_LIMIT_MINUTES（15 分）以上なら拒否する（標準出力の JSON、permissionDecision=deny、終了コード 0）。先に報告を書かせる。
- PostToolUse（AskUserQuestion）: 回答が戻った時、最新の見出しから今までが AFTER_LIMIT_MINUTES（20 分）を超えていれば、
  「最初に報告を書く」と標準エラーへ出して終了コード 2（Claude Code は PostToolUse の終了コード 2 の標準エラーを統括へ見せる。
  道具の呼出しは既に終わっているので取り消さない）。
- 担当のセッション（agent_id がある、または transcript_path が …/subagents/agent-*.jsonl）は通す。呼出し元が分からない時も通す
  （警告だけ）。判定は workers_pause_guard.caller と同じ。
- 報告記録2 は 90 万バイトを超えるので、先頭の HEAD_BYTES（256KiB）だけを読む（新しい記録は先頭に足される）。その範囲の見出しの
  最大の時刻を「最新」とする。見出しが 1 つも無い・読めない時は通す（警告だけ）。未来の時刻の見出しは数えない。

子プロセスは起こさない。ファイルは報告記録2 の先頭だけを読み、何も書かない。入力の JSON が読めない時は POINTERCAD_HOOK_FAIL_OPEN を
標準エラーに出して通す（他のフックと同じ）。
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = "docs/報告記録2.md"
TOOL = "AskUserQuestion"
ASK_LIMIT_MINUTES = 15
AFTER_LIMIT_MINUTES = 20
HEAD_BYTES = 256 * 1024
HEADING_PATTERN = r"(?m)^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) JST"
SUBAGENT_TRANSCRIPT_PATTERN = r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
RULE = "rules/06 §10.493"
REPORT_COMMAND = "python -B -X utf8 scratchpad/claude/root-runtime/report-capture-progress-1110.py"


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


def latest_report_time(root: Path, now: datetime) -> tuple[datetime | None, str]:
    """(最新の見出しの時刻 か None, 説明)。先頭 HEAD_BYTES だけを読む。未来の見出しは数えない。"""
    path = root / REPORT
    try:
        with open(path, "rb") as handle:
            head = handle.read(HEAD_BYTES)
    except OSError as exc:
        return None, f"{REPORT} を読めない（{type(exc).__name__}）"
    text = head.decode("utf-8", errors="ignore")
    latest = None
    for match in re.finditer(HEADING_PATTERN, text):
        try:
            stamp = datetime(*(int(part) for part in match.groups()))
        except ValueError:
            continue
        if stamp > now + timedelta(minutes=1):
            continue
        if latest is None or stamp > latest:
            latest = stamp
    if latest is None:
        return None, f"{REPORT} の先頭 {HEAD_BYTES} バイトに「## YYYY-MM-DD HH:MM JST」の見出しが無い"
    return latest, ""


def hook(payload: dict, now: datetime, root: Path | None = None) -> tuple[str, str | None, list[str]]:
    """(種類, 文 か None, 警告)。種類は "deny"(PreToolUse の拒否)・"feedback"(PostToolUse の知らせ)・"pass"。"""
    root = ROOT if root is None else root
    event = payload.get("hook_event_name")
    if payload.get("tool_name") != TOOL or event not in ("PreToolUse", "PostToolUse"):
        return "pass", None, []
    role = caller(payload)
    if role == "subagent":
        return "pass", None, []
    if role is None:
        return "pass", None, ["transcript_path と agent_id から呼出し元を判定できないので通す"]
    latest, detail = latest_report_time(root, now)
    if latest is None:
        return "pass", None, [detail + "。報告の空きを判定できないので通す"]
    gap = int((now - latest).total_seconds() // 60)
    if event == "PreToolUse" and gap >= ASK_LIMIT_MINUTES:
        return "deny", (
            f"前の定期の報告（{latest:%H:%M}）から {gap} 分たっている。質問の画面を開いている間は報告を書けず、"
            f"2026-11-12 12:56〜13:49 に報告が 53 分抜けた（{RULE}）。先に {REPORT} へ定期の報告を書いてから質問する"
            f"（{REPORT_COMMAND}）。"), []
    if event == "PostToolUse" and gap > AFTER_LIMIT_MINUTES:
        return "feedback", (
            f"回答が戻った。前の定期の報告（{latest:%H:%M}）から {gap} 分たっている（15〜20 分に 1 回の決まりを超えた）。"
            f"ほかの作業の前に、最初に {REPORT} へ定期の報告を書く（{RULE}）。"), []
    return "pass", None, []


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON のオブジェクトが必要です")
        kind, text, warnings = hook(payload, datetime.now())
    except Exception as exc:  # 判定の不具合で統括を止めない（他のフックと同じく通す）
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 報告の空きの判定不能: {exc}", file=sys.stderr)
        return 0
    if warnings:
        print("report_gap_question_guard の警告: " + " / ".join(warnings), file=sys.stderr)
    if kind == "deny":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": text,
        }}, ensure_ascii=False))
        return 0
    if kind == "feedback":
        print(text, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
