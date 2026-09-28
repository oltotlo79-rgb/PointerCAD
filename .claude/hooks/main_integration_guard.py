"""Reject commands that integrate work into main before a valid completion judgment exists.

rules/03 §6: integration into main requires (1) a judgment that at least 10 root tasks are
complete and (2) both-OS CI green at the same SHA as main. This hook enforces only the first
half, mechanically, at the point a PreToolUse Bash/PowerShell call would actually perform the
integration: `gh pr create` (whose base is main -- explicitly, or by omission, since this
project's default base is main), `gh pr ready` / `gh pr merge` (whose target PR's base cannot be
determined from the command text alone, so per the instruction it is treated as main -- the
"undecidable -> deny side" rule), `git push` whose destination literally contains `main`,
`refs/heads/main`, or a `...:main` refspec, and `git merge` / `git rebase` run while the real
repository's current branch is `main`.

The hook does not judge whether a completion claim is *true* -- that is the judgment worker's
and the orchestrator's responsibility (per the instruction). It only checks that the record file
scratchpad/claude/state/main-integration-judgment.json exists, parses as an object, and has
`count` (int) >= 10 with `completedTaskIds` (array) whose length equals `count`. Any other
defect in the record (missing commit/judgedAt/evidence, mismatched commit, etc.) is NOT this
hook's concern and is left alone, per the instruction's explicit scope ("フックは記録の有無と形と
件数だけを見る").

Unreadable hook input (malformed JSON, missing tool_input) fails open (prints
POINTERCAD_HOOK_FAIL_OPEN to stderr and allows), matching every other hook in this project. This
is a different case from "undecidable which branch a gh pr targets", which fails CLOSED per the
instruction -- that undecidability is about the *command's own meaning*, not about being unable
to parse the hook's own input.

This hook applies to every caller (orchestrator included) -- unlike subagent_background_guard.py
and subagent_search_scope_guard.py, it does not exempt the orchestrator's own transcript, because
2026-09-25's precipitating incident (rules/06 §10.359) was the orchestrator itself creating the
PR without checking rules/03 §6.

2026-09-27 (rules/06 §10.357, w69a/w71a): `git push`/`git merge`/`git rebase` detection used to
look only at the first two words of a segment (`tokens[0]=='git' and tokens[1]=='push'`), so any
git *global* option before the subcommand -- `git -C <path> push origin main`, `git -c a=b push
...`, `git --git-dir=... push ...`, `--work-tree`, `--no-pager`, etc. -- slipped past unseen.
`_git_subcommand_index()` now skips git's (closed) global-option surface first and locates the
actual subcommand wherever it falls. Two more routes that push to an explicit ref without the
literal text "git push" ever appearing -- `scratchpad/claude/tools/deliver.py gate --push-ref
<ref>` and `scripts/lib/isolated_checkout_preflight.py ... --push-ref <ref>` -- are now checked by
`_push_ref_script_violation()`: if `--push-ref` resolves to `main`/`refs/heads/main`, the same
judgment-record requirement applies, matched by script basename so the interpreter/path prefix in
front of it (`python -B -X utf8 <path>/deliver.py ...`) does not matter.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys

# main_integration_guard.py lives at .claude/hooks/main_integration_guard.py -- three dirname()
# calls up from its own real path reaches the repository root, matching the other hooks in this
# directory (e.g. subagent_search_scope_guard.py's ROOT).
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
JUDGMENT_PATH = os.path.join(ROOT, "scratchpad", "claude", "state", "main-integration-judgment.json")

REASON_TEMPLATE = (
    "{what} は main への統合に当たります(rules/03 §6: main への統合は10原タスク以上の完了の"
    "判定と、main と同一 SHA の両OS CI の後)。{detail}"
)


# --- command-string segmentation (quote-aware; same approach as subagent_search_scope_guard.py's
# _segments()/_tokens(), so a `|` or `;` inside a quoted pattern does not split the command) ---

def _segments(command: str) -> list[str]:
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


_INLINE_FLAG_PATTERN = r"^(-{1,2}[A-Za-z][\w-]*)[=:](.*)$"


def _flag_value(tokens: list[str], index: int, long_name: str) -> tuple[str | None, int]:
    """Read a flag's value at tokens[index] (already matched as long_name or long_name=value).
    Returns (value_or_None, next_index_to_resume_from)."""
    token = tokens[index]
    inline = re.match(_INLINE_FLAG_PATTERN, token)
    if inline is not None and inline.group(1).lower() == long_name.lower():
        return inline.group(2), index + 1
    if token.lower() == long_name.lower() and index + 1 < len(tokens):
        return tokens[index + 1], index + 2
    return None, index + 1


# --- git global options: skip past them to find the real subcommand. `git -C <path> push ...`,
# `git -c a=b push ...`, `git --git-dir=... push ...` etc. must be recognized as `git push`, not
# missed because the naive "tokens[0]=='git' and tokens[1]=='push'" check only looked at the first
# two words (rules/06 §10.357 loophole). Git's global-option surface is closed (git itself rejects
# anything else before the subcommand), so an exhaustive allowlist is safe here: any option not on
# it either takes no value or git would already refuse to parse it as a subcommand invocation. ---

_GIT_GLOBAL_VALUE_SEPARATE = ("-C", "-c")  # always "-C <path>" / "-c <key>=<value>" (a separate
# token) in real-world usage -- config values routinely contain "=" themselves, so an inline
# "-C=..."/"-c=..." form is not treated specially; git does not document it either.
_GIT_GLOBAL_VALUE_LONG = (
    "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
    "--attr-source", "--exec-path", "--list-cmds",
)
_GIT_GLOBAL_FLAG = (
    "-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--bare",
    "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
    "--no-optional-locks", "--no-advice",
)


def _git_subcommand_index(tokens: list[str]) -> int | None:
    """Returns the index of the real git subcommand (push/merge/rebase/...) after skipping any
    global options, or None if tokens is not a `git ...` invocation or has no subcommand."""
    if not tokens or tokens[0].lower() != "git":
        return None
    i = 1
    n = len(tokens)
    while i < n:
        token = tokens[i]
        if not token.startswith("-"):
            return i
        if token in _GIT_GLOBAL_VALUE_SEPARATE:
            i += 2
            continue
        inline = re.match(_INLINE_FLAG_PATTERN, token)
        name = (inline.group(1) if inline is not None else token).lower()
        if name in _GIT_GLOBAL_VALUE_LONG:
            i += 1 if inline is not None else 2
            continue
        if name in _GIT_GLOBAL_FLAG or token in _GIT_GLOBAL_FLAG:
            i += 1
            continue
        # Unrecognized "-" token before any subcommand: git's global-option surface above is
        # exhaustive, so this is not a real global option. Skip it as a bare flag rather than
        # guessing it takes a value -- undershooting here would only make push/merge/rebase
        # detection look one token later, not earlier, and this project's existing tokens never
        # emit anything else here.
        i += 1
    return None


# --- scripts that push to an explicit ref without the command text containing "git push":
# `scratchpad/claude/tools/deliver.py gate --push-ref <ref>` and
# `scripts/lib/isolated_checkout_preflight.py ... --push-ref <ref>` (rules/06 §10.357: the
# w69a instruction's own procedure explicitly avoids these two precisely because this hook did not
# used to look for them). Detected by script basename, irrespective of interpreter/path prefix. ---

_PUSH_REF_SCRIPT_BASENAMES = ("deliver.py", "isolated_checkout_preflight.py")


def _push_ref_script_violation(tokens: list[str]) -> str | None:
    script_name = None
    for token in tokens:
        base = os.path.basename(token.strip("\"'")).lower()
        if base in _PUSH_REF_SCRIPT_BASENAMES:
            script_name = base
            break
    if script_name is None:
        return None
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token == "--push-ref" or re.match(r"^--push-ref[=:]", token):
            value, i = _flag_value(tokens, i, "--push-ref")
            if value is not None and _is_main_ref(value):
                return f"{script_name} --push-ref (main への送信)"
            continue
        i += 1
    return None


# --- gh pr create: base branch (explicit or default) ---

def _gh_pr_create_target(tokens: list[str]) -> str | None:
    """Returns the base branch this `gh pr create` targets, or None if this segment is not a
    `gh pr create` call. Missing --base defaults to "main" per this project's default branch."""
    if len(tokens) < 3 or tokens[0].lower() != "gh":
        return None
    if tokens[1].lower() != "pr" or tokens[2].lower() != "create":
        return None
    i = 3
    base: str | None = None
    while i < len(tokens):
        token = tokens[i]
        if token in ("--base", "-B") or re.match(r"^(--base|-B)[=:]", token):
            value, i = _flag_value(tokens, i, "--base" if token.startswith("--") else "-B")
            if value is not None:
                base = value
            continue
        i += 1
    return base if base is not None else "main"


