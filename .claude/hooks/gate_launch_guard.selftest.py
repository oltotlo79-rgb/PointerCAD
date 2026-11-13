"""実フック gate_launch_guard.py の stdin・stdout・終了コードを、使い捨ての偽の根で検査する（rules/06 §10.463）。

フックを偽の根の .claude/hooks/ へ写して起動するので、フックの ROOT は偽の根になり、本物の窓・delivery・印に触れない。
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

HOOK = Path(__file__).resolve().with_name("gate_launch_guard.py")
ROOT = HOOK.parents[2]


class GateLaunchGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parent = ROOT / "scratchpad/temp"
        cls.created = []
        node = parent
        while not node.exists():
            cls.created.append(node)
            node = node.parent
        parent.mkdir(parents=True, exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="gate-launch-guard-", dir=parent)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()
        for directory in cls.created:
            directory.rmdir()

    def setUp(self):
        self.temp_case = tempfile.TemporaryDirectory(dir=self.temp.name)
        self.addCleanup(self.temp_case.cleanup)
        self.root = Path(self.temp_case.name)
        self.hook = self.root / ".claude/hooks/gate_launch_guard.py"
        self.hook.parent.mkdir(parents=True)
        shutil.copyfile(HOOK, self.hook)
        self.runtime = self.root / "scratchpad/claude/root-runtime"
        self.runtime.mkdir(parents=True)
        self.deliveries = self.root / "scratchpad/claude/deliveries"
        self.marker_path = self.runtime / "launch-during-gate.json"
        self.marker_log = self.root / "scratchpad/claude/state/launch-during-gate.jsonl"

    def window(self, started_minutes_ago=5, length_minutes=90, owner="gate"):
        start = datetime.now() - timedelta(minutes=started_minutes_ago)
        (self.runtime / "quiet-window.json").write_text(json.dumps({
            "schema": 1, "startedAt": start.isoformat(timespec="seconds"),
            "endsAt": (start + timedelta(minutes=length_minutes)).isoformat(timespec="seconds"),
            "minutes": length_minutes, "reason": "gate delivery (selftest)", "owner": owner,
        }, ensure_ascii=False), encoding="utf-8")
        return start + timedelta(minutes=length_minutes)

    def delivery(self, name, status, started_minutes_ago=3, child_minutes_ago=None, raw=None, preflight_done=True):
        directory = self.deliveries / name
        directory.mkdir(parents=True)
        if raw is not None:
            (directory / "state.json").write_text(raw, encoding="utf-8")
            return
        state = {"deliveryId": name, "status": status,
                 "startedAt": (datetime.now() - timedelta(minutes=started_minutes_ago)).astimezone().isoformat()}
        if child_minutes_ago is not None:
            state["childStartedAt"] = (datetime.now() - timedelta(minutes=child_minutes_ago)).timestamp()
        (directory / "state.json").write_text(json.dumps(state), encoding="utf-8")
        if preflight_done:
            # rules/06 §10.502: 既定は 2 回目の起動前検査(段 check-ps1)を通った後の gate(起動の直後は別の試験で確かめる)。
            (directory / "gate.log").write_text("[x] 段「check-ps1」の起動前確認: CPU=10%, []\n", encoding="utf-8")

    def marker(self, reason="利用者の指示で急ぎの調査", placed_minutes_ago=1):
        data = {"placedAt": (datetime.now() - timedelta(minutes=placed_minutes_ago)).isoformat(timespec="seconds")}
        if reason is not None:
            data["reason"] = reason
        self.marker_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def invoke(self, tool="Agent", event="PreToolUse"):
        payload = {"hook_event_name": event, "tool_name": tool,
                   "tool_input": {"description": "担当 selftest", "prompt": "作業"},
                   "transcript_path": str(self.root / "session.jsonl")}
        return subprocess.run([sys.executable, "-B", "-X", "utf8", str(self.hook)],
                              input=json.dumps(payload), text=True, encoding="utf-8", capture_output=True)

    def output(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def decision(self, result):
        return self.output(result).get("hookSpecificOutput", {}).get("permissionDecision")

    def test_selftest_stage_inside_gate_window_is_denied(self):
        end = self.window()
        self.delivery("20261107-090000", "checking-hook-selftests", started_minutes_ago=7)
        data = self.output(self.invoke())
        self.assertEqual(data["hookSpecificOutput"]["permissionDecision"], "deny")
        reason = data["hookSpecificOutput"]["permissionDecisionReason"]
        for expected in ("20261107-090000", "checking-hook-selftests", "gate の起動から 7 分",
                         f"静かな窓は {end:%H:%M} まで", "rules/06 §10.463", "launch-during-gate.json"):
            self.assertIn(expected, reason)

    def test_without_an_active_gate_window_launch_passes(self):
        self.delivery("20261107-090000", "checking-hook-selftests")
        self.assertEqual(self.invoke().stdout, "", "窓が無ければ通す")
        self.window(owner="measure")
        self.assertIsNone(self.decision(self.invoke()), "gate 以外の窓では止めない")
        self.window(started_minutes_ago=100, length_minutes=90)
        self.assertIsNone(self.decision(self.invoke()), "期限を過ぎた窓では止めない")
        self.window(started_minutes_ago=95, length_minutes=120)
        self.assertIsNone(self.decision(self.invoke()), "窓は開始から 90 分で終わる（quiet_window.py と同じ上限）")

    def test_finished_statuses_pass_inside_the_window(self):
        self.window()
        for index, status in enumerate(("failed", "pushed", "succeeded")):
            with self.subTest(status=status):
                shutil.rmtree(self.deliveries, ignore_errors=True)
                self.delivery(f"20261107-09000{index}", status)
                self.assertEqual(self.invoke().stdout, "")

    def test_marker_allows_one_launch_records_it_and_is_consumed(self):
        self.window()
        self.delivery("20261107-090000", "checking-hook-selftests")
        self.marker()
        data = self.output(self.invoke())
        self.assertNotIn("hookSpecificOutput", data)
        self.assertIn("利用者の指示で急ぎの調査", data["systemMessage"])
        self.assertFalse(self.marker_path.exists(), "印は 1 回の起動で消える")
        records = [json.loads(line) for line in self.marker_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0]["deliveryId"], records[0]["reason"], records[0]["description"]),
                         ("20261107-090000", "利用者の指示で急ぎの調査", "担当 selftest"))
        self.assertEqual(self.decision(self.invoke()), "deny", "印が消えた後の 2 回目は止める")

    def test_unreadable_state_json_warns_and_passes(self):
        self.window()
        self.delivery("20261107-090000", None, raw="{")
        result = self.invoke()
        data = self.output(result)
        self.assertNotIn("hookSpecificOutput", data)
        self.assertIn("deliveries/20261107-090000/state.json", data["systemMessage"])
        self.assertIn("state.json", result.stderr)

    def test_full_check_running_is_denied_for_the_whole_window_not_only_40_minutes(self):
        # 追補 6: 以前は check.ps1 の起動から 40 分で通したが、今は窓の期限まで止める。
        self.window(started_minutes_ago=60, length_minutes=90)
        self.delivery("20261107-090000", "full-check-running", started_minutes_ago=55, child_minutes_ago=41)
        data = self.output(self.invoke())
        self.assertEqual(data["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("full-check-running", data["hookSpecificOutput"]["permissionDecisionReason"])
        self.window(started_minutes_ago=91, length_minutes=90)
        self.assertEqual(self.invoke().stdout, "", "窓が終われば通す")

    def test_waiting_for_quiet_cpu_is_denied(self):
        self.window()
        for index, status in enumerate(("waiting-for-quiet-cpu", "waiting-for-external-load", "starting")):
            with self.subTest(status=status):
                shutil.rmtree(self.deliveries, ignore_errors=True)
                self.delivery(f"20261107-09100{index}", status)
                data = self.output(self.invoke())
                self.assertEqual(data["hookSpecificOutput"]["permissionDecision"], "deny")
                self.assertIn(status, data["hookSpecificOutput"]["permissionDecisionReason"])

    def test_pushed_passes(self):
        self.window()
        self.delivery("20261107-092000", "pushed", started_minutes_ago=80)
        self.assertEqual(self.invoke().stdout, "")

    def test_passed_and_the_other_finished_statuses_pass(self):
        # 統括の判断(11:58): committed-no-push・passed・scheduler-start-failed も gate が終わった状態として通す。
        self.window()
        for index, status in enumerate(("passed", "committed-no-push", "scheduler-start-failed")):
            with self.subTest(status=status):
                shutil.rmtree(self.deliveries, ignore_errors=True)
                self.delivery(f"20261107-09300{index}", status)
                self.assertEqual(self.invoke().stdout, "")

    def test_latest_delivery_is_chosen_by_started_at_not_by_name(self):
        self.window(started_minutes_ago=30)
        self.delivery("b-older", "checking-hook-selftests", started_minutes_ago=25)
        self.delivery("a-newer", "failed", started_minutes_ago=2)
        self.assertEqual(self.invoke().stdout, "")
        shutil.rmtree(self.deliveries)
        self.delivery("b-older", "failed", started_minutes_ago=25)
        self.delivery("a-newer", "checking-hook-selftests", started_minutes_ago=2)
        self.assertEqual(self.decision(self.invoke()), "deny")

    def test_stale_or_broken_marker_does_not_allow(self):
        self.window(started_minutes_ago=5)
        self.delivery("20261107-090000", "checking-hook-selftests")
        self.marker(placed_minutes_ago=30)
        data = self.output(self.invoke())
        self.assertEqual(data["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("前の gate の印は使わない", data["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertTrue(self.marker_path.exists(), "使わなかった印は消さない")
        self.marker(reason=None)
        data = self.output(self.invoke())
        self.assertIn("reason が空です", data["hookSpecificOutput"]["permissionDecisionReason"])
        self.assertFalse(self.marker_log.exists())

    def test_other_tools_and_events_are_not_checked(self):
        self.window()
        self.delivery("20261107-090000", "checking-hook-selftests")
        self.assertEqual(self.invoke(tool="SendMessage").stdout, "")
        self.assertEqual(self.invoke(event="PostToolUse").stdout, "")

    def test_broken_window_warns_and_passes(self):
        (self.runtime / "quiet-window.json").write_text("{", encoding="utf-8")
        self.delivery("20261107-090000", "checking-hook-selftests")
        data = self.output(self.invoke())
        self.assertNotIn("hookSpecificOutput", data)
        self.assertIn("quiet-window.json", data["systemMessage"])

    def test_unreadable_payload_fails_open(self):
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(self.hook)],
                                input="{", text=True, encoding="utf-8", capture_output=True)
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)


    # --- rules/06 §10.502(候補 C11): 2 回目の起動前検査(段 check-ps1)の前は、印があっても止める ---

    def test_before_the_second_preflight_the_marker_is_not_used(self):
        self.window()
        self.delivery("20261113-040757", "waiting-for-quiet-cpu", started_minutes_ago=2, preflight_done=False)
        self.marker()
        data = self.output(self.invoke())
        self.assertEqual(data["hookSpecificOutput"]["permissionDecision"], "deny")
        reason = data["hookSpecificOutput"]["permissionDecisionReason"]
        for expected in ("20261113-040757", "waiting-for-quiet-cpu", "段 check-ps1", "rules/06 §10.502"):
            self.assertIn(expected, reason)
        self.assertTrue(self.marker_path.exists(), "起動の直後に使わなかった印は残す")
        self.assertFalse(self.marker_log.exists())

    def test_after_the_second_preflight_the_marker_is_used_as_before(self):
        self.window()
        self.delivery("20261113-042001", "full-check-running", started_minutes_ago=10)
        self.marker()
        data = self.output(self.invoke())
        self.assertNotIn("hookSpecificOutput", data)
        self.assertFalse(self.marker_path.exists())

if __name__ == "__main__":
    unittest.main()
