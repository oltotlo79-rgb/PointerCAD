"""統括（Claude Fable）が Bash・PowerShell で調査・作業をすることを止める（rules/06 §10.485、rules/01 §2）。

利用者の指示（2026-11-11）「あなたは作業しないでね。サブエージェントに作業させてね」「ミスは物的対策を打ち、
再発防止をして繰り返させないこと」。統括のセッションの命令だけを判定し、次のどれかに当たれば終了コード 2 と
1 行の理由（stderr）で拒否する。

- R1 製品コードの検索: rg・grep・findstr・Select-String・find・Get-ChildItem -Recurse・ls -R・dir /s・tree・git grep の
  対象が packages/・apps/・e2e/ の下（git grep は対象を省くとリポジトリ全体なので R1）。
- R2 再帰・横断の走査: grep -r、フォルダーへの rg、find、Get-ChildItem -Recurse、ls -R、du、tree と、複数の RUN・
  delivery・担当を回す繰返し（for・while・foreach・ForEach-Object・xargs・ワイルドカード）、会話記録
  （~/.claude/projects）の読取り。対象が次の 1 つの容れ物に収まる時は通す: scratchpad/claude/deliveries/<ID>/・
  runs/<ID>/・agents/<担当>/・instructions/・root-runtime/（find は -maxdepth 1 か 2 の時だけ）。
- R3 製品コードの読取り: cat・head・tail・sed・awk・less・more・type・Get-Content などの対象が製品コード。
- R4 プロセス・性能・OS の調査: Get-Process・Get-CimInstance・Get-WmiObject・Get-WinEvent・Get-EventLog・
  Get-Counter・typeperf・tasklist・wmic・powercfg・systeminfo・perfmon と、その別名・同じ働きの物
  （ps・gps・gcim・gwmi・wevtutil・Get-ComputerInfo・[System.Diagnostics.Process] など）。PC の状態は
  scratchpad/claude/tools/pc_state.py で見る。
- R5 プロセスの強制終了: Stop-Process・taskkill・kill -9（PowerShell の kill は Stop-Process）・pkill・killall。
- R6 道具の失敗をパイプで隠す（2026-11-11 追加、rules/06 §10.485 の誤り B）: Bash の命令で、python で
  scratchpad/claude/tools/・scratchpad/claude/root-runtime/・.claude/hooks/ の道具を実行する部分が `|` で別の命令
  （tail・head・grep など）へ流れ、その後ろに &&・||・;・改行で別の命令が続くのに、最初の `|` より前に
  `set -o pipefail` が無い。後ろに何も続かない命令と PowerShell は通す。理由は「道具の失敗が後ろの命令で隠れる。
  先頭に set -o pipefail を付けるか、命令を分ける」。R6 は緊急時の印でも通さない。

担当（agent_id がある、または transcript_path が …/subagents/agent-*.jsonl）と、呼出し元を判定できない時は通す
（workers_pause_guard.caller と同じ判定）。命令は && || ; | & 改行で区切った各部分ごとに、引用の中の文字列を
命令として数えずに判定する。ただし bash -c・sh -c・eval・powershell -Command・cmd /c の文字列、$(…)・`…`・<(…)
の中身、PowerShell の ( … )・{ … } の中身は命令として判定する。`cd <パス>`（Set-Location・pushd を含む）の後ろの
相対パスはそこからの相対として解く。python -c・node -e・Invoke-Expression・変数に入れた命令・-EncodedCommand・
閉じていない引用など、文字列から解けない書式は通す（自己試験に負例として明記）。

緊急時の印 scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json
（{"reason": 空でない文字列, "placedAt": ISO 時刻, "until": ISO 時刻}。placedAt ≦ 今 < until、
until − placedAt ≦ 30 分）が有効な間だけ R1〜R5 を通し、通した命令を
scratchpad/claude/state/orchestrator-scope-exceptions.jsonl に 1 行ずつ（時刻・区分・命令の先頭 200 字・印の reason）
追記する。印が壊れている・期限切れ・30 分を超える時は通さない（理由の末尾に印が無効な訳を足す）。

子プロセスは起こさない。ファイルは R1〜R5 に当たった時の印 1 つだけ読む（印が有効なら記録へ 1 行追記）。
入力の JSON が読めない時は POINTERCAD_HOOK_FAIL_OPEN を stderr に出して通す（他のフックと同じ）。
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta

# 他のフックと同じく、自分の実パスから 3 つ上がリポジトリの根（pathlib は読込みが重いので使わない。
# subagent_search_scope_guard.py の OPS-26 の記録）。
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
MARKER = "scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json"
EXCEPTION_LOG = "scratchpad/claude/state/orchestrator-scope-exceptions.jsonl"
MARKER_MAX_WINDOW = timedelta(minutes=30)
TOOLS = ("Bash", "PowerShell")
SUBAGENT_TRANSCRIPT_PATTERN = r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
REASON_PREFIX = "統括は調査・作業をしない（rules/01 §2、利用者 2026-11-11）。担当へ指示書で出す。"
MAX_NESTING = 3

PRODUCT_DIRS = ("packages", "apps", "e2e")
CONTAINER_TREES = ("deliveries", "runs", "agents")      # scratchpad/claude/<木>/<ID>/ が 1 つの容れ物
SINGLE_CONTAINERS = ("instructions", "root-runtime")    # scratchpad/claude/<名前>/ がそのまま 1 つの容れ物
KNOWN_DOT_DIRS = (".claude", ".git", ".github", ".vscode", ".husky", ".config", ".cache")

R4_NAMES = frozenset({
    "get-process", "gps", "ps", "get-ciminstance", "gcim", "get-wmiobject", "gwmi", "get-winevent",
    "get-eventlog", "get-counter", "typeperf", "tasklist", "wmic", "powercfg", "systeminfo", "perfmon",
    "resmon", "wevtutil", "get-computerinfo", "logman", "top", "htop", "pslist", "procexp", "procexp64",
    "get-mpcomputerstatus", "get-mpthreat", "get-mpthreatdetection",
})
R5_NAMES = frozenset({"stop-process", "spps", "taskkill", "tskill", "pkill", "killall"})
PS_TYPE_R4 = re.compile(
    r"\[(?:system\.)?diagnostics\.(?:process|performancecounter|eventlog)\]"
    r"|\[(?:wmi|wmiclass|wmisearcher)\]|management\.managementobjectsearcher", re.IGNORECASE)

GREP_NAMES = frozenset({"grep", "egrep", "fgrep", "zgrep"})
RG_NAMES = frozenset({"rg", "ag", "ack"})
SED_AWK = frozenset({"sed", "awk", "gawk", "mawk", "nawk"})
READERS = frozenset({"cat", "head", "tail", "less", "more", "nl", "tac", "bat", "xxd", "od", "hexdump",
                     "strings", "get-content", "gc"}) | SED_AWK
CROSSING = GREP_NAMES | RG_NAMES | SED_AWK | frozenset({"findstr", "select-string", "sls", "find"})
LOOP_CMDLETS = frozenset({"foreach-object", "%", "foreach"})
CD_NAMES = frozenset({"cd", "chdir", "set-location", "sl", "pushd", "push-location"})
SIMPLE_WRAPPERS = frozenset({"sudo", "command", "builtin", "exec", "nohup", "time", "noglob", "winpty",
                             "stdbuf", "ionice", "chronic", "call"})
BASH_KEYWORDS = frozenset({"if", "then", "else", "elif", "fi", "!", "{", "}", "time", "esac"})
PS_KEYWORDS = frozenset({"if", "elseif", "else", "while", "until", "do", "try", "catch", "finally", "return",
                         "throw", "trap", "begin", "process", "end", "param", "switch", "for"})
PS_HEADER_KEYWORDS = frozenset({"foreach", "for", "while", "if", "elseif", "switch"})
PS_ASSIGN_OPS = frozenset({"=", "+=", "-=", "*=", "/=", "%=", "??="})
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=")

GIT_GLOBAL_VALUE_SEPARATE = ("-C", "-c")
GIT_GLOBAL_VALUE_LONG = ("--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
                         "--attr-source", "--exec-path", "--list-cmds")


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


# ---------------------------------------------------------------- 字句解析

class LexError(ValueError):
    """閉じていない引用・括弧など。解けない書式として通す。"""


class Word:
    """1 つの語。value は引用を外した文字列、mask は 1 文字ごとの印
    （u=引用の外、d=二重引用の中で $ が展開される、s=字義どおり）。subs は語の中の命令の置換 $(…) 等の中身。"""

    __slots__ = ("value", "mask", "quoted", "subs")

    def __init__(self, value: str, mask: str, quoted: bool = False, subs: list | None = None):
        self.value = value
        self.mask = mask
        self.quoted = quoted
        self.subs = subs or []

    @property
    def plain(self) -> str:
        return "".join(c for c, m in zip(self.value, self.mask) if m == "u")

    def dynamic(self) -> bool:
        return _has_dyn(self.value, self.mask)

    def __repr__(self) -> str:  # 自己試験の失敗の表示用
        return f"Word({self.value!r})"


COMMA = Word(",", "c")  # PowerShell の配列の区切り
CALL = Word("&", "c")   # PowerShell の呼出し演算子（文の頭の &。続く語は引用されていても命令）
CALL_FOLLOWS = frozenset({";", "|", "\n", "(", "{", "&&", "||", "&"})


def _dyn_word() -> Word:
    return Word("$(…)", "uuuu")


def _has_dyn(text: str, mask: str) -> bool:
    return any(c == "$" and m in "ud" for c, m in zip(text, mask))


def _has_glob(text: str, mask: str) -> bool:
    return any(c in "*?[" and m == "u" for c, m in zip(text, mask))


def _match_paren(text: str, start: int, escape: str) -> int:
    """text[start] == '(' に対応する ')' の位置。引用と逃がし文字を飛ばす。"""
    depth, i, n = 0, start, len(text)
    while i < n:
        ch = text[i]
        if ch == escape:
            i += 2
            continue
        if ch == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise LexError("閉じていない一重引用")
            i = j + 1
            continue
        if ch == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == escape else 1
            if i >= n:
                raise LexError("閉じていない二重引用")
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise LexError("閉じていない括弧")


class _Builder:
    """語を組み立てる共通の部品。"""

    def __init__(self):
        self.tokens: list = []
        self.vals: list[str] = []
        self.masks: list[str] = []
        self.subs: list = []
        self.word = False
        self.quoted = False

    def add(self, text: str, mark: str) -> None:
        self.vals.append(text)
        self.masks.append(mark * len(text))
        self.word = True

    def flush(self) -> None:
        if self.word:
            self.tokens.append(("w", Word("".join(self.vals), "".join(self.masks), self.quoted, self.subs)))
        self.vals, self.masks, self.subs = [], [], []
        self.word = False
        self.quoted = False

    def drop_fd(self, extra: str = "") -> None:
        """2> の 2 や *> の * など、向け先の番号を語から外す。"""
        value = "".join(self.vals)
        mask = "".join(self.masks)
        if self.word and (value.isdigit() or value in extra) and set(mask) <= {"u"} and value:
            self.vals, self.masks, self.subs = [], [], []
            self.word = False

    def op(self, kind: str, value: str) -> None:
        self.flush()
        self.tokens.append((kind, value))


def _skip_heredocs(text: str, i: int, heredocs: list) -> int:
    n = len(text)
    for delim, strip in heredocs:
        if not delim:
            continue
        while i < n:
            end = text.find("\n", i)
            line = text[i:] if end < 0 else text[i:end]
            i = n if end < 0 else end + 1
            body = line.lstrip("\t") if strip else line
            if body.rstrip("\r") == delim:
                break
    return i


def _lex_bash(text: str) -> list:
    b = _Builder()
    heredocs: list = []
    n = len(text)
    i = 0

    def dollar(i: int, mark: str) -> int:
        if text.startswith("$((", i):
            j = text.find("))", i + 3)
            if j < 0:
                raise LexError("閉じていない $((")
            b.add("$((…))", mark)
            return j + 2
        if text.startswith("$(", i):
            j = _match_paren(text, i + 1, "\\")
            b.subs.append((text[i + 2:j], "bash"))
            b.add("$(…)", mark)
            return j + 1
        if text.startswith("${", i):
            j = text.find("}", i + 2)
            if j < 0:
                raise LexError("閉じていない ${")
            b.add(text[i:j + 1], mark)
            return j + 1
        if text.startswith("$'", i) and mark == "u":
            j, out = i + 2, []
            while j < n and text[j] != "'":
                if text[j] == "\\" and j + 1 < n:
                    out.append(text[j:j + 2])
                    j += 2
                    continue
                out.append(text[j])
                j += 1
            if j >= n:
                raise LexError("閉じていない $'")
            b.add("".join(out), "s")
            b.quoted = True
            return j + 1
        match = re.match(r"\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])", text[i:i + 256])
        if match:
            b.add(match.group(0), mark)
            return i + len(match.group(0))
        b.add("$", "s")
        return i + 1

    def backtick(i: int, mark: str) -> int:
        j = i + 1
        while j < n and text[j] != "`":
            j += 2 if text[j] == "\\" else 1
        if j >= n:
            raise LexError("閉じていない `")
        b.subs.append((text[i + 1:j], "bash"))
        b.add("$(…)", mark)
        return j + 1

    while i < n:
        ch = text[i]
        if ch in " \t\r":
            b.flush()
            i += 1
            continue
        if ch == "\n":
            b.op("op", "\n")
            i += 1
            if heredocs:
                i = _skip_heredocs(text, i, heredocs)
                heredocs = []
            continue
        if ch == "#" and not b.word:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "\\":
            if i + 1 < n and text[i + 1] == "\n":
                i += 2
                continue
            if i + 1 < n:
                b.add(text[i + 1], "s")
            i += 2
            continue
        if ch == "'":
            j = text.find("'", i + 1)
            if j < 0:
                raise LexError("閉じていない一重引用")
            b.add(text[i + 1:j], "s")
            b.word = b.quoted = True
            i = j + 1
            continue
        if ch == '"':
            b.word = b.quoted = True
            i += 1
            while True:
                if i >= n:
                    raise LexError("閉じていない二重引用")
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\" and i + 1 < n and text[i + 1] in '$`"\\\n':
                    if text[i + 1] != "\n":
                        b.add(text[i + 1], "s")
                    i += 2
                    continue
                if c == "$":
                    i = dollar(i, "d")
                    continue
                if c == "`":
                    i = backtick(i, "d")
                    continue
                b.add(c, "d")
                i += 1
            continue
        if ch == "$":
            i = dollar(i, "u")
            continue
        if ch == "`":
            i = backtick(i, "u")
            continue
        if ch in "<>" and text.startswith("(", i + 1):
            j = _match_paren(text, i + 1, "\\")
            b.subs.append((text[i + 2:j], "bash"))
            b.add("$(…)", "u")
            i = j + 1
            continue
        if text.startswith("<<<", i):
            b.drop_fd()
            b.op("redir", "<<<")
            i += 3
            continue
        if text.startswith("<<", i):
            b.drop_fd()
            b.flush()
            strip = text.startswith("<<-", i)
            i += 3 if strip else 2
            while i < n and text[i] in " \t":
                i += 1
            delim = []
            while i < n and text[i] not in " \t\r\n;|&<>()":
                if text[i] not in "'\"\\":
                    delim.append(text[i])
                i += 1
            heredocs.append(("".join(delim), strip))
            continue
        two = text[i:i + 2]
        if two in ("&&", "||"):
            b.op("op", two)
            i += 2
            continue
        if two == ";;":
            b.op("op", ";")
            i += 2
            continue
        if two == "|&":
            b.op("op", "|")
            i += 2
            continue
        if two in (">>", ">&", "<&", ">|", "<>", "&>"):
            b.drop_fd()
            i += 2
            if two == "&>" and i < n and text[i] == ">":
                i += 1
            b.op("redir", "<" if two in ("<&", "<>") else ">")
            continue
        if ch in "<>":
            b.drop_fd()
            b.op("redir", ch)
            i += 1
            continue
        if ch in ";|&()":
            b.op("op", ch)
            i += 1
            continue
        b.add(ch, "u")
        i += 1
    b.flush()
    return b.tokens


def _lex_ps(text: str) -> list:
    b = _Builder()
    n = len(text)
    i = 0

    def dollar(i: int, mark: str) -> int:
        if text.startswith("$(", i):
            j = _match_paren(text, i + 1, "`")
            b.subs.append((text[i + 2:j], "ps"))
            b.add("$(…)", mark)
            return j + 1
        if text.startswith("${", i):
            j = text.find("}", i + 2)
            if j < 0:
                raise LexError("閉じていない ${")
            b.add(text[i:j + 1], mark)
            return j + 1
        match = re.match(r"\$(?:[A-Za-z_]\w*(?::\w+)?|[?^$])", text[i:i + 256])
        if match:
            b.add(match.group(0), mark)
            return i + len(match.group(0))
        b.add("$", "s")
        return i + 1

    def here_body(i: int) -> int | None:
        """@' / @" の直後から行末までが空白だけなら、本文の始まりの位置。"""
        j = i
        while j < n and text[j] in " \t":
            j += 1
        if j < n and text[j] == "\r":
            j += 1
        if j < n and text[j] == "\n":
            return j + 1
        return None

    while i < n:
        ch = text[i]
        if ch in " \t\r":
            b.flush()
            i += 1
            continue
        if ch == "\n":
            b.op("op", "\n")
            i += 1
            continue
        if text.startswith("<#", i):
            j = text.find("#>", i + 2)
            i = n if j < 0 else j + 2
            continue
        if ch == "#" and not b.word:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "`":
            if i + 1 < n and text[i + 1] in "\r\n":
                i += 3 if text[i + 1:i + 3] == "\r\n" else 2
                continue
            if i + 1 < n:
                b.add(text[i + 1], "s")
            i += 2
            continue
        if ch == "@" and text[i + 1:i + 2] in ("'", '"'):
            start = here_body(i + 2)
            if start is not None:
                quote = text[i + 1]
                end = text.find("\n" + quote + "@", start - 1)
                if end < 0:
                    raise LexError("閉じていないヒアストリング")
                b.add(text[start:end], "s" if quote == "'" else "d")
                b.word = b.quoted = True
                i = end + 3
                continue
        if ch == "'":
            j, out = i + 1, []
            while True:
                if j >= n:
                    raise LexError("閉じていない一重引用")
                if text[j] == "'":
                    if text[j + 1:j + 2] == "'":
                        out.append("'")
                        j += 2
                        continue
                    break
                out.append(text[j])
                j += 1
            b.add("".join(out), "s")
            b.word = b.quoted = True
            i = j + 1
            continue
        if ch == '"':
            b.word = b.quoted = True
            i += 1
            while True:
                if i >= n:
                    raise LexError("閉じていない二重引用")
                c = text[i]
                if c == '"':
                    if text[i + 1:i + 2] == '"':
                        b.add('"', "s")
                        i += 2
                        continue
                    i += 1
                    break
                if c == "`" and i + 1 < n:
                    b.add(text[i + 1], "s")
                    i += 2
                    continue
                if c == "$":
                    i = dollar(i, "d")
                    continue
                b.add(c, "d")
                i += 1
            continue
        if ch == "$":
            i = dollar(i, "u")
            continue
        if text.startswith("@(", i):
            j = _match_paren(text, i + 1, "`")
            b.subs.append((text[i + 2:j], "ps"))
            b.add("$(…)", "u")
            i = j + 1
            continue
        if text.startswith("@{", i):
            b.op("op", "{")
            i += 2
            continue
        if ch in "{}()":
            b.op("op", ch)
            i += 1
            continue
        two = text[i:i + 2]
        if two in ("&&", "||"):
            b.op("op", two)
            i += 2
            continue
        if ch == "&" and not b.word and (not b.tokens or (b.tokens[-1][0] == "op" and b.tokens[-1][1] in CALL_FOLLOWS)):
            b.tokens.append(("w", CALL))
            i += 1
            continue
        if ch in ";|&":
            b.op("op", ch)
            i += 1
            continue
        if ch == ",":
            b.flush()
            b.tokens.append(("w", COMMA))
            i += 1
            continue
        if ch in "<>":
            b.drop_fd("*")
            i += 1
            if i < n and text[i] == ">":
                i += 1
            if i + 1 < n and text[i] == "&" and text[i + 1].isdigit():
                i += 1
            b.op("redir", "<" if ch == "<" else ">")
            continue
        b.add(ch, "u")
        i += 1
    b.flush()
    return b.tokens