def _is_main_ref(value: str) -> bool:
    normalized = value.strip().strip("\"'")
    if normalized.startswith("refs/heads/"):
        normalized = normalized[len("refs/heads/"):]
    return normalized == "main"


# --- gh pr ready / gh pr merge: base is undecidable from the command text -> deny side ---

def _gh_pr_ready_or_merge(tokens: list[str]) -> bool:
    if len(tokens) < 3 or tokens[0].lower() != "gh":
        return False
    if tokens[1].lower() != "pr":
        return False
    return tokens[2].lower() in ("ready", "merge")


# --- git push: destination refspec ---

_PUSH_VALUE_FLAGS = ("--repo", "--receive-pack", "-o", "--push-option")


def _git_push_violation(tokens: list[str]) -> bool:
    subcommand_index = _git_subcommand_index(tokens)
    if subcommand_index is None or tokens[subcommand_index].lower() != "push":
        return False
    i = subcommand_index + 1
    while i < len(tokens):
        token = tokens[i]
        matched_flag = None
        for flag in _PUSH_VALUE_FLAGS:
            if token == flag or re.match(rf"^{re.escape(flag)}[=:]", token):
                matched_flag = flag
                break
        if matched_flag is not None:
            _, i = _flag_value(tokens, i, matched_flag)
            continue
        if token.startswith("-"):
            i += 1
            continue
        candidate = token.strip("\"'").lstrip("+")
        if _is_main_ref(candidate):
            return True
        if candidate.endswith(":main") or candidate.endswith(":refs/heads/main"):
            return True
        i += 1
    return False


