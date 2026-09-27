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


if __name__ == "__main__":
    unittest.main()
