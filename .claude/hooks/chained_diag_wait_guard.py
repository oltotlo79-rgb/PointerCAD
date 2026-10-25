"""Reject Claude subagents' single Bash/PowerShell call that chains `diag.py wait`
two or more times.

OPS-31(共通規律§2、指示書 w64a-ops-gate-tools.md、w58bの報告§4): 担当が1回のBash呼出しの
中で `diag.py wait --run A ... ; diag.py wait --run B ...` のように wait を連ねると、
呼出し全体が2回分の最大540秒待ちの合計まで前景でブロックし続け、Bashツールの1回の
上限(10分)を超えて時間切れになる・出力がプロジェクト外の一時フォルダーへ移される
恐れがある(共通規律§2「待ち方」と同じ理由)。`diag.py wait` は1回のBash呼出しにつき
1回だけにし、複数の実行を待つ必要があるときは呼出しを分ける(その都度 progress.md へ
1行残す運用と噛み合う)。

他の担当ガード(subagent_background_guard.py・subagent_search_scope_guard.py)と同じ
構造: 呼出元がサブエージェント(担当)のときだけ拒否し、統括(main)自身の呼出しは
素通りする。判定はコマンド文字列のquote-awareな分割(`&&`・`||`・裸の`;`・裸の`|`・
裸の改行で区切る)の上で、各セグメントが「`diag.py` を含み、その直後の非フラグの
位置引数が `wait`」であるものを数える完全な文字列一致ではなく発見的な判定(他の
パターンマッチガードと同じ考え方。完全なシェル構文解析は行わない)。
"""

from __future__ import annotations

import json
import re
import shlex
import sys

SUBAGENT_TRANSCRIPT_PATTERN = (
    r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
)

REASON = (
    "1回のBash/PowerShell呼出しの中で `diag.py wait` を2回以上連ねています。"
    "1回の呼出しにつき `diag.py wait --timeout 540` は1回だけにし、複数の実行を"
    "待つときは呼出しを分けてください(共通規律§2「待ち方」・rules/06 w58bの報告§4)。"
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
    parts = re.split(r"[/\\]", transcript)
    if "subagents" in parts or not parts[-1].endswith(".jsonl"):
        return None
    return "main"


def _segments(command: str) -> list[str]:
    """&&・||・裸の;・裸の|・裸の改行で区切る(quote-awareな分割。
    subagent_search_scope_guard.pyの_segmentsと同じ考え方)。"""
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if quote is not None:
            current.append(ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            current.append(ch)
            i += 1
            continue
        if command[i:i + 2] in ("&&", "||"):
            segments.append("".join(current))
            current = []
            i += 2
            continue
        if ch in (";", "|", "\n"):
            segments.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    segments.append("".join(current))
    return [segment.strip() for segment in segments if segment.strip()]


def _tokens(segment: str) -> list[str]:
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def _segment_is_diag_wait(tokens: list[str]) -> bool:
    """トークン列のどこかに `diag.py` があり、その直後の非フラグの位置引数が
    `wait` であれば真(python -B -X utf8 .../diag.py wait --run ... の形も、
    PowerShell経由でも同じトークン化で拾える)。"""
    for i, token in enumerate(tokens):
        name = token.replace("\\", "/").rsplit("/", 1)[-1]
        if name.lower() != "diag.py":
            continue
        for later in tokens[i + 1:]:
            if later.startswith("-"):
                continue
            return later == "wait"
        return False
    return False


LOOP_STARTS = {"for", "while", "until", "select", "foreach"}
LOOP_ANYWHERE = {"foreach-object", "%", "xargs", "parallel"}


def _is_loop_head(tokens: list[str]) -> bool:
    """bashのfor/while/until、PowerShellのforeach/ForEach-Object、xargsなど、
    本体を繰り返し実行する書き方の頭。"""
    if not tokens:
        return False
    if tokens[0].lower().lstrip("({") in LOOP_STARTS:
        return True
    return any(token.lower() in LOOP_ANYWHERE for token in tokens)


def count_diag_wait_segments(command: str, _depth: int = 0) -> int:
    """`diag.py wait` の実行回数の見積り。繰り返し(for/while/until・foreach・
    ForEach-Object・xargs)の中の wait は、1回しか書かれていなくても2回と数える
    (2026-10-01 cl-v102-calc-deadline の `for r in A B; do ... diag.py wait ...; done` が
    本文の wait が1つのため通り、600秒を超えた。2026-10-05 R27 で穴と確定)。
    bash -c "..." / pwsh -Command "..." のように引用符の中へ入れた本文も再帰して数える。"""
    total = 0
    loop_depth = 0   # bashのfor..doneの入れ子
    ps_loop = False  # PowerShellの波括弧の繰り返しは終わりを数えず、最後まで続くと見なす
    for segment in _segments(command):
        tokens = _tokens(segment)
        if not tokens:
            continue
        head = tokens[0].lower()
        if head == "done":
            loop_depth = max(0, loop_depth - 1)
            continue
        loop_head = _is_loop_head(tokens)
        if loop_head:
            if head in ("foreach", "(foreach") or any(t.lower() in ("foreach-object", "%") for t in tokens):
                ps_loop = True
            else:
                loop_depth += 1
        weight = 2 if (loop_depth > 0 or ps_loop or loop_head) else 1
        if _segment_is_diag_wait(tokens):
            total += weight
        elif _depth < 3:
            for token in tokens:
                if " " in token and "diag.py" in token:
                    inner = count_diag_wait_segments(token, _depth + 1)
                    total += inner * (2 if (loop_depth > 0 or ps_loop) else 1)
    return total


def hook(payload: object) -> dict | None:
    if not isinstance(payload, dict):
        raise ValueError("フック入力がオブジェクトではない")
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    tool = payload.get("tool_name")
    if tool not in ("Bash", "PowerShell"):
        return None
    entry = payload.get("tool_input")
    if not isinstance(entry, dict):
        raise ValueError("tool_input を読めない")
    command = entry.get("command")
    if not isinstance(command, str) or not command.strip():
        return None
    role = caller(payload)
    if role is None:
        raise ValueError("transcript_path と agent_id から呼出元を判定できない")
    if role == "main":
        return None
    if count_diag_wait_segments(command) < 2:
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
        print(f"POINTERCAD_HOOK_FAIL_OPEN: diag.py wait連ねの判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
