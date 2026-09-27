"""Reject invisible or easily-mistaken-for-whitespace characters written into source/doc files
(Claude Code PreToolUse hook for Write/Edit/MultiEdit).

Some characters are visually indistinguishable from an ordinary space or newline in most editors
but change program behavior or corrupt text (rules/06 10.346: a Write/Edit tool call whose body
contained an escape-style notation for U+00A0 had that notation silently turned into the *actual*
character by the tool layer, and no mechanical check caught it before this hook existed). This
hook re-reads the exact text Write/Edit/MultiEdit is about to place into a file of a targeted
extension and denies the call, with the offending line numbers, whenever one of these code points
appears:

  - U+00A0  NO-BREAK SPACE
  - U+200B  ZERO WIDTH SPACE
  - U+200C  ZERO WIDTH NON-JOINER
  - U+200D  ZERO WIDTH JOINER
  - U+2028  LINE SEPARATOR
  - U+2029  PARAGRAPH SEPARATOR
  - U+FEFF  BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE -- except at absolute offset 0 of the
            resulting file, where a leading BOM is the normal, intended form (this repository
            saves .ps1 files with a leading BOM by convention).

U+3000 IDEOGRAPHIC SPACE (full-width space) is deliberately *not* banned (2026-09-24, coordinator
decision, see the instruction's "追加指示"): (1) ESLint's `no-irregular-whitespace` (enabled via
`js.configs.recommended`, eslint.config.js line 140) already rejects it outside string literals in
.ts/.js, so this hook would be redundant there. (2) Inside a string literal the real character and
its escape-style notation evaluate to the identical value, so it can never cause the rules/06
10.346 kind of accident (a character silently swapped for a different, invisible one that changes
meaning). (3) Existing code intentionally relies on it as data: the normalization table in
packages/ui/src/sketch/commandLine.ts (line 176) and six tests that exercise full-width-space
input. Earlier revisions of this hook banned it for code files; that has been reverted.

Targeted extensions: .ts .tsx .mts .mjs .js .ps1 .py .json .md -- anything else passes through
untouched. The check is self-contained in this one file (no import from scratchpad/, which is
gitignored and absent from a hermetic checkout or CI -- rules/06 10.336).

Note for anyone editing this file (and its selftest): never type an actual escape-style notation
for one of these code points (backslash + the letter u + four hex digits) inside a Write/Edit
tool call body -- that is precisely the pattern rules/06 10.346 warns about. Build the real
character with chr(0x00A0) etc. (a plain hex *integer* literal, no backslash) instead, and refer
to code points in comments/messages with the "U+00A0" spelling, never the backslash-u spelling.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

# 対象拡張子のすべてで、常にこれらだけを禁止する(拡張子による分けは無い。値は理由
# メッセージに出す説明文)。U+3000(全角スペース)は2026-09-24の統括の判断でここに含めない
# (理由は上のモジュールの説明を参照)。
ALWAYS_BANNED: dict[int, str] = {
    0x00A0: "U+00A0 (NBSP、改行なしスペース)",
    0x200B: "U+200B (ゼロ幅スペース)",
    0x200C: "U+200C (ゼロ幅非接合子)",
    0x200D: "U+200D (ゼロ幅接合子)",
    0x2028: "U+2028 (行区切り)",
    0x2029: "U+2029 (段落区切り)",
    0xFEFF: "U+FEFF (BOM/ゼロ幅非改行スペース)",
}
TARGET_EXTENSIONS = {".ts", ".tsx", ".mts", ".mjs", ".js", ".ps1", ".py", ".json", ".md"}


def find_banned(text: str, banned: dict[int, str], chunk_is_file_start: bool) -> list[tuple[int, str]]:
    """text中の禁止文字を(そのtext内で1始まりの行番号, 説明)の一覧で返す。
    chunk_is_file_startがTrueのとき、textの先頭(index 0)のU+FEFFだけはファイル先頭の
    BOMとして許す(先頭以外の位置のU+FEFFは常に拒否する)。"""
    found: list[tuple[int, str]] = []
    line = 1
    for index, char in enumerate(text):
        code = ord(char)
        description = banned.get(code)
        if description is not None:
            if not (code == 0xFEFF and chunk_is_file_start and index == 0):
                found.append((line, description))
        if char == "\n":
            line += 1
    return found


def _edits_for(tool: str, entry: dict) -> list[dict]:
    if tool == "Write":
        return [{"new_string": entry.get("content", "")}]
    if tool == "Edit":
        return [entry]
    return entry.get("edits", []) or []


def scan_write(path: Path, tool: str, entry: dict) -> list[tuple[int, str]]:
    """Write/Edit/MultiEditがこれから書こうとしている内容から禁止文字を探し、
    (ファイル全体の中での行番号, 説明)の一覧を返す。MultiEditは既存の
    record_time_guard.pyのhook()と同じく、編集を順に適用しながら現在地を追う。"""
    extension = path.suffix.lower()
    if extension not in TARGET_EXTENSIONS:
        return []
    current = path.read_text(encoding="utf-8") if tool != "Write" and path.is_file() else ""
    findings: list[tuple[int, str]] = []
    for edit in _edits_for(tool, entry):
        old = edit.get("old_string", "")
        new = edit.get("new_string", "")
        start = current.find(old) if old and old in current else 0
        offset = current.count("\n", 0, start)
        chunk_is_file_start = start == 0
        for local_line, description in find_banned(new, ALWAYS_BANNED, chunk_is_file_start):
            findings.append((local_line + offset, description))
        if old:
            current = current.replace(old, new, 1)
    return findings


def scan_existing_file(path: Path) -> list[tuple[int, str]]:
    """既存ファイル全体を読んで禁止文字を探す(点検専用。書き込みは一切行わない)。
    UTF-8として読めないファイルは対象外として静かに飛ばす(点検は見逃しより
    誤検出を避ける側に倒す)。"""
    extension = path.suffix.lower()
    if extension not in TARGET_EXTENSIONS:
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    return find_banned(text, ALWAYS_BANNED, True)


def _display(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def reason(path: Path, findings: list[tuple[int, str]]) -> str:
    where = _display(path)
    shown = findings[:8]
    locations = "、".join(f"{line}行目 {description}" for line, description in shown)
    more = f" 他{len(findings) - 8}件" if len(findings) > 8 else ""
    return (
        f"{where}: 見えない文字・特殊な空白があります({locations}{more})。"
        "エスケープ表記(バックスラッシュ+u+4桁の16進)を書くと道具が実文字に置き換える"
        "ことがある。chr(0xa0)のようにコードで組み立てる(rules/06 10.346)。"
    )


def hook(payload: dict) -> dict | None:
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    tool = payload.get("tool_name")
    if tool not in ("Write", "Edit", "MultiEdit"):
        return None
    entry = payload.get("tool_input")
    if not isinstance(entry, dict):
        return None
    file_path = entry.get("file_path")
    if not isinstance(file_path, str) or not file_path:
        return None
    path = Path(file_path)
    if not path.is_absolute():
        path = ROOT / path
    findings = scan_write(path, tool, entry)
    if not findings:
        return None
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason(path, findings),
    }}


def main() -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--scan", nargs="*", default=None,
                             help="指定したファイルだけを読んで点検する(書き込みは行わない)")
        args = parser.parse_args()
        if args.scan is not None:
            total = 0
            for name in args.scan:
                path = Path(name)
                if not path.is_absolute():
                    path = ROOT / path
                findings = scan_existing_file(path)
                if findings:
                    total += len(findings)
                    where = _display(path)
                    for line, description in findings:
                        print(f"{where}\t{line}\t{description}")
            print(f"見えない文字: {total} 件")
            return 1 if total else 0
        payload = json.load(sys.stdin)
        output = hook(payload)
        if output is not None:
            print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 見えない文字の判定不能: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
