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
        last = last_record(conversation)
        complete = last.get("type") == "assistant" and last.get("message", {}).get("stop_reason") == "end_turn"
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
