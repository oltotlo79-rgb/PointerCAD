"""Reject Bash/PowerShell commands that read Claude Code transcripts (~/.claude/projects/**/*.jsonl) with
grep・rg・findstr・sed・awk・cat・head・tail・wc・sort・Select-String・Get-Content.

rules/06 §10.484(2026-11-11、cl-v103-gate-speed-guard-1111): 統括が以前の監視の文面を探すため、会話記録の .jsonl
(1 行が巨大)へ `grep -a -o` を背景で流した。GNU grep は行を丸ごと読み込み、TaskStop の後も grep.exe が残って
作業セット 17.7GB・CPU 1.9 コアを 14 分使い(空きメモリ 620MB)、実行中の全体検査のフックの自己試験が 1 秒の上限を
超えて落ちた。会話記録は Read ツールの offset/limit で読む。統括と担当の両方に効かせる(呼出し元を見ない)。

判定は他のパターンマッチ型のフック(heredoc_backslash_guard.py・subagent_search_scope_guard.py)と同じ発見的な判定で、
完全なシェル構文解析ではない。
- 速い道: 命令に「.claude」と「projects」の両方が無ければ何もしない(大半の命令はここで終わる)。
- 引用符を考えて語に分け、`;`・`&&`・`||`・`&`・改行で命令の列に、`|` で段に分ける。各段の命令の位置の語(先頭、
  `sudo`・`xargs`・`timeout` などの後、`-exec` の後、`(`・`{`・`$(` の後)が読取りの道具なら、次のどれかで拒否する。
  1. その段に `.claude/projects` の下を指す語と `.jsonl` を含む語がある(1 語でも `-Filter *.jsonl` のような別の語でも)。
  2. 前の命令で `cd`・`Set-Location` などにより `.claude/projects` の下へ移った後、その段に `.jsonl` を含む語がある。
  3. その段の `.claude/projects` の下を指す語が `*`・`?`・`[` の glob を持つ(.jsonl に当たり得る)。
  4. 道具が再帰で読む(rg、grep の -r・-R・--recursive、findstr の /s)のに、`.claude/projects` の下のフォルダーを指す。
  5. 道具が前の段から渡されたファイルの中身を読む(PowerShell の Select-String・Get-Content と別名、PowerShell の
     cat・type、xargs の後の道具)のに、同じ列に `.claude/projects` の下の語があり、`.jsonl`・glob・-Recurse・find がある。
  ただし `.claude/projects/<名前>/memory` の下(記憶の .md)と、拡張子のある .jsonl 以外のファイル、`rg --files`(名前の
  一覧だけ)は通す。`ls`・`Get-ChildItem` だけの一覧も通す(読取りの道具が無い)。
- 入力が読めない時は、他の Bash/PowerShell のフックと同じく POINTERCAD_HOOK_FAIL_OPEN を stderr に出して通す。
"""

from __future__ import annotations

import json
import re
import sys

BACKSLASH = chr(92)
READERS = frozenset({'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'sed', 'awk', 'gawk', 'cat', 'head', 'tail', 'wc', 'sort',
                     'select-string', 'sls', 'get-content', 'gc'})
POWERSHELL_READERS = frozenset({'type'})
PIPELINE_CONTENT_READERS = frozenset({'select-string', 'sls', 'get-content', 'gc'})
POWERSHELL_PIPELINE_CONTENT_READERS = frozenset({'cat', 'type'})
GREP_FAMILY = frozenset({'grep', 'egrep', 'fgrep'})
WRAPPERS = frozenset({'sudo', 'xargs', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'timeout', 'stdbuf', 'ionice'})
EXEC_FLAGS = frozenset({'-exec', '-execdir', '-ok', '-okdir'})
CHANGE_DIRECTORY = frozenset({'cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'})
SEPARATORS = frozenset({';', '&&', '||', '&', '\n'})
PROJECTS_PATTERN = r'\.claude/projects(?=/|$)'
ASSIGNMENT_PATTERN = r'[A-Za-z_][A-Za-z0-9_]*='
GREP_RECURSIVE_PATTERN = r'-[A-Za-z]*[rR][A-Za-z]*'

REASON = (
    "会話記録(~/.claude/projects 以下の .jsonl)を grep・rg・cat・head・tail・wc・Select-String・Get-Content などで"
    "読む命令は拒否します。会話記録は 1 行が巨大で、GNU grep は行を丸ごと読み込み、2026-11-11 に作業セット 17.7GB・"
    "空きメモリ 620MB まで使って全体検査のフックの自己試験を落としました(rules/06 §10.484)。読む時は Read ツールの"
    " offset/limit を使ってください。名前や大きさの一覧は ls・Get-ChildItem だけで見られます。"
)


def _tokens(command: str) -> list[tuple[str, bool | None]]:
    """引用符を考えた語の列。値は引用符を外した文字列、2 番目は引用符を含んだか(区切りの記号は None)。"""
    out: list[tuple[str, bool | None]] = []
    buf: list[str] = []
    quoted = False
    started = False

    def flush() -> None:
        nonlocal buf, quoted, started
        if started:
            out.append((''.join(buf), quoted))
        buf, quoted, started = [], False, False

    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c in ('"', "'"):
            j = i + 1
            while j < n and command[j] != c:
                if c == '"' and command[j] in (BACKSLASH, '`') and j + 1 < n and command[j + 1] == '"':
                    j += 1
                j += 1
            buf.append(command[i + 1:j])
            quoted = started = True
            i = j + 1
            continue
        if c in ' \t\r':
            flush()
        elif c in '\n;':
            flush()
            out.append((c, None))
        elif c == '|':
            flush()
            if command.startswith('||', i):
                out.append(('||', None))
                i += 1
            else:
                out.append(('|', None))
        elif c == '&' and not (i > 0 and command[i - 1] in '<>') and not command.startswith('&>', i):
            flush()
            if command.startswith('&&', i):
                out.append(('&&', None))
                i += 1
            else:
                out.append(('&', None))
        else:
            buf.append(c)
            started = True
        i += 1
    flush()
    return out


