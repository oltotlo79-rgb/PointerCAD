"""候補と PreToolUse の登録案を入れた写しで実行する Python 自己試験。"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path


HOOK = Path(__file__).resolve().with_name("orchestrator_desktop_guard.py")
ROOT = HOOK.parents[2]
PREFIX = "mcp__computer-use__"
TRANSCRIPT = r"C:\test\.claude\projects\PointerCAD\test-session.jsonl"
MARKER_PATH = "scratchpad/claude/root-runtime/orchestrator-desktop-capture-allowed.json"
DELEGATE = "参考の CAD などのアプリの操作と調査は担当へ指示書で出す（利用者 2026-11-18）"
OPERATIONS = (
    "left_click", "right_click", "double_click", "type_text", "drag", "left_click_drag",
    "key", "press_key", "scroll", "computer_batch", "open_application", "switch_display",
    "move_mouse", "future_tool", "request_access_extra",
)


def payload(tool="left_click", **fields):
    data = {"hook_event_name": "PreToolUse", "tool_name": PREFIX + tool, "tool_input": {},
            "transcript_path": TRANSCRIPT}
    return {**data, **fields}


class DesktopGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp_parent = ROOT / "scratchpad/temp"
        temp_parent.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(prefix="desktop-guard-", dir=temp_parent)
        cls.addClassCleanup(temp.cleanup)
        cls.root = Path(temp.name)
        hook_dir = cls.root / ".claude/hooks"
        hook_dir.mkdir(parents=True)
        cls.hook = hook_dir / HOOK.name
        shutil.copyfile(HOOK, cls.hook)
        scope = "orchestrator_scope_guard.py"
        shutil.copyfile(HOOK.with_name(scope), hook_dir / scope)
        cls.marker = cls.root / MARKER_PATH
        cls.marker.parent.mkdir(parents=True)

    def setUp(self):
        self.marker.unlink(missing_ok=True)

    def invoke(self, data=None, *, raw=None, flag=False, command=None):
        if raw is None:
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        if command is None:
            command = [sys.executable, "-B", "-X", "utf8", str(self.hook)]
            if flag:
                command.append("--allow-unmarked-captures")
        return subprocess.run(command, input=raw, capture_output=True, cwd=self.root, timeout=5)

    def assert_allowed(self, result):
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))

    def assert_denied(self, result, text=DELEGATE):
        self.assertEqual(result.returncode, 2, result.stderr.decode("utf-8"))
        self.assertEqual(result.stdout, b"")
        output = result.stderr.decode("utf-8").strip()
        self.assertEqual(len(output.splitlines()), 1)
        self.assertIn(DELEGATE, output)
        self.assertIn(text, output)

    def assert_fail_open(self, result):
        self.assertEqual((result.returncode, result.stdout), (0, b""))
        self.assertIn(b"POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def mark(self, **overrides):
        now = datetime.now(timezone.utc)
        body = {"reason": "担当の計測結果の受入", "transcript_path": TRANSCRIPT,
                "placedAt": (now - timedelta(seconds=5)).isoformat(),
                "until": (now + timedelta(minutes=1)).isoformat()}
        self.marker.write_text(json.dumps({**body, **overrides}), encoding="utf-8")

    def test_main_operations_and_future_tools_are_denied(self):
        for tool in OPERATIONS:
            with self.subTest(tool=tool):
                self.assert_denied(self.invoke(payload(tool)), PREFIX + tool)

    def test_agent_id_with_main_transcript_passes(self):
        self.assert_allowed(self.invoke(payload(agent_id="a1b2c3d4")))

    def test_agent_id_without_transcript_passes(self):
        self.assert_allowed(self.invoke(payload(transcript_path=None, agent_id="a1b2c3d4")))

    def test_subagent_transcript_passes_with_either_separator(self):
        for separator in ("/", chr(92)):
            with self.subTest(separator=separator):
                transcript = separator.join(["test-session", "subagents", "agent-a1b2c3d4.jsonl"])
                self.assert_allowed(self.invoke(payload(transcript_path=transcript)))

    def test_subagent_capture_passes_and_leaves_marker_for_main(self):
        self.mark()
        self.assert_allowed(self.invoke(payload("screenshot", agent_id="a1b2c3d4")))
        self.assertTrue(self.marker.is_file())

    def test_main_permission_tools_pass_and_do_not_consume_marker(self):
        self.mark()
        for tool in ("request_access", "list_granted_applications"):
            with self.subTest(tool=tool):
                self.assert_allowed(self.invoke(payload(tool)))
        self.assertTrue(self.marker.is_file())

    def test_tool_input_cannot_supply_a_caller_or_bypass_for_batch(self):
        self.mark()
        data = payload("computer_batch", tool_input={"agent_id": "a1", "actions": [{"action": "screenshot"}]})
        self.assert_denied(self.invoke(data), "computer_batch")
        self.assertTrue(self.marker.is_file())

    def test_operations_remain_denied_with_marker_and_open_capture_option(self):
        self.mark()
        self.assert_denied(self.invoke(payload("left_click"), flag=True))
        self.assertTrue(self.marker.is_file())

    def test_each_capture_is_denied_without_marker(self):
        for tool in ("screenshot", "zoom"):
            with self.subTest(tool=tool):
                self.assert_denied(self.invoke(payload(tool)), "受入の印が無いか消費済み")

    def test_each_capture_consumes_valid_marker(self):
        for tool in ("screenshot", "zoom"):
            with self.subTest(tool=tool):
                self.mark()
                self.assert_allowed(self.invoke(payload(tool)))
                self.assertFalse(self.marker.exists())
                used = json.loads(self.marker.with_suffix(".used.json").read_text(encoding="utf-8"))
                self.assertEqual(used["reason"], "担当の計測結果の受入")

    def test_capture_budget_is_shared(self):
        self.mark()
        self.assert_allowed(self.invoke(payload("screenshot")))
        self.assert_denied(self.invoke(payload("zoom")), "受入の印が無いか消費済み")

    def test_concurrent_capture_calls_share_one_marker(self):
        with ThreadPoolExecutor(max_workers=2) as threads:
            for attempt in range(8):
                with self.subTest(attempt=attempt):
                    self.mark()
                    results = list(threads.map(self.invoke, (payload("screenshot"), payload("zoom"))))
                    self.assertEqual(sorted(result.returncode for result in results), [0, 2],
                                     [result.stderr.decode("utf-8") for result in results])
                    winner, denied = sorted(results, key=lambda result: result.returncode)
                    self.assert_allowed(winner)
                    self.assert_denied(denied)
                    self.assertFalse(self.marker.exists())

    def test_existing_claim_prevents_consumption(self):
        self.mark()
        lock = self.marker.with_suffix(".lock")
        lock.mkdir()
        self.addCleanup(lambda: lock.rmdir() if lock.exists() else None)
        self.assert_denied(self.invoke(payload("zoom")), "別の呼出しが受入の印を処理中")
        self.assertTrue(self.marker.is_file())
        lock.rmdir()
        self.assert_allowed(self.invoke(payload("zoom")))

    def test_capture_option_can_allow_both_without_marker(self):
        for tool in ("screenshot", "zoom", "screenshot"):
            self.assert_allowed(self.invoke(payload(tool), flag=True))

    def test_expired_marker_is_rejected(self):
        self.mark(until=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat())
        self.assert_denied(self.invoke(payload("screenshot")), "時刻が無効")

    def test_future_marker_is_rejected(self):
        self.mark(placedAt=(datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat())
        self.assert_denied(self.invoke(payload("zoom")), "時刻が無効")

    def test_marker_longer_than_five_minutes_is_rejected(self):
        self.mark(until=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat())
        self.assert_denied(self.invoke(payload("zoom")), "時刻が無効")

    def test_marker_without_utc_offset_is_rejected(self):
        self.mark(placedAt=datetime.now().isoformat())
        self.assert_denied(self.invoke(payload("screenshot")), "受入の印を読めない")

    def test_marker_without_reason_is_rejected(self):
        self.mark(reason=" \t")
        self.assert_denied(self.invoke(payload("screenshot")), "受入の印に理由を書く")

    def test_other_session_cannot_consume_marker(self):
        self.mark()
        self.assert_denied(self.invoke(payload("zoom", transcript_path="other.jsonl")), "一致しない")
        self.assertTrue(self.marker.is_file())

    def test_malformed_marker_is_rejected(self):
        for raw in (b"{", bytes([255]), b"[]"):
            with self.subTest(raw=raw):
                self.marker.write_bytes(raw)
                self.assert_denied(self.invoke(payload("screenshot")))

    def test_unreadable_marker_is_rejected(self):
        self.marker.mkdir()
        self.addCleanup(self.marker.rmdir)
        self.assert_denied(self.invoke(payload("screenshot")), "受入の印を読めない")

    def test_malformed_stdin_fails_open(self):
        for raw in (b"{", bytes([255]), b"[]", b""):
            with self.subTest(raw=raw):
                self.assert_fail_open(self.invoke(raw=raw))

    def test_utf8_bom_payload_is_supported(self):
        self.assert_denied(self.invoke(raw=json.dumps(payload()).encode("utf-8-sig")))

    def test_malformed_envelope_fails_open(self):
        self.assert_fail_open(self.invoke(payload(tool_input=None)))
        self.assert_fail_open(self.invoke(payload(tool_name=[])))

    def test_unknown_caller_fails_open(self):
        for transcript in (None, "", "subagents/unrecognized.jsonl", "file.txt"):
            with self.subTest(transcript=transcript):
                self.assert_fail_open(self.invoke(payload(transcript_path=transcript)))

    def test_unrelated_tool_and_event_pass(self):
        self.assert_allowed(self.invoke(payload(tool_name="Read")))
        self.assert_allowed(self.invoke(payload(hook_event_name="PostToolUse")))

    def test_registration_matches_namespace_and_runs_guard(self):
        settings = json.loads((ROOT / ".claude/settings.json").read_text(encoding="utf-8-sig"))
        target = "${CLAUDE_PROJECT_DIR}/.claude/hooks/" + HOOK.name
        matches = [(entry["matcher"], command) for entry in settings["hooks"]["PreToolUse"]
                   for command in entry["hooks"] if target in command.get("args", [])]
        self.assertEqual(len(matches), 1)
        pattern, config = matches[0]
        captures = ("request_access", "list_granted_applications", "screenshot", "zoom")
        self.assertTrue(all(re.search(pattern, PREFIX + name) for name in (*OPERATIONS, *captures)))
        self.assertFalse(any(re.search(pattern, name) for name in
                             ("Bash", "Agent", "mcp__other__screenshot", "x" + PREFIX + "left_click")))
        self.assertEqual((config["type"], config["command"], config["timeout"]), ("command", "python", 5))
        args = [arg.replace("${CLAUDE_PROJECT_DIR}", str(self.root)) for arg in config["args"]]
        command = [sys.executable, *args]
        self.assert_denied(self.invoke(payload(), command=command))
        self.assert_allowed(self.invoke(payload(agent_id="a1b2c3d4"), command=command))
        self.assert_allowed(self.invoke(payload("request_access"), command=command))
        if "--allow-unmarked-captures" in args:
            self.assert_allowed(self.invoke(payload("screenshot"), command=command))
        else:
            self.assert_denied(self.invoke(payload("screenshot"), command=command))


if __name__ == "__main__":
    unittest.main()