def _lex_cmd(text: str) -> list:
    b = _Builder()
    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        if ch in " \t\r":
            b.flush()
            i += 1
            continue
        if ch == "\n":
            b.op("op", "\n")
            i += 1
            continue
        if ch == "^":
            if i + 1 < n:
                b.add(text[i + 1], "s")
            i += 2
            continue
        if ch == '"':
            j = text.find('"', i + 1)
            j = n if j < 0 else j
            b.add(text[i + 1:j], "s")
            b.word = b.quoted = True
            i = j + 1
            continue
        two = text[i:i + 2]
        if two in ("&&", "||"):
            b.op("op", two)
            i += 2
            continue
        if ch in "&|()":
            b.op("op", ch)
            i += 1
            continue
        if ch in "<>":
            b.drop_fd()
            i += 1
            if i < n and text[i] == ">":
                i += 1
            if i + 1 < n and text[i] == "&" and text[i + 1].isdigit():
                i += 1
            b.op("redir", "<" if ch == "<" else ">")
            continue
        b.add(ch, "u")
        i += 1
    b.flush()
    return b.tokens


def lex(text: str, mode: str) -> list:
    if mode == "ps":
        return _lex_ps(text)
    if mode == "cmd":
        return _lex_cmd(text)
    return _lex_bash(text)


