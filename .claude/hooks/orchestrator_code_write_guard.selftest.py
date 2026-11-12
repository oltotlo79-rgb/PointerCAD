"""orchestrator_code_write_guard.py(rules/06 §10.495: 統括が Write・Edit で道具やコードを書くのを止める)の自己試験。

作業の場所は scratchpad/temp/<名前>-<乱数> を作って終わりに消す。
usage: python -B -X utf8 f4_orchestrator_code_write.selftest.py
"""
import importlib.util
import json
import shutil
import subprocess
import sys
import unittest
import uuid
from datetime import datetime
from pathlib import Path

def _created_ancestors(path: Path) -> list[Path]:
    """path から根へ向かって、まだ無い祖先を深い方から集める(空なら後で消す。rules/06 §10.343)。"""
    created: list[Path] = []
    node = path
    while not node.exists():
        created.append(node)
        node = node.parent
    return created


def _remove_if_empty(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.rmdir()
        except OSError:
            pass


HOOK = Path(__file__).resolve().with_name("orchestrator_code_write_guard.py")
REPO = HOOK.parents[2]
_TEMP_BASE = REPO / "scratchpad" / "temp"
_TEMP_CREATED = _created_ancestors(_TEMP_BASE)
spec = importlib.util.spec_from_file_location("orchestrator_code_write_guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

MAIN = "C:/Users/x/.claude/projects/p/abc.jsonl"
SUB = "C:/Users/x/.claude/projects/p/abc/subagents/agent-a1b2c3.jsonl"
NOW = datetime(2026, 11, 12, 10, 48)


def payload(path, tool="Write", transcript=MAIN, agent_id=None):
    data = {"hook_event_name": "PreToolUse", "tool_name": tool, "transcript_path": transcript,
            "tool_input": {"file_path": path, "content": "x"}}
    if agent_id:
        data["agent_id"] = agent_id
    return data


class Base(unittest.TestCase):
    def setUp(self):
        self.root = REPO / "scratchpad" / "temp" / f"cl-v103-failure-records-f4-{uuid.uuid4().hex[:8]}"
        (self.root / "scratchpad/claude/root-runtime").mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.root, True)

    def marker(self, placed="2026-11-12T10:40:00", until="2026-11-12T11:00:00", reason="緊急の修理"):
        (self.root / guard.MARKER).write_text(json.dumps({"reason": reason, "placedAt": placed, "until": until},
                                                         ensure_ascii=False), encoding="utf-8")


class StopExamples(Base):
    def test_today_watcher_script_is_denied(self):
        line, _ = guard.hook(payload("C:/Users/oltot/Documents/git-projects/PointerCAD/scratchpad/claude/root-runtime/"
                                     "wait-gate-terminal-1112.py"), NOW, str(self.root))
        self.assertIsNotNone(line)
        self.assertIn("wait-gate-terminal-1112.py", line)
        self.assertIn("担当へ指示書で出す", line)

    def test_edit_and_multiedit_of_code_are_denied(self):
        for tool, path in (("Edit", "scratchpad/claude/tools/diag.py"), ("MultiEdit", "packages/ui/src/a.tsx"),
                           ("Write", "scripts/release/x.MJS"), ("Write", "scratchpad/temp/run.ps1")):
            with self.subTest(tool=tool, path=path):
                self.assertIsNotNone(guard.hook(payload(path, tool), NOW, str(self.root))[0])

    def test_expired_or_too_long_marker_does_not_help(self):
        for kwargs in ({"until": "2026-11-12T10:45:00"}, {"until": "2026-11-12T11:30:00"}, {"reason": ""}):
            with self.subTest(kwargs=kwargs):
                self.marker(**kwargs)
                line, _ = guard.hook(payload("scratchpad/claude/root-runtime/w.py"), NOW, str(self.root))
                self.assertIsNotNone(line)
                self.assertIn("印は無効", line)

    def test_cli_prints_deny_json(self):
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input=json.dumps(payload("scratchpad/claude/root-runtime/w.py")).encode("utf-8"),
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        decision = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(decision["hookSpecificOutput"]["permissionDecision"], "deny")


class PassExamples(Base):
    def test_documents_and_markers_pass(self):
        for path in ("scratchpad/claude/instructions/cl-v103-x-1112.md", "docs/報告記録2.md", "rules/06-過去の失敗と対策.md",
                     "scratchpad/claude/root-runtime/workers-pause.json", "scratchpad/claude/agents/a/orchestrator-message.md",
                     "CLAUDE.md", "scratchpad/claude/root-runtime/forecast-hold.json"):
            with self.subTest(path=path):
                self.assertEqual(guard.hook(payload(path), NOW, str(self.root)), (None, []))

    def test_subagent_passes(self):
        self.assertEqual(guard.hook(payload("scratchpad/claude/agents/a/tool.py", transcript=SUB), NOW, str(self.root))[0], None)
        self.assertEqual(guard.hook(payload("scratchpad/claude/agents/a/tool.py", agent_id="a1"), NOW, str(self.root))[0], None)

    def test_unknown_caller_passes_with_warning(self):
        line, warnings = guard.hook(payload("x.py", transcript=""), NOW, str(self.root))
        self.assertIsNone(line)
        self.assertTrue(warnings)

    def test_valid_marker_passes_and_is_logged(self):
        self.marker()
        line, warnings = guard.hook(payload("scratchpad/claude/root-runtime/w.py"), NOW, str(self.root))
        self.assertIsNone(line)
        self.assertEqual(warnings, [])
        log = (self.root / guard.EXCEPTION_LOG).read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(log[-1])["category"], "W1")

    def test_other_tools_and_events_pass(self):
        self.assertEqual(guard.hook(dict(payload("a.py"), tool_name="Read"), NOW, str(self.root))[0], None)
        self.assertEqual(guard.hook(dict(payload("a.py"), hook_event_name="PostToolUse"), NOW, str(self.root))[0], None)


def tearDownModule():
    _remove_if_empty(_TEMP_CREATED)


if __name__ == "__main__":
    unittest.main(verbosity=2)