def _pipelines(tokens: list[tuple[str, bool | None]]) -> list[list[list[tuple[str, bool]]]]:
    pipelines: list[list[list[tuple[str, bool]]]] = [[[]]]
    for value, quoted in tokens:
        if quoted is None:
            if value == '|':
                pipelines[-1].append([])
            elif value in SEPARATORS:
                pipelines.append([[]])
            continue
        pipelines[-1][-1].append((value, quoted))
    return [[stage for stage in pipeline if stage] for pipeline in pipelines if any(pipeline)]


def _name(value: str) -> str:
    name = value.replace(BACKSLASH, '/').rsplit('/', 1)[-1].lower()
    return name[:-4] if name.endswith('.exe') else name


def _command_words(stage: list[tuple[str, bool]]) -> list[tuple[str, bool]]:
    """段の中の命令の位置の語の名前と、xargs の後か。"""
    words: list[tuple[str, bool]] = []
    expect, wrapper, via_xargs = True, False, False
    for value, quoted in stage:
        text = value
        if not quoted:
            if text == '{}':
                continue
            stripped = text.lstrip('$@({`')
            if stripped != text and (text[0] in '({`' or text.startswith(('$(', '@('))):
                expect = True
            text = stripped.rstrip(')};`')
            if not text:
                continue
        if expect:
            if not quoted and re.match(ASSIGNMENT_PATTERN, text):
                continue
            name = _name(text)
            if name in WRAPPERS:
                wrapper, via_xargs = True, via_xargs or name == 'xargs'
                continue
            if wrapper and not quoted and (text.startswith('-') or re.fullmatch(r'\d+(?:\.\d+)?[smhd]?', text)):
                continue
            words.append((name, via_xargs))
            expect, wrapper, via_xargs = False, False, False
            continue
        if not quoted and text.lower() in EXEC_FLAGS:
            expect = True
    return words


def _normalized(value: str) -> str:
    return re.sub('/+', '/', value.replace(BACKSLASH, '/')).lower()


def _projects_part(value: str) -> str | None:
    """`.claude/projects` から後ろ(小文字・斜線へそろえた形)。無ければ None。"""
    match = re.search(PROJECTS_PATTERN, _normalized(value))
    return None if match is None else _normalized(value)[match.start():]


def _memory(part: str) -> bool:
    return 'memory' in part.split('/')[3:]


def _has_glob(part: str) -> bool:
    return any(char in part for char in '*?[')


def _folder(part: str) -> bool:
    return '.' not in part.rstrip('/').rsplit('/', 1)[-1]


def _recursive(name: str, stage: list[tuple[str, bool]]) -> bool:
    texts = [value for value, quoted in stage if not quoted]
    if name == 'rg':
        return True
    if name in GREP_FAMILY:
        return any(re.fullmatch(GREP_RECURSIVE_PATTERN, text) or text == '--recursive' or text == '--dereference-recursive'
                   or text == '--directories=recurse' for text in texts)
    if name == 'findstr':
        return any(text.lower() == '/s' for text in texts)
    return False


def _reads_transcript(command: str, tool: str) -> bool:
    lowered = command.lower()
    if '.claude' not in lowered or 'projects' not in lowered:
        return False
    in_projects = False
    for pipeline in _pipelines(_tokens(command)):
        values = [value for stage in pipeline for value, _ in stage]
        parts = [part for part in map(_projects_part, values) if part is not None]
        open_parts = [part for part in parts if not _memory(part)]
        first = _command_words(pipeline[0])
        if first and first[0][0] in CHANGE_DIRECTORY:
            in_projects = bool(open_parts) and not any('.jsonl' in part for part in open_parts)
            continue
        jsonl_anywhere = any('.jsonl' in _normalized(value) for value in values)
        enumerates = any(value.lower() in ('-recurse', '-r') for value in values) or any(
            name == 'find' for stage in pipeline for name, _ in _command_words(stage))
        for stage in pipeline:
            stage_values = [value for value, _ in stage]
            stage_parts = [part for part in map(_projects_part, stage_values) if part is not None]
            stage_open = [part for part in stage_parts if not _memory(part)]
            stage_jsonl = any('.jsonl' in _normalized(value) for value in stage_values)
            for name, via_xargs in _command_words(stage):
                readers = READERS | (POWERSHELL_READERS if tool == 'PowerShell' else frozenset())
                if name not in readers:
                    continue
                if name == 'rg' and '--files' in stage_values:
                    continue
                if stage_jsonl and (stage_open or in_projects):
                    return True
                if any(_has_glob(part) for part in stage_open):
                    return True
                if _recursive(name, stage) and any(_folder(part) for part in stage_open):
                    return True
                content_reader = (name in PIPELINE_CONTENT_READERS or via_xargs
                                  or (tool == 'PowerShell' and name in POWERSHELL_PIPELINE_CONTENT_READERS))
                if content_reader and open_parts and (jsonl_anywhere or enumerates
                                                      or any(_has_glob(part) for part in open_parts)):
                    return True
    return False


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
    if not _reads_transcript(command, tool):
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
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 会話記録の読取りの判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