# ---------------------------------------------------------------- 道のり

def _split(value: str, mask: str) -> list:
    parts, start = [], 0
    for k, ch in enumerate(value):
        if ch == "/":
            parts.append((value[start:k], mask[start:k]))
            start = k + 1
    parts.append((value[start:], mask[start:]))
    return parts


def _absolute(value: str, mask: str, cwd: list | None) -> list | None:
    """正規化した絶対の道のりの部分（(文字列, 印) の list）。基準が分からない相対の道のりは None。"""
    v = value.replace("\\", "/")
    if re.match(r"^/[A-Za-z](?:/|$)", v):          # Git Bash の /c/... → c:/...
        v = v[1] + ":" + v[2:]
        mask = mask[1:2] + "s" + mask[2:]
    parts = _split(v, mask)
    if v.startswith("~") or re.match(r"^\$(?:home|\{home\}|env:userprofile|env:home)(?:/|$)", v, re.IGNORECASE):
        absolute = [("~", "s")] + parts[1:]          # 利用者のホーム（リポジトリの外）
    elif re.match(r"^[A-Za-z]:$", parts[0][0]):
        absolute = parts
    elif v.startswith("/"):
        absolute = [("/", "s")] + parts[1:]
    else:
        if cwd is None:
            return None
        absolute = list(cwd) + parts
    norm: list = []
    for text, m in absolute:
        if text in ("", "."):
            continue
        if text == "..":
            if len(norm) > 1:
                norm.pop()
            continue
        norm.append((text, m))
    return norm


def _plain_parts(text: str) -> list:
    return _absolute(text, "s" * len(text), None) or []


class PathInfo:
    __slots__ = ("inside", "product", "container", "heavy", "id_glob", "transcript")

    def __init__(self):
        self.inside = False      # リポジトリの中と分かる
        self.product = False     # packages/・apps/・e2e/ の下（ワイルドカードで当たり得る物を含む）
        self.container = None    # 1 つの容れ物（("agents", "<担当>") など）。収まらない・分からない時は None
        self.heavy = False       # scratchpad/claude/{deliveries,runs,agents} の下
        self.id_glob = False     # その ID の位置がワイルドカード（複数の容れ物を回す）
        self.transcript = False  # Claude Code の会話記録（~/.claude/projects）


def _path_info(word: Word, cwd: list | None, root_parts: list) -> PathInfo:
    info = PathInfo()
    normalized = word.value.replace("\\", "/")
    info.transcript = re.search(r"(?:^|/)\.claude/projects(?:/|$)", normalized, re.IGNORECASE) is not None
    parts = _absolute(word.value, word.mask, cwd)
    if parts is None or len(parts) < len(root_parts):
        return info
    if any(parts[k][0].lower() != root_parts[k] for k in range(len(root_parts))):
        return info
    rel = parts[len(root_parts):]
    info.inside = True
    if not rel:
        return info
    first, first_mask = rel[0]
    if _has_glob(first, first_mask) and not _has_dyn(first, first_mask):
        import fnmatch  # 使う時だけ読む（フックの起動を軽くする）
        info.product = any(fnmatch.fnmatchcase(name, first.lower()) for name in PRODUCT_DIRS)
    elif not _has_dyn(first, first_mask) and first.lower() in PRODUCT_DIRS:
        info.product = True
    if len(rel) >= 3 and all(not _has_glob(t, m) and not _has_dyn(t, m) for t, m in rel[:3]) \
            and rel[0][0].lower() == "scratchpad" and rel[1][0].lower() == "claude":
        tree = rel[2][0].lower()
        if tree in CONTAINER_TREES:
            info.heavy = True
            if len(rel) >= 4:
                ident, ident_mask = rel[3]
                if _has_glob(ident, ident_mask):
                    info.id_glob = True
                elif not _has_dyn(ident, ident_mask):
                    info.container = (tree, ident.lower())
        elif tree in SINGLE_CONTAINERS:
            info.container = (tree,)
    return info


def _looks_like_folder(word: Word) -> bool:
    """rg などの対象がフォルダーらしいか（ファイルの読取りはしないので、名前で決める）。"""
    v = word.value.replace("\\", "/")
    if v.endswith("/"):
        return True
    last = v.rsplit("/", 1)[-1]
    if last in ("", ".", "..", "~"):
        return True
    if last.startswith("."):
        return last.lower() in KNOWN_DOT_DIRS
    return re.search(r"\.[A-Za-z0-9_-]{1,12}$", last) is None


# ---------------------------------------------------------------- 引数の解析

def _sub_word(word: Word, start: int) -> Word:
    return Word(word.value[start:], word.mask[start:], word.quoted)


