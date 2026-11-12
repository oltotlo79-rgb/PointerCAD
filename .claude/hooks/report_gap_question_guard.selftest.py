"""report_gap_question_guard.py(rules/06 §10.493: 報告が空いたままの質問を止める)の自己試験。

作業の場所は scratchpad/temp/<名前>-<乱数> を作って終わりに消す(rules/06 §10.336)。本物の docs/報告記録2.md は読まない。
usage: python -B -X utf8 c2_report_gap_question.selftest.py
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


HOOK = Path(__file__).resolve().with_name("report_gap_question_guard.py")
REPO = HOOK.parents[2]
_TEMP_BASE = REPO / "scratchpad" / "temp"
_TEMP_CREATED = _created_ancestors(_TEMP_BASE)
spec = importlib.util.spec_from_file_location("report_gap_question_guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

MAIN = "C:/Users/x/.claude/projects/p/abc.jsonl"
SUB = "C:/Users/x/.claude/projects/p/abc/subagents/agent-a1b2c3.jsonl"


def payload(event="PreToolUse", transcript=MAIN, tool="AskUserQuestion", agent_id=None):
    data = {"hook_event_name": event, "tool_name": tool, "transcript_path": transcript, "tool_input": {"questions": []}}
    if agent_id:
        data["agent_id"] = agent_id
    return data


class Base(unittest.TestCase):
    def setUp(self):
        self.root = REPO / "scratchpad" / "temp" / f"cl-v103-failure-records-c2-{uuid.uuid4().hex[:8]}"
        (self.root / "docs").mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.root, True)

    def write_report(self, *stamps: str, filler: int = 0):
        body = "".join(f"## {stamp} JST 公開準備の進捗\n\n本文。\n\n" for stamp in stamps)
        (self.root / "docs/報告記録2.md").write_text("# 報告記録2\n\n" + body + ("x" * filler), encoding="utf-8")

    def run_hook(self, data, now):
        return guard.hook(data, now, self.root)


class StopExamples(Base):
    def test_question_15_minutes_after_the_last_report_is_denied(self):
        self.write_report("2026-11-12 12:56", "2026-11-12 12:38")
        kind, text, _ = self.run_hook(payload(), datetime(2026, 11, 12, 13, 11))
        self.assertEqual(kind, "deny")
        self.assertIn("12:56", text)
        self.assertIn("15 分たっている", text)

    def test_today_replay_53_minutes_is_denied(self):
        self.write_report("2026-11-12 12:56", "2026-11-12 12:38")
        kind, text, _ = self.run_hook(payload(), datetime(2026, 11, 12, 13, 49))
        self.assertEqual(kind, "deny")
        self.assertIn("53 分", text)

    def test_answer_after_more_than_20_minutes_gives_feedback(self):
        self.write_report("2026-11-12 12:56")
        kind, text, _ = self.run_hook(payload("PostToolUse"), datetime(2026, 11, 12, 13, 17))
        self.assertEqual(kind, "feedback")
        self.assertIn("最初に", text)

    def test_newest_heading_is_the_maximum_not_the_first(self):
        self.write_report("2026-11-12 12:00", "2026-11-12 12:20")
        kind, _text, _ = self.run_hook(payload(), datetime(2026, 11, 12, 12, 36))
        self.assertEqual(kind, "deny")

    def test_cli_prints_deny_json_and_post_exits_2(self):
        self.write_report("2026-11-12 12:56")
        data = payload()
        cli = self.root / ".claude" / "hooks"
        cli.mkdir(parents=True)
        copy = cli / "report_gap_question_guard.py"
        copy.write_bytes(HOOK.read_bytes())
        # 写しの ROOT は self.root。今の時計で判定するので、見出しは十分に古い(12:56 の昨日以前でも未来でなければよい)。
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(copy)], input=json.dumps(data).encode("utf-8"),
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        decision = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(decision["hookSpecificOutput"]["permissionDecision"], "deny")
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(copy)],
                                input=json.dumps(payload("PostToolUse")).encode("utf-8"), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("最初に", result.stderr.decode("utf-8"))


class PassExamples(Base):
    def test_recent_report_passes(self):
        self.write_report("2026-11-12 12:56")
        self.assertEqual(self.run_hook(payload(), datetime(2026, 11, 12, 13, 5))[0], "pass")

    def test_answer_within_20_minutes_passes(self):
        self.write_report("2026-11-12 12:56")
        self.assertEqual(self.run_hook(payload("PostToolUse"), datetime(2026, 11, 12, 13, 16))[0], "pass")

    def test_subagent_and_other_tools_pass(self):
        self.write_report("2026-11-12 10:00")
        now = datetime(2026, 11, 12, 13, 0)
        self.assertEqual(self.run_hook(payload(transcript=SUB), now)[0], "pass")
        self.assertEqual(self.run_hook(payload(agent_id="a1"), now)[0], "pass")
        self.assertEqual(self.run_hook(payload(tool="Bash"), now)[0], "pass")

    def test_unknown_caller_or_missing_report_pass_with_warning(self):
        kind, _text, warnings = self.run_hook(payload(), datetime(2026, 11, 12, 13, 0))
        self.assertEqual(kind, "pass")
        self.assertTrue(warnings)
        self.write_report("2026-11-12 10:00")
        kind, _text, warnings = self.run_hook(payload(transcript=""), datetime(2026, 11, 12, 13, 0))
        self.assertEqual(kind, "pass")
        self.assertTrue(warnings)

    def test_future_heading_is_ignored(self):
        self.write_report("2026-11-12 14:00", "2026-11-12 12:56")
        kind, _text, _ = self.run_hook(payload(), datetime(2026, 11, 12, 13, 5))
        self.assertEqual(kind, "pass")

    def test_only_the_head_is_read(self):
        # 見出しが先頭 256KiB より後ろにしか無い時は「見出しが無い」として通す(全文を読まない)。
        (self.root / "docs/報告記録2.md").write_text("x" * (300 * 1024) + "\n## 2026-11-12 10:00 JST t\n", encoding="utf-8")
        kind, _text, warnings = self.run_hook(payload(), datetime(2026, 11, 12, 13, 0))
        self.assertEqual(kind, "pass")
        self.assertIn("見出しが無い", warnings[0])


def tearDownModule():
    _remove_if_empty(_TEMP_CREATED)


if __name__ == "__main__":
    unittest.main(verbosity=2)
