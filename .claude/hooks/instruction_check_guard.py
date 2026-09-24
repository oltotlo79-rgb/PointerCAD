"""Validate a launch prompt's referenced instruction file before an Agent subagent starts.

PreToolUse guard for the Agent tool. When the launch prompt (tool_input.prompt) names an
instruction file under scratchpad/claude/instructions/<name>.md, this hook independently
re-checks that file's own claims against the current state of the repository, catching drift
between when the orchestrator wrote the instruction and when the subagent is actually launched
(rules/06 §10.334, §10.333, §10.336, §10.344 -- see
scratchpad/claude/instructions/w22b-ops12-instruction-check.md, OPS-12, and
scratchpad/claude/instructions/w28c-ops12b-hook-refine.md, OPS-12b):

  (a) "new" paths (new `<path>` / new-with-note...`<path>`, chained with the nakaguro "・") that
      already exist now.
  (b) a path's recorded SHA-256 (first 16 hex digits, written right after the closing backtick as
      `<path>`(<16 hex> ...) that no longer matches the file's current content. A bare filename
      (no "/") is treated as a candidate only when it carries a recognizable extension (a "."
      followed by 1-10 characters starting with a letter -- this excludes a bare 40-hex commit or
      blob id, which has no dot at all, OPS-12b). Such a candidate is checked against the repo
      root first; if not found there, it falls back to the directory of the nearest preceding full
      path on the same line; if neither resolves it, it is left unchecked (a miss is preferred
      over a false positive here, per the instruction's own §(b) wording). A path beginning with
      "./" is resolved relative to the repo root.
  (c) a future timestamp in the heading (line 1), a "state at (HH:MM)" note, or a
      "supervisor at HH:MM" note -- evidence the instruction's clock or measurement was off.
  (d) the referenced instruction file does not exist at all under
      scratchpad/claude/instructions/ -- e.g. the orchestrator's own Write of it was denied by
      record_time_guard.py's future-timestamp check, yet the Agent launch went ahead anyway with
      the stale prompt (rules/06 §10.344, OPS-12b). This is checked before (a)-(c), which need the
      file's contents to evaluate.

Everything the check needs lives in this one file (no import of anything under scratchpad/, which
is gitignored and absent from CI and from any hermetic checkout -- rules/06 §10.336). Only
scratchpad/claude/instructions/*.md content is inspected; unrelated prompts, or prompts that name
no such file, pass through untouched. This hook is a second line of defense alongside
record_time_guard.py's own (unrelated, Write/Edit-triggered) future-timestamp scan; it does not
import or depend on that file, since it is being edited concurrently by another worker
(w21c/OPS-16) while this file was written.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime

# 2026-09-24 OPS-26(速度): argparse・hashlib・pathlib の import と、下の8個の正規表現の
# re.compile を、実際に必要になるまで遅延させる(_root()・main()・各find関数を参照)。
# フック呼出しの大半(依頼文がscratchpad/claude/instructions/…を1つも参照せずnamesが
# 空になる経路)では、これらを一切読み込まない・コンパイルしない。判定結果は変えない:
# argparseの遅延はsys.argvが空のときparser.parse_args([])が必ず副作用無しで
# Namespace(check=None)を返す性質を使うだけで、--check等の実引数があるときは元の
# argparseの経路をそのまま通す。正規表現はパターン文字列の定数にして使う関数の中で
# re.<関数>(パターン, ...)を直接呼ぶ(reの内部キャッシュにより2回目以降は再コンパイル
# されない。re.compile(...).match(...)等とre.match(...)等は同じ結果を返す標準ライブラリ
# の通常の等価性)。

INSTRUCTIONS_DIR = "scratchpad/claude/instructions"

INSTRUCTION_REF = re.compile(r"scratchpad[/\\]claude[/\\]instructions[/\\]([\w.\-]+\.md)")
PATH_TOKEN_PATTERN = r"`([^`\n]{1,200})`"
# (a) "新規 `path`" / "新規の<20字以内、句読点・括弧を含まない>`path`"。バッククォートが
# 直後に来る位置だけを許す(lookahead)ので、括弧や句読点を挟んだ先の無関係なパスへ
# ずれ込まない(w22b-ops12-instruction-check.md 自身の説明文中のプレースホルダー
# 「`<パス>`」で誤検出しないことを実測で確認済み: 直後に丸括弧が来て一致に失敗する)。
NEW_INTRO_PATTERN = r"新規(?:の[^`\n。、（）()：:]{0,30})?[ \t]*(?=`)"
# 新規の連鎖: 直前のパスの直後が「・」(任意で「新規 」を再度伴う)+バッククォートのときだけ続く。
CHAIN_SEP_PATTERN = r"^・(?:新規[ \t]*)?(?=`)"
# 16桁ちょうどの16進(前後がさらに16進文字だと不一致にする=40桁のHEADハッシュ等の部分文字列に
# 一致しない)。
HEX16_PATTERN = r"(?<![0-9a-fA-F])[0-9a-fA-F]{16}(?![0-9a-fA-F])"
# 裸の名前(スラッシュ無し)として扱うのは拡張子(「.」の後に英字で始まる1〜10字)を持つ場合だけ
# (事実2: 40桁の16進のblob ID等ドットを持たないトークンを裸のファイル名と誤認しない)。
BARE_NAME_EXTENSION_PATTERN = r"\.[A-Za-z][A-Za-z0-9]{0,9}$"
BARE_TIME_PATTERN = r"(?<!\d)(\d{2}):(\d{2})(?!\d)"
STATE_PAREN_PATTERN = r"投入時の状態[（(]\s*(\d{2}):(\d{2})\s*[）)]"
SUPERVISOR_NI_PATTERN = r"統括が[ \t]*(\d{2}):(\d{2})[ \t]*に"
ANNOTATION_WINDOW = 100

_ROOT_CACHE = None


def _root():
    """ROOT(元のPath(__file__).resolve().parents[2]と同値)を初回呼出し時だけ計算し
    キャッシュする。pathlibのimportもここに遅延させ、namesが空の(参照先指示書が無い)
    hook()呼出しではpathlib自体を読み込まないようにする。"""
    global _ROOT_CACHE
    if _ROOT_CACHE is None:
        from pathlib import Path
        _ROOT_CACHE = Path(__file__).resolve().parents[2]
    return _ROOT_CACHE


def _path_parts(relative: str) -> list[str]:
    return re.split(r"[\\/]+", relative.strip())


def _normalize_relative(relative: str) -> str:
    """`./`(または `.\\`)で始まるパスは、その接頭辞を1つ剥がして根からの相対として扱う
    (事実2: `./eslint.config.js` のように書いても「不在」にならないようにする)。"""
    stripped = relative.strip()
    while stripped.startswith("./") or stripped.startswith(".\\"):
        stripped = stripped[2:]
    return stripped


def _safe_relative(relative: str) -> bool:
    relative = relative.strip()
    if not relative:
        return False
    return all(part not in ("", ".", "..") for part in _path_parts(relative))


def _exists_under(root: Path, relative: str) -> bool:
    relative = _normalize_relative(relative)
    if not _safe_relative(relative):
        return False
    try:
        return (root / relative).exists()
    except Exception:
        return False


def _hash16_under(root: Path, relative: str) -> str | None:
    import hashlib
    relative = _normalize_relative(relative)
    if not _safe_relative(relative):
        return None
    try:
        target = root / relative
        if not target.is_file():
            return None
        return hashlib.sha256(target.read_bytes()).hexdigest()[:16]
    except Exception:
        return None


def new_path_findings(text: str) -> list[tuple[int, str]]:
    """(a) 「新規」の直後のバッククォート付きパス(・で連鎖)を行ごとに集める
    (行番号, パス)。実在チェックはしない(呼び出し側が root と突き合わせる)。"""
    found: list[tuple[int, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for intro in re.finditer(NEW_INTRO_PATTERN, line):
            rest = line[intro.end():]
            while True:
                token = re.match(PATH_TOKEN_PATTERN, rest)
                if not token:
                    break
                candidate = token.group(1).strip()
                if (line_number, candidate) not in found:
                    found.append((line_number, candidate))
                rest = rest[token.end():]
                sep = re.match(CHAIN_SEP_PATTERN, rest)
                if not sep:
                    break
                rest = rest[sep.end():]
    return found


def sha_findings(text: str, root: Path) -> list[tuple[int, str, str]]:
    """(b) `<パス>`(...16桁の16進...) の形を行ごとに集め、(行番号, 解決したパス,
    記載された先頭16桁の小文字)を返す。パスがスラッシュを含まない(ファイル名だけ)場合、
    拡張子(BARE_NAME_EXTENSION: 「.」の後に英字で始まる1〜10字)を持つ名前だけを裸の
    ファイル名の候補として扱う(40桁の16進のblob ID等ドットの無いトークンは候補にしない、
    事実2a)。候補はまず根に同名のファイルがあるか調べ、あれば根で確定し、無ければ従来どおり
    同じ行で直前に見たスラッシュ入りパスのフォルダーで補う(事実2b)。どちらでも補えなければ
    そのトークンは結果に含めない(誤検出より見逃しを選ぶ、指示書 §(b) の指定どおり)。"""
    found: list[tuple[int, str, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        last_dir: str | None = None
        for token in re.finditer(PATH_TOKEN_PATTERN, line):
            candidate_raw = token.group(1).strip()
            has_slash = "/" in candidate_raw or "\\" in candidate_raw
            if has_slash:
                normalized = _normalize_relative(candidate_raw)
                parts = _path_parts(normalized)
                last_dir = "/".join(parts[:-1]) if len(parts) > 1 else None
                resolved: str | None = normalized
            elif re.search(BARE_NAME_EXTENSION_PATTERN, candidate_raw):
                if _exists_under(root, candidate_raw):
                    resolved = candidate_raw
                elif last_dir:
                    resolved = f"{last_dir}/{candidate_raw}"
                else:
                    resolved = None
            else:
                resolved = None
            end = token.end()
            if line[end:end + 1] != "（":
                continue
            window = line[end + 1:end + 1 + ANNOTATION_WINDOW]
            closing = window.find("）")
            annotation = window if closing == -1 else window[:closing]
            hex_match = re.search(HEX16_PATTERN, annotation)
            if hex_match and resolved:
                found.append((line_number, resolved, hex_match.group().lower()))
    return found


def _is_future(hour: int, minute: int, now: datetime) -> bool:
    if hour > 23 or minute > 59:
        return False
    ahead = (hour * 60 + minute - now.hour * 60 - now.minute) % (24 * 60)
    return 0 < ahead <= 180


def future_time_findings(text: str, now: datetime) -> list[tuple[int, str]]:
    """(c) 見出し(1行目)の裸の HH:MM、「投入時の状態(HH:MM)」、「統括が HH:MM に」を集め、
    今の分より先のものを (行番号, "HH:MM") で返す(日をまたぐ表記は180分先までを未来と
    みなし、前夜の時刻を誤って未来と扱わない。record_time_guard.py の同種の判定とは
    独立にこの場で同じ考え方だけを再実装したもので、そちらへは依存しない)。"""
    lines = text.splitlines()
    found: list[tuple[int, str]] = []
    if lines:
        for match in re.finditer(BARE_TIME_PATTERN, lines[0]):
            hour, minute = int(match.group(1)), int(match.group(2))
            if _is_future(hour, minute, now):
                found.append((1, match.group()))
    for line_number, line in enumerate(lines, start=1):
        for pattern in (STATE_PAREN_PATTERN, SUPERVISOR_NI_PATTERN):
            for match in re.finditer(pattern, line):
                hour, minute = int(match.group(1)), int(match.group(2))
                if not _is_future(hour, minute, now):
                    continue
                stamp = f"{match.group(1)}:{match.group(2)}"
                if (line_number, stamp) not in found:
                    found.append((line_number, stamp))
    return found


def check_instruction_text(root: Path, display_path: str, text: str, now: datetime) -> list[str]:
    """3つの検査を行い、外れの理由(行番号と検査の種類を含む文)の一覧を返す。空なら外れ無し。"""
    messages: list[str] = []
    for line_number, candidate in new_path_findings(text):
        if _exists_under(root, candidate):
            messages.append(
                f"{display_path} 行{line_number}: 新規と書かれた `{candidate}` が既に存在する"
            )
    for line_number, candidate, expected in sha_findings(text, root):
        actual = _hash16_under(root, candidate)
        if actual != expected:
            messages.append(
                f"{display_path} 行{line_number}: `{candidate}` の SHA-256 先頭16桁が不一致"
                f"(指示書の記載 {expected}、実際 {actual or '不在'})"
            )
    for line_number, stamp in future_time_findings(text, now):
        messages.append(f"{display_path} 行{line_number}: 時刻 {stamp} が現在({now:%H:%M})より先")
    return messages


def extract_instruction_names(prompt: str) -> list[str]:
    names: list[str] = []
    for match in INSTRUCTION_REF.finditer(prompt):
        name = match.group(1)
        if name not in names:
            names.append(name)
    return names


def hook(payload: dict, now: datetime, root: Path | None = None) -> dict | None:
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    if payload.get("tool_name") != "Agent":
        return None
    entry = payload.get("tool_input")
    if not isinstance(entry, dict):
        return None
    prompt = entry.get("prompt")
    if not isinstance(prompt, str):
        return None
    names = extract_instruction_names(prompt)
    if not names:
        return None
    if root is None:
        root = _root()
    messages: list[str] = []
    for name in names:
        path = root / INSTRUCTIONS_DIR / name
        if not path.is_file():
            messages.append(
                f"指示書 {INSTRUCTIONS_DIR}/{name} がありません。"
                "書き込みの結果を確かめてから起動してください。"
            )
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        messages.extend(check_instruction_text(root, f"{INSTRUCTIONS_DIR}/{name}", text, now))
    if not messages:
        return None
    shown = messages[:12]
    more = f" ...他{len(messages) - 12}件" if len(messages) > 12 else ""
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            "起動の依頼文が指す指示書に外れがあります(OPS-12): " + " / ".join(shown) + more
        ),
    }}


def _resolve_check_target(value: str) -> Path:
    from pathlib import Path
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    if candidate.is_file():
        return candidate
    alt = _root() / INSTRUCTIONS_DIR / value
    return alt if alt.is_file() else candidate


def _display_for(path: Path) -> str:
    try:
        return path.resolve().relative_to(_root()).as_posix()
    except ValueError:
        return str(path)


def main() -> int:
    try:
        now = datetime.now()
        check_value = None
        if len(sys.argv) > 1:
            # 2026-09-24 OPS-26(速度): sys.argvが空(フックとしての通常呼出し。Claude
            # CodeはstdinでJSONを渡すだけで追加引数を付けない)のときはargparseを
            # importも構築もしない。ArgumentParser().add_argument("--check").
            # parse_args([])は引数が無ければ必ずNamespace(check=None)を副作用無しで
            # 返す(argparseの仕様)ので、その場合と完全に同じ値(=None)を直接使うだけで
            # 判定は変わらない。--check等の実引数があるときは元のargparseの経路
            # (-h・誤った引数等の挙動を含め)をそのまま通す。
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--check")
            args = parser.parse_args()
            check_value = args.check
        if check_value:
            path = _resolve_check_target(check_value)
            if not path.is_file():
                print(f"指示書が見つからない: {check_value}")
                return 1
            text = path.read_text(encoding="utf-8")
            messages = check_instruction_text(_root(), _display_for(path), text, now)
            for message in messages:
                print(message)
            print(f"外れ: {len(messages)} 件")
            return 1 if messages else 0
        payload = json.load(sys.stdin)
        output = hook(payload, now)
        if output is not None:
            print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 指示書検査不能: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
