"""Limit simultaneously running Claude Opus subagents to three."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXCEPTIONS = ROOT / "scratchpad/claude/state/opus-exceptions.jsonl"
STALE = timedelta(minutes=45)
EXCEPTION = re.compile(r"【opus例外:([^】\r\n]+)】")


def last_record(path: Path) -> dict:
    with path.open("rb") as stream:
        stream.seek(0, 2)
        end = stream.tell()
        if not end:
            return {}
        position = end - 1
        while position >= 0:
            stream.seek(position)
            if stream.read(1) not in (b"\r", b"\n"):
                break
            position -= 1
        end = position + 1
        while position >= 0:
            stream.seek(position)
            if stream.read(1) == b"\n":
                break
            position -= 1
        stream.seek(position + 1)
        return json.loads(stream.read(end - position - 1).decode("utf-8"))


def tail_records(path: Path, count: int = 12) -> list[dict]:
    """末尾から最大 count 件の記録を古い順に返す(巨大な1行でも、必要な行数が揃うまで
    後ろから読み足す。先頭の欠けた行は捨てる)。"""
    with path.open("rb") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        chunk, start = 65536, size
        data = b""
        while start > 0 and data.count(b"\n") <= count:
            start = max(0, start - chunk)
            stream.seek(start)
            data = stream.read(size - start)
            chunk *= 2
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]
    records = []
    for line in lines:
        if line.strip():
            try:
                records.append(json.loads(line.decode("utf-8")))
            except ValueError:
                continue
    return records[-count:]


def is_complete(records: list[dict]) -> bool:
    """担当の完了判定。次のどれかなら完了:
    1. 最後の意味のある記録が assistant の stop_reason == end_turn(従来)。
    2. SubagentHandback の tool_use が最後の assistant 記録で、その後に続くのが
       その tool_use_id の tool_result だけ(attachment 等の付随記録は無視する)。
       この形で終わる担当は、末尾が end_turn にならず従来の判定では稼働中と数えられた
       (2026-10-05 cl-v103-ledger・cl-v103-ci-sharding・cl-v103-w09-drawing)。
    SendMessage で再開された担当は末尾が新しい user の依頼になるので、完了と見なさない。"""
    meaningful = [r for r in records if r.get("type") in ("assistant", "user")]
    if not meaningful:
        return False
    last = meaningful[-1]
    message = last.get("message", {})
    if last.get("type") == "assistant" and message.get("stop_reason") == "end_turn":
        return True

    def blocks(record: dict) -> list[dict]:
        content = record.get("message", {}).get("content")
        return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []

    def handback_ids(record: dict) -> set[str]:
        if record.get("type") != "assistant":
            return set()
        return {str(b.get("id")) for b in blocks(record)
                if b.get("type") == "tool_use" and b.get("name") == "SubagentHandback"}

    if last.get("type") == "assistant":
        return bool(handback_ids(last))
    if len(meaningful) >= 2:
        ids = handback_ids(meaningful[-2])
        results = {str(b.get("tool_use_id")) for b in blocks(last) if b.get("type") == "tool_result"}
        return bool(ids & results)
    return False


def agents(transcript: str, now: datetime) -> list[dict]:
    transcript_path = Path(transcript)
    directory = transcript_path.with_suffix("") / "subagents"
    result = []
    for meta_path in directory.glob("agent-*.meta.json"):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if "opus" not in str(meta.get("model", "")).lower():
            continue
        agent_id = meta_path.name[len("agent-"):-len(".meta.json")]
        conversation = meta_path.with_name(f"agent-{agent_id}.jsonl")
        if not conversation.is_file():
            continue
        updated = datetime.fromtimestamp(conversation.stat().st_mtime)
        complete = is_complete(tail_records(conversation))
        result.append({
            "id": agent_id, "description": str(meta.get("description", "")),
            "updated": updated, "active": not complete and now - updated <= STALE,
        })
    return result


def hook(payload: dict, now: datetime) -> dict | None:
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    tool = payload.get("tool_name")
    if tool not in ("Agent", "SendMessage"):
        return None
    entry = payload.get("tool_input", {})
    if tool == "Agent":
        model = entry.get("model")
        if model and "opus" not in str(model).lower() and entry.get("subagent_type") != "fork":
            return None
        target = str(entry.get("description", "new agent"))
        message = str(entry.get("prompt", ""))
    else:
        target = str(entry["to"])
        message = str(entry.get("message", ""))
    all_agents = agents(payload["transcript_path"], now)
    active = [agent for agent in all_agents if agent["active"]]
    if tool == "SendMessage":
        matches = [agent for agent in all_agents if target in (agent["id"], f"agent-{agent['id']}", agent["description"])]
        if not matches or matches[0]["active"]:
            return None
    if len(active) < 3:
        return None
    exception = EXCEPTION.search(message)
    if exception:
        EXCEPTIONS.parent.mkdir(parents=True, exist_ok=True)
        with EXCEPTIONS.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "time": now.isoformat(timespec="seconds"), "target": target,
                "reason": exception.group(1).strip(),
            }, ensure_ascii=False) + "\n")
        return None
    listing = "; ".join(
        f"{agent['id']} {agent['description']} {agent['updated']:%Y-%m-%d %H:%M}"
        for agent in active
    )
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": (
            f"稼働中の opus 担当は {len(active)} 本: {listing}。"
            "sonnet か Codex（gpt-6-astra・gpt-6-sol）へ回す、または稼働中の opus の完了を待つ。"
        ),
    }}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = hook(payload, datetime.now())
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: opus 同時数の判定不能: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
