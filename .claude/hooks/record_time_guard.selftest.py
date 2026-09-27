"""Subprocess tests for the timestamp hook's JSON protocol."""

import json
import importlib.util
import shutil
import subprocess
import sys
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path

# 2026-09-24 OPS-14 追記: check.ps1はこの自己試験を`<根>\scripts\..\.claude\hooks\...`の
# ように`..`を含む道のりで起動する(PowerShellのJoin-Pathは`..`を畳み込まない)。
# .resolve()を挟まないと__file__に`scripts\..`が文字どおり残り、フック本体
# (record_time_guard.py)側の解決済みROOT(`Path(__file__).resolve().parents[2]`)と
# 文字列が食い違ってrelative_to()が失敗する(ValueError)。フック本体と同じ解決方法にする。
HOOK = Path(__file__).resolve().with_name("record_time_guard.py")
ROOT = HOOK.parents[2]
REPORT = "docs/報告記録.md"
# 2026-09-24 OPS-14: 以前は他担当の実在フォルダー(cx-ops01b-registry)を前提にしていた。
# ここではPreToolUse側(pathの文字列だけで判定し、実ファイルは読まない)の検査にだけ
# このパスを使う。実ファイルの読み書きが要るtest_post_blockは、自分で作って消す
# 使い捨てフォルダーを別に用意する(下記参照)。
PROGRESS = "scratchpad/claude/agents/record-time-guard-selftest-fixture/progress.md"
spec = importlib.util.spec_from_file_location("record_time_guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def invoke(event="PreToolUse", tool="Write", path=REPORT, **entry):
    data = {"hook_event_name": event, "tool_name": tool,
            "tool_input": {"file_path": path, **entry}}
    return subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                          input=json.dumps(data), text=True, capture_output=True,
                          cwd=ROOT, check=False)


class RecordTimeGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.future = (datetime.now() + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M")
        cls.past = (datetime.now() - timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M")

    def deny(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def allow(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_write_future(self):
        self.deny(invoke(content=f"## {self.future}\n"))

    def test_write_past(self):
        self.allow(invoke(content=f"## {self.past}\n"))

    def test_iso_separator(self):
        self.deny(invoke(content=self.future.replace(" ", "T")))

    def test_edit_only_new_string(self):
        self.allow(invoke(tool="Edit", old_string=self.future, new_string=self.past))

    def test_edit_new_string(self):
        self.deny(invoke(tool="Edit", old_string=self.past, new_string=self.future))

    def test_multiedit(self):
        self.deny(invoke(tool="MultiEdit", edits=[{"new_string": self.past}, {"new_string": self.future}]))

    def test_forecast(self):
        self.allow(invoke(content=f"予定 {self.future}"))

    def test_date_only(self):
        self.allow(invoke(content=self.future[:10]))

    def test_other_file(self):
        self.allow(invoke(path="README.md", content=self.future))

    def test_progress_line_start(self):
        self.deny(invoke(path=PROGRESS, content=f"{self.future} 作業"))

    def test_progress_embedded(self):
        self.allow(invoke(path=PROGRESS, content=f"作業 {self.future}"))

    def test_registry_bare(self):
        self.deny(invoke(path="scratchpad/claude/agents/registry.md", content=f"| {self.future[11:]} |"))

    def test_previous_evening_bare_allowed(self):
        path = ROOT / "scratchpad/claude/agents/registry.md"
        self.assertEqual(guard.future_times(path, "| 22:13 |", datetime(2026, 9, 24, 4, 7)), [])

    def test_near_future_bare_denied(self):
        path = ROOT / "scratchpad/claude/agents/registry.md"
        self.assertEqual(guard.future_times(path, "| 04:10 |", datetime(2026, 9, 24, 4, 7)), [(1, "04:10")])

    def test_midnight_forward_bare_denied(self):
        path = ROOT / "scratchpad/claude/agents/registry.md"
        self.assertEqual(guard.future_times(path, "| 00:03 |", datetime(2026, 9, 24, 23, 58)), [(1, "00:03")])

    def test_midnight_previous_bare_allowed(self):
        path = ROOT / "scratchpad/claude/agents/registry.md"
        self.assertEqual(guard.future_times(path, "| 23:58 |", datetime(2026, 9, 25, 0, 3)), [])

    def test_queue_update_cue(self):
        self.deny(invoke(path="scratchpad/claude/plans/orchestrator-queue.md",
                         content=f"{self.future[11:]} 更新"))

    def test_instruction(self):
        self.deny(invoke(path="scratchpad/claude/instructions/test.md", content=self.future))

    def test_rules(self):
        self.deny(invoke(path="rules/06-過去の失敗と対策.md", content=self.future))

    def test_invalid_input_fail_open(self):
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input="{", text=True, capture_output=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("FAIL_OPEN", result.stderr)

    def test_post_block(self):
        # 2026-09-24 OPS-24(w35b): 以前はここでROOT配下の本物のscratchpad/claude/agents/へ
        # 使い捨てのprogress.md(先の時刻を含む)を実際に置いていた。その置いてある間に
        # 他の担当のBash/PowerShell呼出しが同じ本物のフォルダーをcandidates()で走査すると、
        # この自己試験のためだけの使い捨てファイルを拾って誤って止めてしまっていた
        # (他の担当への意図しない副作用)。kind()/candidates()/future_times()/reason()/
        # scan()/hook()にroot引数を足し(既定は本物のROOTのままで挙動は不変)、本物の
        # ROOTと重ならない一時の根(scratchpad/temp/配下。candidates()の対象パターン
        # である scratchpad/claude/agents 等とは別の木)を使って同じ検査(recent mtime +
        # 先の時刻の内容を持つ候補をPostToolUseがblockすること)を確かめる。これにより
        # 本物のagentsフォルダーには一切書き込まなくなった(OPS-14/OPS-12bの反対に、
        # 使い捨てフォルダー自体を本物の木の外に置くので、祖先フォルダーの後片付けも
        # 不要になる。一時の根ごとshutil.rmtreeで消せる)。
        temp_root = ROOT / "scratchpad/temp" / f"record-time-guard-selftest-root-{uuid.uuid4().hex[:8]}"
        # OPS-24追記: まっさらな写しではscratchpad/・scratchpad/temp/も新規作成されるため、
        # 後片付けでtemp_root自身のshutil.rmtreeに加え、新規作成した祖先だけを(深い方から)
        # rmdirし、写しの中にscratchpad/を残さない(rules/06 §10.344と同じ考え方)。
        created_ancestors = []
        node = temp_root
        while not node.exists():
            created_ancestors.append(node)
            node = node.parent
        folder = temp_root / "scratchpad/claude/agents/fixture"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "progress.md"
        try:
            path.write_bytes(f"{self.past} 準備\n{self.future} post test\n".encode("utf-8"))
            relative = str(path.relative_to(temp_root)).replace("\\", "/")
            payload = {"hook_event_name": "PostToolUse", "tool_name": "PowerShell", "tool_input": {}}
            output = guard.hook(payload, datetime.now(), root=temp_root)
            self.assertIsNotNone(output)
            self.assertEqual(output["decision"], "block")
            self.assertIn(relative, output["reason"])
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)
            for created in created_ancestors[1:]:  # [0]=temp_root自身は上のrmtreeで既に消えている
                try:
                    created.rmdir()
                except OSError:
                    pass

    def test_candidates_root_parameter_isolated_from_real_tree(self):
        # 2026-09-24 OPS-24(w35b): root引数を渡したcandidates()が、本物のROOT配下の
        # 実在ファイル(例 docs/報告記録.md)を一切含まず、一時の根だけを見ることを確認する
        # (test_post_blockが実際に隔離できていることの直接の裏付け)。
        temp_root = ROOT / "scratchpad/temp" / f"record-time-guard-selftest-root-{uuid.uuid4().hex[:8]}"
        created_ancestors = []
        node = temp_root
        while not node.exists():
            created_ancestors.append(node)
            node = node.parent
        temp_root.mkdir(parents=True, exist_ok=True)
        try:
            found = guard.candidates(root=temp_root)
            self.assertEqual(found, [])
            self.assertNotIn(ROOT / REPORT, found)
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)
            for created in created_ancestors[1:]:  # [0]=temp_root自身は上のrmtreeで既に消えている
                try:
                    created.rmdir()
                except OSError:
                    pass

    # --- 2026-09-24 統括の指示: ALLOWANCE を2分から0分にした(同じ分は許す) ---

    def test_same_minute_dated_allowed(self):
        now = datetime(2026, 9, 24, 8, 24, 45)
        stamp = now.strftime("%Y-%m-%d %H:%M")
        self.assertEqual(guard.future_times(ROOT / REPORT, f"## {stamp}\n", now), [])

    def test_one_minute_ahead_dated_denied(self):
        now = datetime(2026, 9, 24, 8, 24, 10)
        stamp = (now + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M")
        self.assertEqual(guard.future_times(ROOT / REPORT, f"## {stamp}\n", now), [(1, stamp)])

    def test_incident_ninety_seconds_ahead_now_denied(self):
        # rules/06 §10.320 再発の実例: 旧ALLOWANCE=2分では1.5分(90秒)先の時刻が許容内に
        # 収まり拒否されなかった。0分許容ではこの差でも拒否する(検査を強める変更)。
        now = datetime(2026, 9, 24, 8, 22, 0)
        stamp = (now + timedelta(seconds=90)).strftime("%Y-%m-%d %H:%M")
        self.assertEqual(guard.future_times(ROOT / REPORT, f"## {stamp}\n", now), [(1, stamp)])

    def test_one_minute_ahead_subprocess_denied_via_write(self):
        # 実際のフックの入出力契約(subprocess経由、datetime.now()を実際に使う)でも
        # 1分以上先の時刻を拒否することを確認する(10分先を使い分の境界の揺れを避ける)。
        self.deny(invoke(content=f"## {self.future}\n"))

    # --- 2026-09-24 統括の指示: MANIFEST.txt を検査対象に追加(PreToolUseと--scanの両方) ---

    MANIFEST = "scratchpad/claude/deliveries/w13b-selftest-delivery/MANIFEST.txt"

    def test_manifest_kind_recognized(self):
        self.assertEqual(guard.kind(ROOT / self.MANIFEST), "manifest")

    def test_manifest_sibling_file_not_recognized(self):
        sibling = "scratchpad/claude/deliveries/w13b-selftest-delivery/other.txt"
        self.assertIsNone(guard.kind(ROOT / sibling))

    def test_manifest_embedded_bare_time_denied(self):
        now = datetime(2026, 9, 24, 8, 24, 0)
        content = "# 着手前の控え（08:25:29 作成〔フォルダーの作成時刻〕、統括）。\n"
        self.assertEqual(guard.future_times(ROOT / self.MANIFEST, content, now), [(1, "08:25")])

    def test_manifest_past_time_allowed(self):
        now = datetime(2026, 9, 24, 8, 30, 0)
        content = "# 着手前の控え（08:25:29 作成）。\n"
        self.assertEqual(guard.future_times(ROOT / self.MANIFEST, content, now), [])

    def test_manifest_hash_lines_no_false_positive(self):
        now = datetime(2026, 9, 24, 8, 24, 0)
        line = ("packages/expression/src/math/mathTextSyntax.ts "
                "7380c66037fabede6aabed40e8ed85fb7cc639483fabc718a59d81e8c6023793\n")
        self.assertEqual(guard.future_times(ROOT / self.MANIFEST, line, now), [])

    def test_manifest_candidates_includes_created_file(self):
        # 2026-09-24 OPS-14: 以前は統括が作成済みの特定の配送(base-20260924-0825)の
        # MANIFEST.txtが一覧に含まれることを前提にしていたが、まっさらな取り出しや
        # そのフォルダーが後片付けされた環境では実在しない。この自己試験が自分で
        # 作って消すMANIFEST.txtに差し替える(--scanとPostToolUseの再走査が使う
        # candidates()の対象漏れが無いことの確認、という検査の中身は変えていない)。
        # 2026-09-24 OPS-12b: test_post_blockと同じ理由で、後片付けを(g)と同じ形
        # (試験の前に無かった祖先フォルダーだけを深い方から、空の場合だけ消す)にそろえる。
        folder = ROOT / "scratchpad/claude/deliveries" / f"record-time-guard-selftest-{uuid.uuid4().hex[:8]}"
        created_dirs = []
        node = folder
        while not node.exists():
            created_dirs.append(node)
            node = node.parent
        folder.mkdir(parents=True, exist_ok=True)
        manifest = folder / "MANIFEST.txt"
        manifest.write_text(
            "dummy.txt 0000000000000000000000000000000000000000000000000000000000000000\n",
            encoding="utf-8")
        try:
            found = {str(p.relative_to(ROOT)).replace("\\", "/") for p in guard.candidates()}
            self.assertIn(str(manifest.relative_to(ROOT)).replace("\\", "/"), found)
        finally:
            manifest.unlink(missing_ok=True)
            for created in created_dirs:  # 深い方から(collectした順=folderが先頭)
                try:
                    created.rmdir()
                except OSError:
                    pass

    def test_manifest_pretooluse_denied_via_write(self):
        stamp = self.future[11:]  # "HH:MM"部分だけを取り出しMANIFEST.txtの見出し書式を模す
        self.deny(invoke(path=self.MANIFEST, content=f"# 着手前の控え（{stamp}:00 作成）。\n"))

    # --- 2026-09-24 OPS-16: instruction種別の年月日無し時刻(文脈限定)を追加 ---
    # 今の時刻に依存しないよう、既存の直接呼出し系の自己試験と同じくnowを固定して試す。
    # 実在しないダミーの指示書パスでよい(future_times/kind共にファイルの実在を要らない。
    # 既存のtest_manifest_kind_recognized等と同じ考え方)。

    INSTRUCTION_DUMMY = "scratchpad/claude/instructions/record-time-guard-selftest-dummy.md"

    def test_instruction_header_line_one_minute_ahead_denied(self):
        # (a) 1行目(「# 指示書」で始まる行)に今の分より1分先の時刻 → 拒否
        now = datetime(2026, 9, 24, 10, 30, 0)
        content = "# 指示書 w00-selftest（覚書 10:31 開始）\n"
        self.assertEqual(guard.future_times(ROOT / self.INSTRUCTION_DUMMY, content, now), [(1, "10:31")])

    def test_instruction_header_line_same_minute_allowed(self):
        # (b) 同じ分 → 通る
        now = datetime(2026, 9, 24, 10, 30, 0)
        content = "# 指示書 w00-selftest（覚書 10:30 開始）\n"
        self.assertEqual(guard.future_times(ROOT / self.INSTRUCTION_DUMMY, content, now), [])

    def test_instruction_acquired_cue_one_minute_ahead_denied(self):
        # (c) 「統括が HH:MM に取得した」で1分先 → 拒否(見出し行以外=2行目で確認)
        now = datetime(2026, 9, 24, 10, 30, 0)
        content = "（本文）\n編集可（統括が 10:31 に取得した SHA-256）\n"
        self.assertEqual(guard.future_times(ROOT / self.INSTRUCTION_DUMMY, content, now), [(2, "10:31")])

    def test_instruction_state_paren_one_minute_ahead_denied(self):
        # (d) 「投入時の状態（HH:MM）」で1分先 → 拒否
        now = datetime(2026, 9, 24, 10, 30, 0)
        content = "（本文）\n投入時の状態（10:31）: HEAD abc\n"
        self.assertEqual(guard.future_times(ROOT / self.INSTRUCTION_DUMMY, content, now), [(2, "10:31")])

    def test_instruction_formula_examples_not_flagged(self):
        # (e) 本文の数式の例 12:05 と 1:30:00(見出しでも記入の文脈でもない行) → 通る
        now = datetime(2026, 9, 24, 10, 30, 0)
        content = "（本文）\n数式の例（比の 12:05・1:30:00）\n"
        self.assertEqual(guard.future_times(ROOT / self.INSTRUCTION_DUMMY, content, now), [])

    def test_instruction_absence_confirmation_cue_one_minute_ahead_denied(self):
        # (f) 「09:57 に不在を確認」の形で1分先 → 拒否
        now = datetime(2026, 9, 24, 9, 56, 0)
        content = "（本文）\n（09:57 に不在を確認）\n"
        self.assertEqual(guard.future_times(ROOT / self.INSTRUCTION_DUMMY, content, now), [(2, "09:57")])

    def test_instruction_edit_body_line_one_minute_ahead_denied(self):
        # (g) Editで既存の指示書の2行目以降に1分先の記入の時刻を足す → 拒否
        # 作業の記録のフォルダーに頼らず、この自己試験が自分で使い捨ての指示書ファイルを
        # 作って消す(test_post_block等と同じ考え方)。hook()を直接呼びnowを固定する。
        # 2026-09-24 OPS-16b: scratchpad/claude/instructions自体が無いまっさらな取り出し
        # (独立コピー)でも動くように、書く前にfolder.mkdir(parents=True, exist_ok=True)で
        # 作る。後片付けは自分で作ったファイルと、試験の前に無かった祖先フォルダーだけ
        # (深い方から、空の場合だけ)を消す。既にあったフォルダーは消さない。
        folder = ROOT / "scratchpad/claude/instructions"
        created_dirs = []
        node = folder
        while not node.exists():
            created_dirs.append(node)
            node = node.parent
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"record-time-guard-selftest-{uuid.uuid4().hex[:8]}.md"
        path.write_text("# 指示書 selftest（ダミー）\n本文の1行目。\n", encoding="utf-8")
        try:
            now = datetime(2026, 9, 24, 10, 30, 0)
            payload = {
                "hook_event_name": "PreToolUse",
                "tool_name": "Edit",
                "tool_input": {
                    "file_path": str(path),
                    "old_string": "本文の1行目。",
                    "new_string": "統括が 10:31 に取得した値。",
                },
            }
            output = guard.hook(payload, now)
            self.assertIsNotNone(output)
            self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")
        finally:
            path.unlink(missing_ok=True)
            for created in created_dirs:  # 深い方から(collectした順=folderが先頭)
                try:
                    created.rmdir()
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()
