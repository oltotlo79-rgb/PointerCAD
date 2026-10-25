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

2026-10-25 cl-v103-instruction-guard-upgrade adds five more checks to (a)-(c), because the orchestrator's
own instruction mistakes stopped workers four times on 2026-10-24/25 with only a rule written down (rules/06
§10.422-§10.427): (1) an "## 影響の列挙" section is required when the instruction adds a type/kind/field, and
every file that references the listed identifiers (found by scanning packages/*/src, apps/*/src, e2e/tests --
rg if it is on PATH, else an equivalent pure-Python scan) must be inside (3) or listed as "触らない: <path>（理由）";
(2) a quoted expected value on a "出典 <path>:<line>" line must really appear within 3 lines of that line (a quoted
value without a citation is only a warning); (3) sources.md + SHA-256 needs a fetch permission or a local copy;
(4) a change to packages/ui/src/**/*.tsx or packages/help-content/docs needs controlInventory.test.ts and
topics.test.ts in section 2; (5) a generator-side confirmation line (warning only). Violations (外れ) deny the launch;
warnings are printed only by --check. Each new check isolates its own exceptions (they become warnings).

2026-10-25 cl-v103-instruction-guard-paths adds check 7: every root-prefixed path written in the "③" paragraph
(packages/, apps/, e2e/, scripts/, docs/, .claude/, scratchpad/claude/tools/) must exist now (os.path.exists only),
unless it is marked as new ("新規 <path>", a following "（…新規…）" remark, ...). A worker stopped on 2026-10-25 02:1x because
the orchestrator had copied three nonexistent test files from a plan line into (3). Path extraction is shared with check 1.

2026-10-25 cl-v103-instruction-guard-union adds check 8: when "## 影響の列挙" lists a string-literal union type
(export type X = 'a' | 'b'), every file that holds a fixed table keyed by its values (Record<X,...>, or one {...} block
whose keys are exactly the values -- found by a value scan, because such tables never name the type) must be inside (3),
even if it is written under "触らない:". A worker stopped on 2026-10-25 03:19 (SteelCondition, TS7053 in two UI tables).
The scan result of check 1 is reused; the value scan is one more find_references call, only when a union is found.

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
    """検査を行い、外れの理由(行番号と検査の種類を含む文)の一覧を返す。空なら外れ無し。
    警告(起動を止めない注意)は check_instruction_report が (外れ, 警告) の組で返す。"""
    return check_instruction_report(root, display_path, text, now)[0]


# ---------------------------------------------------------------------------
# 2026-10-25 cl-v103-instruction-guard-upgrade: 統括の指示書の誤りの再発を、記録ではなく機械で
# 止める6つの検査のうち5つ(6つ目は registry.py の list --running。scan_questions.py)。
# rules/06 §10.422〜§10.427 と 2026-10-25 の W11d・W6 の停止が元。既存の (a)〜(d) は変えない。
#   1. 影響の列挙 (§10.422・§10.423): 型・kind・欄を足す包みは、その識別子を参照する全ファイルを
#      ③に入れるか「触らない: <パス>（理由）」に書く。参照するファイルはこの場で走査して得る。
#   2. 期待値の出典 (W11d): §2 の引用の期待値に「出典 <パス>:<行>」があれば、その行の前後3行に実在。
#   3. 出典の実物 (W6): sources.md と SHA-256 を挙げるなら、取得の許可か手元の実物のパスが要る。
#   4. 画面を変える包みの help-content の検査 (§10.427)。
#   5. 生成側の固定値 (W6 の2つ目。簡易。警告のみ)。
#   (7. ③のパスの実在は 2026-10-25 cl-v103-instruction-guard-paths が足した。下の「検査7」の節。)
#   (8. union 型の固定の表は 2026-10-25 cl-v103-instruction-guard-union が足した。下の「検査8」の節。)
# 外れ(起動を止める)と警告(--check の出力にだけ出す)を分ける。各検査の内部の例外は警告に落として
# 続行する(既存の検査と他の新しい検査を巻き込まない。フックは失敗しても開く方針)。
# ---------------------------------------------------------------------------

# settings.json のフックの timeout は5秒。走査はそれより十分短い枠で打ち切り、外れにせず警告にする。
HOOK_SCAN_SECONDS = 2.5
CLI_SCAN_SECONDS = 120.0
CITATION_WINDOW = 3
FILE_LIST_LIMIT = 8
SCAN_MAX_FILE_BYTES = 2_000_000
SCAN_WORKERS = 8
SCAN_CACHE_NAME = "instruction-guard-scan-cache.json"
SCAN_CACHE_MAX_IDENTIFIERS = 200
SCAN_SKIP_DIRS = frozenset({
    "node_modules", "dist", "dist-types", "out", "build", ".vite", "coverage", "__pycache__",
    "test-results", "playwright-report", "scratchpad", ".git",
})
SCAN_BINARY_SUFFIXES = (
    ".wasm", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".pyc",
    ".zip", ".gz", ".pdf", ".glb", ".bin",
)

SCOPE_LINE_PATTERN = r"^[ \t>*\-]*③"
INSTRUCTION_TITLE_PATTERN = r"^#[ \t]+指示書"
SCOPE_STOP_PATTERN = r"^[ \t>*\-]*[①②④⑤⑥⑦⑧⑨⑩]|^#{1,6}[ \t]"
HEADING_PATTERN = r"^(#{1,6})[ \t]+(.*?)[ \t]*$"
FENCE_PATTERN = r"^[ \t]*(?:```|~~~)"
CODE_SPAN_PATTERN = r"`([^`\n]*)`"
COMMAND_SPAN_PATTERN = r"^[ \t]*(?:rg|grep|git|python|node|pnpm|find|ls|cat|diag\.py)(?![A-Za-z0-9_])"
# ③の中の経路の語: スラッシュを含むもの(先頭の ./ ・末尾の / ・* ? の glob を許す)か、拡張子を持つ裸の
# 名前(直前の完全な経路のフォルダーで補う。既存の (b) の裸のファイル名と同じ作法)。
SCOPE_TOKEN_PATTERN = (
    r"(?<![A-Za-z0-9_@.\-/*?])"
    r"(?:(?:\./)?[A-Za-z0-9_@.\-*?]+(?:/[A-Za-z0-9_@.\-*?]+)+/?"
    r"|[A-Za-z0-9_@*?][A-Za-z0-9_@.\-*?]*\.[A-Za-z][A-Za-z0-9]{0,9})"
    r"(?![A-Za-z0-9_@\-*?/])"
)
TYPES_TS_PATTERN = r"^packages/[^/]+/src/(?:.*/)?types\.ts$"
# 影響の列挙が要る本文の語(過去形の「足した」は対象外。引用符・バッククォートの中は規約の引用なので除く)。
IMPACT_BODY_PATTERNS = (
    r"kind[ \t]*を[ \t]*(?:足す|追加)",
    r"欄を[ \t]*(?:足す|追加)",
    r"型に[^。\n]{0,40}を[ \t]*追加",
)
IMPACT_SKIP_TITLE_PATTERN = r"過去の失敗|変えてはいけない"
CITED_RULE_PATTERN = r"§[0-9]+(?:\.[0-9]+)*[a-z]?[（(][^）)]*[）)]"
IMPACT_NEGATION_PATTERN = r"採らない|採用しない|行わない|やらない|しない|避け|禁止|足さない|追加しない|不要"
IMPACT_TITLE_PATTERN = r"^(?:[0-9０-９]+[.．)）]?[ \t]*)?影響の列挙"
IDENT_LINE_PATTERN = r"対象の識別子[ \t]*[:：][ \t]*(.*)$"
NOTOUCH_LINE_PATTERN = r"触らない[ \t]*[:：][ \t]*(.*)$"
PAREN_PATTERN = r"[（(]([^）)]*)[）)]"
ACCEPT_TITLE_PATTERN = r"^(?:[0-9０-９]+[.．)）\s]*)?合格条件"
ACCEPT_NUMBER_PATTERN = r"^[2２][.．)）\s]"
# 「出典 <パス>:<行>」。行の範囲(:10-12)と、「出典 a:10、b:20」のように読点で並べた複数の出典も許す。
CITATION_HEAD_PATTERN = r"出典[ \t]*[:：]?[ \t]*"
CITATION_ITEM_PATTERN = (
    r"`?([^\s`:：（）()、。，,「」『』\"']+?)`?[ \t]*[:：][ \t]*([0-9]+)"
    r"(?:[ \t]*[-–－〜~][ \t]*([0-9]+))?"
)
CITATION_SEPARATOR_PATTERN = r"[ \t]*[、，,・][ \t]*(?:出典[ \t]*[:：]?[ \t]*)?"
QUOTE_PATTERN = (
    r"「([^「」\n]{1,200})」"
    r"|『([^『』\n]{1,200})』"
    r"|“([^“”\n]{1,200})”"
    r"|(?<![A-Za-z0-9])\"([^\"\n]{1,200})\"(?![A-Za-z0-9])"
    r"|(?<![A-Za-z0-9])'([^'\n]{1,200})'(?![A-Za-z0-9])"
)
LOCAL_COPY_PATTERN = r"手元[ \t]*[:：][ \t]*`?([^\s`（）()、。，,「」『』]+)"
# 取得を許可する文。W6 は「ダウンロードはしない」と書いて止まり、W6b は「取得し、SHA-256 が一致した
# 場合だけ出典として使う」と書いて通った。否定の形(許可しない・取得しない)は許可に数えない。
FETCH_PERMIT_PATTERN = (
    r"取得を許可(?!しない|せず|していない|できない)"
    r"|取得して(?:も)?よい(?!か)"
    r"|取得を認め(?!ない)"
    r"|取得し[、，,]"
    r"|取得して[、，,]"
    r"|ダウンロード(?:を許可|して(?:も)?よい)(?!しない)"
)
HELP_CONTENT_NAMES = ("controlInventory.test.ts", "topics.test.ts")
GENERATED_SIDE_TRIGGER_PATTERN = r"表を増やす|行の加法追加|fixture[ \t]*を[ \t]*足す"
GENERATED_SIDE_FILE_PATTERN = r"(?:Profiles|Generator|Builder)\.ts$"
GENERATED_SIDE_CONFIRM_PATTERN = r"生成側の確認[ \t]*[:：][ \t]*\S"