def _posix_parse(args: list, value_short: str, value_long: frozenset | set) -> tuple:
    """(位置引数, 短い旗の集合, 長い旗の集合, 旗の値 {名前: [Word]})。"""
    pos: list = []
    shorts: set = set()
    longs: set = set()
    values: dict = {}
    i, n, ended = 0, len(args), False
    while i < n:
        a = args[i]
        v = a.value
        if a is COMMA:
            i += 1
            continue
        if ended or not v.startswith("-") or v == "-":
            pos.append(a)
            i += 1
            continue
        if v == "--":
            ended = True
            i += 1
            continue
        if v.startswith("--"):
            name, eq, val = v[2:].partition("=")
            longs.add(name)
            if eq:
                values.setdefault(name, []).append(_sub_word(a, len(v) - len(val)))
            elif name in value_long and i + 1 < n:
                values.setdefault(name, []).append(args[i + 1])
                i += 2
                continue
            i += 1
            continue
        j = 1
        while j < len(v):
            ch = v[j]
            shorts.add(ch)
            if ch in value_short:
                if j + 1 < len(v):
                    values.setdefault(ch, []).append(_sub_word(a, j + 1))
                elif i + 1 < n:
                    values.setdefault(ch, []).append(args[i + 1])
                    i += 1
                break
            j += 1
        i += 1
    return pos, shorts, longs, values


def _ps_parse(args: list, value_params: tuple, switch_params: tuple) -> tuple:
    """PowerShell の引数（名前の前方一致・-名前:値・カンマの並び）。(名前つきの値, 位置引数, スイッチ)。"""
    named: dict = {}
    pos: list = []
    switches: set = set()
    every = value_params + switch_params
    i, n = 0, len(args)
    while i < n:
        a = args[i]
        if a is COMMA:
            i += 1
            continue
        match = None if a.quoted else re.match(r"^-([A-Za-z][\w-]*)(?::(.*))?$", a.value)
        if match:
            key = match.group(1).lower()
            exact = [p for p in every if p == key]
            candidates = exact or [p for p in every if p.startswith(key)]
            i += 1
            if len(candidates) != 1:
                continue                      # 知らない・曖昧な名前はスイッチとして飛ばす
            param = candidates[0]
            if param in switch_params:
                switches.add(param)
                continue
            vals = []
            if match.group(2):
                vals.append(_sub_word(a, len(a.value) - len(match.group(2))))
            elif i < n and args[i] is not COMMA:
                vals.append(args[i])
                i += 1
            while i + 1 < n and args[i] is COMMA:
                vals.append(args[i + 1])
                i += 2
            named.setdefault(param, []).extend(vals)
            continue
        pos.append(a)
        i += 1
        while i + 1 < n and args[i] is COMMA:
            pos.append(args[i + 1])
            i += 2
    return named, pos, switches


def _normalize_name(value: str) -> str:
    base = value.replace("\\", "/").rsplit("/", 1)[-1].lower()
    for ext in (".exe", ".cmd", ".bat", ".com"):
        if base.endswith(ext) and len(base) > len(ext):
            return base[:-len(ext)]
    return base


GREP_VALUE_SHORT = "efmABCdDX"
GREP_VALUE_LONG = frozenset({"regexp", "file", "max-count", "after-context", "before-context", "context",
                             "directories", "devices", "include", "exclude", "exclude-dir", "exclude-from",
                             "label", "binary-files", "group-separator"})
RG_VALUE_SHORT = "efgtTmABCMjdrE"
RG_VALUE_LONG = frozenset({"regexp", "file", "glob", "iglob", "type", "type-not", "max-count", "after-context",
                           "before-context", "context", "max-columns", "threads", "max-depth", "replace",
                           "encoding", "pre", "pre-glob", "type-add", "type-clear", "ignore-file", "sort", "sortr",
                           "max-filesize", "path-separator", "context-separator", "field-match-separator",
                           "field-context-separator", "colors", "color", "colour", "engine", "dfa-size-limit",
                           "regex-size-limit"})
SLS_VALUE = ("pattern", "path", "literalpath", "inputobject", "include", "exclude", "encoding", "context", "culture")
SLS_SWITCH = ("simplematch", "casesensitive", "list", "quiet", "allmatches", "notmatch", "raw", "noemphasis")
GCI_VALUE = ("path", "literalpath", "filter", "include", "exclude", "depth", "attributes")
GCI_SWITCH = ("recurse", "force", "name", "directory", "file", "hidden", "system", "followsymlink")
GC_VALUE = ("path", "literalpath", "totalcount", "head", "first", "tail", "last", "readcount", "encoding",
            "delimiter", "stream", "filter", "include", "exclude")
GC_SWITCH = ("raw", "wait", "force")


def _dot() -> Word:
    return Word(".", "u")


def _grep_targets(args: list) -> tuple:
    pos, shorts, longs, values = _posix_parse(args, GREP_VALUE_SHORT, GREP_VALUE_LONG)
    recursive = bool({"r", "R"} & shorts) or bool({"recursive", "dereference-recursive"} & longs) \
        or any(w.value == "recurse" for w in values.get("d", []) + values.get("directories", []))
    given = any(k in values for k in ("e", "f", "regexp", "file"))
    targets = pos if given else pos[1:]
    if not targets and recursive:
        targets = [_dot()]
    return targets, recursive


def _rg_targets(args: list, piped: bool) -> list:
    pos, shorts, longs, values = _posix_parse(args, RG_VALUE_SHORT, RG_VALUE_LONG)
    files_mode = "files" in longs or "type-list" in longs
    given = files_mode or any(k in values for k in ("e", "f", "regexp", "file"))
    targets = pos if given else pos[1:]
    if not targets and not (piped and not files_mode):
        targets = [_dot()]   # 対象を省いた rg は今の場所を再帰で探す（受けた入力が無い時）
    return targets


def _findstr_targets(args: list) -> tuple:
    recursive, given, pos = False, False, []
    for a in args:
        v = a.value
        if len(v) >= 2 and v[0] in "/-" and not a.quoted:
            body = v[1:].lower()
            if body.startswith(("c:", "g:")):
                given = True
            elif ":" not in body and "s" in body:
                recursive = True
            continue
        pos.append(a)
    targets = pos if given else pos[1:]
    return targets, recursive


def _find_targets(args: list) -> tuple:
    k = 0
    while k < len(args) and args[k].value in ("-H", "-L", "-P"):
        k += 1
    targets = []
    while k < len(args):
        v = args[k].value
        if args[k] is COMMA or v.startswith("-") or v in ("(", ")", "!"):
            break
        targets.append(args[k])
        k += 1
    maxdepth = None
    for j in range(len(args) - 1):
        if args[j].value == "-maxdepth":
            try:
                maxdepth = int(args[j + 1].value)
            except ValueError:
                maxdepth = None
    return targets or [_dot()], maxdepth


def _reader_targets(name: str, args: list, mode: str) -> list:
    if name in ("get-content", "gc") or (mode == "ps" and name in ("cat", "type")):
        named, pos, _ = _ps_parse(args, GC_VALUE, GC_SWITCH)
        return named.get("path", []) + named.get("literalpath", []) + pos
    if name in ("head", "tail"):
        pos, _, _, _ = _posix_parse(args, "ncs", {"lines", "bytes", "sleep-interval", "pid", "max-unchanged-stats"})
        return pos
    if name == "sed":
        pos, _, _, values = _posix_parse(args, "efl", {"expression", "file", "line-length"})
        given = any(k in values for k in ("e", "f", "expression", "file"))
        return pos if given else pos[1:]
    if name in SED_AWK:
        pos, _, _, values = _posix_parse(args, "fvF", {"file", "assign", "field-separator"})
        files = pos if ("f" in values or "file" in values) else pos[1:]
        return [p for p in files if not re.match(r"^[A-Za-z_]\w*=", p.value)]
    if name == "type":
        return [a for a in args if a is not COMMA and not re.match(r"^/[A-Za-z]$", a.value)]
    pos, _, _, _ = _posix_parse(args, "", set())
    return pos


def _kill_forced(args: list) -> bool:
    values = [a.value.upper() for a in args if a is not COMMA]
    for k, v in enumerate(values):
        if v in ("-9", "-KILL", "-SIGKILL", "-F"):
            return True
        if v in ("-S", "-N") and k + 1 < len(values) and values[k + 1] in ("9", "KILL", "SIGKILL"):
            return True
    return False


def _shell_c_arg(args: list) -> str | None:
    k = 0
    while k < len(args):
        v = args[k].value
        if v in ("-o", "+o", "-O", "+O"):
            k += 2
            continue
        if v.startswith("-") and not v.startswith("--") and "c" in v[1:]:
            for b in args[k + 1:]:
                if not b.value.startswith("-"):
                    return b.value
            return None
        if not v.startswith("-") and not v.startswith("+"):
            return None          # スクリプトのファイルを流す（中身は解けない）
        k += 1
    return None