# --- git merge / git rebase: only a violation when actually run on top of the real "main"
# branch (checked via the current process's real repository state, matching how this hook is
# actually invoked by Claude Code -- before the shell command runs, with cwd already set to the
# working tree the command would operate on) ---

_MERGE_REBASE_NO_OP_FLAGS = ("--abort", "--continue", "--skip", "--quit")


def _git_merge_or_rebase_subcommand(tokens: list[str]) -> str | None:
    subcommand_index = _git_subcommand_index(tokens)
    if subcommand_index is None:
        return None
    subcommand = tokens[subcommand_index].lower()
    if subcommand not in ("merge", "rebase"):
        return None
    rest = [t.lower() for t in tokens[subcommand_index + 1:]]
    if any(flag in rest for flag in _MERGE_REBASE_NO_OP_FLAGS):
        return None  # not integrating anything new onto the current branch
    return subcommand


def _current_branch(cwd: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=3,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    branch = result.stdout.strip()
    return branch if branch else None


def _git_merge_or_rebase_violation(tokens: list[str], cwd: str) -> bool:
    if _git_merge_or_rebase_subcommand(tokens) is None:
        return False
    return _current_branch(cwd) == "main"


def find_main_integration(command: str, cwd: str) -> str | None:
    """Returns a human-readable description of the offending call, or None."""
    for segment in _segments(command):
        tokens = _tokens(segment)
        if not tokens:
            continue
        base = _gh_pr_create_target(tokens)
        if base is not None and _is_main_ref(base):
            return "gh pr create (base=main)"
        if _gh_pr_ready_or_merge(tokens):
            return f"gh pr {tokens[2].lower()}(対象PRのbaseを判定できないためmain扱い)"
        if _git_push_violation(tokens):
            return "git push (main への送信)"
        if _git_merge_or_rebase_violation(tokens, cwd):
            return f"git {_git_merge_or_rebase_subcommand(tokens)} (main の上で実行)"
        push_ref_violation = _push_ref_script_violation(tokens)
        if push_ref_violation is not None:
            return push_ref_violation
    return None


# --- judgment record: existence, shape, count only (per the instruction's explicit scope) ---

def _load_judgment_record() -> dict | None:
    if not os.path.isfile(JUDGMENT_PATH):
        return None
    with open(JUDGMENT_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _judgment_defect(record: object) -> str | None:
    """Returns a reason string if the record is missing/malformed/insufficient, else None."""
    if record is None:
        return (
            f"判定の記録が無い({JUDGMENT_PATH})。"
        )
    if not isinstance(record, dict):
        return "判定の記録がオブジェクトの形になっていない。"
    count = record.get("count")
    if isinstance(count, bool) or not isinstance(count, int):
        return "判定の記録の count が整数になっていない。"
    task_ids = record.get("completedTaskIds")
    if not isinstance(task_ids, list):
        return "判定の記録の completedTaskIds が配列になっていない。"
    if count < 10:
        return f"判定の記録の count が10未満({count})。"
    if len(task_ids) != count:
        return f"判定の記録の completedTaskIds の件数({len(task_ids)})と count({count})が一致しない。"
    return None


def hook(payload: object, cwd: str) -> dict | None:
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

    what = find_main_integration(command, cwd)
    if what is None:
        return None

    try:
        record = _load_judgment_record()
    except Exception as exc:
        record_defect = f"判定の記録を読み取れない(JSON不正等): {exc}"
    else:
        record_defect = _judgment_defect(record)

    if record_defect is None:
        return None

    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": REASON_TEMPLATE.format(what=what, detail=record_defect),
    }}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd") if isinstance(payload, dict) else None
        if not isinstance(cwd, str) or not cwd.strip():
            cwd = os.getcwd()
        result = hook(payload, cwd)
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: main統合の判定不能: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
