r"""Reject Claude subagents' index-rewriting git reads that lack --no-optional-locks.

2026-10-24 18:23: a subagent's read-only `git status` / `git diff` stopped midway and left a
0-byte `.git/index.lock` in the repository root. By default those commands take that lock to
refresh the index's stat cache (git's "optional locks"). The stale lock then stopped another
subagent's contact calculation at 18:27 (its isolation check needs HEAD and the index to match
byte for byte) and the orchestrator had to delete the lock and rerun (rules/06 §10.414). The
written rule (common discipline: read git with `--no-optional-locks`) was not enough, so this
hook denies the call before the shell runs it.

Denied (subagent callers only; the orchestrator's own calls always pass): a `git` call whose
subcommand can rewrite the index -- `status`, `diff`, `diff-index`, `diff-files`, `difftool`,
`describe --dirty|--broken`, `stash list|show` -- unless

  (a) `--no-optional-locks` is among git's global options (between `git` and the subcommand,
      `-C <path>` / `-c k=v` may be in between), or
  (b) `GIT_OPTIONAL_LOCKS=0` is in effect for that very call, in the shell dialect of the tool:
      Bash:       `GIT_OPTIONAL_LOCKS=0 git ...`, `env GIT_OPTIONAL_LOCKS=0 git ...`, or an
                  earlier `export GIT_OPTIONAL_LOCKS=0` in the same command string;
      PowerShell: an earlier `$env:GIT_OPTIONAL_LOCKS='0'` (also `Set-Item Env:...` and
                  `[Environment]::SetEnvironmentVariable(...)`) in the same command string.
  The dialects are not interchangeable on purpose: a PowerShell-style `$env:...` line in Bash (or
  `export ...` in PowerShell) fails as a command, and the `;` that follows still runs git with
  no protection. A bare `GIT_OPTIONAL_LOCKS=0;` in Bash does not export the variable either, and
  a prefix assignment (`GIT_OPTIONAL_LOCKS=0 git status && git diff`) covers only its own command.

Everything else passes: `git log` / `show` / `rev-parse` / `ls-files` / `cat-file` / ... never
rewrite the index. Each git call in `&&`, `||`, `;`, `|`, newline, `$( )`, backticks, `( )`,
`{ }`, `bash -c`, `powershell -Command`, `cmd /c`, `eval`, `-exec`, `xargs`, `env`, `time`, ...
chains is judged on its own. Heredoc bodies, PowerShell here-strings and comments are skipped.
Anything the hook cannot decide (a subcommand that is a shell variable, broken hook input, an
unknown caller) passes and writes POINTERCAD_HOOK_FAIL_OPEN to stderr, like the other hooks.
Known limits: git aliases, git calls hidden in scripts (`python -c`, `diag.py`, ...), and an
`export` made inside a Bash `( ... )` subshell (treated as if it lasted) are not modelled.
`git diff --no-index` is judged like any `git diff` (adding the flag costs nothing).

This is a best-effort lexical check (a small shell-word lexer, not a full shell parser),
consistent with the other pattern-matching guards in this directory.
"""

from __future__ import annotations

import json
import re
import sys

SUBAGENT_TRANSCRIPT_PATTERN = (
    r"(?:^|[/\\])[^/\\]+[/\\]subagents[/\\]agent-[A-Za-z0-9]+\.jsonl$"
)

ENV_NAME = "GIT_OPTIONAL_LOCKS"
MAX_DEPTH = 40  # nested command strings, substitutions and bracket groups together