PS_VALUE_OPTIONS = ("executionpolicy", "ex", "ep", "windowstyle", "w", "inputformat", "outputformat", "of",
                    "psconsolefile", "version", "v", "configurationname", "workingdirectory", "wd",
                    "settingsfile", "custompipename")


def _ps_command_arg(args: list, name: str) -> str | None:
    k = 0
    while k < len(args):
        a = args[k]
        v = a.value
        if a is COMMA:
            k += 1
            continue
        if v.startswith("-") or (v.startswith("/") and len(v) > 1):
            key = v[1:].lower()
            if key in ("c", "command") or (len(key) >= 3 and "command".startswith(key)):
                rest = [b.value for b in args[k + 1:] if b is not COMMA]
                return " ".join(rest) if rest else None
            if key in ("e", "ec", "enc") or (len(key) >= 2 and "encodedcommand".startswith(key)):
                return None      # -EncodedCommand は解けない
            if key in ("f", "file") or (len(key) >= 2 and "file".startswith(key)):
                return None
            k += 2 if key in PS_VALUE_OPTIONS else 1
            continue
        if name == "powershell":  # powershell.exe の位置引数は -Command（pwsh は -File）
            return " ".join(b.value for b in args[k:] if b is not COMMA)
        return None
    return None


def _cmd_c_arg(args: list) -> str | None:
    for k, a in enumerate(args):
        v = a.value.lower()
        if v in ("/c", "/k", "/r"):
            rest = [b.value for b in args[k + 1:] if b is not COMMA]
            return " ".join(rest) if rest else None
        if v.startswith(("/c", "/k")) and len(v) > 2 and not v[2].isalpha():
            return " ".join([a.value[2:]] + [b.value for b in args[k + 1:] if b is not COMMA])
    return None


def _git_subcommand(args: list) -> tuple:
    """(副命令の位置, -C の値の list)。main_integration_guard._git_subcommand_index と同じ一覧で大域の旗を飛ばす。"""
    k, dirs = 0, []
    while k < len(args):
        v = args[k].value
        if not v.startswith("-"):
            return k, dirs
        if v in GIT_GLOBAL_VALUE_SEPARATE:
            if v == "-C" and k + 1 < len(args):
                dirs.append(args[k + 1])
            k += 2
            continue
        name = v.split("=", 1)[0]
        if name in GIT_GLOBAL_VALUE_LONG and "=" not in v:
            k += 2
            continue
        k += 1
    return None, dirs


def _references(word: Word, var: str, mode: str) -> list:
    """word の中で変数 var を参照している位置（字義どおりの $ は除く）。"""
    escaped = re.escape(var)
    pattern = r"\$(?:\{" + escaped + r"\}|" + escaped + r"(?![A-Za-z0-9_]))"
    flags = re.IGNORECASE if mode == "ps" else 0
    return [m for m in re.finditer(pattern, word.value, flags) if word.mask[m.start()] != "s"]


def _substitute(word: Word, matches: list, item: Word) -> Word:
    out_v, out_m, last = [], [], 0
    for m in matches:
        out_v.append(word.value[last:m.start()])
        out_m.append(word.mask[last:m.start()])
        out_v.append(item.value)
        out_m.append(item.mask)
        last = m.end()
    out_v.append(word.value[last:])
    out_m.append(word.mask[last:])
    return Word("".join(out_v), "".join(out_m), word.quoted)


# ---------------------------------------------------------------- 判定

class Found(Exception):
    def __init__(self, category: str, word: str):
        super().__init__(category)
        self.category = category
        self.word = word


class Loop:
    __slots__ = ("var", "words")

    def __init__(self, var: str | None, words: list | None):
        self.var = var        # 回す変数の名前（$ を除く）。None は分からない
        self.words = words    # 回す値の Word の一覧。None は分からない（命令の出力・受けた入力など）


NONLOOP = Loop(None, None)   # if・switch の見出しの印（続く { } は繰返しではない）


