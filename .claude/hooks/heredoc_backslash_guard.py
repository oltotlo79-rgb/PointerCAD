r"""Reject Bash/PowerShell calls whose heredoc body or python -c/node -e inline
code contains a literal backslash.

w127a-heredoc-backslash-hook(共通規律§2「編集のスクリプトはファイルに書いてから実行する」
MC-19b)。Bashのヒアドキュメント(`python - <<'EOF' … EOF`、`node -e`等)にPython・JSの
文字列として逆斜線を含むコードを書くと、シェルの引用・ツール層・JSON往復のどこかで
`\r`・`\1`・`\.`等が制御文字や別の文字へ化ける事故が繰り返し起きた(統括が2026-09-29に
2回、この指示書を書く時にも3回目、w114a・w115aも同型)。共通規律§2に規律の文言はあるが
機械の止めが無かったため、この入口で拒否する。

判定は完全なシェル構文解析ではなく、他のパターンマッチ型ガード(chained_diag_wait_guard.py
等)と同じ発見的な判定である。
- ヒアドキュメント: 開始行の`<<`(`<<-`は終端行の先頭空白を許す)と、引用符の有無を
  問わないデリミタを見つけ、次にデリミタだけの行が現れるまでを本文として取り出す。
- インラインコード: `python`・`python3`・`node`の呼出しの中で`-c`・`-e`の直後に続く
  単一引用符・二重引用符の中身を取り出す(二重引用符は`\"`のようなエスケープを許す)。
どちらかの本文に逆斜線(`chr(92)`)が1文字でもあれば拒否する。コマンド引数の中の逆斜線
(ヒアドキュメント・インラインコードの外、Windowsのパス等)は対象にしない。

timeoutを指定しないBashで`scratchpad/**.py`・`scripts/manual/*`を流す呼出しは、フック
入力からtimeoutの有無が分かる場合だけ警告を出す(止めない。stderrへ書くだけで
permissionDecisionは返さない)。
"""

from __future__ import annotations

import json
import re
import sys

HEREDOC_START_RE = re.compile(r"<<(-)?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
INLINE_CODE_RE = re.compile(
    r"\b(?:python3?|node)\b[^\n]*?\s(?:-c|-e)\s+"
    r"(?:'([^']*)'|\"((?:[^\"\\]|\\.)*)\")"
)
SCRATCHPAD_PY_RE = re.compile(r"scratchpad/[\w./-]*?\.py\b")
MANUAL_SCRIPT_RE = re.compile(r"scripts/manual/[\w./-]*")

REASON = (
    "Bash/PowerShellのヒアドキュメント、またはpython -c・node -eのインラインコードの"
    "本文に逆斜線が含まれています。Windowsのパスや正規表現(\\d・\\.・\\1等)をそのまま"
    "書くと、シェルの引用・ツール層の往復で文字が化けます(共通規律§2、MC-19b)。"
    "逆斜線はchr(92)で組み立ててください。長いコードはWriteツールでファイルに書いてから"
    "実行してください。"
)

WARNING = (
    "POINTERCAD_HOOK_WARN: heredoc_backslash_guard: timeoutを指定しないBashで"
    "scratchpad配下または scripts/manual のスクリプトを実行しています。長くなり得る"
    "場合はdiag.pyの--bgとdiag.py wait --timeout 540を使うか、Bashツールのtimeout"
    "引数を明示してください(共通規律§2「待ち方」)。"
)


def _heredoc_bodies(command: str) -> list[str]:
    lines = command.split("\n")
    bodies: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        matches = list(HEREDOC_START_RE.finditer(lines[i]))
        i += 1
        for m in matches:
            strip_leading = bool(m.group(1))
            delim = m.group(3)
            collected: list[str] = []
            terminator_found = False
            while i < n:
                current = lines[i]
                check = current.lstrip() if strip_leading else current
                if check == delim:
                    terminator_found = True
                    i += 1
                    break
                collected.append(current)
                i += 1
            if terminator_found:
                bodies.append("\n".join(collected))
    return bodies


def _inline_code_snippets(command: str) -> list[str]:
    snippets: list[str] = []
    for m in INLINE_CODE_RE.finditer(command):
        snippet = m.group(1) if m.group(1) is not None else m.group(2)
        if snippet is not None:
            snippets.append(snippet)
    return snippets


def has_backslash_violation(command: str) -> bool:
    backslash = chr(92)
    for body in _heredoc_bodies(command):
        if backslash in body:
            return True
    for snippet in _inline_code_snippets(command):
        if backslash in snippet:
            return True
    return False


def looks_like_unbounded_script(command: str) -> bool:
    return bool(SCRATCHPAD_PY_RE.search(command) or MANUAL_SCRIPT_RE.search(command))


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

    if has_backslash_violation(command):
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        }}

    if tool == "Bash" and entry.get("timeout") is None and looks_like_unbounded_script(command):
        print(WARNING, file=sys.stderr)

    return None


def main() -> int:
    try:
        result = hook(json.load(sys.stdin))
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: heredoc逆斜線の判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
