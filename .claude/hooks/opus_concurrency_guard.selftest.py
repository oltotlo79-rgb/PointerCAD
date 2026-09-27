"""Subprocess tests against synthetic Claude subagent records."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

# 2026-09-24 OPS-14追記: check.ps1はこの自己試験を`<根>\scripts\..\.claude\hooks\...`の
# ように`..`を含む道のりで起動する(PowerShellのJoin-Pathは`..`を畳み込まない)。
# .resolve()を挟み、フック本体(opus_concurrency_guard.py)と同じ解決方法にする
# (このファイルはROOTをrelative_to()の比較には使っていないため実害は無かったが、
# record_time_guard.selftest.pyで実際に踏んだのと同じ書き方のため統一する)。
HOOK = Path(__file__).resolve().with_name("opus_concurrency_guard.py")
ROOT = HOOK.parents[2]
EXCEPTIONS = ROOT / "scratchpad/claude/state/opus-exceptions.jsonl"
# 2026-09-24 OPS-14: 以前はscratchpad/claude/agents/cx-ops01-guards(他担当の実在フォルダー)
# を前提にしており、まっさらな取り出しや同フォルダーが無い環境ではsetUpが
# FileNotFoundErrorで13件全滅していた。フック本体(opus_concurrency_guard.py)は
# transcript_pathの場所を自由に受け取り、実在のagentsフォルダーを要求しないため、
# この自己試験だけが使う作業場所をscratchpad/temp配下に自分で作り、終わりに消す。
WORK = ROOT / "scratchpad/temp" / f"opus-concurrency-guard-selftest-{uuid.uuid4().hex[:8]}"


class OpusGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 2026-09-24 追加指示: まっさらな写し(scratchpad/自体が無い環境)ではscratchpad/・
        # scratchpad/temp/もWORKと一緒に新規作成される。tearDownClassでWORK自身をrmtree
        # した後、この2つの祖先も新規作成した場合だけ(深い方から)rmdirし、写しの中に
        # scratchpad/を残さない(rules/06 §10.344、record_time_guard.selftest.py・
        # invisible_char_guard.selftest.pyの既存の同種の後片付けと同じ形)。
        cls._work_created_ancestors = []
        node = WORK
        while not node.exists():
            cls._work_created_ancestors.append(node)
            node = node.parent
        WORK.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(WORK, ignore_errors=True)
        for created in cls._work_created_ancestors[1:]:  # [0]=WORK自身は上のrmtreeで既に消えている
            try:
                created.rmdir()
            except OSError:
                pass

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=WORK)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.transcript = self.base / "session.jsonl"
        self.folder = self.base / "session/subagents"
        self.folder.mkdir(parents=True)

    def agent(self, agent_id, model="opus", stop=None, age_minutes=0):
        (self.folder / f"agent-{agent_id}.meta.json").write_text(
            json.dumps({"model": model, "description": f"task {agent_id}"}), encoding="utf-8")
        path = self.folder / f"agent-{agent_id}.jsonl"
        path.write_text(json.dumps({"type": "assistant", "message": {"stop_reason": stop}}) + "\n", encoding="utf-8")
        stamp = path.stat().st_mtime - age_minutes * 60
        os.utime(path, (stamp, stamp))

    def invoke(self, tool="Agent", **entry):
        data = {"hook_event_name": "PreToolUse", "tool_name": tool,
                "tool_input": entry, "transcript_path": str(self.transcript)}
        return subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                              input=json.dumps(data), text=True, capture_output=True, cwd=ROOT)

    def test_two_allow(self):
        self.agent("one"); self.agent("two")
        self.assertEqual(self.invoke(model="opus").stdout, "")

    def test_three_deny(self):
        for name in ("one", "two", "three"): self.agent(name)
        result = self.invoke(model="opus")
        self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("task one", result.stdout)

    def test_inherited_opus_deny(self):
        for name in ("one", "two", "three"): self.agent(name)
        self.assertIn('"deny"', self.invoke().stdout)

    def test_fork_deny(self):
        for name in ("one", "two", "three"): self.agent(name)
        self.assertIn('"deny"', self.invoke(model="sonnet", subagent_type="fork").stdout)

    def test_sonnet_allow(self):
        for name in ("one", "two", "three"): self.agent(name)
        self.assertEqual(self.invoke(model="sonnet").stdout, "")

    def test_completed_not_counted(self):
        self.agent("one"); self.agent("two"); self.agent("done", stop="end_turn")
        self.assertEqual(self.invoke(model="opus").stdout, "")

    def test_stale_not_counted(self):
        self.agent("one"); self.agent("two"); self.agent("old", age_minutes=46)
        self.assertEqual(self.invoke(model="opus").stdout, "")

    def test_sonnet_not_counted(self):
        self.agent("one"); self.agent("two"); self.agent("other", model="sonnet")
        self.assertEqual(self.invoke(model="opus").stdout, "")

    def test_restart_completed_deny(self):
        for name in ("one", "two", "three"): self.agent(name)
        self.agent("done", stop="end_turn")
        self.assertIn('"deny"', self.invoke(tool="SendMessage", to="done", message="再開").stdout)

    def test_running_message_allow(self):
        for name in ("one", "two", "three"): self.agent(name)
        self.assertEqual(self.invoke(tool="SendMessage", to="one", message="状況").stdout, "")

    def test_unknown_message_allow(self):
        for name in ("one", "two", "three"): self.agent(name)
        self.assertEqual(self.invoke(tool="SendMessage", to="unknown", message="状況").stdout, "")

    def test_exception_record(self):
        for name in ("one", "two", "three"): self.agent(name)
        original = EXCEPTIONS.read_bytes() if EXCEPTIONS.exists() else None
        # 2026-09-24 追加指示: EXCEPTIONSが元から無い(=このフック呼び出しがscratchpad/claude/
        # state/を新規作成しうる)ときだけ、後片付けのために祖先の新規作成有無を先に記録する
        # (WORKと同じ考え方)。元からあった場合は親フォルダーも元から在るので祖先の後片付けは
        # 不要(write_bytes(original)でファイルの中身だけ戻す)。
        created_ancestors: list[Path] = []
        if original is None:
            node = EXCEPTIONS.parent
            while not node.exists():
                created_ancestors.append(node)
                node = node.parent
        try:
            self.assertEqual(self.invoke(model="opus", prompt="【opus例外:保存の妨げの原因調査】").stdout, "")
            self.assertIn("保存の妨げ", EXCEPTIONS.read_text(encoding="utf-8"))
        finally:
            if original is None:
                EXCEPTIONS.unlink(missing_ok=True)
                for created in created_ancestors:  # 深い方から(collectした順=EXCEPTIONS.parentが先頭)
                    try:
                        created.rmdir()
                    except OSError:
                        pass
            else:
                EXCEPTIONS.write_bytes(original)

    def test_bad_json_fail_open(self):
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input="{", text=True, capture_output=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0)
        self.assertIn("FAIL_OPEN", result.stderr)


if __name__ == "__main__":
    unittest.main()
