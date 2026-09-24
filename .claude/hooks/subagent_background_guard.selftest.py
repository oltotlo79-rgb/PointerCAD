"""Subprocess checks for the background guard's real stdin/stdout contract."""

from __future__ import annotations

import json
import subprocess
import sys
import time
import unittest
from pathlib import Path


# 2026-09-24 OPS-14追記: check.ps1はこの自己試験を`<根>\scripts\..\.claude\hooks\...`の
# ように`..`を含む道のりで起動する(PowerShellのJoin-Pathは`..`を畳み込まない)。
# .resolve()を挟み、フック本体と同じ解決方法にする(このファイルはROOTをcwdにしか
# 使っておらずrelative_to()の比較は無いため実害は無かったが、record_time_guard.
# selftest.pyやsubagent_search_scope_guard.selftest.pyで実際に踏んだのと同じ
# 書き方のため統一する)。
HOOK = Path(__file__).resolve().with_name("subagent_background_guard.py")
ROOT = HOOK.parents[2]
SESSION = r"C:\Users\oltot\.claude\projects\PointerCAD\session-1"
AGENT = SESSION + r"\subagents\agent-a6e1bbbebf07c7a6c.jsonl"
MAIN = SESSION + ".jsonl"


class BackgroundGuardTests(unittest.TestCase):
    def invoke(self, *, tool="Bash", entry=None, transcript=AGENT, agent_id=None, raw=None):
        payload = {
            "hook_event_name": "PreToolUse", "tool_name": tool,
            "tool_input": {"run_in_background": True} if entry is None else entry,
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
        self.assertIn("diag.py wait --timeout 540", output["permissionDecisionReason"])
        self.assertIn("600000 ms", output["permissionDecisionReason"])

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_subagent_bash_background_denied(self):
        self.assert_denied(self.invoke())

    def test_subagent_powershell_background_denied(self):
        self.assert_denied(self.invoke(tool="PowerShell"))

    def test_subagent_monitor_denied(self):
        self.assert_denied(self.invoke(tool="Monitor", entry={"task_id": "one"}))

    def test_subagent_foreground_allowed(self):
        self.assert_allowed(self.invoke(entry={"run_in_background": False}))

    def test_main_background_allowed(self):
        self.assert_allowed(self.invoke(transcript=MAIN))

    def test_main_monitor_allowed(self):
        self.assert_allowed(self.invoke(tool="Monitor", transcript=MAIN))

    def test_bad_json_fail_open(self):
        result = self.invoke(raw="{")
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_missing_transcript_fail_open(self):
        result = self.invoke(transcript=None)
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_agent_id_without_transcript_denied(self):
        self.assert_denied(self.invoke(transcript=None, agent_id="a6e1bbbebf07c7a6c"))

    def test_malformed_subagent_path_fail_open(self):
        result = self.invoke(transcript=SESSION + r"\subagents\other.jsonl")
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_unrelated_tool_allowed(self):
        self.assert_allowed(self.invoke(tool="Read"))

    def test_non_boolean_background_allowed(self):
        self.assert_allowed(self.invoke(entry={"run_in_background": "true"}))

    def test_execution_under_half_second(self):
        start = time.perf_counter()
        result = self.invoke()
        elapsed = time.perf_counter() - start
        self.assert_denied(result)
        self.assertLess(elapsed, 0.5, f"hook took {elapsed:.3f}s")


if __name__ == "__main__":
    unittest.main()