REASON_HEAD = (
    "`{call}` は index を書き直し得る git の読み取りです。既定の git は index の stat の更新の"
    "ために .git/index.lock を作り、途中で止まると 0 バイトの錠が残って、並行する別の処理が"
    "止まります(2026-10-24 18:23 の事故: 残った錠のために接触計算の isolation の照合が 18:27 に"
    "止まり、再実行になった。rules/06 §10.414)。"
)
REASON_FIX = (
    "`git` の直後に `--no-optional-locks` を付けて読んでください: "
    "`git --no-optional-locks status`{example}。{alternative}"
    "git log・show・rev-parse・ls-files・cat-file など index を書かないコマンドはそのままで"
    "構いません。.git/index.lock を見つけても担当は消さず、統括へ報告してください。"
)
EXAMPLE = "(この呼出しなら `git --no-optional-locks {sub} ...`)"
ALTERNATIVE = {
    "bash": "または、`GIT_OPTIONAL_LOCKS=0 git {sub} ...` と git の直前に置くか、同じ命令の前の文で"
            " `export GIT_OPTIONAL_LOCKS=0` してもかまいません。",
    "ps": "または、同じ命令の git より前の文で `$env:GIT_OPTIONAL_LOCKS='0'` を設定してもかまいません。",
}
HINT = (
    "この命令には GIT_OPTIONAL_LOCKS がありますが、この git 呼出しには効いていません"
    "(変数への代入だけ・別のシェルの書き方・git より後ろの設定・先頭の1つの git だけに付けた設定は、"
    "この呼出しには届きません)。"
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


# --- lexer: command string -> statements -> shell words ---------------------------------------


class Word:
    """One shell word with its quotes removed, plus the bodies of the command substitutions
    ($( ), backticks, <( ), PowerShell @( )) it contains outside single quotes."""

    __slots__ = ("text", "subs")

    def __init__(self, text: str, subs: tuple[str, ...] = ()) -> None:
        self.text = text
        self.subs = subs


class Finding:
    __slots__ = ("sub", "call", "dialect")

    def __init__(self, sub: str, call: str, dialect: str) -> None:
        self.sub = sub
        self.call = call
        self.dialect = dialect


# `<<`, `<<-`, optional quotes, delimiter; `<<<` (here-string) is not a heredoc.
_HEREDOC_START_RE = re.compile(r"(?<!<)<<(?!<)(-)?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
_PS_HERESTRING_RE = re.compile(r"@(['\"])[ \t]*\n.*?\n[ \t]*\1@", re.S)


def _strip_heredocs(text: str) -> str:
    lines = text.split("\n")
    kept: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        kept.append(line)
        i += 1
        for match in _HEREDOC_START_RE.finditer(line):
            indented = bool(match.group(1))
            delimiter = match.group(3)
            while i < n:
                body = lines[i]
                i += 1
                if (body.lstrip() if indented else body) == delimiter:
                    break
    return "\n".join(kept)


def _preprocess(text: str, dialect: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if dialect == "ps":
        text = _PS_HERESTRING_RE.sub("''", text)
        return text.replace("`\n", " ")
    return _strip_heredocs(text).replace("\\\n", "")


def _skip_quoted(text: str, i: int, escape: str) -> int:
    """text[i] is a quote character; return the index just after its closing quote."""
    quote = text[i]
    j, n = i + 1, len(text)
    while j < n:
        c = text[j]
        if quote == '"' and c == escape and j + 1 < n:
            j += 2
            continue
        if c == quote:
            return j + 1
        j += 1
    return n


def _match_paren(text: str, i: int, escape: str) -> tuple[int, int]:
    """text[i] is '('. Returns (index of the matching ')', index after it); (n, n) if unbalanced."""
    n = len(text)
    depth = 0
    j = i
    while j < n:
        c = text[j]
        if c == escape and j + 1 < n:
            j += 2
            continue
        if c == "'" or c == '"':
            j = _skip_quoted(text, j, escape)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return j, j + 1
        j += 1
    return n, n


def _match_backtick(text: str, i: int) -> tuple[int, int]:
    """text[i] is a backtick (Bash command substitution)."""
    n = len(text)
    j = i + 1
    while j < n:
        c = text[j]
        if c == "\\" and j + 1 < n:
            j += 2
            continue
        if c == "`":
            return j, j + 1
        j += 1
    return n, n


def _parse(text: str, dialect: str) -> list[list[Word]]:
    """Split a command string into statements (at newline ; | || && and, in Bash, a lone &) of
    shell words. Quote-aware, and $( ) / backticks / ${ } stay inside their word."""
    ps = dialect == "ps"
    escape = "`" if ps else "\\"
    statements: list[list[Word]] = []
    words: list[Word] = []
    cur: list[str] = []
    subs: list[str] = []
    started = False
    n = len(text)
    i = 0

    def end_word() -> None:
        nonlocal cur, subs, started
        if started:
            words.append(Word("".join(cur), tuple(subs)))
        cur = []
        subs = []
        started = False

    def end_statement() -> None:
        nonlocal words
        end_word()
        if words:
            statements.append(words)
        words = []

    while i < n:
        ch = text[i]
        if ch in " \t":
            end_word()
            i += 1
            continue
        if ch == "\n" or ch == ";":
            end_statement()
            i += 1
            continue
        if ch == "|":
            end_statement()
            i += 2 if text[i + 1:i + 2] in ("|", "&") else 1
            continue
        if ch == "&":
            following = text[i + 1:i + 2]
            if following == "&":
                end_statement()
                i += 2
                continue
            if not ps:
                previous = cur[-1][-1:] if (started and cur) else ""
                if following == ">" or previous in ("<", ">"):
                    cur.append(ch)  # redirection such as >&2 or &>file
                    started = True
                    i += 1
                    continue
                end_statement()  # a lone & ends a background command
                i += 1
                continue
            # PowerShell: a lone & is the call operator -> an ordinary word character below.
        if ch == "#" and not started:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ps and ch == "<" and not started and text.startswith("<#", i):
            j = text.find("#>", i + 2)
            i = n if j < 0 else j + 2
            continue
        if ch == "'":
            started = True
            j = text.find("'", i + 1)
            if j < 0:
                j = n
            cur.append(text[i + 1:j])
            i = j + 1
            continue
        if ch == '"':
            started = True
            i += 1
            while i < n and text[i] != '"':
                c = text[i]
                if c == escape and i + 1 < n:
                    following = text[i + 1]
                    if ps or following in '"\\$`':
                        cur.append(following)
                        i += 2
                    else:
                        cur.append(c)
                        i += 1
                    continue
                if c == "$" and text.startswith("$(", i):
                    close, after = _match_paren(text, i + 1, escape)
                    subs.append(text[i + 2:close])
                    cur.append(text[i:after])
                    i = after
                    continue
                if not ps and c == "`":
                    close, after = _match_backtick(text, i)
                    subs.append(text[i + 1:close])
                    cur.append(text[i:after])
                    i = after
                    continue
                cur.append(c)
                i += 1
            i += 1  # the closing quote
            continue
        if ch == escape and i + 1 < n:
            cur.append(text[i + 1])
            started = True
            i += 2
            continue
        if ch == "$" and text.startswith("$(", i):
            close, after = _match_paren(text, i + 1, escape)
            subs.append(text[i + 2:close])
            cur.append(text[i:after])
            started = True
            i = after
            continue
        if ch == "$" and text.startswith("${", i):
            j = text.find("}", i + 2)
            after = n if j < 0 else j + 1
            cur.append(text[i:after])
            started = True
            i = after
            continue
        if ps and ch == "@" and text.startswith("@(", i):
            close, after = _match_paren(text, i + 1, escape)
            subs.append(text[i + 2:close])
            cur.append(text[i:after])
            started = True
            i = after
            continue
        if not ps and ch == "`":
            close, after = _match_backtick(text, i)
            subs.append(text[i + 1:close])
            cur.append(text[i:after])
            started = True
            i = after
            continue
        if not ps and ch in "<>" and text.startswith("(", i + 1):
            close, after = _match_paren(text, i + 1, escape)
            subs.append(text[i + 2:close])
            cur.append(text[i:after])
            started = True
            i = after
            continue
        cur.append(ch)
        started = True
        i += 1
    end_statement()
    return statements


# --- environment: is GIT_OPTIONAL_LOCKS=0 in effect? ------------------------------------------

_ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")
_ZERO_VALUES = ("0", "false", "no", "off")
_PS_ENV_ASSIGN_RE = re.compile(r"^\$\{?env:" + ENV_NAME + r"\}?\s*=\s*(.*)$", re.I | re.S)
_PS_SET_ITEM_RE = re.compile(
    r"^(?:set-item|si|set-content|sc)\s+(?:-(?:literal)?path\s+)?env:\\?" + ENV_NAME
    + r"\s+(?:-value\s+)?(\S+)\s*$", re.I)
_PS_SETENV_RE = re.compile(
    r"^\[(?:system\.)?environment\]::setenvironmentvariable\(\s*" + ENV_NAME
    + r"\s*,\s*(\S+?)\s*(?:,\s*process\s*)?\)\s*$", re.I)
_PS_REMOVE_RE = re.compile(
    r"^(?:remove-item|ri|del|rm)\s+(?:-(?:literal)?path\s+)?env:\\?" + ENV_NAME + r"\s*$", re.I)
_PS_VAR_RE = re.compile(r"^(?:\[[^\]]*\])*\$\{?[A-Za-z_][\w:.]*\}?")
_PS_ASSIGN_OP_RE = re.compile(r"^[+\-*/%]?=(.*)$", re.S)


def _is_zero(value: str) -> bool:
    return value.strip().strip("'\"").lower() in _ZERO_VALUES


def _bash_env_statement(base: str, args: list[Word], env_zero: bool) -> bool | None:
    """The new persistent state if this Bash statement exports/unsets GIT_OPTIONAL_LOCKS."""
    if base == "export" or (base in ("declare", "typeset")
                            and any(a.text.startswith("-") and "x" in a.text for a in args)):
        value = env_zero
        for arg in args:
            match = _ASSIGN_RE.match(arg.text)
            if match is not None and match.group(1) == ENV_NAME:
                value = _is_zero(arg.text[match.end():])
        return value
    if base == "unset" and any(a.text == ENV_NAME for a in args):
        return False
    return None


def _ps_env_statement(words: list[Word]) -> bool | None:
    """The new persistent state if this PowerShell statement sets/removes GIT_OPTIONAL_LOCKS."""
    joined = " ".join(w.text for w in words)
    for pattern in (_PS_ENV_ASSIGN_RE, _PS_SET_ITEM_RE, _PS_SETENV_RE):
        match = pattern.match(joined)
        if match is not None:
            return _is_zero(match.group(1))
    if _PS_REMOVE_RE.match(joined) is not None:
        return False
    return None


def _drop_leading_openers(words: list[Word]) -> list[Word]:
    i = 0
    while i < len(words) and words[i].text != "" and not words[i].text.strip("({&"):
        i += 1
    words = words[i:]
    if words and words[0].text[:1] in ("(", "{"):
        words = [Word(words[0].text.lstrip("({"), ())] + words[1:]
    return words


def _ps_strip_assignment(words: list[Word]) -> list[Word]:
    """`$x = git status` / `$x=(git status)` / `[string]$x = ...` -> the right-hand side."""
    if not words:
        return words
    text = words[0].text
    match = _PS_VAR_RE.match(text)
    if match is None:
        return words
    rest = text[match.end():]
    if rest == "":
        if len(words) >= 2 and words[1].text in ("=", "+=", "-=", "*=", "/=", "%="):
            return words[2:]
        return words
    op = _PS_ASSIGN_OP_RE.match(rest)
    if op is not None:
        remainder = op.group(1)
        return ([Word(remainder, ())] if remainder else []) + words[1:]
    return words


# --- command position: assignments, keywords and wrappers in front of the command word -------

_PREFIX_WORDS = frozenset({"if", "then", "else", "elif", "do", "while", "until", "!", "&"})
_WRAPPERS_WITH_FLAGS = frozenset({"time", "command", "builtin", "exec", "nohup"})
_EXEC_FLAGS = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
_BASH_SHELLS = frozenset({"bash", "sh", "zsh", "dash", "ksh"})
_PS_SHELLS = frozenset({"powershell", "pwsh"})
_BASH_C_RE = re.compile(r"^-[A-Za-z]*c[A-Za-z]*$")
_PS_COMMAND_RE = re.compile(r"^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$", re.I)
_XARGS_VALUE_FLAGS = frozenset({"-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"})


def _basename(text: str) -> str:
    name = re.split(r"[\\/]", text)[-1].lower()
    return name[:-4] if name.endswith(".exe") else name


def _skip_options(words: list[Word], i: int, value_flags: frozenset[str]) -> int:
    n = len(words)
    while i < n:
        text = words[i].text
        if text == "--":
            return i + 1
        if len(text) < 2 or not text.startswith("-"):
            return i
        i += 2 if text in value_flags else 1
    return i


def _skip_prefix(words: list[Word], dialect: str, env_zero: bool) -> tuple[int, str | None, bool]:
    """Returns (index of the command word, its text with opening brackets removed, whether
    GIT_OPTIONAL_LOCKS=0 reaches that command). (len(words), None, ...) when there is no command."""
    i, n = 0, len(words)
    local = env_zero
    while i < n:
        text = words[i].text
        if dialect == "bash":
            match = _ASSIGN_RE.match(text)
            if match is not None:
                if match.group(1) == ENV_NAME:
                    local = _is_zero(text[match.end():])
                i += 1
                continue
        head = text.lstrip("({")
        if head == "" and text != "":
            i += 1  # a bare opening bracket
            continue
        base = _basename(head)
        if head in _PREFIX_WORDS or base in _PREFIX_WORDS:
            i += 1
            continue
        if base in _WRAPPERS_WITH_FLAGS:
            # `command -v git` becomes a bare `git` without a subcommand, which passes.
            i = _skip_options(words, i + 1, frozenset())
            continue
        if base == "env":
            i += 1
            while i < n:
                item = words[i].text
                match = _ASSIGN_RE.match(item)
                if match is not None:
                    if match.group(1) == ENV_NAME:
                        local = _is_zero(item[match.end():])
                    i += 1
                    continue
                if item == "--":
                    i += 1
                    break
                if item in ("-u", "--unset"):
                    if i + 1 < n and words[i + 1].text == ENV_NAME:
                        local = False
                    i += 2
                    continue
                if item in ("-C", "--chdir", "-S", "--split-string"):
                    i += 2
                    continue
                if item in ("-i", "--ignore-environment", "-"):
                    local = False
                    i += 1
                    continue
                if item.startswith("-"):
                    i += 1
                    continue
                break
            continue
        if base == "timeout":
            i = _skip_options(words, i + 1, frozenset({"-k", "-s", "--kill-after", "--signal"})) + 1
            continue
        if base == "nice":
            i = _skip_options(words, i + 1, frozenset({"-n", "--adjustment"}))
            continue
        if base == "xargs":
            i = _skip_options(words, i + 1, _XARGS_VALUE_FLAGS)
            continue
        return i, head, local
    return n, None, local


def _nested_code(base: str, args: list[Word]) -> tuple[str, str] | None:
    """(code, dialect) when the command runs another shell/command string: bash -c, sh -c,
    powershell/pwsh -Command, cmd /c, eval, Invoke-Expression/iex."""
    texts = [a.text for a in args]
    if base in _BASH_SHELLS:
        skip = False
        for index, text in enumerate(texts):
            if skip:
                skip = False
                continue
            if _BASH_C_RE.match(text):
                return (texts[index + 1], "bash") if index + 1 < len(texts) else None
            if text in ("-o", "-O", "+o", "+O"):
                skip = True
                continue
            if text.startswith("-") or text.startswith("+"):
                continue
            return None  # a script path, not an inline command
        return None
    if base in _PS_SHELLS:
        for index, text in enumerate(texts):
            if _PS_COMMAND_RE.match(text):
                return (" ".join(texts[index + 1:]), "ps") if index + 1 < len(texts) else None
        return None
    if base == "cmd":
        for index, text in enumerate(texts):
            if text.lower() in ("/c", "/k", "/r"):
                return (" ".join(texts[index + 1:]), "bash") if index + 1 < len(texts) else None
        return None
    if base == "eval":
        return (" ".join(texts), "bash") if texts else None
    if base in ("iex", "invoke-expression"):
        return (" ".join(texts), "ps") if texts else None
    return None


# --- git: which calls can rewrite the index? --------------------------------------------------

_GIT_VALUE_LONG = frozenset({
    "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source",
})
_ALWAYS_LOCK_TAKING = frozenset({"status", "diff", "diff-index", "diff-files", "difftool"})


def _lock_taking(sub: str, rest: list[Word]) -> bool:
    if sub in _ALWAYS_LOCK_TAKING:
        return True
    if sub == "describe":
        for word in rest:
            name = word.text.partition("=")[0]
            if name.startswith("--") and len(name) >= 4 and (
                    "--dirty".startswith(name) or "--broken".startswith(name)):
                return True
        return False
    if sub == "stash":
        for word in rest:
            text = word.text.rstrip(")}")
            if text.startswith("-"):
                continue
            return text in ("list", "show")
        return False
    return False


def _check_git(args: list[Word], env_zero: bool, dialect: str,
               findings: list[Finding], warnings: list[str]) -> None:
    """args = the words after `git`."""
    i, n = 0, len(args)
    no_optional_locks = False
    while i < n:
        text = args[i].text
        if not text.startswith("-"):
            break
        if text in ("-C", "-c"):
            i += 2
            continue
        name, equals, _ = text.partition("=")
        if name in _GIT_VALUE_LONG:
            i += 1 if equals else 2
            continue
        if name == "--no-optional-locks":
            no_optional_locks = True
        i += 1
    if i >= n:
        return  # `git`, `git --version`, ...: no subcommand
    sub = args[i].text.rstrip(")}").lower()
    if sub.startswith(("$", "%", "@")) or "$(" in sub or "`" in sub:
        warnings.append(
            "git の副コマンドが変数・展開で、index を書き直すか静的に判定できません: git "
            + " ".join(a.text for a in args[:6])[:80])
        return
    if no_optional_locks or env_zero or not _lock_taking(sub, args[i + 1:]):
        return
    findings.append(Finding(sub, _render_call(args), dialect))


def _render_call(args: list[Word]) -> str:
    """The offending call as shown in the denial: `git` plus up to 8 words, cut at the bracket
    that closes the group the call sits in (`(git status)`, `{ git diff }`), words with spaces quoted."""
    parts = ["git"]
    for word in args[:8]:
        text = word.text
        cut = -1
        for closer in ")}":
            position = text.find(closer)
            if position >= 0 and "(" not in text[:position] and "{" not in text[:position]:
                cut = position if cut < 0 else min(cut, position)
        if cut >= 0:
            if cut > 0:
                parts.append(text[:cut])
            return " ".join(parts)[:120]
        parts.append('"' + text + '"' if (text == "" or " " in text) else text)
    return (" ".join(parts) + (" ..." if len(args) > 8 else ""))[:120]


# --- statements ------------------------------------------------------------------------------


def _analyze(text: str, dialect: str, env_zero: bool, depth: int,
             findings: list[Finding], warnings: list[str]) -> None:
    if depth > MAX_DEPTH or findings:
        return
    for words in _parse(_preprocess(text, dialect), dialect):
        env_zero = _analyze_statement(words, dialect, env_zero, depth, findings, warnings, True)
        if findings:
            return


def _analyze_statement(words: list[Word], dialect: str, env_zero: bool, depth: int,
                       findings: list[Finding], warnings: list[str], scan_subs: bool) -> bool:
    """Judge the git calls of one statement. Returns the persistent GIT_OPTIONAL_LOCKS=0 state
    for the statements that follow."""
    if depth > MAX_DEPTH or findings or not words:
        return env_zero
    if scan_subs:
        for word in words:
            for body in word.subs:
                _analyze(body, dialect, env_zero, depth + 1, findings, warnings)
    if dialect == "ps":
        words = _drop_leading_openers(words)
        if not words:
            return env_zero
        changed = _ps_env_statement(words)
        if changed is not None:
            return changed
        words = _ps_strip_assignment(words)
    index, command, local = _skip_prefix(words, dialect, env_zero)
    if command is None:
        return env_zero
    args = words[index + 1:]
    base = _basename(command)
    if dialect == "bash":
        changed = _bash_env_statement(base, args, env_zero)
        if changed is not None:
            return changed
    if base == "git":
        _check_git(args, local, dialect, findings, warnings)
    else:
        nested = _nested_code(base, args)
        if nested is not None:
            code, nested_dialect = nested
            inherited = env_zero if base in ("eval", "iex", "invoke-expression") else local
            _analyze(code, nested_dialect, inherited, depth + 1, findings, warnings)
    if findings:
        return env_zero
    # The first bracket / -exec in the arguments starts a new command position; its own scan
    # covers any later ones, so one recursion is enough (and keeps the work linear).
    for k, word in enumerate(args):
        text = word.text
        if text in _EXEC_FLAGS:
            _analyze_statement(args[k + 1:], dialect, env_zero, depth + 1, findings, warnings, False)
            break
        if text[:1] in ("(", "{") or text == "&":
            head = text.lstrip("({&")
            rest = ([Word(head, ())] if head else []) + args[k + 1:]
            # A setting made inside the block (`{ $env:X = '0'; git ... }`) stays in effect after it.
            return _analyze_statement(rest, dialect, env_zero, depth + 1, findings, warnings, False)
    return env_zero


def find_violations(command: str, dialect: str) -> tuple[list[Finding], list[str]]:
    findings: list[Finding] = []
    warnings: list[str] = []
    _analyze(command, dialect, False, 0, findings, warnings)
    return findings, warnings


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
    if "git" not in command.lower():
        return None  # nothing to judge, and no need to know who is calling
    role = caller(payload)
    if role is None:
        raise ValueError("transcript_path と agent_id から呼出元を判定できない")
    if role == "main":
        return None
    findings, warnings = find_violations(command, "ps" if tool == "PowerShell" else "bash")
    for warning in warnings:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: {warning}", file=sys.stderr)
    if not findings:
        return None
    found = findings[0]
    # The user's command text goes in as a value only: it is never parsed as a format string.
    reason = REASON_HEAD.format(call=found.call) + REASON_FIX.format(
        example="" if found.sub == "status" else EXAMPLE.format(sub=found.sub),
        alternative=ALTERNATIVE[found.dialect].format(sub=found.sub),
    ) + (HINT if ENV_NAME.lower() in command.lower() else "")
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}


def main() -> int:
    try:
        result = hook(json.load(sys.stdin))
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: git の optional lock の判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
