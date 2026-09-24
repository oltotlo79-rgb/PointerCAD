"""Reject Claude subagents' unscoped recursive filesystem searches over the repo root.

rules/06 §10.330: a subagent ran `grep -rln ... .` (repository root, including the large
`scratchpad/` tree) without scoping it to a subdirectory. Bash's own 120-second timeout then
silently moved the call to background execution and wrote its output outside the project
(under the OS temp folder). This hook denies, before the shell call runs, the specific
patterns named in that record: unscoped `grep -r`/`-R`/`-rl`, `find .`, PowerShell
`Get-ChildItem -Recurse`, `Select-String` recursion, and `rg --no-ignore`/`-u` (which turns off
`rg`'s own default `.gitignore` handling). Plain `rg` (its default already honours
`.gitignore`, so it naturally skips `scratchpad/`) and any search whose every explicit path
argument resolves to something other than the bare repo root (`packages/...`, `scratchpad/...`,
an absolute path elsewhere, etc.) are left untouched, as is every call made by the orchestrator
(Claude Code's main thread) itself. A leading `cd <repo root> &&` does not by itself make a
later command's own explicit, non-root path arguments count as unscoped.

This is a best-effort structural heuristic (token-based, quote-aware segment splitting so a
pattern like `grep -rn "foo|bar" ...` isn't cut apart at the `|`), not a full shell parser --
consistent with the other pattern-matching guards in this project (e.g. eslint.config.js's
e2eSyntaxGuards). 2026-09-24: fixed a false-deny (a `grep` with two explicit `packages/...`
targets, reached via `cd <root> && ... ; grep ...`, was denied) and a related false-allow (any
single scoped-looking token anywhere in the command used to short-circuit the whole check, so
`grep -rn x packages/ui/src .` was wrongly allowed even though one of its two targets was the
root) by replacing the old fixed-prefix allow-list with a direct check of the tool's own
extracted path arguments.

2026-09-24 (OPS-23): extended the same "root-like" concept to five additional large trees that
live inside `scratchpad/` itself -- `scratchpad` (bare), `scratchpad/c3` (a full independent
mirror of the repo root, and everything under it), `scratchpad/claude/runs` (saved test-run
output), `scratchpad/temp` (throwaway copies), and `scratchpad/tasks` (if present) -- because a
subagent recursing over any of these is exactly as slow and exactly as likely to spill output
outside the project as recursing over the root itself (rules/06 §10.330 追補). A worker's own
`scratchpad/claude/agents/<name>/`, `scratchpad/claude/instructions/`, and
`scratchpad/claude/plans/` are left untouched, as before -- they don't match any of the five
banned trees. `rg` gets one extra rule: because whether its own `.gitignore` handling actually
skips an explicitly-named path can't be verified from the command string alone, an explicit
target inside one of these five trees is denied even without `--no-ignore`/`-u` (unlike a bare
root target, which `rg`'s default ignore handling is still trusted to skip).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys

# 2026-09-24 OPS-26(速度): ROOTはこのファイル内でstr(ROOT)としてしか使わない(下の
# _is_banned_scratchpad_subtree/_is_root_like)ので、ROOT計算専用だったpathlibの
# importを無くしosで代替する。osはPython起動時のsite初期化で既に読込み済みで、
# import os の追加コストは実測ゼロ。pathlibは内部でfnmatch・urllib.parse・urllib・
# ipaddress・mathを芋づる式に読み込み、高負荷下でこの読込みだけで100ms超かかる
# ことを実測で確認した。os.path.realpath+dirnameを3回はPath(__file__).resolve()
# .parents[2]と文字列が完全一致することを実測で確認済み。
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))

# 2026-09-24 OPS-26(速度): 以下はモジュール読込み時にre.compileしていたが、判定結果を
# 変えずにパターン文字列の定数へ変え、使う関数の中でre.<関数>(パターン, 文字列)を直接
# 呼ぶ形にした。re標準ライブラリは呼び出されたパターンを内部キャッシュするため、同じ
# パターンを複数回呼んでも2回目以降は再コンパイルされない(re.compile(...).match(...)と
# re.match(...)は同じ結果を返す標準ライブラリの通常の等価性)。`grep -rn x .`のように
# _grep_violationだけで判定が確定する呼出しでは、_gci_violation等専用のパターンは
# 一度もコンパイルされずに済む。
SUBAGENT_TRANSCRIPT_PATTERN = (
    r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
)

_RECURSIVE_GREP_FLAG_PATTERN = r"^-[A-Za-z]*[rR][A-Za-z]*$|^--recursive$"
_RECURSE_FLAG_PATTERN = r"^-Recurse$"
_GCI_NAME_PATTERN = r"^(Get-ChildItem|gci)$"
_SELECT_STRING_NAME_PATTERN = r"^Select-String$"
# rg -u/-uu/-uuu(段階的に無視ファイルを外す)・--no-ignore系(gitignore等を外す)。
_RG_UNIGNORE_FLAG_PATTERN = r"^(--no-ignore(-vcs|-parent|-global)?|--unrestricted|-u{1,3})$"
_INLINE_FLAG_PATTERN = r"^(-{1,2}[A-Za-z][\w-]*)[=:](.*)$"

REASON_TEMPLATE = (
    "{tool} をリポジトリの根に対して実行しようとしています(scratchpad を含む全体は大きく、"
    "120秒を超えると自動で背景実行へ移り出力がプロジェクト外へ書かれます)。"
    "packages/… や自分の scratchpad/claude/agents/<担当名>/ 等、具体的な下位フォルダーに"
    "絞るか、既定の rg(.gitignore を守る)を使ってください(rules/06 §10.330)。"
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
    # A malformed path inside subagents is not evidence of a main call.
    parts = re.split(r"[/\\]", transcript)
    if "subagents" in parts or not parts[-1].endswith(".jsonl"):
        return None
    return "main"


def _segments(command: str) -> list[str]:
    """&&・||・裸の;・裸の|・裸の改行で区切る(quote-awareな分割)。シングル/ダブル
    クォートの中にある区切り文字(例: grep -rn "foo|bar" のパターン中の|)は区切りとして
    扱わない。2026-09-24統括の誤検出報告(§10.330): クォート非対応の分割だと、パターンに
    |を含むgrepがパスの引数ごと別セグメントへ分断され、パスが省略された(=根扱いの)
    grepと誤認されて拒否されていた。"""
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


# 2026-09-24 OPS-23: scratchpad配下にも根と同じくらい大きな木がある(全体検査の
# 独立コピーscratchpad/c3・検査記録scratchpad/claude/runs・一時の写しscratchpad/temp・
# scratchpad/tasks(あれば))。これらを再帰検索の対象に明示しても根と同じく拒否する
# (rules/06 §10.330 追補)。担当自身のscratchpad/claude/agents/<名前>/・
# scratchpad/claude/instructions/・scratchpad/claude/plans/はここに含めず今までどおり
# 通す(以下のいずれの木の前方一致にも当たらないので、この関数を変えずに素通りする)。
_BANNED_SCRATCHPAD_BARE = "scratchpad"
_BANNED_SCRATCHPAD_SUBTREES = (
    "scratchpad/c3",
    "scratchpad/claude/runs",
    "scratchpad/temp",
    "scratchpad/tasks",
)


def _is_banned_scratchpad_subtree(path_token: str) -> bool:
    """path_tokenが`scratchpad`そのもの、または上のいずれかの木(とその中の任意の
    深さ)を指すときTrueを返す。前方一致は必ず'/'境界を要求する(例:
    'scratchpad/claude/runsArchive'は'scratchpad/claude/runs'に前方一致させない)。
    相対パス(呼出しはcwd=ROOT前提)・ROOT配下の絶対パスの両方を扱う。ROOT自身や
    '.'・空(省略)は既存のROOT一致側の役割なのでここではFalseを返す。"""
    normalized = path_token.strip().strip("\"'").replace("\\", "/").rstrip("/")
    if normalized in ("", "."):
        return False
    root_norm = ROOT.replace("\\", "/").rstrip("/")
    lowered = normalized.lower()
    if lowered == root_norm.lower():
        return False
    prefix = root_norm.lower() + "/"
    if lowered.startswith(prefix):
        relative = lowered[len(prefix):]
    elif re.match(r"^[a-z]:/", lowered) or lowered.startswith("//"):
        return False  # ROOT配下ではない別の絶対パス(他ドライブ・UNC)は対象外
    else:
        relative = lowered  # 相対パスはcwd=ROOT前提でそのまま比較する
    if relative == _BANNED_SCRATCHPAD_BARE:
        return True
    return any(relative == subtree or relative.startswith(subtree + "/")
               for subtree in _BANNED_SCRATCHPAD_SUBTREES)


def _is_root_like(path_token: str) -> bool:
    normalized = path_token.strip().strip("\"'").replace("\\", "/").rstrip("/")
    if normalized in ("", "."):
        return True
    root_norm = ROOT.replace("\\", "/").rstrip("/")
    if normalized.lower() == root_norm.lower():
        return True
    return _is_banned_scratchpad_subtree(path_token)


def _excludes_scratchpad(segment: str) -> bool:
    lowered = segment.lower()
    return "scratchpad" in lowered and ("exclude" in lowered or "prune" in lowered or "!scratchpad" in lowered)


def _extract_path_candidates(tokens: list[str], path_flags: tuple[str, ...],
                              non_path_value_flags: tuple[str, ...]) -> list[str]:
    """コマンド名を除いたトークン列(tokens[1:])から、パスとして扱ってよい値だけを
    集める: path_flags(-Path/-LiteralPath等)の値、または裸の位置引数。
    non_path_value_flags(-Pattern/-Filter/-e等、値を取るがパスではないフラグ)は
    その値ごと読み飛ばす(値がたまたま裸の位置引数に見えてパスと誤認されるのを防ぐ)。
    これは完全なシェル/コマンドの構文解析ではなく、実務上ありがちな書き方をねらった
    発見的な判定(eslint.config.jsの他の構造マッチ規則と同じ考え方)。"""
    path_flag_names = {f.lower() for f in path_flags}
    drop_flag_names = {f.lower() for f in non_path_value_flags}
    candidates: list[str] = []
    pending: str | None = None  # 'path' | 'drop' | None(直前のフラグが次のトークンを値として消費する)
    for token in tokens:
        if pending == "path":
            candidates.append(token)
            pending = None
            continue
        if pending == "drop":
            pending = None
            continue
        inline = re.match(_INLINE_FLAG_PATTERN, token)  # 例: --exclude-dir=scratchpad
        if inline is not None:
            low_name, value_part = inline.group(1).lower(), inline.group(2)
            if low_name in path_flag_names and value_part:
                candidates.append(value_part)
            elif low_name not in drop_flag_names and not token.startswith("-"):
                candidates.append(token)  # 実際には起こらない(inline一致時は必ず'-'始まり)が念のため
            continue
        low_name = token.lower()
        if low_name in path_flag_names:
            pending = "path"
        elif low_name in drop_flag_names:
            pending = "drop"
        elif not token.startswith("-"):
            candidates.append(token)
    return candidates


def _root_or_omitted(candidates: list[str]) -> bool:
    if not candidates:
        return True  # パス省略はカレント(根)相当
    return any(_is_root_like(p) for p in candidates)


_GREP_NON_PATH_VALUE_FLAGS = (
    "-e", "--regexp", "-f", "--file", "--include", "--exclude", "--exclude-from",
    "--exclude-dir", "--include-dir", "-m", "--max-count", "-A", "-B", "-C", "--context",
    "--color", "--colour", "--binary-files", "--label",
)
_RG_NON_PATH_VALUE_FLAGS = (
    "-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type",
    "-T", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context",
    "-M", "--max-columns", "--color", "--colour",
)
_PS_NON_PATH_VALUE_FLAGS = ("-Pattern", "-Filter", "-Include", "-Exclude", "-Context", "-Encoding", "-Depth")


def _grep_violation(tokens: list[str]) -> bool:
    if not tokens or not re.search(r"(^|[\\/])grep(\.exe)?$", tokens[0], re.IGNORECASE):
        return False
    if not any(re.match(_RECURSIVE_GREP_FLAG_PATTERN, t) for t in tokens[1:] if t.startswith("-")):
        return False
    # 位置引数の並びは通常 PATTERN [PATH...]。先頭の1件をパターンとみなして除き、
    # 残りをパス候補とする(-e/--regexpでパターンを渡した場合でも、パターン相当の
    # 1件を余分に無視するだけなので、パス自体の判定を誤らせない)。パスが無ければ
    # 「パスの省略」として根扱いにする(rules/06 §10.330の対象)。複数のパスを渡した
    # 場合は全てが根でない(=明示的に絞られている)ときだけ許可する(2026-09-24
    # 統括の指摘: 一部だけが絞られていても、他の対象が根なら見逃してはいけない)。
    candidates = _extract_path_candidates(tokens[1:], (), _GREP_NON_PATH_VALUE_FLAGS)
    return _root_or_omitted(candidates[1:])


def _find_violation(tokens: list[str]) -> bool:
    if not tokens or not re.fullmatch(r"find(\.exe)?", tokens[0], re.IGNORECASE):
        return False
    # findは対象パスを先頭にいくつでも並べてから式(-name等、'-'始まり)を書く規則。
    # 先頭から'-'で始まるトークンが現れるまでを全てパス候補として集める。
    paths: list[str] = []
    for token in tokens[1:]:
        if token.startswith("-"):
            break
        paths.append(token)
    return _root_or_omitted(paths)


def _gci_violation(tokens: list[str]) -> bool:
    if not tokens or not re.match(_GCI_NAME_PATTERN, tokens[0], re.IGNORECASE):
        return False
    if not any(re.match(_RECURSE_FLAG_PATTERN, t, re.IGNORECASE) for t in tokens[1:]):
        return False
    candidates = _extract_path_candidates(tokens[1:], ("-Path", "-LiteralPath"), _PS_NON_PATH_VALUE_FLAGS)
    return _root_or_omitted(candidates)


def _select_string_violation(tokens: list[str]) -> bool:
    if not tokens or not re.match(_SELECT_STRING_NAME_PATTERN, tokens[0], re.IGNORECASE):
        return False
    if not any(re.match(_RECURSE_FLAG_PATTERN, t, re.IGNORECASE) for t in tokens[1:]):
        return False
    candidates = _extract_path_candidates(tokens[1:], ("-Path", "-LiteralPath"), _PS_NON_PATH_VALUE_FLAGS)
    return _root_or_omitted(candidates)


def _rg_violation(tokens: list[str]) -> bool:
    if not tokens or not re.fullmatch(r"rg(\.exe)?", tokens[0], re.IGNORECASE):
        return False
    candidates = _extract_path_candidates(tokens[1:], (), _RG_NON_PATH_VALUE_FLAGS)
    path_candidates = candidates[1:]
    # 2026-09-24 OPS-23: scratchpad・scratchpad/c3等の5つの木は、既定のrg(.gitignoreを
    # 守る想定)へ明示的に対象として渡した場合でも、ignoreが実際に効くかはコマンド
    # 文字列だけからは保証できないため、unignoreフラグの有無に関わらず拒否する
    # (rules/06 §10.330 追補)。裸の根・省略・"."は従来どおりrgの既定動作を信頼して
    # 見逃す(下のunignoreフラグの有無チェックへ進む)。
    if any(_is_banned_scratchpad_subtree(p) for p in path_candidates):
        return True
    if not any(re.match(_RG_UNIGNORE_FLAG_PATTERN, t, re.IGNORECASE) for t in tokens[1:] if t.startswith("-")):
        return False  # 既定のrg(.gitignoreを守る)は対象外
    return _root_or_omitted(path_candidates)


def _segment_violation(tokens: list[str]) -> str | None:
    if _grep_violation(tokens):
        return "grep -r"
    if _find_violation(tokens):
        return "find"
    if _gci_violation(tokens):
        return "Get-ChildItem -Recurse"
    if _select_string_violation(tokens):
        return "Select-String -Recurse"
    if _rg_violation(tokens):
        return "rg"
    return None


def find_violation(command: str) -> str | None:
    for segment in _segments(command):
        if _excludes_scratchpad(segment):
            continue
        label = _segment_violation(_tokens(segment))
        if label is not None:
            return label
    return None


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
    label = find_violation(command)
    if label is None:
        return None
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": REASON_TEMPLATE.format(tool=label),
    }}


def main() -> int:
    try:
        result = hook(json.load(sys.stdin))
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 検索範囲の判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