class Analyzer:
    def __init__(self, mode: str, root_parts: list, cwd: list | None, depth: int = 0, loops: list | None = None):
        self.mode = mode
        self.root_parts = root_parts
        self.cwd = cwd
        self.depth = depth
        self.loops = list(loops or [])
        self.base_loops = len(self.loops)
        self.pending_loop: Loop | None = None

    # -- 入口
    def run(self, text: str) -> None:
        try:
            tokens = lex(text, self.mode)
        except LexError:
            return                      # 解けない書式は通す
        self.sequence(tokens, 0, None)

    def nested(self, text: str, mode: str) -> None:
        if self.depth >= MAX_NESTING:
            return
        Analyzer(mode, self.root_parts, self.cwd, self.depth + 1, self.loops).run(text)

    def info(self, word: Word) -> PathInfo:
        return _path_info(word, self.cwd, self.root_parts)

    # -- 並び（区切りと括弧）
    def sequence(self, tokens: list, i: int, closer: str | None) -> int:
        seg: list = []
        redir_in: list = []
        piped = False
        n = len(tokens)
        while i < n:
            kind, val = tokens[i]
            if kind == "w":
                seg.append(val)
                i += 1
                continue
            if kind == "redir":
                if i + 1 < n and tokens[i + 1][0] == "w":
                    target = tokens[i + 1][1]
                    self.subs_of(target)
                    if val == "<":
                        redir_in.append(target)
                    i += 2
                else:
                    i += 1
                continue
            if val == closer:
                self.finish(seg, redir_in, piped)
                return i + 1
            if val == "(":
                if self.mode == "ps" and len(seg) == 1 and seg[0].plain.lower() in PS_HEADER_KEYWORDS:
                    i = self.ps_header(tokens, i + 1, seg[0].plain.lower())
                    continue
                saved = self.cwd
                i = self.sequence(tokens, i + 1, ")")
                if self.mode == "ps":
                    seg.append(_dyn_word())          # 式の値（引数としては分からない）
                    if self.cwd != saved:
                        self.cwd = None
                else:
                    self.cwd = saved                 # bash の ( … ) は子シェル
                continue
            if val == "{":
                loop = self.block_loop(seg)
                if loop is not None:
                    self.loops.append(loop)
                saved = self.cwd
                i = self.sequence(tokens, i + 1, "}")
                if loop is not None:
                    self.loops.pop()
                if self.cwd != saved:
                    self.cwd = None
                seg.append(_dyn_word())
                continue
            if val in (")", "}"):
                i += 1
                continue
            self.finish(seg, redir_in, piped)
            seg, redir_in = [], []
            piped = val == "|"
            i += 1
        self.finish(seg, redir_in, piped)
        return i

    def ps_header(self, tokens: list, i: int, keyword: str) -> int:
        depth, j, n = 1, i, len(tokens)
        while j < n:
            kind, val = tokens[j]
            if kind == "op" and val == "(":
                depth += 1
            elif kind == "op" and val == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        inner = tokens[i:j]
        if keyword == "foreach":
            var, items, rest = None, None, inner
            if len(inner) >= 2 and inner[0][0] == "w" and inner[1][0] == "w" and inner[1][1].plain.lower() == "in":
                var = inner[0][1].value.lstrip("$").lower()
                rest = inner[2:]
                if rest and all(k == "w" and (w is COMMA or (w.quoted and "u" not in w.mask and not w.dynamic()))
                                for k, w in rest):
                    items = [w for _, w in rest if w is not COMMA]
            self.sequence(rest, 0, None)
            self.pending_loop = Loop(var, items)
        else:
            self.sequence(inner, 0, None)
            self.pending_loop = Loop(None, None) if keyword in ("for", "while") else NONLOOP
        return min(j + 1, n)

    def block_loop(self, seg: list) -> Loop | None:
        if self.pending_loop is not None:
            loop, self.pending_loop = self.pending_loop, None
            return None if loop is NONLOOP else loop
        if not seg:
            return None
        first = seg[0]
        if first is not COMMA and first.plain.lower() == "do":
            return Loop(None, None)
        for w in seg:
            if w is COMMA or w.dynamic():
                continue
            name = _normalize_name(w.value)
            if name in PS_KEYWORDS:
                continue
            return Loop("_", None) if name in LOOP_CMDLETS else None
        return None

    # -- 1 つの単純な命令
    def subs_of(self, word: Word) -> None:
        for text, mode in word.subs:
            self.nested(text, mode)

    def finish(self, seg: list, redir_in: list, piped: bool) -> None:
        if not seg:
            return
        for w in seg:
            if w is not COMMA:
                self.subs_of(w)
        if self.mode == "ps":
            for w in seg:
                if w is not COMMA:
                    match = PS_TYPE_R4.search(w.plain)
                    if match:
                        raise Found("R4", match.group(0))
        called = self.mode == "ps" and any(w is CALL for w in seg[:1])
        words, xargs = self.strip_prefix(seg)
        if not words:
            return
        command = words[0]
        if command is COMMA or command is CALL or command.dynamic():
            return                      # 変数に入れた命令などは解けない
        if self.mode == "ps" and not called and "u" not in command.mask:
            return                      # PowerShell の文の頭の引用は文字列の値（& が無ければ命令ではない）
        name = _normalize_name(command.value)
        self.judge(name, command, words[1:], redir_in, piped, xargs)

    def strip_prefix(self, seg: list) -> tuple:
        words = list(seg)
        xargs = False
        while words:
            w = words[0]
            if w is COMMA:
                words.pop(0)
                continue
            key = None if (w.quoted or w.dynamic()) else w.value.lower()
            if self.mode != "ps":
                if key == "do":
                    self.loops.append(self.pending_loop if self.pending_loop not in (None, NONLOOP)
                                      else Loop(None, None))
                    self.pending_loop = None
                    words.pop(0)
                    continue
                if key == "done":
                    if len(self.loops) > self.base_loops:
                        self.loops.pop()
                    words.pop(0)
                    continue
                if key in ("while", "until"):
                    self.pending_loop = Loop(None, None)
                    words.pop(0)
                    continue
                if key in ("for", "select"):
                    var = words[1].value if len(words) > 1 else None
                    items = words[3:] if len(words) > 2 and words[2].value == "in" else None
                    self.pending_loop = Loop(var, items)
                    return [], False
                if key in ("case", "function"):
                    return [], False
                if key in BASH_KEYWORDS:
                    words.pop(0)
                    continue
                if ASSIGNMENT.match(w.plain):
                    words.pop(0)
                    continue
            else:
                if w is CALL:
                    words.pop(0)
                    continue
                if key in PS_KEYWORDS:
                    words.pop(0)
                    continue
                if key in ("function", "filter"):
                    return [], False
                if w.value.startswith("$") or (w.value.startswith("[") and "]$" in w.value):
                    if len(words) >= 2 and words[1] is not COMMA and words[1].plain in PS_ASSIGN_OPS:
                        words = words[2:]
                        continue
                    match = re.match(r"^\$[\w:]+=(.+)$", w.value)
                    if match:
                        rest = match.group(1)
                        words[0] = Word(rest, w.mask[len(w.value) - len(rest):], w.quoted, w.subs)
                        continue
                if key == ".":
                    words.pop(0)
                    continue
            if key in SIMPLE_WRAPPERS:
                words.pop(0)
                while words and words[0] is not COMMA and words[0].value.startswith("-"):
                    words.pop(0)
                continue
            if key == "nice":
                words.pop(0)
                if words and words[0].value == "-n":
                    del words[:2]
                elif words and words[0].value.startswith("-"):
                    words.pop(0)
                continue
            if key == "timeout":
                words.pop(0)
                while words and words[0].value.startswith("-"):
                    del words[:2 if words[0].value in ("-s", "-k", "--signal", "--kill-after") else 1]
                if words:
                    words.pop(0)        # 時間
                continue
            if key == "env":
                words.pop(0)
                while words:
                    v = words[0].value
                    if v in ("-u", "-C", "-S", "--unset", "--chdir", "--split-string"):
                        del words[:2]
                    elif v.startswith("-") or ASSIGNMENT.match(words[0].plain):
                        words.pop(0)
                    else:
                        break
                continue
            if key == "xargs":
                xargs = True
                words.pop(0)
                while words and words[0].value.startswith("-"):
                    v = words[0].value
                    if v == "--":
                        words.pop(0)
                        break
                    if v.startswith("--"):
                        separate = "=" not in v and v[2:] in ("max-args", "max-procs", "max-lines", "delimiter",
                                                              "arg-file", "max-chars", "eof")
                        del words[:2 if separate else 1]
                    else:
                        del words[:2 if len(v) == 2 and v[1] in "InPLdsEa" else 1]
                continue
            break
        return words, xargs

    def judge(self, name: str, command: Word, args: list, redir_in: list, piped: bool, xargs: bool) -> None:
        mode = self.mode
        # 入れ子の shell の文字列は命令として判定する
        if name in ("bash", "sh", "zsh", "dash", "ksh"):
            text = _shell_c_arg(args)
            if text is not None:
                self.nested(text, "bash")
            return
        if name in ("powershell", "pwsh"):
            text = _ps_command_arg(args, name)
            if text is not None:
                self.nested(text, "ps")
            return
        if name == "cmd":
            text = _cmd_c_arg(args)
            if text is not None:
                self.nested(text, "cmd")
            return
        if name == "eval" and mode == "bash":
            self.nested(" ".join(a.value for a in args if a is not COMMA), "bash")
            return
        if name in ("start-process", "saps") or (name == "start" and mode == "ps"):
            named, pos, _ = _ps_parse(args, ("filepath", "argumentlist", "workingdirectory"), ("wait", "nonewwindow"))
            target = (named.get("filepath") or pos[:1] or [None])[0]
            if target is not None and not target.dynamic():
                inner = _normalize_name(target.value)
                if inner in R5_NAMES:
                    raise Found("R5", f"{command.value} {target.value}")
                if inner in R4_NAMES:
                    raise Found("R4", f"{command.value} {target.value}")
            return
        # R5・R4
        if name in R5_NAMES or (name == "kill" and (mode != "bash" or _kill_forced(args))):
            raise Found("R5", command.value)
        if name in R4_NAMES:
            raise Found("R4", command.value)
        # 場所の移動
        if name in CD_NAMES:
            self.change_dir(args)
            return
        if name in ("popd", "pop-location"):
            self.cwd = None
            return
        if xargs and (name in CROSSING or name in ("du", "tree", "ls", "dir", "get-childitem", "gci")):
            raise Found("R2", f"xargs {command.value}（標準入力の一覧を回す）")
        label = command.value
        if name == "git":
            self.git(args)
        elif name in GREP_NAMES:
            targets, recursive = _grep_targets(args)
            folders = [t for t in targets if _looks_like_folder(t)] if recursive else []
            self.check(label, targets + redir_in, product="R1", recursive=folders, crossing=True)
        elif name in RG_NAMES:
            targets = _rg_targets(args, piped)
            self.check(label, targets, product="R1", recursive=[t for t in targets if _looks_like_folder(t)],
                       crossing=True)
        elif name == "findstr":
            targets, recursive = _findstr_targets(args)
            if recursive and not targets:
                targets = [_dot()]
            self.check(label, targets + redir_in, product="R1", recursive=targets if recursive else [],
                       crossing=True)
        elif name in ("select-string", "sls"):
            named, pos, _ = _ps_parse(args, SLS_VALUE, SLS_SWITCH)
            targets = named.get("path", []) + named.get("literalpath", []) + (pos if "pattern" in named else pos[1:])
            self.check(label, targets, product="R1", recursive=[], crossing=True)
        elif name == "find":
            if mode == "ps" and not any(a is not COMMA and a.value.startswith("-") for a in args):
                targets = [a for a in args if a is not COMMA and not re.match(r"^/[A-Za-z]+(?::.*)?$", a.value)][1:]
                self.check(label, targets, product="R1", recursive=[], crossing=True)
            else:
                targets, maxdepth = _find_targets(args)
                self.check(label, targets, product="R1", recursive=targets, crossing=True,
                           maxdepth_ok=maxdepth in (1, 2))
        elif name in ("get-childitem", "gci") or (mode == "ps" and name in ("ls", "dir")):
            named, pos, switches = _ps_parse(args, GCI_VALUE, GCI_SWITCH)
            recursive = "recurse" in switches or "depth" in named
            if any(p.value.lower() == "/s" for p in pos):
                recursive = True
            pos = [p for p in pos if not re.match(r"^/[A-Za-z]$", p.value)]
            targets = named.get("path", []) + named.get("literalpath", []) + pos[:1] or [_dot()]
            if recursive:
                self.check(label, targets, product="R1", recursive=targets, crossing=False)
        elif name in ("ls", "dir"):
            pos, shorts, longs, _ = _posix_parse(args, "ITw", {"ignore", "hide", "tabsize", "width", "block-size",
                                                              "format", "sort", "time", "time-style",
                                                              "indicator-style", "quoting-style"})
            recursive = "R" in shorts or "recursive" in longs or any(p.value.lower() == "/s" for p in pos)
            targets = [p for p in pos if not re.match(r"^/[A-Za-z]$", p.value)] or [_dot()]
            if recursive:
                self.check(label, targets, product="R1", recursive=targets, crossing=False)
        elif name == "tree":
            pos, _, _, _ = _posix_parse(args, "LPIo", {"filelimit", "charset", "sort", "timefmt"})
            targets = [p for p in pos if not re.match(r"^/[A-Za-z]$", p.value)] or [_dot()]
            self.check(label, targets, product="R1", recursive=targets, crossing=False)
        elif name == "du":
            pos, _, _, _ = _posix_parse(args, "dBtX", {"max-depth", "block-size", "threshold", "exclude",
                                                      "exclude-from", "time-style", "files0-from"})
            targets = pos or [_dot()]
            self.check(label, targets, product=None, recursive=targets, crossing=False)
        elif name in READERS or (name == "type" and mode != "bash"):
            targets = _reader_targets(name, args, mode) + redir_in
            self.check(label, targets, product="R3", recursive=[], crossing=name in SED_AWK)

    def change_dir(self, args: list) -> None:
        target = None
        for k, a in enumerate(args):
            if a is not COMMA and a.value.lower() in ("-path", "-literalpath", "-lp") and k + 1 < len(args):
                target = args[k + 1]
        if target is None:
            rest = [a for a in args if a is not COMMA and not (a.value.startswith("-") and len(a.value) > 1)]
            target = rest[0] if rest else None
        if target is None or target.dynamic() or target.value == "-":
            self.cwd = None
            return
        self.cwd = _absolute(target.value, target.mask, self.cwd)

    def git(self, args: list) -> None:
        index, dirs = _git_subcommand(args)
        if index is None or args[index].value.lower() != "grep":
            return
        base = self.cwd
        for d in dirs:
            base = _absolute(d.value, d.mask, base)   # -C は前の -C・今の場所からの相対
        pos, _, _, values = _posix_parse(args[index + 1:], "efmABC", {"max-depth", "threads", "context",
                                                                     "after-context", "before-context"})
        given = any(k in values for k in ("e", "f"))
        targets = pos if given else pos[1:]
        if not targets:
            if base is None:
                return
            parts = base
            root = self.root_parts
            if len(parts) >= len(root) and all(parts[k][0].lower() == root[k] for k in range(len(root))):
                rel = parts[len(root):]
                if not rel:
                    raise Found("R1", "git grep（対象を省くとリポジトリ全体）")
                if rel[0][0].lower() in PRODUCT_DIRS:
                    raise Found("R1", "git grep（対象を省くと " + "/".join(t for t, _ in rel) + " の全体）")
            return
        for t in targets:
            if _path_info(t, base, self.root_parts).product:
                raise Found("R1", f"git grep {t.value}")

    def check(self, label: str, targets: list, *, product: str | None, recursive: list, crossing: bool,
              maxdepth_ok: bool = True) -> None:
        infos = [(w, self.info(w)) for w in targets if w is not COMMA]
        for w, info in infos:
            if info.transcript:
                raise Found("R2", f"{label} {w.value}（会話記録）")
        if product:
            for w, info in infos:
                if info.product:
                    raise Found(product, f"{label} {w.value}")
        rec = [(w, self.info(w)) for w in recursive if w is not COMMA]
        if rec:
            containers = {info.container for _, info in rec}
            if None in containers or len(containers) != 1 or not maxdepth_ok:
                bad = next((w for w, info in rec if info.container is None), rec[0][0])
                raise Found("R2", f"{label} {bad.value}（再帰）")
        if crossing:
            heavy = [(w, info) for w, info in infos if info.heavy]
            for w, info in heavy:
                if info.id_glob:
                    raise Found("R2", f"{label} {w.value}（横断）")
            if len({info.container for _, info in heavy if info.container is not None}) > 1:
                raise Found("R2", f"{label} {heavy[0][0].value} ほか（横断）")
        if self.loops:
            for w, _ in infos:
                if w.dynamic():
                    self.loop_check(label, w, product, crossing)

    def loop_check(self, label: str, word: Word, product: str | None, crossing: bool) -> None:
        loop, matches = None, []
        for candidate in reversed(self.loops):
            if candidate.var:
                matches = _references(word, candidate.var, self.mode)
                if matches:
                    loop = candidate
                    break
        if loop is None or loop.words is None:
            if crossing:
                raise Found("R2", f"{label} {word.value}（繰返し）")
            return
        containers = set()
        for item in loop.words:
            if item is COMMA:
                continue
            sub = _substitute(word, matches, item)
            if sub.dynamic():
                if crossing:
                    raise Found("R2", f"{label} {word.value}（繰返し）")
                continue
            info = self.info(sub)
            if info.transcript:
                raise Found("R2", f"{label} {sub.value}（会話記録）")
            if product and info.product:
                raise Found(product, f"{label} {sub.value}")
            if crossing:
                if info.container is None or info.id_glob:
                    raise Found("R2", f"{label} {word.value}（繰返し）")
                containers.add(info.container)
        if len(containers) > 1:
            raise Found("R2", f"{label} {word.value}（繰返し）")


