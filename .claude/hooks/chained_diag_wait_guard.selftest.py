"""Subprocess checks for chained_diag_wait_guard's real stdin/stdout contract.

本物のロック・プロセス・.claude/hooks/ には一切触れない(候補の写しを直接実行して
確かめるだけ)。"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().with_name("chained_diag_wait_guard.py")
ROOT = HOOK.parents[4]  # scratchpad/temp/w64a/hooks -> ルート
SESSION = r"C:\Users\oltot\.claude\projects\PointerCAD\session-1"
AGENT = SESSION + r"\subagents\agent-a6e1bbbebf07c7a6c.jsonl"
MAIN = SESSION + ".jsonl"

ONE_WAIT = "python -B -X utf8 scratchpad/claude/tools/diag.py wait --run A --timeout 540"
TWO_WAIT_SEMI = ONE_WAIT + " ; " + \
    "python -B -X utf8 scratchpad/claude/tools/diag.py wait --run B --timeout 540"
TWO_WAIT_AND = ONE_WAIT + " && " + \
    "python -B -X utf8 scratchpad/claude/tools/diag.py wait --run B --timeout 540"


class ChainedDiagWaitGuardTests(unittest.TestCase):
    def invoke(self, *, tool="Bash", command=ONE_WAIT, transcript=AGENT, agent_id=None, raw=None):
        payload = {
            "hook_event_name": "PreToolUse", "tool_name": tool,
            "tool_input": {"command": command},
        }
        if transcript is not None:
            payload["transcript_path"] = transcript
        if agent_id is not None:
            payload["agent_id"] = agent_id
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps(payload) if raw is None else raw,
            text=True, capture_output=True, cwd=ROOT, timeout=2,
        )

    def assert_denied(self, result):
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn("diag.py wait", output["permissionDecisionReason"])

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_single_wait_allowed(self):
        self.assert_allowed(self.invoke(command=ONE_WAIT))

    def test_two_waits_semicolon_denied(self):
        self.assert_denied(self.invoke(command=TWO_WAIT_SEMI))

    def test_two_waits_and_denied(self):
        self.assert_denied(self.invoke(command=TWO_WAIT_AND))

    def test_two_waits_powershell_denied(self):
        self.assert_denied(self.invoke(tool="PowerShell", command=TWO_WAIT_SEMI))

    def test_main_chained_waits_allowed(self):
        self.assert_allowed(self.invoke(command=TWO_WAIT_SEMI, transcript=MAIN))

    def test_unrelated_command_allowed(self):
        self.assert_allowed(self.invoke(command="git status"))

    def test_diag_py_other_subcommand_not_counted(self):
        cmd = ("python -B -X utf8 scratchpad/claude/tools/diag.py static --owner w64a ; " + ONE_WAIT)
        self.assert_allowed(self.invoke(command=cmd))

    def test_unrelated_tool_allowed(self):
        self.assert_allowed(self.invoke(tool="Read"))

    def test_missing_transcript_fail_open(self):
        result = self.invoke(transcript=None)
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_bad_json_fail_open(self):
        result = self.invoke(raw="{")
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_agent_id_without_transcript_denied(self):
        self.assert_denied(self.invoke(transcript=None, agent_id="a6e1bbbebf07c7a6c", command=TWO_WAIT_SEMI))

    def test_empty_command_allowed(self):
        self.assert_allowed(self.invoke(command=""))

    # --- 2026-10-05 R27: 繰り返しの中の wait(本文には1回しか無い) ---
    # 実物: 2026-10-01 10:55:26Z cl-v102-calc-deadline が実際に出した Bash の本文(省略なし)。
    REAL_V102 = (
        "cd C:/Users/oltot/Documents/git-projects/PointerCAD && for r in "
        "20261001-195522-cl-v102-calc-deadline-unit 20261001-195522-cl-v102-calc-deadline-unit-2; "
        "do python -B -X utf8 scratchpad/claude/tools/diag.py wait --run $r --timeout 540 2>&1 "
        '| grep -E "Test Files|Tests |exit=|FAIL" | head -10; done'
    )
    LOOP_WAIT = "python -B -X utf8 scratchpad/claude/tools/diag.py wait --run $r --timeout 540"

    def test_real_v102_for_loop_denied(self):
        self.assert_denied(self.invoke(command=self.REAL_V102))

    def test_for_loop_newline_denied(self):
        cmd = chr(10).join(["for r in A B", "do", "  " + self.LOOP_WAIT, "done"])
        self.assert_denied(self.invoke(command=cmd))

    def test_while_loop_denied(self):
        cmd = "while read r; do " + self.LOOP_WAIT + "; done < runs.txt"
        self.assert_denied(self.invoke(command=cmd))

    def test_powershell_foreach_denied(self):
        cmd = "foreach ($r in $runs) { " + self.LOOP_WAIT + " }"
        self.assert_denied(self.invoke(tool="PowerShell", command=cmd))

    def test_powershell_foreach_object_pipeline_denied(self):
        cmd = "$runs | ForEach-Object { " + self.LOOP_WAIT.replace("$r", "$_") + " }"
        self.assert_denied(self.invoke(tool="PowerShell", command=cmd))

    def test_xargs_denied(self):
        cmd = "echo A B | xargs -n1 python -B -X utf8 scratchpad/claude/tools/diag.py wait --timeout 540 --run"
        self.assert_denied(self.invoke(command=cmd))

    def test_bash_c_quoted_two_waits_denied(self):
        inner = ONE_WAIT + " ; " + ONE_WAIT.replace("--run A", "--run B")
        self.assert_denied(self.invoke(command='bash -c "' + inner + '"'))

    def test_bash_c_quoted_loop_denied(self):
        inner = "for r in A B; do " + self.LOOP_WAIT + "; done"
        self.assert_denied(self.invoke(command='bash -c "' + inner + '"'))

    def test_loop_without_wait_allowed(self):
        cmd = "for f in a b; do echo $f; done ; " + ONE_WAIT
        self.assert_allowed(self.invoke(command=cmd))

    def test_wait_before_loop_allowed(self):
        cmd = ONE_WAIT + " ; for f in a b; do echo $f; done"
        self.assert_allowed(self.invoke(command=cmd))

    def test_loop_with_other_diag_subcommand_allowed(self):
        cmd = "for r in A B; do python -B -X utf8 scratchpad/claude/tools/diag.py status --run $r; done"
        self.assert_allowed(self.invoke(command=cmd))

    def test_main_loop_wait_allowed(self):
        self.assert_allowed(self.invoke(command=self.REAL_V102, transcript=MAIN))


if __name__ == "__main__":
    unittest.main()
