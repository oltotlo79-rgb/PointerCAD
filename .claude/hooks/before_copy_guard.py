"""担当が、着手前の現物を自担当フォルダーの before/ へ写す前に、git に追跡されているファイルを編集することを止める（rules/06 §10.517。候補）。

2026-11-14、担当 cl-v104-ui-statusbar-fileerror-1114 が e2e の 6 本を、before/ へ写す前に編集した。ほかの担当の未送信の変更が載っていた
ファイルなら、元の中身を失っていた。指示書で「先に写す」と書くだけでは防げなかったので、編集の道具の前で機械的に確かめる。

- 対象: 担当のセッション（agent_id がある、または transcript_path が …/subagents/agent-*.jsonl。workers_pause_guard.caller と同じ判定）の
  PreToolUse（Edit・Write・MultiEdit）。tool_input.file_path（絶対でも相対でもよい）を根からの相対パスにする。
- 通す: 呼出し元が分からない時（警告）、統括（main）、file_path が無い・根の外、scratchpad/ の下（自担当フォルダーを含む）、
  git に追跡されていないファイル（新規）、いずれかの担当のフォルダーの before/（または 1 段深い <名前>/before/）に同じ相対パスの写しがある時。
- 断る: 追跡されているファイルで、写しがどこにも無い時。理由に「先に before/ へ写す」と写す命令の例を出す（permissionDecision=deny、終了コード 0）。
- 担当名の知り方（担当名は入力に無い）: (1) registry.md の表の agentId 列が agent_id に等しい行の担当名。(2) 無ければ、担当の会話記録の先頭 64KB に
  最初に出る scratchpad/claude/instructions/<名前>.md の <名前>（指示書の名前＝担当名の決まり）が agents/<名前>/ として実在する時。
  (3) どちらも分からない時は、24 時間以内に進捗（progress.md）か before/ が更新された全ての担当のフォルダーのどれかに写しがあれば通す
  （誤って通す場合: 別の担当が同じ相対パスの写しを持つ時。誤って止める場合: 写しが 24 時間より古い担当のフォルダーだけにある時）。
  名前が分かった時は、その担当のフォルダーだけを見る。
- 限界: Bash・PowerShell の cp・sed -i・Set-Content などでの編集は見ない（Edit・Write・MultiEdit だけ）。広げる案は final.md の「§ 追加 5」。

子プロセスは git ls-files を 1 回だけ起こす（追跡の判定）。入力の JSON が読めない時は POINTERCAD_HOOK_FAIL_OPEN を標準エラーに出して通す。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
TOOLS = ("Edit", "Write", "MultiEdit")
AGENTS = "scratchpad/claude/agents"
REGISTRY = AGENTS + "/registry.md"
SUBAGENT_TRANSCRIPT_PATTERN = r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
INSTRUCTION_PATTERN = r"scratchpad/claude/instructions/([A-Za-z0-9][A-Za-z0-9._-]*?)\.md"
TRANSCRIPT_HEAD_BYTES = 64 * 1024
RECENT_SECONDS = 24 * 3600
RULE = "rules/06 §10.517"


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


def relative_path(root: str, path: str) -> str | None:
    """根からの相対パス（/ 区切り）。根の外・空は None。"""
    text = path.strip()
    if not text:
        return None
    absolute = text if os.path.isabs(text) else os.path.join(root, text)
    full = os.path.normcase(os.path.normpath(absolute))
    base = os.path.normcase(os.path.normpath(root))
    if full != base and not full.startswith(base + os.sep):
        return None
    relative = os.path.relpath(absolute, root).replace("\\", "/")
    return None if relative in (".", "") or relative.startswith("..") else relative


def is_tracked(root: str, relative: str) -> bool | None:
    """git に追跡されていれば True、されていなければ False、判定できなければ None。"""
    try:
        result = subprocess.run(["git", "--no-optional-locks", "ls-files", "--error-unmatch", "--", relative],
                                cwd=root, capture_output=True, timeout=4)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode == 0:
        return True
    return False if result.returncode == 1 else None


def name_from_registry(root: str, agent_id: str) -> str | None:
    try:
        with open(os.path.join(root, *REGISTRY.split("/")), encoding="utf-8-sig", errors="replace") as handle:
            for line in handle:
                cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
                if len(cells) >= 7 and cells[6] == agent_id.strip() and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", cells[0]):
                    return cells[0]
    except OSError:
        return None
    return None


def name_from_transcript(root: str, transcript) -> str | None:
    if not isinstance(transcript, str) or not transcript.strip():
        return None
    try:
        with open(transcript, "rb") as handle:
            head = handle.read(TRANSCRIPT_HEAD_BYTES).decode("utf-8", "replace")
    except OSError:
        return None
    for match in re.finditer(INSTRUCTION_PATTERN, head.replace("\\\\", "/").replace("\\/", "/")):
        if os.path.isdir(os.path.join(root, *AGENTS.split("/"), match.group(1))):
            return match.group(1)
    return None


def recent_agent_folders(root: str, now: float) -> list[str]:
    folders = []
    base = os.path.join(root, *AGENTS.split("/"))
    try:
        entries = list(os.scandir(base))
    except OSError:
        return folders
    for entry in entries:
        if not entry.is_dir():
            continue
        newest = 0.0
        for probe in ("progress.md", "before"):
            try:
                newest = max(newest, os.stat(os.path.join(entry.path, probe)).st_mtime)
            except OSError:
                pass
        if now - newest <= RECENT_SECONDS:
            folders.append(entry.path)
    return folders


def has_copy(folder: str, relative: str) -> bool:
    """folder/before/<相対> か、1 段深い folder/<名前>/before/<相対> に写しがある。"""
    parts = relative.split("/")
    if os.path.isfile(os.path.join(folder, "before", *parts)):
        return True
    try:
        children = [entry.path for entry in os.scandir(folder) if entry.is_dir() and entry.name != "before"]
    except OSError:
        return False
    return any(os.path.isfile(os.path.join(child, "before", *parts)) for child in children)


def hook(payload: dict, root: str | None = None, now: float | None = None) -> tuple[str | None, list[str]]:
    """(拒否の 1 行 か None, 警告の list)。"""
    root = ROOT if root is None else root
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") not in TOOLS:
        return None, []
    entry = payload.get("tool_input")
    path = entry.get("file_path") if isinstance(entry, dict) else None
    if not isinstance(path, str) or not path.strip():
        return None, []
    role = caller(payload)
    if role == "main":
        return None, []
    if role is None:
        return None, ["transcript_path と agent_id から呼出し元を判定できないので通す"]
    relative = relative_path(root, path)
    if relative is None or relative.startswith("scratchpad/") or relative.startswith(".git/"):
        return None, []
    tracked = is_tracked(root, relative)
    if tracked is None:
        return None, ["git の追跡を判定できないので通す"]
    if not tracked:
        return None, []
    when = time.time() if now is None else now
    agent_id = payload.get("agent_id")
    name = name_from_registry(root, agent_id) if isinstance(agent_id, str) and agent_id.strip() else None
    source = "registry.md の agentId"
    if name is None:
        name = name_from_transcript(root, payload.get("transcript_path"))
        source = "会話記録の指示書の名前"
    if name is not None:
        folders = [os.path.join(root, *AGENTS.split("/"), name)]
    else:
        folders = recent_agent_folders(root, when)
        source = "担当名が分からないので 24 時間以内に更新された担当のフォルダー全て"
    if any(has_copy(folder, relative) for folder in folders):
        return None, []
    target = name or "<担当名>"
    command = (f"mkdir -p scratchpad/claude/agents/{target}/before/{os.path.dirname(relative) or '.'} && "
               f"cp {relative} scratchpad/claude/agents/{target}/before/{relative}")
    line = (f"{relative} は git に追跡されているのに、自担当フォルダーの before/ に着手前の写しが無い（{RULE}。見たところ: {source}）。"
            f"先に before/ へ写してから編集する（ほかの担当の未送信の変更を失わないため）。写す命令の例: {command}")
    return line, []


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON のオブジェクトが必要です")
        line, warnings = hook(payload)
    except Exception as exc:  # 判定の不具合で担当を止めない（他のフックと同じく通す）
        print(f"POINTERCAD_HOOK_FAIL_OPEN: before の写しの判定不能: {exc}", file=sys.stderr)
        return 0
    if warnings:
        print("before_copy_guard の警告: " + " / ".join(warnings), file=sys.stderr)
    if line is not None:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": line,
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
