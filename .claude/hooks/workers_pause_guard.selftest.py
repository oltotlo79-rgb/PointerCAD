"""実フック workers_pause_guard.py の stdin・stdout・終了コードを、使い捨ての偽の根で検査する（rules/06 §10.465）。

フックを偽の根の .claude/hooks/ へ写して起動するので、フックの ROOT は偽の根になり、本物の印に触れない。
作業場所は scratchpad/temp の下に自分で作り、終わりに消す（scratchpad が無いまっさらな写しでも、作った祖先だけ消す）。
"""

import json
from datetime import datetime, timedelta
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = Path(__file__).resolve().with_name("workers_pause_guard.py")
ROOT = HOOK.parents[2]
SESSION = r"C:\Users\oltot\.claude\projects\PointerCAD\session-1"
AGENT = SESSION + r"\subagents\agent-a6e1bbbebf07c7a6c.jsonl"
MAIN = SESSION + ".jsonl"


class WorkersPauseGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parent = ROOT / "scratchpad/temp"
        cls.created = []
        node = parent
        while not node.exists():
            cls.created.append(node)
            node = node.parent
        parent.mkdir(parents=True, exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="workers-pause-guard-", dir=parent)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()
        for directory in cls.created:
            directory.rmdir()

    def setUp(self):
        self.temp_case = tempfile.TemporaryDirectory(dir=self.temp.name)
        self.addCleanup(self.temp_case.cleanup)
        self.root = Path(self.temp_case.name)
        self.hook = self.root / ".claude/hooks/workers_pause_guard.py"
        self.hook.parent.mkdir(parents=True)
        shutil.copyfile(HOOK, self.hook)
        self.marker_path = self.root / "scratchpad/claude/root-runtime/workers-pause.json"
        self.marker_path.parent.mkdir(parents=True)

    def marker(self, until_minutes=30, reason="gate の単体の段（担当を全て止める）", raw=None):
        if raw is None:
            now = datetime.now()
            raw = json.dumps({"reason": reason, "placedAt": (now - timedelta(minutes=1)).isoformat(timespec="seconds"),
                              "until": (now + timedelta(minutes=until_minutes)).isoformat(timespec="seconds")},
                             ensure_ascii=False)
        self.marker_path.write_text(raw, encoding="utf-8")

    def invoke(self, tool="Bash", transcript=AGENT, agent_id=None, event="PreToolUse"):
        payload = {"hook_event_name": event, "tool_name": tool, "tool_input": {"command": "python x.py"}}
        if transcript is not None:
            payload["transcript_path"] = transcript
        if agent_id is not None:
            payload["agent_id"] = agent_id
        return subprocess.run([sys.executable, "-B", "-X", "utf8", str(self.hook)], input=json.dumps(payload),
                              text=True, encoding="utf-8", capture_output=True)

    def output(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def test_worker_calls_are_denied_with_the_reason_and_until(self):
        self.marker()
        for tool in ("Bash", "PowerShell", "Edit", "Write", "MultiEdit"):
            with self.subTest(tool=tool):
                data = self.output(self.invoke(tool=tool))
                self.assertEqual(data["hookSpecificOutput"]["permissionDecision"], "deny")
                reason = data["hookSpecificOutput"]["permissionDecisionReason"]
                self.assertIn("gate の単体の段（担当を全て止める）", reason)
                self.assertIn("until", reason)
                self.assertIn("§10.465", reason)
        self.assertEqual(self.output(self.invoke(transcript=MAIN, agent_id="a123"))["hookSpecificOutput"]["permissionDecision"],
                         "deny", "agent_id があれば担当")

    def test_orchestrator_session_passes(self):
        self.marker()
        for tool in ("Bash", "Edit", "Write"):
            with self.subTest(tool=tool):
                self.assertEqual(self.invoke(tool=tool, transcript=MAIN).stdout, "")

    def test_without_a_marker_everything_passes(self):
        self.assertEqual(self.invoke().stdout, "")
        self.assertEqual(self.invoke(tool="Edit").stdout, "")

    def test_marker_past_its_until_passes_with_a_warning(self):
        self.marker(until_minutes=-5)
        result = self.invoke()
        data = self.output(result)
        self.assertNotIn("hookSpecificOutput", data)
        self.assertIn("until", data["systemMessage"])
        self.assertIn("過ぎている", result.stderr)

    def test_broken_marker_passes_with_a_warning(self):
        for raw in ("{", json.dumps({"reason": "x", "placedAt": "2026-11-07T09:00:00"}),
                    json.dumps({"reason": " ", "placedAt": "2026-11-07T09:00:00", "until": "2026-11-01T23:00:00"})):
            with self.subTest(raw=raw):
                self.marker(raw=raw)
                data = self.output(self.invoke())
                self.assertNotIn("hookSpecificOutput", data)
                self.assertIn("workers-pause.json", data["systemMessage"])

    def test_read_and_other_events_are_not_checked(self):
        self.marker()
        self.assertEqual(self.invoke(tool="Read").stdout, "")
        self.assertEqual(self.invoke(event="PostToolUse").stdout, "")


if __name__ == "__main__":
    unittest.main()