def analyze(command: str, tool: str, cwd: str, root: str) -> tuple | None:
    """(区分, 当たった語) か None。"""
    root_parts = [text.lower() for text, _ in _plain_parts(root)]
    cwd_parts = _plain_parts(cwd) or _plain_parts(root)
    analyzer = Analyzer("ps" if tool == "PowerShell" else "bash", root_parts, cwd_parts)
    try:
        analyzer.run(command)
    except Found as found:
        return found.category, found.word
    return None


# ---------------------------------------------------------------- 区分 R6（道具の失敗をパイプで隠す）
# 2026-11-11 cl-v103-enforcement-integration-1111（rules/06 §10.485 の誤り B）: 統括が
# `python … adopt-forecast-0021-1110.py … 2>&1 | tail -3 && python … | tail -1 && python … registry.py set-status …`
# を流し、最初の道具が AssertionError で失敗したのに tail の成功で先へ進み、採用していない物を登録簿へ「採用」と書いた。
# 統括の Bash の命令で、python で scratchpad/claude/tools/・scratchpad/claude/root-runtime/・.claude/hooks/ の道具を
# 実行する部分が `|` で別の命令へ流れ、その後ろに && ・ || ・ ; ・改行で別の命令が続くのに、最初の `|` より前に
# `set -o pipefail` が無ければ拒否する。後ろに何も続かない（結果を見るだけの）命令と PowerShell は通す。
# 印（orchestrator-investigation-allowed.json）は R1〜R5 だけに効き、R6 は印があっても拒否する（set -o pipefail で直せるため）。

R6_REASON = "道具の失敗が後ろの命令で隠れる。先頭に set -o pipefail を付けるか、命令を分ける（rules/06 §10.485）。"
R6_TOOL_DIRS = (("scratchpad", "claude", "tools"), ("scratchpad", "claude", "root-runtime"), (".claude", "hooks"))
R6_TOOL_TEXT = ("scratchpad/claude/tools/", "scratchpad/claude/root-runtime/", ".claude/hooks/")
R6_PYTHON = re.compile(r"^(?:python(?:3(?:\.[0-9]+)?)?w?|py)$")
R6_TRIVIAL = BASH_KEYWORDS | frozenset({"do", "done", "while", "until", "elif", "else", "then", "fi", "esac"})


def _r6_units(tokens: list) -> list:
    """bash の字句を (種類, 語の list, 後ろの区切り) の並びにする。種類は cmd・open（"("）・close（")"）。
    向け先（2>&1・> file・<<< 文字列）は語に数えない。"""
    units: list = []
    seg: list = []
    i, n = 0, len(tokens)
    while i < n:
        kind, val = tokens[i]
        if kind == "w":
            seg.append(val)
            i += 1
            continue
        if kind == "redir":
            i += 2 if i + 1 < n and tokens[i + 1][0] == "w" else 1
            continue
        if val == "(":
            if seg:
                units.append(("cmd", seg, "("))
                seg = []
            units.append(("open", [], "("))
        elif val == ")":
            units.append(("cmd", seg, ")"))
            seg = []
            units.append(("close", [], ")"))
        else:
            units.append(("cmd", seg, val))
            seg = []
        i += 1
    units.append(("cmd", seg, ""))
    return units


def _r6_strip(words: list) -> list:
    """命令の前置き（if・then・! などの語、変数の代入、sudo・env・timeout・nice など）を外す。"""
    words = list(words)
    while words:
        w = words[0]
        key = None if (w.quoted or w.dynamic()) else w.value.lower()
        if key in R6_TRIVIAL or (key is not None and ASSIGNMENT.match(w.plain)):
            words.pop(0)
            continue
        if key in SIMPLE_WRAPPERS:
            words.pop(0)
            while words and words[0].value.startswith("-"):
                words.pop(0)
            continue
        if key == "env":
            words.pop(0)
            while words and (words[0].value.startswith("-") or ASSIGNMENT.match(words[0].plain)):
                words.pop(0)
            continue
        if key == "timeout":
            words.pop(0)
            while words and words[0].value.startswith("-"):
                del words[:2 if words[0].value in ("-s", "-k", "--signal", "--kill-after") else 1]
            if words:
                words.pop(0)
            continue
        if key == "nice":
            words.pop(0)
            if words and words[0].value == "-n":
                del words[:2]
            elif words and words[0].value.startswith("-"):
                words.pop(0)
            continue
        break
    return words


