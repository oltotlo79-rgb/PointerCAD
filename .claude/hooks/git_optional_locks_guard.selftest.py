"""Checks for git_optional_locks_guard.

Two layers: HookContractTests run the hook as a subprocess exactly as Claude Code does (JSON on
stdin, deny JSON or nothing on stdout, warnings on stderr, exit code 0) and include the nine
required cases (a)-(i); JudgmentTableTests call the hook in-process over long tables of command
shapes (Bash and PowerShell dialects) so that hundreds of shapes cost milliseconds.

scripts/check.selftest.ps1 runs this file as
  & python -B -X utf8 (Join-Path $PSScriptRoot '../.claude/hooks/git_optional_locks_guard.selftest.py')
and requires exit code 0 (unittest.main). It reads only the hook next to it: no scratchpad/, no
git repository, no network (rules/06 10.336).
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path

# check.ps1 starts this file through `<root>\scripts\..\.claude\hooks\...`; resolve() folds the `..`.
HOOK = Path(__file__).resolve().with_name("git_optional_locks_guard.py")
ROOT = HOOK.parents[2]
SESSION = r"C:\Users\oltot\.claude\projects\PointerCAD\session-1"
AGENT = SESSION + r"\subagents\agent-a6e1bbbebf07c7a6c.jsonl"
MAIN = SESSION + ".jsonl"

sys.dont_write_bytecode = True
_SPEC = importlib.util.spec_from_file_location("git_optional_locks_guard_under_test", HOOK)
GUARD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(GUARD)


def judge(command, *, tool="Bash", transcript=AGENT, agent_id=None):
    """In-process call of hook(); returns (result or None, text written to stderr)."""
    payload = {
        "hook_event_name": "PreToolUse", "tool_name": tool,
        "tool_input": {"command": command},
    }
    if transcript is not None:
        payload["transcript_path"] = transcript
    if agent_id is not None:
        payload["agent_id"] = agent_id
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        result = GUARD.hook(payload)
    return result, captured.getvalue()


class HookContractTests(unittest.TestCase):
    def invoke(self, command=None, *, tool="Bash", transcript=AGENT, agent_id=None, raw=None,
               tool_input=None, event="PreToolUse"):
        payload = {"hook_event_name": event, "tool_name": tool}
        payload["tool_input"] = {"command": command} if tool_input is None else tool_input
        if transcript is not None:
            payload["transcript_path"] = transcript
        if agent_id is not None:
            payload["agent_id"] = agent_id
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps(payload) if raw is None else raw,
            text=True, encoding="utf-8", capture_output=True, cwd=ROOT, timeout=30,
        )

    def assert_denied(self, result, *contains):
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        reason = output["permissionDecisionReason"]
        for needle in ("--no-optional-locks", "index.lock", "2026-10-24") + contains:
            self.assertIn(needle, reason)
        return reason

    def assert_allowed(self, result, *, warns=False):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        if warns:
            self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)
        else:
            self.assertEqual(result.stderr, "")

    # --- the nine required cases (a)-(i) ---

    def test_a_git_status_denied(self):
        reason = self.assert_denied(self.invoke("git status"), "git --no-optional-locks status")
        self.assertIn("git status", reason)

    def test_b_no_optional_locks_status_allowed(self):
        self.assert_allowed(self.invoke("git --no-optional-locks status"))

    def test_c_env_prefix_git_diff_allowed(self):
        self.assert_allowed(self.invoke("GIT_OPTIONAL_LOCKS=0 git diff"))

    def test_d_powershell_env_then_git_status_allowed(self):
        self.assert_allowed(self.invoke("$env:GIT_OPTIONAL_LOCKS='0'; git status", tool="PowerShell"))
        self.assert_allowed(self.invoke('$env:GIT_OPTIONAL_LOCKS="0"; git status', tool="PowerShell"))

    def test_e_git_C_status_denied(self):
        self.assert_denied(self.invoke("git -C scratchpad/q1 status"), "git -C scratchpad/q1 status")

    def test_f_git_log_allowed(self):
        self.assert_allowed(self.invoke("git log -3"))

    def test_g_cd_then_git_diff_stat_denied(self):
        self.assert_denied(self.invoke("cd packages && git diff --stat"), "git diff --stat")

    def test_h_main_caller_git_status_allowed(self):
        self.assert_allowed(self.invoke("git status", transcript=MAIN))
        self.assert_allowed(self.invoke("git diff", transcript=MAIN, agent_id=""))

    def test_i_undecidable_input_allowed(self):
        bad_json = self.invoke(raw="{")
        self.assert_allowed(bad_json, warns=True)
        self.assertIn("判定不能", bad_json.stderr)
        self.assert_allowed(self.invoke(tool_input={}))  # no command at all
        self.assert_allowed(self.invoke(tool_input={"command": None}))
        self.assert_allowed(self.invoke(""))
        self.assert_allowed(self.invoke("   \n  "))
        self.assert_allowed(self.invoke(tool_input="not an object"), warns=True)

    # --- calling convention and reason text ---

    def test_reason_is_japanese_json_with_correct_form_and_cause(self):
        result = self.invoke("git diff HEAD~1 -- packages")
        reason = self.assert_denied(result, "git --no-optional-locks status",
                                    "git --no-optional-locks diff", "git diff HEAD~1 -- packages",
                                    "GIT_OPTIONAL_LOCKS=0 git diff", "統括へ報告")
        self.assertIn("並行", reason)
        self.assertNotIn("$env:", reason)
        self.assertNotIn("GIT_OPTIONAL_LOCKS がありますが", reason)

    def test_powershell_reason_shows_powershell_form(self):
        reason = self.assert_denied(self.invoke("git status", tool="PowerShell"),
                                    "$env:GIT_OPTIONAL_LOCKS='0'")
        self.assertNotIn("GIT_OPTIONAL_LOCKS=0 git", reason)

    def test_hint_when_the_variable_is_present_but_not_in_effect(self):
        self.assert_denied(self.invoke("GIT_OPTIONAL_LOCKS=0; git status"),
                           "GIT_OPTIONAL_LOCKS がありますが")
        self.assert_denied(self.invoke("$env:GIT_OPTIONAL_LOCKS='0'; git status"),
                           "GIT_OPTIONAL_LOCKS がありますが")

    def test_agent_id_without_transcript_denied(self):
        self.assert_denied(self.invoke("git status", transcript=None, agent_id="a6e1bbbebf07c7a6c"))

    def test_powershell_tool_denied_and_allowed(self):
        self.assert_denied(self.invoke("git diff", tool="PowerShell"))
        self.assert_allowed(self.invoke("git --no-optional-locks diff", tool="PowerShell"))

    def test_missing_caller_fail_open(self):
        result = self.invoke("git status", transcript=None)
        self.assert_allowed(result, warns=True)
        self.assertIn("呼出元", result.stderr)

    def test_malformed_subagent_path_fail_open(self):
        self.assert_allowed(self.invoke("git status", transcript=SESSION + r"\subagents\other.jsonl"),
                            warns=True)

    def test_command_without_git_needs_no_caller(self):
        self.assert_allowed(self.invoke("ls -la", transcript=None))

    def test_dynamic_subcommand_passes_with_warning(self):
        result = self.invoke("sub=status; git $sub")
        self.assert_allowed(result, warns=True)
        self.assertIn("副コマンド", result.stderr)

    def test_other_tools_and_events_ignored(self):
        self.assert_allowed(self.invoke("git status", tool="Read"))
        self.assert_allowed(self.invoke("git status", tool="Monitor"))
        self.assert_allowed(self.invoke("git status", event="PostToolUse"))

    # The bounds are far above the normal ~0.1 s even on a machine busy with other agents: they
    # only catch pathological slowness (settings.json gives the hook 5 s).
    def test_execution_is_fast(self):
        start = time.perf_counter()
        result = self.invoke("cd packages && git diff --stat")
        elapsed = time.perf_counter() - start
        self.assert_denied(result)
        self.assertLess(elapsed, 10.0, f"hook took {elapsed:.3f}s")

    def test_large_command_is_fast(self):
        command = ";\n".join(["git log -1 --oneline"] * 20000) + "\ngit status"
        start = time.perf_counter()
        result = self.invoke(command)
        elapsed = time.perf_counter() - start
        self.assert_denied(result)
        self.assertLess(elapsed, 20.0, f"hook took {elapsed:.3f}s")


BASH_DENIED = [
    # subcommands that can rewrite the index
    "git status", "git status --short", "git status -sb", "git diff", "git diff --stat",
    "git diff --cached", "git diff HEAD~1 -- packages/ui", "git diff-index HEAD",
    "git diff-index --quiet HEAD", "git diff-files", "git difftool", "git describe --dirty",
    "git describe --tags --dirty=-x", "git describe --broken", "git stash list",
    "git stash show -p",
    # global options between git and the subcommand
    "git -C scratchpad/q1 status", "git -c core.quotepath=false status",
    "git -C packages -c a=b diff", "git --git-dir=.git --work-tree=. status",
    "git --git-dir .git --work-tree . status", "git --no-pager diff",
    # the flag only counts among git's global options
    "git status --no-optional-locks",
    # chains
    "cd packages && git diff --stat", "git log -1 && git status", "git status | head -5",
    "echo hi; git diff", "git status || true", "cd x\ngit diff", "git status & git log -1",
    "git --no-optional-locks status && git diff", "git log -1 | cat; git status 2>&1",
    "git log --oneline | head -3 && git diff --stat | tail -1",
    # substitutions, groups, control flow, wrappers
    'echo "$(git status --short)"', "FILES=$(git diff --name-only)", "x=`git status`",
    '[ -n "$(git status --porcelain)" ] && echo dirty', 'echo "$(echo "$(git diff)")"',
    'git -C "$(git rev-parse --show-toplevel)" status',
    "for f in a b; do git diff $f; done", "if git diff --quiet; then echo clean; fi",
    "while git status >/dev/null; do :; done", "! git diff --quiet", "(cd x && git status)",
    "{ git diff; }", "time git status", "timeout 10 git status", "nohup git status &",
    "command git status", "exec git status", "env FOO=1 git status",
    "printf 'a\\n' | xargs -I{} git -C {} status", "find . -name .git -execdir git status \\;",
    "bash -c 'git status'", 'sh -c "cd x && git diff"', "bash -lc 'git status'",
    'eval "git diff"', 'cmd /c "git status"', 'powershell -NoProfile -Command "git status"',
    "pwsh -c 'git diff'", "diff <(git diff a) <(git diff b)",
    # program names and paths
    "git.exe status", "/usr/bin/git diff", r'"C:\Program Files\Git\cmd\git.exe" status',
    # GIT_OPTIONAL_LOCKS that does not protect this very call
    "GIT_OPTIONAL_LOCKS=1 git status", "GIT_OPTIONAL_LOCKS=0; git status",
    "GIT_OPTIONAL_LOCKS=0 git status && git diff", "export GIT_OPTIONAL_LOCKS=1; git status",
    "export GIT_OPTIONAL_LOCKS=0; unset GIT_OPTIONAL_LOCKS; git status",
    "git status; export GIT_OPTIONAL_LOCKS=0", "GIT_OPTIONAL_LOCKS=0 echo x; git status",
    "export GIT_OPTIONAL_LOCKS=0; env -i git status", "env -u GIT_OPTIONAL_LOCKS git status",
    "bash -c 'export GIT_OPTIONAL_LOCKS=0'; git status",
    "FOO=GIT_OPTIONAL_LOCKS=0 git status",
    # PowerShell syntax does not help in the Bash tool: the failed line is followed by git
    "$env:GIT_OPTIONAL_LOCKS='0'; git status",
    # shapes taken from real subagent calls
    r'cd "C:\Users\oltot\Documents\git-projects\PointerCAD" && git status --porcelain | wc -l',
    'until [ -z "$(git status --porcelain -- packages/kernel)" ]; do sleep 20; done',
    'for f in a.ts b.ts; do echo "== $f: $(git diff --stat 7682b1c -- $f | tail -1)"; done',
    "T=$(date '+%H:%M'); printf '%s HEAD=%s dirty=%s\\n' \"$T\" \"$(git rev-parse HEAD)\" \"$(git status --porcelain | wc -l)\"",
]

BASH_ALLOWED = [
    # --no-optional-locks among the global options
    "git --no-optional-locks status", "git --no-optional-locks diff --stat",
    "git -C packages --no-optional-locks status", "git --no-optional-locks -C packages status",
    "git -c a=b --no-optional-locks diff", "git --no-pager --no-optional-locks diff",
    "git --no-optional-locks stash list", "git --no-optional-locks describe --dirty",
    "git --no-optional-locks diff-index --quiet HEAD", "git --no-optional-locks diff-files",
    "git --no-optional-locks status && git --no-optional-locks diff",
    "cd packages && git --no-optional-locks diff --stat | head -5",
    # GIT_OPTIONAL_LOCKS=0 in effect for the call
    "GIT_OPTIONAL_LOCKS=0 git diff", 'GIT_OPTIONAL_LOCKS="0" git diff',
    "GIT_OPTIONAL_LOCKS='0' git diff", "GIT_OPTIONAL_LOCKS=false git diff",
    "FOO=1 GIT_OPTIONAL_LOCKS=0 git diff", "env GIT_OPTIONAL_LOCKS=0 git diff",
    "GIT_OPTIONAL_LOCKS=0 command git status",
    "GIT_OPTIONAL_LOCKS=0 git status && GIT_OPTIONAL_LOCKS=0 git diff",
    "export GIT_OPTIONAL_LOCKS=0; git status",
    "export GIT_OPTIONAL_LOCKS=0 && git status && git diff",
    "export FOO=1 GIT_OPTIONAL_LOCKS=0; git status", "declare -x GIT_OPTIONAL_LOCKS=0; git diff",
    "export GIT_OPTIONAL_LOCKS=0\ngit status\ngit diff",
    "cd packages && export GIT_OPTIONAL_LOCKS=0 && git diff --stat",
    "export GIT_OPTIONAL_LOCKS=0; for f in a b; do git diff $f; done",
    'export GIT_OPTIONAL_LOCKS=0; echo "$(git status --short)"',
    "GIT_OPTIONAL_LOCKS=0 bash -c 'git status'", "bash -c 'git --no-optional-locks status'",
    "export GIT_OPTIONAL_LOCKS=0; bash -c 'git diff'",
    "{ export GIT_OPTIONAL_LOCKS=0; git status; }",
    "export GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS=0; git status",
    # PowerShell run from the Bash tool brings its own dialect
    "powershell -Command \"$env:GIT_OPTIONAL_LOCKS='0'; git status\"",
    # git commands that never rewrite the index
    "git log -3", "git log --oneline -5 -- packages/ui", "git show HEAD",
    "git show HEAD:README.md", "git rev-parse --abbrev-ref HEAD", "git rev-parse HEAD",
    "git ls-files", "git ls-files -m", "git cat-file -p HEAD", "git branch --show-current",
    "git blame README.md", "git diff-tree -r HEAD", "git config --get user.name", "git remote -v",
    "git describe --tags", "git describe HEAD", "git help status", "git --version", "git",
    "git -C", "git --no-pager log -1", "git -C status log", "git log -- status",
    'git log --grep="git status"', "git rev-parse --git-path index.lock", "git stash",
    # text that only mentions git
    'echo "git status"', "echo git status", 'grep -n "git diff" file.md',
    "rg -n 'git status' rules/", "# git status", "ls # git status", "echo ok # git diff",
    "# note; git status", "echo ok # a && git diff", "ls # $(git status)",
    "which git", "command -v git", "type git", "git-lfs status",
    "cd git-projects/PointerCAD && ls", "ls /c/Users/oltot/Documents/git-projects/PointerCAD",
    "cat <<'EOF'\ngit status\ngit diff\nEOF", "cat > x.md <<EOF\n  git status\nEOF",
    "cat <<-EOF\n\tgit diff\n\tEOF", 'cat <<< "git status"', "echo '$(git status)'",
    "cat <<'EOF'\ndon't\ngit status\nEOF",
    "find . -name '*.git' -exec ls {} \\;", "echo $((1 + 2))", "echo ${HOME}",
    # known limit: git hidden inside another program's code is not seen
    "python - <<'PY'\nimport subprocess\nsubprocess.run(['git', 'status'])\nPY",
    # substitutions that do not rewrite the index
    "echo $(git rev-parse HEAD)", "git log $(git rev-parse HEAD)",
    "diff <(git show a:f) <(git show b:f)",
    # shapes taken from real subagent calls
    'git -C "$ROOT" worktree list', 'git show 8616ae9:packages/ui/src/math/x.ts | grep -n "x"',
    "echo \"$T 着手。HEAD=$(git rev-parse HEAD)、未コミット件数を確認\" >> progress.md",
]

PS_DENIED = [
    "git status", "git diff --stat", "git -C packages status", "cd packages; git diff",
    "git status | Select-Object -First 5", "git diff --name-only | ForEach-Object { $_ }",
    "$s = git status --short", "$s=(git diff --stat)", "[string]$s = git status", "$s += git diff",
    "(git status --short) -join ' '", "@(git diff --name-only)", 'Write-Output "$(git status)"',
    "& git status", r"& 'C:\Program Files\Git\cmd\git.exe' status", "git.exe status",
    r'& "C:\Program Files\Git\cmd\git.exe" diff',
    "if ((git status --porcelain)) { 'dirty' }", "foreach ($d in $dirs) { git -C $d status }",
    "git log | ForEach-Object { git diff $_ }", "try { git diff } catch { }",
    "Get-ChildItem | ForEach-Object { git -C $_.FullName status }",
    "Invoke-Expression 'git status'", "iex 'git diff'", 'powershell -Command "git status"',
    'bash -c "git status"', "cmd /c git status",
    # the Bash form does not help in PowerShell: `export` fails and git still runs
    "export GIT_OPTIONAL_LOCKS=0; git status", "GIT_OPTIONAL_LOCKS=0; git status",
    # settings that do not protect this call
    "$env:GIT_OPTIONAL_LOCKS='1'; git status", "git status; $env:GIT_OPTIONAL_LOCKS='0'",
    "$env:GIT_OPTIONAL_LOCKS='0'; Remove-Item Env:GIT_OPTIONAL_LOCKS; git status",
    "[Environment]::SetEnvironmentVariable('GIT_OPTIONAL_LOCKS','0','User'); git status",
    "$env:OTHER='0'; git status", "$env:GIT_OPTIONAL_LOCKS='0'; $env:GIT_OPTIONAL_LOCKS=$null; git diff",
    "$env:GIT_OPTIONAL_LOCKS='0'; bash -c 'env -i git status'",
    # shapes taken from real subagent calls
    "$raw = @(& git -C $root status --porcelain -z)",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $raw = @(& git -C $root -c core.quotepath=false status --porcelain=v1 -z)",
]

PS_ALLOWED = [
    "git --no-optional-locks status", "git -C packages --no-optional-locks diff",
    "$env:GIT_OPTIONAL_LOCKS='0'; git status", '$env:GIT_OPTIONAL_LOCKS="0"; git status',
    "$env:GIT_OPTIONAL_LOCKS = '0'; git diff --stat", "$env:GIT_OPTIONAL_LOCKS=0; git status",
    "${env:GIT_OPTIONAL_LOCKS}='0'; git diff", "$Env:git_optional_locks = 'false'; git status",
    "Set-Item Env:GIT_OPTIONAL_LOCKS 0; git status",
    "Set-Item -Path Env:GIT_OPTIONAL_LOCKS -Value 0; git status",
    "[Environment]::SetEnvironmentVariable('GIT_OPTIONAL_LOCKS','0'); git status",
    "[Environment]::SetEnvironmentVariable('GIT_OPTIONAL_LOCKS', '0', 'Process'); git status",
    "$env:GIT_OPTIONAL_LOCKS='0'\ngit status\ngit diff",
    "$env:GIT_OPTIONAL_LOCKS='0'; $s = git status --short",
    "$env:GIT_OPTIONAL_LOCKS='0'; foreach ($d in $dirs) { git -C $d status }",
    "foreach ($d in $dirs) { $env:GIT_OPTIONAL_LOCKS='0'; git -C $d status }",
    "$env:GIT_OPTIONAL_LOCKS='0'; powershell -Command \"git status\"",
    "$env:GIT_OPTIONAL_LOCKS='0'; & git diff; if (git status) { 1 }",
    "powershell -Command \"$env:GIT_OPTIONAL_LOCKS='0'; git status\"",
    "git log -3", "git show HEAD", "git rev-parse HEAD", "git ls-files | Select-String ts",
    "Write-Host git status", 'Write-Output "git diff"',
    'Select-String -Pattern "git status" -Path x.md',
    "Set-Content -Path x.md -Value @'\ngit status\n'@",
    "Set-Content x.md -Value @'\ndon't run\ngit status\n'@",
    'Set-Content x.md -Value @"\nsay "hi\ngit status\n"@',
    "# note; git status", "Get-Date # a; git diff",
    "Get-ChildItem -Path packages | Select-Object -First 3", "# git status",
    "<# git status #> Get-Date", "$s = git log -1", "& git log -1", "(git rev-parse HEAD)",
    "@(git rev-parse HEAD)", "git log --format=%H -1 | ForEach-Object { git show $_ }",
]

WEIRD_INPUTS = [
    "git", "git ", "git -C", "git -c", "git --git-dir", "$(", "$(git", "$(git status", '"', "'",
    "`", "{", "(", ")", "}", "{ (", "&", "&&&&", ";;;", "|||", "a & b & c", "\\", "git \\",
    "<<EOF", "cat <<EOF\ngit status", "@'", "@'\ngit status", "'" * 50, '"' * 51, "$(" * 100,
    "(" * 300 + "git log" + ")" * 300, "git log\x00 -1", "git ログ -1 日本語", "git " + "x" * 200000,
    "GIT_OPTIONAL_LOCKS", "GIT_OPTIONAL_LOCKS=", "env", "env -u", "env --", "command", "command -v",
    "timeout", "nice", "xargs", "bash -c", "bash -c ''", "powershell -Command", "cmd /c",
    "eval", "iex", "export", "export GIT_OPTIONAL_LOCKS", "unset", "declare -x",
    "$env:GIT_OPTIONAL_LOCKS", "$env:GIT_OPTIONAL_LOCKS=", "$s =", "[x]$", "${", "${x",
    "<#", "<# unterminated git status", "#", "# ", "git status #", "echo $#", "echo ${#x}",
]


class JudgmentTableTests(unittest.TestCase):
    def assert_decision(self, command, tool, expected_deny):
        with self.subTest(tool=tool, command=command):
            result, stderr = judge(command, tool=tool)
            if expected_deny:
                self.assertIsNotNone(result, f"should be denied: {command!r}")
                output = result["hookSpecificOutput"]
                self.assertEqual(output["hookEventName"], "PreToolUse")
                self.assertEqual(output["permissionDecision"], "deny")
                self.assertIn("--no-optional-locks", output["permissionDecisionReason"])
                self.assertEqual(stderr, "")
            else:
                self.assertIsNone(result, f"should pass: {command!r}")
                self.assertEqual(stderr, "")

    def test_bash_denied(self):
        for command in BASH_DENIED:
            self.assert_decision(command, "Bash", True)

    def test_bash_allowed(self):
        for command in BASH_ALLOWED:
            self.assert_decision(command, "Bash", False)

    def test_powershell_denied(self):
        for command in PS_DENIED:
            self.assert_decision(command, "PowerShell", True)

    def test_powershell_allowed(self):
        for command in PS_ALLOWED:
            self.assert_decision(command, "PowerShell", False)

    def test_orchestrator_is_never_judged(self):
        for command in BASH_DENIED:
            with self.subTest(command=command):
                result, stderr = judge(command, transcript=MAIN)
                self.assertIsNone(result)
                self.assertEqual(stderr, "")
        for command in PS_DENIED:
            with self.subTest(command=command):
                result, stderr = judge(command, tool="PowerShell", transcript=MAIN)
                self.assertIsNone(result)
                self.assertEqual(stderr, "")

    def test_agent_id_marks_a_subagent_even_with_a_main_transcript(self):
        result, _ = judge("git status", transcript=MAIN, agent_id="a6e1bbbebf07c7a6c")
        self.assertIsNotNone(result)

    def test_weird_inputs_never_raise(self):
        for command in WEIRD_INPUTS:
            for tool in ("Bash", "PowerShell"):
                with self.subTest(tool=tool, command=command[:60]):
                    judge(command, tool=tool)  # must not raise; deny or pass are both fine

    def test_deep_nesting_is_bounded(self):
        for depth in (50, 200, 1000):
            command = "echo $(" * depth + "git status" + ")" * depth
            with self.subTest(depth=depth):
                started = time.perf_counter()
                judge(command)
                self.assertLess(time.perf_counter() - started, 10.0)

    def test_many_brackets_in_one_statement_stay_linear(self):
        command = "foreach ($d in $dirs) " + "{ " * 200 + "git log -1 " + "} " * 200
        started = time.perf_counter()
        result, _ = judge(command, tool="PowerShell")
        self.assertIsNone(result)
        self.assertLess(time.perf_counter() - started, 10.0)

    def test_the_blamed_call_is_shown_without_the_surrounding_group(self):
        cases = [
            ("PowerShell", "if (git status --porcelain) { 'dirty' }", "`git status --porcelain`"),
            ("PowerShell", "(git diff --name-only).Count", "`git diff --name-only`"),
            ("PowerShell", 'git diff -- "a b.txt"', '`git diff -- "a b.txt"`'),
            ("Bash", "(cd x && git status)", "`git status`"),
            ("Bash", 'echo "$(git diff --stat HEAD)"', "`git diff --stat HEAD`"),
        ]
        for tool, command, shown in cases:
            with self.subTest(command=command):
                result, _ = judge(command, tool=tool)
                self.assertIn(shown, result["hookSpecificOutput"]["permissionDecisionReason"])

    def test_lexer_keeps_substitutions_and_quotes_together(self):
        statements = GUARD._parse("a 'b c' \"d $(e f) g\" h$(i j)k; l | m && n\no", "bash")
        texts = [[word.text for word in words] for words in statements]
        self.assertEqual(texts, [["a", "b c", "d $(e f) g", "h$(i j)k"], ["l"], ["m"], ["n"], ["o"]])
        self.assertEqual(statements[0][2].subs, ("e f",))
        self.assertEqual(statements[0][3].subs, ("i j",))

    def test_heredoc_body_is_dropped_but_the_rest_is_kept(self):
        self.assertEqual(GUARD._strip_heredocs("cat <<'EOF' > f\nx\ny\nEOF\ngit log"),
                         "cat <<'EOF' > f\ngit log")
        self.assertEqual(GUARD._strip_heredocs("cat <<< word\ngit log"), "cat <<< word\ngit log")
        denied, _ = judge("cat <<'EOF' > f\nx\nEOF\ngit status")
        self.assertIsNotNone(denied)


if __name__ == "__main__":
    unittest.main()
