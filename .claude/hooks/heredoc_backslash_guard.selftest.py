"""Subprocess checks for heredoc_backslash_guard's real stdin/stdout contract.

本物の`.claude/hooks/`には一切触れない(候補の写しを直接実行して確かめるだけ)。"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().with_name("heredoc_backslash_guard.py")
BS = chr(92)

HEREDOC_WINDOWS_PATH = (
    "python -B -X utf8 - <<'PY'\n"
    "path = \"C:" + BS + "Users" + BS + "oltot" + BS + "Documents\"\n"
    "print(path)\n"
    "PY"
)
HEREDOC_REGEX = (
    "python - <<'PY'\n"
    "import re\n"
    "re.sub(r'" + BS + "d+" + BS + ".'" + ", '', text)\n"
    "PY"
)
HEREDOC_CLEAN = (
    "python -B -X utf8 - <<'PY'\n"
    "print('hello world')\n"
    "PY"
)
HEREDOC_CHR92 = (
    "python -B -X utf8 - <<'PY'\n"
    "backslash = chr(92)\n"
    "print(backslash)\n"
    "PY"
)
HEREDOC_INDENTED = (
    "python -B -X utf8 - <<-'PY'\n"
    "    path = \"C:" + BS + "Users" + BS + "x\"\n"
    "    PY"
)
WINDOWS_PATH_AS_ARG = (
    "python scripts/manual/tool.py C:" + BS + "Users" + BS + "oltot" + BS + "Documents"
)
PYTHON_C_BACKSLASH = (
    "python -c \"path = 'C:" + BS + "Users" + BS + "x'\""
)
NODE_E_BACKSLASH = (
    "node -e \"console.log('C:" + BS + "Users" + BS + "x')\""
)
PYTHON_C_CLEAN = "python -c \"print('hello world')\""
SCRATCHPAD_SCRIPT_NO_TIMEOUT = "python -B -X utf8 scratchpad/claude/tools/diag.py static --owner w127a"
MANUAL_SCRIPT_NO_TIMEOUT = "node scripts/manual/captureRegistry.mjs register"


class HeredocBackslashGuardTests(unittest.TestCase):
    def invoke(self, *, tool="Bash", command, timeout=None, raw=None):
        payload = {
            "hook_event_name": "PreToolUse", "tool_name": tool,
            "tool_input": {"command": command},
        }
        if timeout is not None:
            payload["tool_input"]["timeout"] = timeout
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps(payload) if raw is None else raw,
            text=True, capture_output=True, timeout=10,
        )

    def assert_denied(self, result, contains="逆斜線"):
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn(contains, output["permissionDecisionReason"])

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    # 事故の再現(統括の実際の事故の2つの形)
    def test_heredoc_windows_path_denied(self):
        self.assert_denied(self.invoke(command=HEREDOC_WINDOWS_PATH))

    def test_heredoc_regex_backslash_denied(self):
        self.assert_denied(self.invoke(command=HEREDOC_REGEX))

    def test_heredoc_indented_terminator_denied(self):
        self.assert_denied(self.invoke(command=HEREDOC_INDENTED))

    def test_heredoc_powershell_denied(self):
        self.assert_denied(self.invoke(tool="PowerShell", command=HEREDOC_WINDOWS_PATH))

    # 通すべき形
    def test_heredoc_without_backslash_allowed(self):
        self.assert_allowed(self.invoke(command=HEREDOC_CLEAN))

    def test_chr92_style_allowed(self):
        self.assert_allowed(self.invoke(command=HEREDOC_CHR92))

    def test_windows_path_outside_heredoc_allowed(self):
        self.assert_allowed(self.invoke(command=WINDOWS_PATH_AS_ARG, timeout=600000))

    def test_unrelated_command_allowed(self):
        self.assert_allowed(self.invoke(command="git status"))

    def test_unrelated_tool_allowed(self):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps({
                "hook_event_name": "PreToolUse", "tool_name": "Read",
                "tool_input": {"file_path": "a.txt"},
            }),
            text=True, capture_output=True, timeout=10,
        )
        self.assert_allowed(result)

    def test_empty_command_allowed(self):
        self.assert_allowed(self.invoke(command=""))

    # インラインコード
    def test_python_c_backslash_denied(self):
        self.assert_denied(self.invoke(command=PYTHON_C_BACKSLASH))

    def test_node_e_backslash_denied(self):
        self.assert_denied(self.invoke(command=NODE_E_BACKSLASH))

    def test_python_c_clean_allowed(self):
        self.assert_allowed(self.invoke(command=PYTHON_C_CLEAN))

    def test_bad_json_fail_open(self):
        result = self.invoke(command="unused", raw="{")
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    # 警告だけ(止めない)
    def test_warning_scratchpad_script_without_timeout(self):
        result = self.invoke(command=SCRATCHPAD_SCRIPT_NO_TIMEOUT)
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_WARN", result.stderr)

    def test_warning_manual_script_without_timeout(self):
        result = self.invoke(command=MANUAL_SCRIPT_NO_TIMEOUT)
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_WARN", result.stderr)

    def test_no_warning_when_timeout_given(self):
        result = self.invoke(command=SCRATCHPAD_SCRIPT_NO_TIMEOUT, timeout=600000)
        self.assert_allowed(result)
        self.assertEqual(result.stderr, "")

    def test_no_warning_for_unrelated_command(self):
        result = self.invoke(command="git status")
        self.assert_allowed(result)
        self.assertEqual(result.stderr, "")

    def test_no_warning_for_powershell_without_timeout(self):
        result = self.invoke(tool="PowerShell", command=SCRATCHPAD_SCRIPT_NO_TIMEOUT)
        self.assert_allowed(result)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