def _r6_set_pipefail(args: list) -> bool | None:
    """`set -o pipefail`・`set -euo pipefail` なら True、`set +o pipefail` なら False、触れなければ None。"""
    state = None
    i = 0
    while i < len(args):
        v = args[i].value
        if re.fullmatch(r"[-+][A-Za-z]+", v) and "o" in v[1:] and i + 1 < len(args) \
                and args[i + 1].value == "pipefail":
            state = v[0] == "-"
            i += 2
            continue
        i += 1
    return state


def _r6_cd(args: list, cwd: list | None) -> list | None:
    targets = [a for a in args if a.value not in ("-L", "-P", "-e", "-@")]
    if not targets or targets[0].value == "-" or targets[0].dynamic():
        return None
    return _absolute(targets[0].value, targets[0].mask, cwd)


def _r6_tool_script(words: list, cwd: list | None, root_parts: list) -> Word | None:
    """python で R6 の対象の道具（スクリプト）を実行する命令なら、そのスクリプトの語。"""
    command = words[0]
    if command.dynamic() or not R6_PYTHON.match(_normalize_name(command.value)):
        return None
    args = words[1:]
    i, n = 0, len(args)
    while i < n:
        v = args[i].value
        if v == "--":
            i += 1
            break
        if not v.startswith("-") or v == "-":
            break
        i += 1
        if v.startswith("--"):
            if v == "--check-hash-based-pycs":
                i += 1
            continue
        for k, ch in enumerate(v[1:], start=1):
            if ch in "cm":
                return None             # -c の文字列・-m のモジュールは道具のファイルではない
            if ch in "XWQ":
                if k == len(v) - 1:
                    i += 1              # 値は次の語
                break
    if i >= n:
        return None
    script = args[i]
    parts = _absolute(script.value, script.mask, cwd) if not script.dynamic() else None
    if parts is not None and len(parts) > len(root_parts) \
            and all(parts[k][0].lower() == root_parts[k] for k in range(len(root_parts))):
        rel = tuple(text.lower() for text, _ in parts[len(root_parts):])
        return script if any(len(rel) > len(d) and rel[:len(d)] == d for d in R6_TOOL_DIRS) else None
    normalized = script.value.replace("\\", "/").lower()
    return script if any(text in normalized for text in R6_TOOL_TEXT) else None


def _r6_follows(units: list, start: int) -> bool:
    for kind, words, _ in units[start:]:
        if kind != "cmd":
            continue
        if any(w.quoted or w.dynamic() or w.value.lower() not in R6_TRIVIAL for w in words):
            return True
    return False


def pipefail_hazard(command: str, cwd: str, root: str) -> str | None:
    """区分 R6 に当たれば当たった語（例 `python … deliver.py | tail`）、当たらなければ None。bash の命令だけ。
    最上位と ( … ) の中を見る。$(…) の中・bash -c の文字列は見ない（解けない書式として通す。自己試験に負例）。"""
    if "|" not in command:
        return None
    try:
        tokens = _lex_bash(command)
    except LexError:
        return None                     # 解けない書式は通す
    if not any(kind == "op" and val == "|" for kind, val in tokens):
        return None
    root_parts = [text.lower() for text, _ in _plain_parts(root)]
    cwd_parts = _plain_parts(cwd) or _plain_parts(root)
    units = _r6_units(tokens)
    pipefail = False
    before_first_pipe = None            # 最初の | の時に set -o pipefail が効いていたか
    stack: list = []                    # ( … ) は子シェル。抜けたら pipefail と cd を戻す
    for index, (kind, raw_words, end) in enumerate(units):
        if kind == "open":
            stack.append((pipefail, cwd_parts))
            continue
        if kind == "close":
            if stack:
                pipefail, cwd_parts = stack.pop()
            continue
        words = _r6_strip(raw_words)
        if words and not words[0].dynamic():
            name = _normalize_name(words[0].value)
            if name == "set":
                state = _r6_set_pipefail(words[1:])
                if state is not None:
                    pipefail = state
            elif name in ("cd", "pushd", "chdir"):
                cwd_parts = _r6_cd(words[1:], cwd_parts)
        if end != "|":
            continue
        if before_first_pipe is None:
            before_first_pipe = pipefail
        if not words or (pipefail and before_first_pipe):
            continue
        script = _r6_tool_script(words, cwd_parts, root_parts)
        if script is None:
            continue
        consumer = "…"
        j = index + 1
        while j < len(units):
            next_kind, next_words, next_end = units[j]
            if next_kind == "cmd":
                stripped = _r6_strip(next_words)
                if consumer == "…" and stripped:
                    consumer = _normalize_name(stripped[0].value)
                if next_end != "|":
                    break
            j += 1
        if _r6_follows(units, j + 1):
            tool = script.value.replace("\\", "/").rsplit("/", 1)[-1]
            return f"{words[0].value} … {tool} | {consumer}"
    return None


def r6_line(command: str, tool: str, cwd: str, root: str) -> str | None:
    if tool != "Bash":
        return None                     # PowerShell は対象外（決定 4）
    word = pipefail_hazard(command, cwd, root)
    if word is None:
        return None
    return _one_line(f"{R6_REASON}区分: R6。{_one_line(word)}", 400)


# ---------------------------------------------------------------- 緊急時の印と記録

def local_time(value) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"時刻が文字列ではありません: {value!r}")
    parsed = datetime.fromisoformat(value.strip())
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def read_marker(root: str, now: datetime) -> tuple:
    """(none | valid | invalid, 中身 か 無効の訳)。"""
    path = os.path.join(root, *MARKER.split("/"))
    try:
        with open(path, encoding="utf-8-sig") as handle:
            text = handle.read()
    except FileNotFoundError:
        return "none", ""
    except (OSError, UnicodeError) as exc:
        return "invalid", f"読めない（{type(exc).__name__}）"
    try:
        data = json.loads(text)
    except ValueError:
        return "invalid", "JSON ではない"
    if not isinstance(data, dict):
        return "invalid", "JSON のオブジェクトではない"
    if not isinstance(data.get("reason"), str) or not data["reason"].strip():
        return "invalid", "reason が空"
    try:
        placed = local_time(data.get("placedAt"))
        until = local_time(data.get("until"))
    except (ValueError, TypeError):
        return "invalid", "placedAt か until が ISO 時刻ではない"
    if until <= placed:
        return "invalid", "until が placedAt 以前"
    if until - placed > MARKER_MAX_WINDOW:
        return "invalid", "期間が 30 分を超える"
    if now < placed:
        return "invalid", "placedAt が未来"
    if now >= until:
        return "invalid", f"期限切れ（until {data['until']}）"
    return "valid", data


def append_exception(root: str, now: datetime, category: str, word: str, command: str, reason: str) -> None:
    path = os.path.join(root, *EXCEPTION_LOG.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps({"at": now.isoformat(timespec="seconds"), "category": category, "word": word,
                       "command": command[:200], "reason": reason}, ensure_ascii=False)
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")


def _one_line(text: str, limit: int = 160) -> str:
    collapsed = " ".join(str(text).split())
    return collapsed if len(collapsed) <= limit else collapsed[:limit - 1] + "…"


def hook(payload: dict, now: datetime, root: str | None = None) -> tuple:
    """(拒否の 1 行 か None, 警告の list)。"""
    root = ROOT if root is None else root
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") not in TOOLS:
        return None, []
    entry = payload.get("tool_input")
    if not isinstance(entry, dict):
        raise ValueError("tool_input を読めない")
    command = entry.get("command")
    if not isinstance(command, str) or not command.strip():
        return None, []
    if caller(payload) != "main":
        return None, []
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        cwd = root
    found = analyze(command, payload["tool_name"], cwd, root)
    if found is None:
        return r6_line(command, payload["tool_name"], cwd, root), []
    category, word = found
    status, detail = read_marker(root, now)
    if status == "valid":
        r6 = r6_line(command, payload["tool_name"], cwd, root)
        if r6 is not None:
            return r6, []               # 印は R6 に効かない。拒否するので印の記録も書かない
        try:
            append_exception(root, now, category, word, command, detail["reason"])
        except OSError as exc:
            return None, [f"印で通したが {EXCEPTION_LOG} へ記録できない（{type(exc).__name__}: {exc}）"]
        return None, []
    line = f"{REASON_PREFIX}区分: {category}。{_one_line(word)}"
    if status == "invalid":
        line += f"。印は無効（{detail}）"
    return _one_line(line, 400), []


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON のオブジェクトが必要です")
        line, warnings = hook(payload, datetime.now())
    except Exception as exc:  # 判定の不具合で統括を止めない（他のフックと同じく通す）
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 統括の作業範囲の判定不能: {_one_line(exc)}", file=sys.stderr)
        return 0
    if warnings:
        print("orchestrator_scope_guard の警告: " + _one_line(" / ".join(warnings), 400), file=sys.stderr)
    if line is None:
        return 0
    print(line, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