def _headings(lines: list[str]) -> list[tuple[int, int, str]]:
    """(行の位置, 見出しの深さ, 見出しの文)。コードの囲み(```)の中の # は見出しにしない。"""
    found: list[tuple[int, int, str]] = []
    in_fence = False
    for index, line in enumerate(lines):
        if re.match(FENCE_PATTERN, line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = re.match(HEADING_PATTERN, line)
        if match:
            found.append((index, len(match.group(1)), match.group(2)))
    return found


def _section_range(lines: list[str], headings: list[tuple[int, int, str]], position: int) -> tuple[int, int]:
    """見出し(headings[position])の行から、同じか浅い次の見出しの手前までの (開始, 終了の次) の位置。"""
    start, level, _ = headings[position]
    end = len(lines)
    for later_start, later_level, _ in headings[position + 1:]:
        if later_level <= level:
            end = later_start
            break
    return start, end


def _acceptance_range(lines: list[str]) -> tuple[int, int] | None:
    """§2(合格条件)の節の (見出しの位置, 終了の次の位置)。番号が 2 の見出しを先に探し、無ければ
    「合格条件」で始まる見出し(「1. 目的（…の合格条件）」のような括弧の中の語には当たらない)。"""
    headings = _headings(lines)
    for pattern in (ACCEPT_NUMBER_PATTERN, ACCEPT_TITLE_PATTERN):
        position = next(
            (index for index, (_, _, title) in enumerate(headings) if re.match(pattern, title)), None)
        if position is not None:
            return _section_range(lines, headings, position)
    return None


def _looks_like_instruction(lines: list[str]) -> bool:
    """担当への指示書の雛形か(「③」で始まる行、または「# 指示書」の見出しがある)。
    この道具は報告の下書きなど指示書でない文書にも --check される(v103_publish_report.py)ので、
    新しい検査は指示書の形の文書にだけ当てる。"""
    return any(re.match(SCOPE_LINE_PATTERN, line) or re.match(INSTRUCTION_TITLE_PATTERN, line) for line in lines)


def _scope_block(lines: list[str]) -> tuple[int, list[str]] | None:
    """③の段落(「③」で始まる行から、空行・見出し・次の丸数字の手前まで)の (最初の行の位置, 行の一覧)。無ければ None。"""
    for index, line in enumerate(lines):
        if not re.match(SCOPE_LINE_PATTERN, line):
            continue
        collected = [line]
        for follow in lines[index + 1:]:
            if not follow.strip() or re.match(SCOPE_STOP_PATTERN, follow):
                break
            collected.append(follow)
        return index, collected
    return None


def _scope_paragraph(lines: list[str]) -> str:
    """③の段落の文。無ければ空。"""
    block = _scope_block(lines)
    return "\n".join(block[1]) if block else ""


def _strip_command_spans(text: str) -> str:
    """`rg -l …` のようなコマンドのバッククォートは編集の範囲ではないので空白にする。"""
    def blank(match):
        return " " * len(match.group(0)) if re.match(COMMAND_SPAN_PATTERN, match.group(1)) else match.group(0)
    return re.sub(CODE_SPAN_PATTERN, blank, text)


def _entry_folder(entry: str) -> str:
    """経路の語の「フォルダー」: 末尾 / か拡張子の無い最後の部分ならその語自身、拡張子つきのファイルならその親。"""
    body = entry.rstrip("/")
    last_segment = body.rsplit("/", 1)[-1]
    if entry.endswith("/") or "." not in last_segment:
        return body
    return body.rsplit("/", 1)[0]


def _path_entry_spans(text: str) -> list[tuple[str, str, int, int, bool]]:
    """文の中の経路の語を出現の順に (補った後の語, 書かれた語, 始まり, 終わり, 裸の名前か)。
    フルパス・末尾 / のフォルダー・glob と、直前のフォルダーで補った裸の名前。始まり・終わりは text の中の位置
    (バッククォートのコマンドは長さを変えずに空白にするので、元の文の位置と同じ)。重複も落とさない。
    検査 1・4・5 の _path_entries と検査 7 が、同じこの切り出しを共有する。"""
    spans: list[tuple[str, str, int, int, bool]] = []
    last_dir: str | None = None
    for match in re.finditer(SCOPE_TOKEN_PATTERN, _strip_command_spans(text)):
        token = match.group(0).rstrip(".")
        while token.startswith("./"):
            token = token[2:]
        if not token:
            continue
        if "/" in token:
            entry = token
            last_dir = _entry_folder(token)
            bare = False
        elif last_dir:
            entry = f"{last_dir}/{token}"
            bare = True
        else:
            continue
        spans.append((entry, token, match.start(), match.start() + len(match.group(0).rstrip(".")), bare))
    return spans


def _path_entries(text: str) -> list[str]:
    """文の中の経路の語(フルパス・末尾 / のフォルダー・glob・直前のフォルダーで補った裸の名前)。"""
    entries: list[str] = []
    for entry, _token, _start, _end, _bare in _path_entry_spans(text):
        if entry not in entries:
            entries.append(entry)
    return entries


def _glob_regex(pattern: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if pattern.startswith("**/", index):
                out.append("(?:.*/)?")
                index += 3
                continue
            if pattern.startswith("**", index):
                out.append(".*")
                index += 2
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        index += 1
    return "".join(out)


def _entry_covers(entry: str, path: str) -> bool:
    """経路の語 entry が、根からの相対の path を覆うか(同じ・フォルダー・glob)。"""
    body = entry.rstrip("/")
    if not body:
        return False
    if "*" in body or "?" in body:
        return re.match("^" + _glob_regex(body) + "(?:/.*)?$", path) is not None
    return path == body or path.startswith(body + "/")


def _without_quoted(line: str) -> str:
    """引用(「」『』“”・\"\"・'')とバッククォートの中を空白にした行(規約の題名の引用を数えない)。"""
    blanked = re.sub(CODE_SPAN_PATTERN, lambda m: " " * len(m.group(0)), line)
    return re.sub(QUOTE_PATTERN, lambda m: " " * len(m.group(0)), blanked)


def _quoted_strings(line: str) -> list[str]:
    found: list[str] = []
    for match in re.finditer(QUOTE_PATTERN, line):
        value = next(group for group in match.groups() if group is not None)
        if value.strip():
            found.append(value)
    return found


def _file_lines(root: Path, relative: str) -> list[str] | None:
    relative = _normalize_relative(relative)
    if not _safe_relative(relative):
        return None
    try:
        target = root / relative
        if not target.is_file():
            return None
        return target.read_bytes().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None


# --- 参照するファイルの走査(rg --files-with-matches --fixed-strings 相当) ---


def _scan_dirs(root: Path) -> list[str]:
    """走査の範囲: packages/*/src・apps/*/src・e2e/tests のうち実在するもの(root からの相対)。"""
    found: list[str] = []
    for group in ("packages", "apps"):
        base = root / group
        try:
            children = sorted(child.name for child in base.iterdir() if (child / "src").is_dir())
        except OSError:
            continue
        found.extend(f"{group}/{name}/src" for name in children)
    if (root / "e2e" / "tests").is_dir():
        found.append("e2e/tests")
    return found


def _rg_invocation():
    """PATH に rg があればその呼び方 (コマンドの先頭, 追加の環境変数)。無ければ None(純 Python の走査)。
    Claude Code の Bash の rg は claude.exe を ARGV0=rg で呼ぶ関数で、Python の子プロセスの PATH には無い。"""
    import shutil
    exe = shutil.which("rg")
    return ([exe], {}) if exe else None


def _rg_scan(invocation, root: Path, scan_dirs: list[str], identifiers: list[str], deadline: float):
    import os
    import subprocess
    import time
    command, extra_env = invocation
    env = dict(os.environ)
    env.update(extra_env)
    skip_globs = [f"--glob=!**/{name}/**" for name in sorted(SCAN_SKIP_DIRS)]
    found: dict[str, list[str]] = {}
    for identifier in identifiers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return found, False
        result = subprocess.run(
            [*command, "--files-with-matches", "--fixed-strings", "--null", "--no-messages",
             "--no-ignore", "--hidden", *skip_globs, "-e", identifier, "--", *scan_dirs],
            cwd=str(root), env=env, capture_output=True, timeout=max(remaining, 0.1),
        )
        if result.returncode not in (0, 1):
            raise RuntimeError(f"rg の終了コード {result.returncode}")
        names = []
        for raw in result.stdout.split(b"\0"):
            if not raw:
                continue
            name = raw.decode("utf-8", errors="replace").replace("\\", "/")
            while name.startswith("./"):
                name = name[2:]
            names.append(name)
        found[identifier] = sorted(set(names))
    return found, True


def _scan_cache_path(root: Path):
    """走査の高速化用の控え。root/scratchpad/temp があるときだけ使う(無い・書けない時は黙って使わない。
    控えが無くても結果は同じで、速さだけが違う。クリーンな取り出しの CI は scratchpad/temp を持たない)。"""
    directory = root / "scratchpad" / "temp"
    return directory / SCAN_CACHE_NAME if directory.is_dir() else None


def _load_scan_cache(path) -> tuple[list[str], dict]:
    """(控えが答えを持つ識別子の一覧, {相対パス: [mtime_ns, size, [その識別子のうちファイルに在るもの]]})。
    壊れている・版が違うなら空。"""
    import json
    if path is None:
        return [], {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        searched, files = data["searched"], data["files"]
        if data.get("version") != 1 or not isinstance(searched, list) or not isinstance(files, dict):
            return [], {}
        return [name for name in searched if isinstance(name, str)], files
    except Exception:
        return [], {}


def _save_scan_cache(path, searched: list[str], files: dict) -> None:
    import json
    import os
    if path is None:
        return
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps({"version": 1, "searched": searched, "files": files}, ensure_ascii=False,
                       separators=(",", ":")),
            encoding="utf-8")
        os.replace(temporary, path)
    except Exception:
        try:
            temporary.unlink()
        except Exception:
            pass


def _python_scan(root: Path, scan_dirs: list[str], identifiers: list[str], deadline: float,
                 use_cache: bool = True):
    """全識別子を1回の走査で。ファイルごとに (mtime_ns, size) が前回と同じなら読まずに控えの答えを使う
    (別の担当が編集中でも、変わったファイルだけ読み直す)。控えが答えを持たない識別子が来たら全て読み直す。"""
    import os
    import time
    from concurrent.futures import ThreadPoolExecutor
    files: list[tuple[str, str, int, int]] = []
    for relative in scan_dirs:
        stack = [(str(root / relative), relative)]
        while stack:
            current, current_relative = stack.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name not in SCAN_SKIP_DIRS:
                                stack.append((entry.path, f"{current_relative}/{entry.name}"))
                        elif entry.is_file(follow_symlinks=False):
                            if entry.name.lower().endswith(SCAN_BINARY_SUFFIXES):
                                continue
                            info = entry.stat()
                            if info.st_size > SCAN_MAX_FILE_BYTES:
                                continue
                            files.append((entry.path, f"{current_relative}/{entry.name}",
                                          info.st_mtime_ns, info.st_size))
            except OSError:
                continue

    cache_path = _scan_cache_path(root) if use_cache else None
    cached_ids, cached_files = _load_scan_cache(cache_path)
    reuse = bool(cached_ids) and set(identifiers) <= set(cached_ids)
    wanted = list(cached_ids) if reuse else list(dict.fromkeys([*cached_ids, *identifiers]))
    if len(wanted) > SCAN_CACHE_MAX_IDENTIFIERS:
        wanted = list(identifiers)
    needles = [(name, name.encode("utf-8")) for name in wanted]

    present: dict[str, list[str]] = {}
    pending: list[tuple[str, str, int, int]] = []
    for item in files:
        _, relative, mtime_ns, size = item
        entry = cached_files.get(relative) if reuse else None
        if (isinstance(entry, list) and len(entry) == 3 and entry[0] == mtime_ns and entry[1] == size
                and isinstance(entry[2], list)):
            present[relative] = entry[2]
        else:
            pending.append(item)

    def match_file(item):
        try:
            with open(item[0], "rb") as handle:
                data = handle.read()
        except OSError:
            return item, None
        return item, [name for name, needle in needles if needle in data]

    complete = True
    fresh: dict[str, list] = {}
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        for offset in range(0, len(pending), 128):
            if time.monotonic() > deadline:
                complete = False
                break
            for item, hits in pool.map(match_file, pending[offset:offset + 128]):
                if hits is not None:
                    present[item[1]] = hits
                    fresh[item[1]] = [item[2], item[3], hits]

    if cache_path is not None and (fresh or not reuse or len(cached_files) != len(present)):
        kept = {relative: cached_files[relative] for relative in present if relative not in fresh and reuse}
        kept.update(fresh)
        _save_scan_cache(cache_path, wanted, kept)

    found: dict[str, list[str]] = {name: [] for name in identifiers}
    for relative, hits in present.items():
        for name in hits:
            if name in found:
                found[name].append(relative)
    return {name: sorted(paths) for name, paths in found.items()}, complete


def find_references(root: Path, identifiers: list[str], seconds: float, invocation="auto",
                    use_cache: bool = True):
    """各識別子を参照するファイル(packages/*/src・apps/*/src・e2e/tests の中。node_modules・dist・
    scratchpad などは除く)の根からの相対パス(/ 区切り・昇順)。戻り値は (識別子→一覧, 走査を終えたか)。
    PATH に rg があれば rg、無い・失敗した時は同じ範囲の純 Python の走査(全識別子を1回で。root/scratchpad/temp
    があれば前回の答えの控えを使い、変わったファイルだけ読む)。"""
    import time
    deadline = time.monotonic() + seconds
    scan_dirs = _scan_dirs(root)
    if not scan_dirs or not identifiers:
        return {name: [] for name in identifiers}, True
    chosen = _rg_invocation() if invocation == "auto" else invocation
    if chosen is not None:
        try:
            found, complete = _rg_scan(chosen, root, scan_dirs, identifiers, deadline)
            for name in identifiers:
                found.setdefault(name, [])
            return found, complete
        except Exception:
            pass
    return _python_scan(root, scan_dirs, identifiers, deadline, use_cache)


# --- 検査1: 影響の列挙 ---


def _impact_body_trigger(lines: list[str]) -> str | None:
    """本文に「kind を足す」「欄を足す」「型に…を追加」があればその語。規約の引用(§10.422（型に欄を足す時は…）)、
    引用符の中、「過去の失敗」「変えてはいけないもの」の節、「…を足す案は採らない」のような否定の文は数えない。"""
    headings = _headings(lines)
    skipped: list[tuple[int, int]] = []
    for position, (_, _, title) in enumerate(headings):
        if re.search(IMPACT_SKIP_TITLE_PATTERN, title):
            skipped.append(_section_range(lines, headings, position))
    for index, line in enumerate(lines):
        if any(low <= index < high for low, high in skipped):
            continue
        plain = re.sub(CITED_RULE_PATTERN, " ", _without_quoted(line))
        for pattern in IMPACT_BODY_PATTERNS:
            for match in re.finditer(pattern, plain):
                sentence_tail = plain[match.end():match.end() + 80].split("。")[0]
                if re.search(IMPACT_NEGATION_PATTERN, sentence_tail):
                    continue
                return match.group(0)
    return None


def _identifiers(section: list[str]) -> tuple[list[str], str | None]:
    """(識別子の一覧, 「なし」の宣言の理由)。`対象の識別子: なし（理由）` は、型・kind・欄を実際には
    変えない(本文の語が規約の引用だった等)ことの明示で、理由の括弧が要る。"""
    names: list[str] = []
    none_reason: str | None = None
    for line in section:
        match = re.search(IDENT_LINE_PATTERN, line)
        if not match:
            continue
        reasons = [reason.strip() for reason in re.findall(PAREN_PATTERN, match.group(1)) if reason.strip()]
        value = re.sub(PAREN_PATTERN, " ", match.group(1))
        if re.fullmatch(r"[ \t]*(?:該当)?(?:なし|無し)[ \t。]*", value):
            if reasons:
                none_reason = reasons[0]
            continue
        for part in re.split(r"[,、，・;；\s]+", value):
            part = part.strip("`'\"「」『』。.")
            if part and part not in names:
                names.append(part)
    return names, none_reason


def _notouch_entries(section: list[str], first_line_number: int) -> tuple[list[str], list[int]]:
    """「触らない: <パス>（理由）」の行から経路の語を集める。理由の括弧が無い行は覆いに数えず、行番号を返す。"""
    entries: list[str] = []
    reasonless: list[int] = []
    for offset, line in enumerate(section):
        match = re.search(NOTOUCH_LINE_PATTERN, line)
        if not match:
            continue
        body = match.group(1)
        if not any(reason.strip() for reason in re.findall(PAREN_PATTERN, body)):
            reasonless.append(first_line_number + offset)
            continue
        for entry in _path_entries(re.sub(PAREN_PATTERN, " ", body)):
            if entry not in entries:
                entries.append(entry)
    return entries, reasonless


def impact_findings(root: Path, display: str, lines: list[str], scope_entries: list[str],
                    scan_seconds: float, full_lists: bool, invocation="auto",
                    scan_sink: dict | None = None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    triggers: list[str] = []
    if any(re.match(TYPES_TS_PATTERN, entry) for entry in scope_entries):
        triggers.append("③に packages/*/src の types.ts がある")
    body_phrase = _impact_body_trigger(lines)
    if body_phrase:
        triggers.append(f"本文に「{body_phrase}」がある")
    headings = _headings(lines)
    position = next(
        (index for index, (_, _, title) in enumerate(headings) if re.match(IMPACT_TITLE_PATTERN, title)), None)
    if position is None:
        if triggers:
            errors.append(
                f"{display}: 影響の列挙が無い({'・'.join(triggers)}のに `## 影響の列挙` の節が無い)。"
                "節に `対象の識別子: <名前>[, <名前>…]` を書き、その識別子を参照する全ファイル"
                "(rg -l -F -e <名前> packages/*/src 相当)を③に入れるか `触らない: <パス>（理由）` に書く"
                "(rules/06 §10.422・§10.423)")
        return errors, warnings
    start, end = _section_range(lines, headings, position)
    section = lines[start + 1:end]
    heading_number = start + 1
    identifiers, none_reason = _identifiers(section)
    if not identifiers:
        if none_reason:
            warnings.append(
                f"{display} 行{heading_number}: 影響の列挙: 対象の識別子は「なし」と宣言されている"
                f"(理由: {none_reason})。型・kind・欄を実際に変えないことを確かめる")
            return errors, warnings
        errors.append(
            f"{display} 行{heading_number}: 影響の列挙に `対象の識別子: <名前>[, <名前>…]` の行が無い"
            "(または名前が空)。型・kind・欄の名前を書く(変えないなら `対象の識別子: なし（理由）`)")
        return errors, warnings
    notouch, reasonless = _notouch_entries(section, heading_number + 1)
    for line_number in reasonless:
        errors.append(
            f"{display} 行{line_number}: `触らない:` の行に（理由）が無い。"
            "`触らない: <パス>（理由）` の形で書く(理由の無い行は覆いに数えない)")
    found, complete = find_references(root, identifiers, scan_seconds, invocation)
    if scan_sink is not None:
        scan_sink["found"] = found  # 検査 8 が同じ走査結果を再利用する(走査を増やさない)
    if not complete:
        warnings.append(
            f"{display}: 影響の列挙: 走査が {scan_seconds:g} 秒の枠を超えたため一部の参照が未確認"
            "(--check なら長い枠で走査する)")
    for name in identifiers:
        files = found.get(name, [])
        if not files and complete:
            warnings.append(
                f"{display}: 影響の列挙: 識別子 `{name}` を参照するファイルが 0 件"
                "(綴り違いか、これから作る名前か)")
        uncovered = [
            path for path in files
            if not any(_entry_covers(entry, path) for entry in scope_entries)
            and not any(_entry_covers(entry, path) for entry in notouch)
        ]
        if uncovered:
            shown = uncovered if full_lists else uncovered[:FILE_LIST_LIMIT]
            more = "" if len(shown) == len(uncovered) else f" …他{len(uncovered) - len(shown)}件"
            errors.append(
                f"{display} 行{heading_number}: 影響の列挙: 識別子 `{name}` を参照する {len(uncovered)} 個の"
                f"ファイルが③にも「触らない:」にも無い: {'、'.join(shown)}{more}。③に入れるか "
                "`触らない: <パス>（理由）` の行を足す(フォルダー・glob も可。rules/06 §10.422・§10.423)")
    return errors, warnings


# --- 検査2: 期待値の出典 ---


def _citations(line: str) -> list[tuple[str, int, int]]:
    """行の中の「出典 <パス>:<行>」を (パス, 開始行, 終了行) で集める(順序どおり・重複なし)。"""
    found: list[tuple[str, int, int]] = []
    for head in re.finditer(CITATION_HEAD_PATTERN, line):
        position = head.end()
        while True:
            item = re.match(CITATION_ITEM_PATTERN, line[position:])
            if not item:
                break
            citation = (item.group(1), int(item.group(2)), int(item.group(3) or item.group(2)))
            if citation not in found:
                found.append(citation)
            position += item.end()
            separator = re.match(CITATION_SEPARATOR_PATTERN, line[position:])
            if not separator:
                break
            position += separator.end()
    return found


def citation_findings(root: Path, display: str, lines: list[str]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    bounds = _acceptance_range(lines)
    if bounds is None:
        return errors, warnings
    start, end = bounds
    cache: dict[str, list[str] | None] = {}
    in_fence = False
    for index in range(start + 1, end):
        line = lines[index]
        line_number = index + 1
        if re.match(FENCE_PATTERN, line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        citations = _citations(line)
        if not citations:
            for quoted in _quoted_strings(re.sub(CODE_SPAN_PATTERN, lambda m: " " * len(m.group(0)), line)):
                warnings.append(
                    f"{display} 行{line_number}: 期待値の引用「{quoted}」に `出典 <パス>:<行>` が無い"
                    "(出典があれば、その行の前後3行に実在するかを確かめる)")
            continue
        quotes = _quoted_strings(line)
        if not quotes:
            continue
        windows: list[tuple[str, int, str]] = []
        for relative, first, last in citations:
            if relative not in cache:
                cache[relative] = _file_lines(root, relative)
            source = cache[relative]
            label = f"出典 {relative}:{first}" + (f"-{last}" if last != first else "")
            if source is None:
                errors.append(f"{display} 行{line_number}: {label} のファイルが無い")
                continue
            if first < 1 or first > len(source):
                errors.append(
                    f"{display} 行{line_number}: {label} の行が範囲外(そのファイルは全 {len(source)} 行)")
                continue
            low = max(0, first - 1 - CITATION_WINDOW)
            high = min(len(source), last + CITATION_WINDOW)
            windows.append((label, first, "\n".join(source[low:high])))
        if not windows:
            continue
        labels = "・".join(label for label, _, _ in windows)
        for quoted in quotes:
            if not any(quoted in window for _, _, window in windows):
                errors.append(
                    f"{display} 行{line_number}: 期待値「{quoted}」が {labels} の前後{CITATION_WINDOW}行に"
                    "実在しない(出典の実物を読んで写すか、出典の行を直す。W11d)")
    return errors, warnings


# --- 検査3: 出典の実物 ---


def source_evidence_findings(root: Path, display: str, text: str) -> list[str]:
    if "sources.md" not in text or not re.search(r"SHA-?256", text, re.IGNORECASE):
        return []
    if re.search(FETCH_PERMIT_PATTERN, text):
        return []
    missing: list[str] = []
    for match in re.finditer(LOCAL_COPY_PATTERN, text):
        candidate = match.group(1).rstrip(".")
        if _exists_under(root, candidate):
            return []
        missing.append(candidate)
    detail = f"(`手元:` の指す {'・'.join(missing)} は実在しない)" if missing else ""
    return [
        f"{display}: 出典の実物が無い: 本文に sources.md と SHA-256 があるのに、担当が出典の実物を得る手段が無い"
        f"{detail}。「取得を許可」「取得してよい」の文(取得先と SHA-256 の照合の手順つき)か、"
        "`手元: <実在するパス>` の行を足す(2026-10-25 の W6 の停止)"]


# --- 検査4: 画面を変える包みの help-content の検査 ---


def help_content_findings(display: str, lines: list[str], scope_entries: list[str]) -> list[str]:
    screen = [
        entry for entry in scope_entries
        if (re.match(r"^packages/ui/src/.*\.tsx$", entry) and not re.search(r"\.(?:test|spec)\.tsx$", entry))
        or entry == "packages/help-content/docs" or entry.startswith("packages/help-content/docs/")
    ]
    if not screen:
        return []
    bounds = _acceptance_range(lines)
    scope_text = "\n".join(lines) if bounds is None else "\n".join(lines[bounds[0]:bounds[1]])
    missing = [name for name in HELP_CONTENT_NAMES if name not in scope_text]
    if not missing:
        return []
    return [
        f"{display}: help-content の検査が §2 に無い: ③が画面か説明書({screen[0]} など)を変えるのに、"
        f"§2 に {'・'.join(missing)} が無い。`diag.py unit --package help-content "
        "src/controlInventory.test.ts src/topics.test.ts` を合格条件に足す(rules/06 §10.427)"]


# --- 検査5: 生成側の固定値(簡易。警告のみ) ---


def generated_side_findings(display: str, lines: list[str], scope_text: str, scope_entries: list[str]) -> list[str]:
    if not re.search(GENERATED_SIDE_TRIGGER_PATTERN, scope_text):
        return []
    if any(re.search(GENERATED_SIDE_FILE_PATTERN, entry) for entry in scope_entries):
        return []
    if any(re.search(GENERATED_SIDE_CONFIRM_PATTERN, line) for line in lines):
        return []
    return [
        f"{display}: 生成側の確認が無い: ③に「表を増やす」「行の加法追加」「fixture を足す」のいずれかがあるのに、"
        "生成側のファイル(*Profiles.ts・*Generator.ts・*Builder.ts)が③に無く、"
        "`生成側の確認: <ファイル>（固定値 …）` の行も無い(表を足しても生成側の固定値で通らない恐れ。W6)"]


# --- 検査7: ③のパスの実在 ---
# 2026-10-25 02:1x、cx-v103-ex09-w02-fe-material.md は、計画書の行から写した存在しない検査ファイル 3 本(analysisModel・
# analysisValidation・solidAnalysisModel の .test.ts)を③に書き、実在する変換の経路を③に入れないまま起動され、担当が製品を
# 編集せずに止まった。③に書いたパスの実在を、起動の前に os.path.exists だけで確かめる(フォルダーや glob は走査せず、フォルダー
# の実在だけ)。パスの切り出しは検査 1 と同じ _path_entry_spans を共有する。
# 対象は packages/・apps/・e2e/・scripts/・docs/・.claude/・scratchpad/claude/tools/ で始まるものだけ(scratchpad/claude/agents/
# <担当名>/ は担当が作るので対象外)。裸の名前(スラッシュ無し)は、直前の対象の語に「・」「、」(間に（補足）があってもよい)で
# つながる時だけ、その語のフォルダーで補って確かめる(補う先が曖昧な progress.md・plan.materials・他の担当の提案ファイルなどを
# 誤って外れにしないため)。

SCOPE_PATH_ROOTS = ("packages/", "apps/", "e2e/", "scripts/", "docs/", ".claude/", "scratchpad/claude/tools/")
NEW_WORD = "新規"
NEW_LOOKBACK = 12
NEW_ALL_PATTERN = r"いずれも|どちらも|全て|すべて|両方|両者"
RG_COMMAND_PATTERN = r"(?<![A-Za-z0-9_\-./])(?:rg|grep)(?![A-Za-z0-9_\-])"
LIST_JOINT_PATTERN = r"\s*([・、,，])\s*(?:新規\s*)?"
# 一覧の続きの裸の名前として確かめる拡張子(e.g の「g」や plan.materials・Set.size のような、ファイル名でない語を除く)。
BARE_FILE_EXTENSIONS = frozenset({
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "md", "py", "ps1", "sh", "css", "html", "yml", "yaml",
    "toml", "txt", "csv", "svg", "patch", "diff", "cpp", "h", "hpp", "rs",
})
# ビルドやインストールが作る場所。実在しなくてよい(例 apps/desktop/out/・e2e/node_modules)。scripts/build は製品の
# 道具の置き場なので、build は入れない。
GENERATED_SEGMENTS = frozenset({
    "node_modules", "dist", "dist-types", "out", ".vite", "coverage", "test-results", "playwright-report",
})
# 「既存の A・B・C の .test.ts」のような略記(フルパスで書かない)。A.test.ts などを③の前の語のフォルダーで補って確かめる。
SHORTHAND_PATTERN = (
    r"(?<![A-Za-z0-9_@.\-/])"
    r"([A-Za-z][A-Za-z0-9_]*(?:[ \t]*[・、][ \t]*[A-Za-z][A-Za-z0-9_]*)*)"
    r"[ \t]*の[ \t]*(\.(?:test|spec)\.tsx?)(?![A-Za-z0-9_])"
)
# 「X と同じフォルダーの …」「e2e/tests/cutFlow.ts 系」のように、名前でなく場所の目印として挙げた語の直後の言い回し。
LOCATOR_PATTERN = r"[ \t]*(?:と同じ(?:フォルダー|場所|階層)|の隣|系)"
_OPEN_BRACKETS = "（(〔"
_CLOSE_BRACKETS = "）)〕"


class _ScopePath:
    """③の中の確かめる対象の語。entry は根からの相対(裸の名前は前の語のフォルダーで補った後)、token は書かれた語。"""

    __slots__ = ("entry", "token", "start", "end", "bare", "glued", "locator")

    def __init__(self, entry: str, token: str, start: int, end: int, bare: bool, glued: bool = False,
                 locator: bool = False):
        self.entry = entry
        self.token = token
        self.start = start
        self.end = end
        self.bare = bare
        # 直後が「と同じフォルダー」「系」などの、場所の目印として挙げた語(その名前のファイルを編集するとは書いていない)。
        # この語は、ファイルそのものでなくそのフォルダーの実在だけを確かめる。
        self.locator = locator
        # 拡張子の無い語の直後に日本語の文字が続く: docs/2026-09-23-Claudeへの申し送り.md のように、切り出しが ASCII の
        # 範囲で切れた日本語の名前かもしれない(実在の名前の先頭と一致すれば実在とみなす)。
        self.glued = glued


def _matching_close(text: str, index: int) -> int | None:
    """text[index] が開き括弧のとき、対応する閉じ括弧の次の位置(入れ子を数える)。閉じていなければ None。"""
    depth = 0
    for position in range(index, len(text)):
        char = text[position]
        if char in _OPEN_BRACKETS:
            depth += 1
        elif char in _CLOSE_BRACKETS and depth:
            depth -= 1
            if depth == 0:
                return position + 1
    return None


def _tail_remark(text: str, end: int) -> tuple[str | None, int]:
    """語の直後(空白は許す)の（補足）の中身と、その閉じ括弧の次の位置。無ければ (None, end)。"""
    position = end
    while position < len(text) and text[position] in " \t":
        position += 1
    if position < len(text) and text[position] in "（(":
        close = _matching_close(text, position)
        if close is not None:
            return text[position + 1:close - 1], close
    return None, end


def _list_joint(text: str, previous_end: int, start: int) -> tuple[str, str | None] | None:
    """前の語の終わりから次の語の始まりまでが一覧の続き(「・」「、」だけ、または（補足）の後の「・」「、」)なら
    (区切り, 補足の中身または None)。それ以外は None。"""
    remark, position = _tail_remark(text, previous_end)
    match = re.fullmatch(LIST_JOINT_PATTERN, text[position:start]) if position <= start else None
    return (match.group(1), remark) if match else None


def _new_marked_before(text: str, start: int) -> bool:
    """語の直前(同じ行の NEW_LOOKBACK 文字以内)に「新規」がある。"""
    window = text[max(0, start - NEW_LOOKBACK):start].rsplit("\n", 1)[-1]
    return NEW_WORD in window


def _rg_quote_regions(text: str) -> list[tuple[int, int]]:
    """バッククォートの無い rg・grep のコマンドの、ダブルクォート・シングルクォートの中の範囲。「実在の名前は rg … で
    確かめる」の探す語で、パスではない。コマンドの終わりは 。 ） ) 改行。"""
    regions: list[tuple[int, int]] = []
    for command in re.finditer(RG_COMMAND_PATTERN, text):
        index = command.end()
        while index < len(text):
            char = text[index]
            if char in "。）)\n":
                break
            if char in "\"'":
                close = text.find(char, index + 1)
                newline = text.find("\n", index + 1)
                if close == -1 or (newline != -1 and newline < close):
                    break
                regions.append((index, close + 1))
                index = close + 1
                continue
            index += 1
    return regions


def _scope_path_subjects(text: str, scope_text: str) -> list[_ScopePath]:
    """確かめる対象の語(出現の順)。裸の名前は直前の対象の語に一覧でつながる時だけ、その語のフォルダーで補う。"""
    import unicodedata
    regions = _rg_quote_regions(text)
    subjects: list[_ScopePath] = []
    anchor: _ScopePath | None = None  # 一覧の直前の項目(直前の語の（補足）の中に出てくる語は項目ではない)
    anchor_remark_end = 0
    for _entry, token, start, end, bare in _path_entry_spans(scope_text):
        if any(low <= start < high for low, high in regions):
            continue
        if bare:
            if (anchor is None or token.rsplit(".", 1)[-1].lower() not in BARE_FILE_EXTENSIONS
                    or _list_joint(text, anchor.end, start) is None):
                continue
            entry = f"{_entry_folder(anchor.entry)}/{token}"
        elif (token.rstrip("/") + "/").startswith(SCOPE_PATH_ROOTS):
            entry = token
        else:
            continue
        parts = entry.split("/")
        if any(part and not part.strip(".") for part in parts):
            continue  # packages/model/src/... の「...」のような省略は経路ではない
        if any(part in GENERATED_SEGMENTS for part in parts):
            continue  # ビルドやインストールが作る場所は、起動の前には無くてよい
        glued = (not bare and end < len(text) and "." not in parts[-1] and unicodedata.category(text[end]) == "Lo")
        locator = re.match(LOCATOR_PATTERN, text[end:end + 16]) is not None
        subject = _ScopePath(entry, token, start, end, bare, glued, locator)
        subjects.append(subject)
        if start >= anchor_remark_end:
            anchor = subject
            anchor_remark_end = _tail_remark(text, end)[1]
    return subjects


def _new_flags(text: str, subjects: list[_ScopePath]) -> list[bool]:
    """各語が「これから作る」と書かれているか。(1) 直前 12 文字以内に「新規」、(2) 「新規 A・B」の B、(3) 直後の（…新規…）の補足と、
    その補足が「・」でつながる前の語(「A・B（新規）」)、「、」でつながる前の語は補足が「いずれも・全て・どちらも」を含む時(「A、B（いずれも新規）」)。"""
    count = len(subjects)
    flags = [_new_marked_before(text, subject.start) for subject in subjects]
    carried: list[bool | None] = [None] * count  # 補足に「新規」がある語: 「いずれも」等を含むか
    for index, subject in enumerate(subjects):
        remark = _tail_remark(text, subject.end)[0]
        if remark is not None and NEW_WORD in remark:
            flags[index] = True
            carried[index] = re.search(NEW_ALL_PATTERN, remark) is not None
    for index in range(1, count):
        joint = _list_joint(text, subjects[index - 1].end, subjects[index].start)
        if joint and joint[0] == "・" and joint[1] is None and flags[index - 1]:
            flags[index] = True
    for index in range(count - 1, 0, -1):
        if carried[index] is None:
            continue
        joint = _list_joint(text, subjects[index - 1].end, subjects[index].start)
        if joint and joint[1] is None and (joint[0] == "・" or carried[index]):
            flags[index - 1] = True
            if carried[index - 1] is None:
                carried[index - 1] = carried[index]
    return flags


def _glob_folder(entry: str) -> str | None:
    """glob(* ?)を含む語の、最初の glob の手前までのフォルダー。glob が無ければ None。"""
    if "*" not in entry and "?" not in entry:
        return None
    keep: list[str] = []
    for part in entry.split("/"):
        if "*" in part or "?" in part:
            break
        keep.append(part)
    return "/".join(keep)


def _scope_path_exists(root: Path, subject: _ScopePath) -> bool | None:
    """実在するか。glob はフォルダー部分(最初の * ? の手前まで)の実在、末尾 / はそのフォルダー。確かめられない形は None。"""
    folder = _glob_folder(subject.entry)
    if folder is not None:
        probe = folder
        if not probe:
            return True
    elif subject.locator:
        probe = _entry_folder(subject.entry)
    else:
        probe = subject.entry.rstrip("/")
    if not _safe_relative(_normalize_relative(probe)):
        return None
    if _exists_under(root, probe):
        return True
    if subject.glued:
        import os
        parent, _, last = probe.rpartition("/")
        try:
            if any(name.startswith(last) for name in os.listdir(root / parent)):
                return True
        except OSError:
            pass
    return bool(subject.bare and "*" not in subject.token and _exists_under(root, subject.token))


def scope_path_findings(root: Path, display: str, lines: list[str], scope_text: str) -> list[str]:
    block = _scope_block(lines)
    if block is None or not scope_text.strip():
        return []
    first_line = block[0]
    text = _strip_command_spans(scope_text)
    regions = _rg_quote_regions(text)
    subjects = _scope_path_subjects(text, scope_text)
    flags = _new_flags(text, subjects)
    marked_new = {subject.entry for subject, flag in zip(subjects, flags) if flag}
    messages: list[str] = []
    reported: set[str] = set()

    def report(entry: str, position: int, origin: str = "") -> None:
        reported.add(entry)
        line_number = first_line + scope_text.count("\n", 0, position) + 1
        messages.append(
            f"{display} 行{line_number}: ③のパスが実在しない: {entry}"
            f"（{origin}新規なら『新規 {entry}』と書く。計画書の行から写す前に ls で確かめる）")

    for subject, flag in zip(subjects, flags):
        if flag or subject.entry in marked_new or subject.entry in reported:
            continue
        if _scope_path_exists(root, subject) is False:
            folder = _glob_folder(subject.entry)
            notes = f"一覧の続きの `{subject.token}` を直前の語のフォルダーで補った。" if subject.bare else ""
            notes += "" if folder is None else f"glob の手前のフォルダー {folder} が無い。"
            if subject.locator and folder is None:
                notes += f"場所の目印の語（と同じフォルダー・系）なのでフォルダー {_entry_folder(subject.entry)} の実在だけを確かめたが、それも無い。"
            report(subject.entry, subject.start, notes)
    for match in re.finditer(SHORTHAND_PATTERN, text):
        if any(low <= match.start() < high for low, high in regions) or _new_marked_before(text, match.start()):
            continue
        suffix = match.group(2)
        written = f"{match.group(1)} の {suffix}"
        for stem in re.split(r"[ \t]*[・、][ \t]*", match.group(1)):
            folders: list[str] = []
            for subject in subjects:
                name = subject.entry.rstrip("/").rsplit("/", 1)[-1]
                if (subject.end <= match.start() and "." in name and "*" not in name and "?" not in name
                        and name.split(".")[0] == stem and _entry_folder(subject.entry) not in folders):
                    folders.append(_entry_folder(subject.entry))
            expansions = [f"{folder}/{stem}{suffix}" for folder in folders]
            if not expansions or any(e in marked_new or _exists_under(root, e) for e in expansions):
                continue
            if expansions[0] not in reported:
                report(expansions[0], match.start(), f"略記「{written}」の展開。")
    return messages


# --- 検査8: union 型の固定の表 ---
# 2026-10-25 cl-v103-instruction-guard-union。03:19 の cx-v103-ex03-w8-sgp-pipes は、文字列 union の SteelCondition に値を 1 つ足す
# 包みで、その値を鍵にした固定の表を持つ 2 ファイル(StandardPartPickerPanel.tsx の STEEL_CONDITION_LABELS、
# steelStockCsvExport.ts の CONDITIONS)を③に入れず「触らない:」に書き、担当は TS7053 が出ると確かめて止まった(損失 約 10 分)。
# 検査 1 は「参照するファイルが③か触らないにあること」しか見ないので、触らないに書けば通る。しかもこの 2 ファイルは型の名前を
# 一度も書かない(`as const` の表を item.condition で引くだけ)ので、検査 1 の参照の一覧にも入らない。
# 規則(実在の指示書 16 本と母集団 397 個の union の走査で決めた。scratchpad/claude/agents/cl-v103-instruction-guard-union/final.md):
#   対象 = `対象の識別子:` の識別子のうち、`export type <識別子> = '…' | '…'`(全ての要素が文字列リテラルで 2 つ以上。改行・コメント・
#          先頭の `|` を許す)で宣言されているもの。interface・数値の union・型の参照を含む union・ジェネリクスつきは対象外。
#   固定の表を持つファイル(.ts/.tsx/.mts/.cts)は次のどちらか:
#     (T) 型の名前を書くファイル(検査 1 の走査結果を再利用)に `Record<識別子,`・`[k in 識別子]`(Partial<Record<…>>・`[k in …]?` は除く)
#     (K) 1 つの `{…}` ブロックの鍵(`'値':`・`"値":`・`値:`)がちょうど union の値の集合のファイル(packages・apps の src のみ。e2e の
#         spec は製品の型を import せず別に写した期待値を持つので除く)。型の名前を書かない表はこちらでだけ見つかるので、値で探す走査を
#         1 回足す(検査 1 と同じ find_references。キャッシュつき。union 型の宣言が見つかった時だけ)。
#   「2 つ以上の鍵」では足りない: 値だけで探すと x/y/z・left/right・width/height が無関係なオブジェクトの鍵として至る所に出て、母集団の
#   220 個の union で 8,382 ファイルが当たった。「ちょうど値の集合」にし、同じ集合のファイルが UNION_GENERIC_LIMIT 個を超える値
#   (x/y/z など)や、値を全て含むファイルが UNION_CANDIDATE_LIMIT 個を超える値は、一般的な語として値の探索をせず警告にする。
#   外れ = 固定の表を持つファイルが③に無い(「触らない:」に書いてあっても外れ)。③の覆い(フルパス・フォルダー・glob)は検査 1 と同じ。

UNION_SOURCE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts")
UNION_GENERIC_LIMIT = 8
UNION_CANDIDATE_LIMIT = 150
UNION_MESSAGE = (
    "{display} 行{line}: 影響の列挙: union 型 {name} の値を鍵にした固定の表を持つ {path} が③に無い"
    "(触らないに書いても通らない。値を足すと TS7053 になる。rules/06 §10.423)")
UNION_KEY_PATTERN = (
    r"(?:^[ \t]*|[{,][ \t]*)(?:'([^'\n]{1,120})'|\"([^\"\n]{1,120})\"|`([^`\n$]{1,120})`|([A-Za-z_$][\w$]*))[ \t]*\??:")
UNION_TOKEN_PATTERN = (
    r"//[^\n]*|/\*.*?\*/|'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`|[{}()\[\]]")


def _source_text(root: Path, relative: str, texts: dict) -> str | None:
    """根からの相対パスのファイルの文字列(読めない・大き過ぎるなら None)。texts は 1 回の検査の中の読み取りの控え。"""
    if relative not in texts:
        try:
            target = root / relative
            if not target.is_file() or target.stat().st_size > SCAN_MAX_FILE_BYTES:
                texts[relative] = None
            else:
                texts[relative] = target.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            texts[relative] = None
    return texts[relative]


def _string_union_values(text: str, position: int) -> list[str] | None:
    """`export type X =` の直後の位置から、全ての要素が文字列リテラルの union ならその値の一覧(重複なし・2 つ以上)。
    型の参照・数値・テンプレート(${})・配列/交差/ジェネリクスの続き・1 つだけの場合は None。"""
    size = len(text)
    values: list[str] = []

    def skip(index: int) -> int:
        while index < size:
            if text[index].isspace():
                index += 1
            elif text.startswith("//", index):
                newline = text.find("\n", index)
                index = size if newline == -1 else newline + 1
            elif text.startswith("/*", index):
                close = text.find("*/", index + 2)
                index = size if close == -1 else close + 2
            else:
                break
        return index

    index = skip(position)
    if index < size and text[index] == "|":
        index = skip(index + 1)
    while True:
        if index >= size or text[index] not in "'\"`":
            return None
        quote = text[index]
        index += 1
        buffer: list[str] = []
        while index < size and text[index] != quote:
            if text[index] == "\\" and index + 1 < size:
                buffer.append(text[index + 1])
                index += 2
                continue
            if quote == "`" and text.startswith("${", index):
                return None
            if text[index] == "\n" and quote != "`":
                return None
            buffer.append(text[index])
            index += 1
        if index >= size:
            return None
        index += 1
        value = "".join(buffer)
        if value not in values:
            values.append(value)
        index = skip(index)
        if index < size and text[index] == "|":
            index = skip(index + 1)
            continue
        break
    if index < size and (text[index] in "[&<.(" or re.match(r"(?:extends|as|keyof)\b", text[index:index + 8])):
        return None
    return values if len(values) >= 2 else None


def _union_declarations(root: Path, identifier: str, files: list[str], texts: dict) -> list[tuple[str, list[str]]]:
    """識別子の文字列 union の宣言 (宣言のあるファイル, 値の一覧)。files は識別子を参照するファイル(検査 1 の走査結果)。"""
    pattern = r"export[ \t\r\n]+(?:declare[ \t]+)?type[ \t]+" + re.escape(identifier) + r"[ \t\r\n]*="
    found: list[tuple[str, list[str]]] = []
    for relative in files:
        if not relative.endswith(UNION_SOURCE_SUFFIXES):
            continue
        text = _source_text(root, relative, texts)
        if text is None or identifier not in text:
            continue
        for match in re.finditer(pattern, text):
            values = _string_union_values(text, match.end())
            if values is not None:
                found.append((relative, values))
    return found


def _object_key_sets(text: str) -> list[set[str]]:
    """ファイルの全ての `{…}` ブロックについて、そのブロックの直下に書かれた鍵の集合。文字列・コメントの中は鍵に数えず、
    `(…)`・`[…]` の中(関数の引数など)はブロックの鍵に数えない。"""
    import bisect
    spans: list[tuple[int, int]] = []
    events: list[tuple[int, str]] = []
    for match in re.finditer(UNION_TOKEN_PATTERN, text, re.S):
        token = match.group(0)
        if len(token) == 1 and token in "{}()[]":
            events.append((match.start(), token))
        else:
            spans.append((match.start(), match.end()))
    span_starts = [start for start, _ in spans]
    stack: list[tuple[str, int]] = []
    cursor = 0
    groups: dict[int, set[str]] = {}
    for match in re.finditer(UNION_KEY_PATTERN, text, re.M):
        group = next(number for number in (1, 2, 3, 4) if match.group(number) is not None)
        position = match.start(group) - (1 if group <= 3 else 0)
        inside = bisect.bisect_right(span_starts, position) - 1
        if inside >= 0 and spans[inside][0] < position < spans[inside][1]:
            continue
        while cursor < len(events) and events[cursor][0] < position:
            if events[cursor][1] in "{([":
                stack.append((events[cursor][1], events[cursor][0]))
            elif stack:
                stack.pop()
            cursor += 1
        if stack and stack[-1][0] == "{":
            groups.setdefault(stack[-1][1], set()).add(match.group(group))
    return list(groups.values())


def _has_exact_table(text: str, values: list[str]) -> bool:
    """1 つの `{…}` ブロックの鍵が、ちょうど values の集合か。先に 1 回の正規表現で全ての値が鍵の形で現れるかを確かめる。"""
    wanted = set(values)
    quoted = "|".join(re.escape(value) for value in values)
    bare = "|".join(re.escape(value) for value in values if re.fullmatch(r"[A-Za-z_$][\w$]*", value))
    pattern = (
        r"(?:^[ \t]*|[{,][ \t]*)(?:'(?:" + quoted + r")'|\"(?:" + quoted + r")\"|`(?:" + quoted + r")`"
        + (r"|(?<![\w$.])(?:" + bare + r")(?![\w$])" if bare else "") + r")[ \t]*\??:")
    present: set[str] = set()
    for match in re.finditer(pattern, text, re.M):
        token = match.group(0).lstrip(" \t{,").rstrip(" \t?:")
        present.add(token[1:-1] if token[:1] in "'\"`" else token)
        if present >= wanted:
            break
    if not present >= wanted:
        return False
    return any(keys == wanted for keys in _object_key_sets(text))


def _identifier_lines(lines: list[str], start: int, end: int) -> dict[str, int]:
    """`## 影響の列挙` の節(lines[start] が見出し、end の手前まで)の `対象の識別子:` の行に書かれた識別子 → その行の番号(1 始まり)。"""
    numbers: dict[str, int] = {}
    for offset, line in enumerate(lines[start + 1:end]):
        match = re.search(IDENT_LINE_PATTERN, line)
        if not match:
            continue
        for part in re.split(r"[,、，・;；\s]+", re.sub(PAREN_PATTERN, " ", match.group(1))):
            part = part.strip("`'\"「」『』。.")
            if part and part not in numbers:
                numbers[part] = start + 2 + offset
    return numbers


def union_table_findings(root: Path, display: str, lines: list[str], scope_entries: list[str], scan_sink: dict,
                         seconds: float, invocation="auto") -> tuple[list[str], list[str]]:
    """検査 8。scan_sink は検査 1 の走査結果(識別子→参照するファイル)。無ければ(影響の列挙が無い・走査に失敗)何もしない。"""
    import time
    errors: list[str] = []
    warnings: list[str] = []
    found = scan_sink.get("found")
    headings = _headings(lines)
    position = next(
        (index for index, (_, _, title) in enumerate(headings) if re.match(IMPACT_TITLE_PATTERN, title)), None)
    if not found or position is None:
        return errors, warnings
    deadline = time.monotonic() + seconds
    start, end = _section_range(lines, headings, position)
    identifiers, _none_reason = _identifiers(lines[start + 1:end])
    numbers = _identifier_lines(lines, start, end)
    texts: dict = {}
    declarations: list[tuple[str, str, list[str]]] = []
    for name in identifiers:
        for declared_in, values in _union_declarations(root, name, found.get(name, []), texts):
            declarations.append((name, declared_in, values))
    if not declarations:
        return errors, warnings
    wanted_values = list(dict.fromkeys(value for _name, _file, values in declarations for value in values))
    value_files, complete = find_references(root, wanted_values, max(deadline - time.monotonic(), 0.25), invocation)
    if not complete:
        warnings.append(
            f"{display}: 影響の列挙: union 型の値の走査が {seconds:g} 秒の枠を超えたため、型の名前を書かない表は一部未確認"
            "(--check なら長い枠で走査する)")
    reported: set[tuple[str, str]] = set()
    for name, _declared_in, values in declarations:
        line = numbers.get(name, start + 1)
        tables: list[str] = []
        typed = (r"(?<!Partial<)Record<\s*" + re.escape(name) + r"\b|\[\s*\w+\s+in\s+" + re.escape(name)
                 + r"\s*\](?!\s*\?)")
        for relative in found.get(name, []):
            if relative.endswith(UNION_SOURCE_SUFFIXES):
                text = _source_text(root, relative, texts)
                if text is not None and re.search(typed, text):
                    tables.append(relative)
        hits: set[str] | None = None
        for value in values:
            files = set(value_files.get(value, []))
            hits = files if hits is None else hits & files
        candidates = sorted(
            path for path in (hits or set()) if path.endswith(UNION_SOURCE_SUFFIXES) and not path.startswith("e2e/"))
        keyed: list[str] = []
        if len(candidates) > UNION_CANDIDATE_LIMIT:
            warnings.append(
                f"{display} 行{line}: 影響の列挙: union 型 {name} の値 {len(values)} 個を全て含むファイルが {len(candidates)} 個あり、"
                f"一般的な語とみなして型の名前を書かない表は探していない(Record<{name},…> の表は探した)")
        else:
            for relative in candidates:
                if time.monotonic() > deadline:
                    warnings.append(
                        f"{display} 行{line}: 影響の列挙: union 型 {name} の値を鍵にした表の探索が {seconds:g} 秒の枠を超えたため一部未確認")
                    break
                text = _source_text(root, relative, texts)
                if text is not None and _has_exact_table(text, values):
                    keyed.append(relative)
            if len(keyed) > UNION_GENERIC_LIMIT:
                warnings.append(
                    f"{display} 行{line}: 影響の列挙: union 型 {name} の値 {len(values)} 個がちょうど鍵のオブジェクトが "
                    f"{len(keyed)} 個のファイルにあり、一般的な語とみなして型の名前を書かない表は探していない"
                    f"(Record<{name},…> の表は探した)")
                keyed = []
        for relative in sorted(set(tables) | set(keyed)):
            if (name, relative) in reported:
                continue
            reported.add((name, relative))
            if any(_entry_covers(entry, relative) for entry in scope_entries):
                continue
            errors.append(UNION_MESSAGE.format(display=display, line=line, name=name, path=relative))
    return errors, warnings


def check_instruction_report(root: Path, display_path: str, text: str, now: datetime, *,
                             full_lists: bool = False, scan_seconds: float = HOOK_SCAN_SECONDS,
                             invocation="auto") -> tuple[list[str], list[str]]:
    """(外れの一覧, 警告の一覧)。外れは起動を止め、警告は --check の出力にだけ出す。
    既存の3検査((a) 新規・(b) SHA-256・(c) 先の時刻)の後に、新しい検査を順に行う。"""
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
    warnings: list[str] = []
    lines = text.splitlines()
    import time
    checks_started = time.monotonic()
    scan_sink: dict = {}  # 検査 1 の走査結果を検査 8 へ渡す
    if not _looks_like_instruction(lines):
        # 報告記録の下書き(v103_publish_report.py が --check にかける)など、③の行も「# 指示書」の見出しも無い
        # 文書には、新しい検査(指示書の雛形を前提にする)を当てない。
        return messages, warnings
    try:
        scope_text = _scope_paragraph(lines)
        scope_entries = _path_entries(scope_text)
    except Exception as exc:
        scope_text, scope_entries = "", []
        warnings.append(f"{display_path}: ③の読取りが内部の例外で実行できなかった: {exc!r}")
    steps = (
        ("影響の列挙", lambda: impact_findings(
            root, display_path, lines, scope_entries, scan_seconds, full_lists, invocation, scan_sink)),
        ("期待値の出典", lambda: citation_findings(root, display_path, lines)),
        ("出典の実物", lambda: (source_evidence_findings(root, display_path, text), [])),
        ("help-content", lambda: (help_content_findings(display_path, lines, scope_entries), [])),
        ("生成側の確認", lambda: ([], generated_side_findings(display_path, lines, scope_text, scope_entries))),
        ("③のパスの実在", lambda: (scope_path_findings(root, display_path, lines, scope_text), [])),
        ("union 型の固定の表", lambda: union_table_findings(
            root, display_path, lines, scope_entries, scan_sink,
            max(0.25, scan_seconds - (time.monotonic() - checks_started)), invocation)),
    )
    for name, step in steps:
        try:
            step_errors, step_warnings = step()
        except Exception as exc:
            warnings.append(f"{display_path}: 検査「{name}」が内部の例外で実行できなかった: {exc!r}")
            continue
        messages.extend(step_errors)
        warnings.extend(step_warnings)
    return messages, warnings


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
            messages, warnings = check_instruction_report(
                _root(), _display_for(path), text, now, full_lists=True, scan_seconds=CLI_SCAN_SECONDS)
            for message in messages:
                print(message)
            print(f"外れ: {len(messages)} 件")
            for warning in warnings:
                print(f"警告: {warning}")
            print(f"警告: {len(warnings)} 件")
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
