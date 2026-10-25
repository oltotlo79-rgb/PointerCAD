"""Direct-call and subprocess tests for the instruction-launch guard.

一時フォルダーに「根」の形(scratchpad/claude/instructions/等)を作って試す。作業の記録の
フォルダー(scratchpad/claude/agents/<担当名>/等)には一切頼らない。時刻はテストごとに固定の
datetimeを渡す(hook()/future_time_findings()はnowを引数で受け取る設計なので、壁時計に
依存せずに検査できる)。CLIの`--check`だけは実ROOTを使う実装のため、対象ファイルは
scratchpad/temp配下に自分で作って自分で消す使い捨てにする(作業の記録には頼らない)。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import time
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path

# 2026-09-24 OPS-14と同じ理由: check.ps1はこの自己試験を`<根>\scripts\..\.claude\hooks\...`の
# ように`..`を含む道のりで起動する(PowerShellのJoin-Pathは`..`を畳み込まない)。.resolve()を
# 挟み、フック本体(instruction_check_guard.py)と同じ解決方法にする。
HOOK = Path(__file__).resolve().with_name("instruction_check_guard.py")
ROOT = HOOK.parents[2]

spec = importlib.util.spec_from_file_location("instruction_check_guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def _missing_ancestors(path: Path) -> list[Path]:
    """pathから根へ向かって、まだ存在しない祖先を深い方から集める(pathが先頭)。
    事実3(OPS-16b)と同種の後片付け漏れ(scratchpadの無いまっさらな写しでscratchpad/・
    scratchpad/temp/が空のまま残る)をこのファイルの使い捨てフォルダー生成箇所でも防ぐ
    (OPS-12b)。"""
    created: list[Path] = []
    node = path
    while not node.exists():
        created.append(node)
        node = node.parent
    return created


def cleanup_root(base: Path, created_dirs: list[Path]) -> None:
    """baseを丸ごと消し、試験の前に無かった祖先(created_dirs、深い方から)を空の場合だけ
    消す。"""
    shutil.rmtree(base, ignore_errors=True)
    for created in created_dirs:
        try:
            created.rmdir()
        except OSError:
            pass


def make_root() -> tuple[Path, list[Path]]:
    """scratchpad/temp配下に使い捨ての「根」の形(scratchpad/claude/instructions/だけを
    持つ最小限のディレクトリ)を作る。戻り値は(根, 試験の前に無かった祖先の一覧)。
    呼び出し側がtearDown/addCleanupでcleanup_root(根, 祖先の一覧)する。"""
    base = ROOT / "scratchpad/temp" / f"instruction-check-guard-selftest-{uuid.uuid4().hex[:8]}"
    created_dirs = _missing_ancestors(base)
    (base / "scratchpad/claude/instructions").mkdir(parents=True)
    return base, created_dirs


def write_instruction(root: Path, name: str, content: str) -> Path:
    path = root / "scratchpad/claude/instructions" / name
    path.write_text(content, encoding="utf-8")
    return path


def hash16(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


class HookLogicTests(unittest.TestCase):
    """guard.hook()を一時的な「根」を渡して直接呼ぶ。nowは固定値(2026-09-24 10:30)。"""

    def setUp(self):
        self.root, created_dirs = make_root()
        self.addCleanup(cleanup_root, self.root, created_dirs)
        self.now = datetime(2026, 9, 24, 10, 30, 0)

    def prompt_for(self, *names: str) -> str:
        return "".join(f"指示書 `scratchpad/claude/instructions/{n}` を読む。" for n in names)

    def invoke(self, *names: str, now: datetime | None = None):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                   "tool_input": {"prompt": self.prompt_for(*names), "description": "t"}}
        return guard.hook(payload, now or self.now, root=self.root)

    def deny_reason(self, result) -> str:
        self.assertIsNotNone(result)
        return result["hookSpecificOutput"]["permissionDecisionReason"]

    # --- (a) 新規 ---

    def test_new_existing_path_denied(self):
        (self.root / "already.txt").write_text("x", encoding="utf-8")
        write_instruction(self.root, "a.md", "本文\n新規 `already.txt`（10:00 に不在を確認）\n")
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("`already.txt` が既に存在する", reason)

    def test_new_absent_path_allowed(self):
        write_instruction(self.root, "a.md", "本文\n新規 `not-yet.txt`（10:00 に不在を確認）\n")
        self.assertIsNone(self.invoke("a.md"))

    def test_new_chain_only_existing_one_flagged(self):
        (self.root / "second.txt").write_text("x", encoding="utf-8")
        write_instruction(
            self.root, "a.md", "本文\n新規 `first.txt`・`second.txt`（10:00 に不在を確認）\n")
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("`second.txt` が既に存在する", reason)
        self.assertNotIn("`first.txt` が既に存在する", reason)

    def test_new_repeated_keyword_chain_both_checked(self):
        (self.root / "cardA.py").write_text("x", encoding="utf-8")
        write_instruction(
            self.root, "a.md", "本文\n新規 `cardA.py`・新規 `cardB.py`（不在を確認）\n")
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("`cardA.py` が既に存在する", reason)
        self.assertNotIn("`cardB.py` が既に存在する", reason)

    def test_new_with_description_no_immediate_path_ignored(self):
        write_instruction(
            self.root, "a.md",
            "本文\n新規の検査ファイル(名前は progress に書く)と `scratchpad/` 以下だけ。\n")
        # 「新規の」の直後にバッククォートが来ないので対象外。`scratchpad/`自体は根に実在するが
        # 「新規」に紐づかないので拒否されない。
        self.assertIsNone(self.invoke("a.md"))

    def test_new_numeric_count_not_treated_as_path(self):
        write_instruction(self.root, "a.md", "本文\n新規12件以上成功。既存の検査は全件成功。\n")
        self.assertIsNone(self.invoke("a.md"))

    # --- (b) SHA-256 先頭16桁 ---

    def test_sha_match_allowed(self):
        target = self.root / "packages/foo.ts"
        target.parent.mkdir(parents=True)
        target.write_text("content", encoding="utf-8")
        digest = hash16(target.read_bytes())
        write_instruction(self.root, "a.md", f"本文\n`packages/foo.ts`（{digest}）\n")
        self.assertIsNone(self.invoke("a.md"))

    def test_sha_mismatch_denied(self):
        target = self.root / "packages/foo.ts"
        target.parent.mkdir(parents=True)
        target.write_text("content", encoding="utf-8")
        write_instruction(self.root, "a.md", "本文\n`packages/foo.ts`（0000000000000000）\n")
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("packages/foo.ts", reason)
        self.assertIn("不一致", reason)

    def test_sha_missing_file_denied(self):
        write_instruction(self.root, "a.md", "本文\n`packages/missing.ts`（0000000000000000）\n")
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("不在", reason)

    def test_sha_bare_filename_supplemented_mismatch_denied(self):
        folder = self.root / "packages/ui/src/math"
        folder.mkdir(parents=True)
        (folder / "a.ts").write_bytes(b"aaa")
        (folder / "b.ts").write_bytes(b"bbb")
        digest_a = hash16((folder / "a.ts").read_bytes())
        write_instruction(
            self.root, "x.md",
            f"本文\n`packages/ui/src/math/a.ts`（{digest_a}）・`b.ts`（0000000000000000）\n")
        reason = self.deny_reason(self.invoke("x.md"))
        self.assertIn("packages/ui/src/math/b.ts", reason)

    def test_sha_bare_filename_supplemented_match_allowed(self):
        folder = self.root / "packages/ui/src/math"
        folder.mkdir(parents=True)
        (folder / "a.ts").write_bytes(b"aaa")
        (folder / "b.ts").write_bytes(b"bbb")
        digest_a = hash16((folder / "a.ts").read_bytes())
        digest_b = hash16((folder / "b.ts").read_bytes())
        write_instruction(
            self.root, "x.md",
            f"本文\n`packages/ui/src/math/a.ts`（{digest_a}）・`b.ts`（{digest_b}）\n")
        self.assertIsNone(self.invoke("x.md"))

    def test_sha_bare_filename_unsupplementable_skipped(self):
        # 直前に完全なパス(スラッシュ入り)が無い裸のファイル名は補えないので検査しない。
        write_instruction(self.root, "x.md", "本文\n`unresolved.ts`（0000000000000000）\n")
        self.assertIsNone(self.invoke("x.md"))

    def test_head_commit_hash_not_treated_as_sha_claim(self):
        # 40桁のHEADハッシュはバッククォート直後が「。」で「（」ではないので対象外
        # (16桁の部分一致にもならない: HEX16は前後が16進文字だと不一致にする)。
        write_instruction(
            self.root, "a.md",
            "投入時の状態（09:00）: HEAD `170286e9d5b2d943ceb354f420c95ac2f12d29c1`。\n")
        self.assertIsNone(self.invoke("a.md"))

    def test_forty_hex_token_with_paren_not_treated_as_bare_filename(self):
        # 事実2(a)の再現: 同じ行に完全なパス(last_dirを設定)があった上で、40桁の16進の
        # blob IDを`...`で囲み、直後の全角括弧に16桁のSHAを書いた行。40桁の16進はドットを
        # 持たないのでBARE_NAME_EXTENSIONに一致せず、裸のファイル名として補完されない
        # (以前は last_dir で補って「不在」の外れになっていた)。
        target = self.root / "packages/foo.ts"
        target.parent.mkdir(parents=True)
        target.write_text("content", encoding="utf-8")
        digest = hash16(target.read_bytes())
        write_instruction(
            self.root, "a.md",
            f"本文\n`packages/foo.ts`（{digest}）と同じ blob の ID "
            "`170286e9d5b2d943ceb354f420c95ac2f12d29c1`（abcdefabcdefabcd）\n")
        self.assertIsNone(self.invoke("a.md"))

    def test_bare_name_matches_root_file_first(self):
        # 事実2(b)の再現: e2e/tests/mathInputFlow.ts の後に、同じ行で根の eslint.config.js を
        # 裸の名前で書いた行。根に同名ファイルがあるので根で確定し、直前のパスのフォルダー
        # (e2e/tests/eslint.config.js、実在しない)で誤って補わない。
        (self.root / "eslint.config.js").write_text("export default [];\n", encoding="utf-8")
        root_digest = hash16((self.root / "eslint.config.js").read_bytes())
        flow_dir = self.root / "e2e/tests"
        flow_dir.mkdir(parents=True)
        (flow_dir / "mathInputFlow.ts").write_bytes(b"flow")
        flow_digest = hash16((flow_dir / "mathInputFlow.ts").read_bytes())
        write_instruction(
            self.root, "a.md",
            f"本文\n`e2e/tests/mathInputFlow.ts`（{flow_digest}）の後に、同じ行で根の "
            f"`eslint.config.js`（{root_digest}）を確認\n")
        self.assertIsNone(self.invoke("a.md"))

    def test_root_relative_dot_slash_path_matches_root(self):
        # 事実2: `./eslint.config.js` と書いても(スラッシュを含むので has_slash=True)、
        # 先頭の`./`を剥がして根からの相対として解決し、一致すれば外れにならない
        # (以前は`_safe_relative`が"."を拒み常に「不在」になっていた)。
        (self.root / "eslint.config.js").write_text("export default [];\n", encoding="utf-8")
        digest = hash16((self.root / "eslint.config.js").read_bytes())
        write_instruction(self.root, "a.md", f"本文\n`./eslint.config.js`（{digest}）\n")
        self.assertIsNone(self.invoke("a.md"))

    def test_root_relative_dot_slash_path_mismatch_denied(self):
        # 上の裏取り: `./`で根に解決した上で、実際に不一致は不一致として検出される
        # (単に検査を素通りさせているだけではないことの確認)。
        (self.root / "eslint.config.js").write_text("export default [];\n", encoding="utf-8")
        write_instruction(self.root, "a.md", "本文\n`./eslint.config.js`（0000000000000000）\n")
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("eslint.config.js", reason)
        self.assertIn("不一致", reason)

    def test_placeholder_angle_bracket_text_not_flagged(self):
        # w22b-ops12-instruction-check.md自身の説明文にある「`<パス>`（...」という
        # プレースホルダーの書き方(架空のパス名、括弧の中に実在の16進が無い)で
        # クラッシュせず、外れにもならないことを確かめる。
        content = (
            "説明: `` `<パス>`（<16桁の16進>`` や `` `<パス>`（SHA-256 先頭16桁 <16桁>`` の"
            "形で書いたパスが一致しなければ外れ（理由の例。ここでは実在しない）。\n"
        )
        write_instruction(self.root, "a.md", content)
        self.assertIsNone(self.invoke("a.md"))

    # --- (c) 先の時刻 ---

    def test_header_line_future_denied(self):
        content = "# 指示書 t（統括が 10:31 に SHA-256 を測って作成）\n本文\n"
        write_instruction(self.root, "a.md", content)
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("10:31", reason)

    def test_header_line_same_minute_allowed(self):
        content = "# 指示書 t（統括が 10:30 に SHA-256 を測って作成）\n本文\n"
        write_instruction(self.root, "a.md", content)
        self.assertIsNone(self.invoke("a.md"))

    def test_state_paren_future_denied(self):
        content = "見出し\n投入時の状態（10:45）: HEAD abc\n"
        write_instruction(self.root, "a.md", content)
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("10:45", reason)

    def test_supervisor_ni_future_denied(self):
        content = "見出し\n編集可（統括が 10:50 に取得した SHA-256）\n"
        write_instruction(self.root, "a.md", content)
        reason = self.deny_reason(self.invoke("a.md"))
        self.assertIn("10:50", reason)

    def test_past_time_allowed(self):
        content = "見出し\n編集可（統括が 09:00 に取得した SHA-256）\n投入時の状態（08:00）: HEAD abc\n"
        write_instruction(self.root, "a.md", content)
        self.assertIsNone(self.invoke("a.md"))

    def test_midnight_previous_evening_not_flagged(self):
        # 23:58に書かれた記録を翌0:03に読んでも未来扱いしない(日をまたぐ誤検出を避ける)。
        content = "見出し\n編集可（統括が 23:58 に取得した SHA-256）\n"
        write_instruction(self.root, "a.md", content)
        self.assertIsNone(self.invoke("a.md", now=datetime(2026, 9, 25, 0, 3, 0)))

    def test_near_midnight_forward_denied(self):
        content = "見出し\n編集可（統括が 00:03 に取得した SHA-256）\n"
        write_instruction(self.root, "a.md", content)
        reason = self.deny_reason(self.invoke("a.md", now=datetime(2026, 9, 24, 23, 58, 0)))
        self.assertIn("00:03", reason)

    # --- 指示書を指さない/複数/対象外 ---

    def test_prompt_without_instruction_reference_allowed(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                   "tool_input": {"prompt": "適当な作業をしてください", "description": "t"}}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_referenced_file_absent_denied(self):
        # 事実1: 依頼文が指す指示書が無いときは理由付きで拒否する(以前は黙って許可していた)。
        reason = self.deny_reason(self.invoke("does-not-exist.md"))
        self.assertIn("scratchpad/claude/instructions/does-not-exist.md", reason)
        self.assertIn("がありません", reason)

    def test_non_agent_tool_allowed(self):
        (self.root / "already.txt").write_text("x", encoding="utf-8")
        write_instruction(self.root, "a.md", "新規 `already.txt`（10:00 に不在を確認）\n")
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                   "tool_input": {"command": self.prompt_for("a.md")}}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_post_tool_use_event_ignored(self):
        payload = {"hook_event_name": "PostToolUse", "tool_name": "Agent",
                   "tool_input": {"prompt": self.prompt_for("a.md"), "description": "t"}}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_two_files_referenced_aggregates_violations(self):
        (self.root / "already.txt").write_text("x", encoding="utf-8")
        write_instruction(self.root, "clean.md", "本文だけ\n")
        write_instruction(self.root, "bad.md", "新規 `already.txt`（10:00 に不在を確認）\n")
        reason = self.deny_reason(self.invoke("clean.md", "bad.md"))
        self.assertIn("bad.md", reason)
        self.assertIn("already.txt", reason)

    def test_non_dict_tool_input_fail_safe(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": "oops"}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_non_string_prompt_fail_safe(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                   "tool_input": {"prompt": None}}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))


class SubprocessContractTests(unittest.TestCase):
    """実プロセス経由のstdin/stdout契約。実ROOTを使うので時刻に依存しない場合だけを扱う。"""

    def invoke(self, payload_extra=None, raw=None):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                   "tool_input": {"prompt": "適当な作業をしてください", "description": "t"}}
        if payload_extra:
            payload.update(payload_extra)
        return subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                              input=json.dumps(payload) if raw is None else raw,
                              text=True, capture_output=True, cwd=ROOT, timeout=10)

    def test_no_reference_allowed(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_nonexistent_real_instruction_denied(self):
        # 事実1: 実ROOTでも、参照先の指示書が実在しなければサブプロセス経由で拒否される。
        prompt = "`scratchpad/claude/instructions/instruction-check-guard-selftest-ghost.md` を読む"
        result = self.invoke({"tool_input": {"prompt": prompt, "description": "t"}})
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)
        self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn(
            "instruction-check-guard-selftest-ghost.md",
            output["hookSpecificOutput"]["permissionDecisionReason"],
        )

    def test_non_agent_tool_allowed(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Read",
                   "tool_input": {"file_path": "x"}}
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input=json.dumps(payload), text=True, capture_output=True,
                                cwd=ROOT, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_malformed_json_fail_open(self):
        result = self.invoke(raw="{")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_execution_under_one_second(self):
        start = time.perf_counter()
        result = self.invoke()
        elapsed = time.perf_counter() - start
        self.assertEqual(result.returncode, 0)
        self.assertLess(elapsed, 1.0, f"hook took {elapsed:.3f}s")


class CliTests(unittest.TestCase):
    """`--check <path>` CLI(実ROOTを使う実装。対象ファイルはscratchpad/temp配下の使い捨て)。"""

    def setUp(self):
        self.work = (ROOT / "scratchpad/temp" /
                     f"instruction-check-guard-cli-selftest-{uuid.uuid4().hex[:8]}")
        created_dirs = _missing_ancestors(self.work)
        self.work.mkdir(parents=True)
        self.addCleanup(cleanup_root, self.work, created_dirs)
        self.target = self.work / "target.txt"
        self.target.write_text("hello", encoding="utf-8")
        self.digest = hash16(self.target.read_bytes())
        self.relative = self.target.relative_to(ROOT).as_posix()

    def run_cli(self, content: str):
        instruction = self.work / "fake.md"
        instruction.write_text(content, encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK), "--check", str(instruction)],
            text=True, capture_output=True, cwd=ROOT, timeout=10,
        )

    def test_cli_sha_match_exit0(self):
        result = self.run_cli(f"`{self.relative}`（{self.digest}）\n")
        self.assertEqual(result.returncode, 0)
        self.assertIn("外れ: 0 件", result.stdout)

    def test_cli_sha_mismatch_exit1(self):
        result = self.run_cli(f"`{self.relative}`（0000000000000000）\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("不一致", result.stdout)

    def test_cli_new_existing_exit1(self):
        # HH:MMを含む注記は実時刻依存の(c)を誤って踏まないよう付けない((a)は注記の
        # 有無を問わない仕様)。
        result = self.run_cli(f"新規 `{self.relative}`\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("既に存在する", result.stdout)

    def test_cli_new_absent_exit0(self):
        missing = f"{self.work.relative_to(ROOT).as_posix()}/missing.txt"
        result = self.run_cli(f"新規 `{missing}`\n")
        self.assertEqual(result.returncode, 0)
        self.assertIn("外れ: 0 件", result.stdout)

    def test_cli_file_not_found_exit1(self):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK), "--check",
             str(self.work / "no-such-file.md")],
            text=True, capture_output=True, cwd=ROOT, timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("見つからない", result.stdout)

    def test_cli_future_time_exit1(self):
        future = (datetime.now() + timedelta(minutes=5)).strftime("%H:%M")
        result = self.run_cli(f"見出し\n編集可（統括が {future} に取得した SHA-256）\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn(future, result.stdout)

    def test_cli_bare_time_example_in_body_not_flagged(self):
        # 本文中の比の例(見出しでも記入の文脈でもない)は(c)の対象にしない。
        result = self.run_cli(f"`{self.relative}`（{self.digest}）\n数式の例（比の 12:05）\n")
        self.assertEqual(result.returncode, 0)

    # --- 2026-10-25 cl-v103-instruction-guard-upgrade: 新しい検査の --check の出力 ---

    def test_cli_prints_warning_count_and_keeps_exit0(self):
        # 出典の無い引用の期待値は警告(外れにはしない)。警告の件数を出す。
        result = self.run_cli("# 指示書 t\n\n## 2. 合格条件（数値）\n\n1. 表示は「面による切断」になる。\n")
        self.assertEqual(result.returncode, 0)
        self.assertIn("外れ: 0 件", result.stdout)
        self.assertIn("警告: 1 件", result.stdout)
        self.assertIn("面による切断", result.stdout)

    def test_cli_citation_mismatch_exit1(self):
        content = (f"# 指示書 t\n\n## 2. 合格条件（数値）\n\n"
                   f"1. 表示は「こんにちは」になる（出典 {self.relative}:1）。\n")
        result = self.run_cli(content)
        self.assertEqual(result.returncode, 1)
        self.assertIn("実在しない", result.stdout)

    def test_cli_citation_match_exit0(self):
        content = (f"# 指示書 t\n\n## 2. 合格条件（数値）\n\n"
                   f"1. 表示は「hello」になる（出典 {self.relative}:1）。\n")
        result = self.run_cli(content)
        self.assertEqual(result.returncode, 0)
        self.assertIn("警告: 0 件", result.stdout)

    def test_cli_impact_section_missing_exit1(self):
        content = "③ 編集してよいファイルは packages/model/src/part/types.ts だけ。\n\n# 指示書 t\n"
        result = self.run_cli(content)
        self.assertEqual(result.returncode, 1)
        self.assertIn("影響の列挙が無い", result.stdout)

    # --- 2026-10-25 cl-v103-instruction-guard-paths: 検査 7(③のパスの実在)の --check の出力 ---

    def test_cli_missing_scope_path_exit1_and_new_scope_path_exit0(self):
        # ③の対象は packages/ などの根の下だけ(scratchpad/temp の下の使い捨ては対象外)。実在するはずのないパスで試す。
        missing = "packages/model/src/zz-no-such-folder-guard-selftest/missing-scope-path.ts"
        result = self.run_cli(f"③ 編集してよいファイルは {missing} だけ。\n\n# 指示書 t\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"③のパスが実在しない: {missing}", result.stdout)
        self.assertIn("外れ: 1 件", result.stdout)
        # 新規と書けば実在しなくてよい。このフックの自己試験自身(どの取り出しにも在る)は実在する。
        for scope in (f"新規 {missing}", ".claude/hooks/instruction_check_guard.py"):
            with self.subTest(scope=scope):
                result = self.run_cli(f"③ 編集してよいファイルは {scope} だけ。\n\n# 指示書 t\n")
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn("外れ: 0 件", result.stdout)


# ---------------------------------------------------------------------------
# 2026-10-25 cl-v103-instruction-guard-upgrade: 新しい5つの検査(影響の列挙・期待値の出典・出典の実物・
# help-content の検査・生成側の確認)。一時的な「根」を作り、guard.check_instruction_report に直接渡す。
# 走査は invocation=None(純 Python)で行い、rg の有無に依らない。rg を使う道は偽の rg と、あれば実物の rg で別に試す。
# ---------------------------------------------------------------------------


def make_instruction(scope: str, body: str = "") -> str:
    return (
        "① 子エージェントを起こさない。\n"
        "② git への書き込み禁止。\n"
        f"③ 編集してよいファイルは {scope} と、scratchpad/claude/agents/w/ 以下だけ。\n"
        "\n"
        "# 指示書 w\n"
        "\n"
        f"{body}"
    )


def impact_section(identifiers: str, extra: str = "") -> str:
    return f"## 影響の列挙\n\n- 対象の識別子: {identifiers}\n{extra}\n"


class NewChecksBase(unittest.TestCase):
    # 検査 7(③のパスの実在)は、③に書いたパスが一時の根に無いと外れにする。検査 1〜6 の試験は③の中身を問わないので、
    # 既定では③に書いたパスを空のファイルとして作ってから検査する(検査 7 の試験だけ False にして、存在を自分で決める)。
    materialize_scope = True

    def setUp(self):
        self.root, created_dirs = make_root()
        self.addCleanup(cleanup_root, self.root, created_dirs)
        self.now = datetime(2026, 9, 24, 10, 30, 0)

    def write(self, relative: str, content: str = "x") -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def materialize(self, text: str) -> None:
        """③の行のフルパスを一時の根に作る(既にあるファイルは触らない)。試験側の単純な切り出しで、フック本体の関数に頼らない。"""
        for line in text.splitlines():
            if not line.startswith("③"):
                continue
            for token in re.findall(r"(?:packages|apps|e2e|scripts|docs)/[A-Za-z0-9_@./\-]+", line):
                token = token.rstrip(".")
                target = self.root / token
                if token.endswith("/") or "." not in token.rsplit("/", 1)[-1]:
                    target.mkdir(parents=True, exist_ok=True)
                elif not target.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("", encoding="utf-8")

    def report(self, text: str, **kwargs):
        kwargs.setdefault("invocation", None)
        if self.materialize_scope:
            self.materialize(text)
        return guard.check_instruction_report(self.root, "x.md", text, self.now, **kwargs)

    def errors(self, text: str, **kwargs) -> list[str]:
        return self.report(text, **kwargs)[0]

    def warnings(self, text: str, **kwargs) -> list[str]:
        return self.report(text, **kwargs)[1]

    def joined(self, messages: list[str]) -> str:
        return "\n".join(messages)


class ImpactEnumerationTests(NewChecksBase):
    """検査1: 影響の列挙(§10.422・§10.423)。"""

    def setUp(self):
        super().setUp()
        self.write("packages/model/src/part/types.ts", "export interface SweepFeature { steelBend?: number }\n")
        self.write("packages/model/src/part/reader.ts", "import type { SweepFeature } from './types';\n")
        self.write("packages/model/src/part/reader.test.ts", "// SweepFeature\n")
        self.write("packages/ui/src/solid/FeatureTree.tsx", "const k: SweepFeature = 1;\n")

    # 外れになる例
    def test_types_ts_in_scope_without_section_denied(self):
        text = make_instruction("packages/model/src/part/types.ts（型の追加だけ）")
        errors = self.errors(text)
        self.assertEqual(len(errors), 1)
        self.assertIn("影響の列挙が無い", errors[0])
        self.assertIn("types.ts", errors[0])

    def test_body_kind_add_phrase_without_section_denied(self):
        text = make_instruction("packages/model/src/part/foo.ts", "## 1. 目的\n\n新しい kind を足す包み。\n")
        self.assertIn("影響の列挙が無い", self.joined(self.errors(text)))

    def test_body_field_add_phrase_without_section_denied(self):
        text = make_instruction("packages/model/src/part/foo.ts", "## 1. 目的\n\n保存の欄を足す。\n")
        self.assertIn("影響の列挙が無い", self.joined(self.errors(text)))

    def test_body_type_add_phrase_without_section_denied(self):
        text = make_instruction("packages/model/src/part/foo.ts", "## 1. 目的\n\n曲げの型に steelBend を追加する。\n")
        self.assertIn("影響の列挙が無い", self.joined(self.errors(text)))

    def test_uncovered_reader_denied_and_named(self):
        scope = "packages/model/src/part/types.ts"
        text = make_instruction(scope, impact_section("SweepFeature"))
        errors = self.errors(text)
        message = self.joined(errors)
        self.assertEqual(len(errors), 1, message)
        for name in ("packages/model/src/part/reader.ts", "packages/model/src/part/reader.test.ts",
                     "packages/ui/src/solid/FeatureTree.tsx"):
            self.assertIn(name, message)
        self.assertNotIn("packages/model/src/part/types.ts", message)
        self.assertIn("SweepFeature", message)

    def test_section_without_identifier_line_denied(self):
        text = make_instruction("packages/model/src/part/types.ts", "## 影響の列挙\n\n（あとで書く）\n")
        self.assertIn("対象の識別子", self.joined(self.errors(text)))

    def test_notouch_without_reason_does_not_cover(self):
        extra = "- 触らない: packages/model/src/part/reader.ts\n"
        text = make_instruction("packages/model/src/part/types.ts", impact_section("SweepFeature", extra))
        message = self.joined(self.errors(text))
        self.assertIn("理由", message)
        self.assertIn("reader.ts", message)

    def test_none_declaration_without_reason_denied(self):
        text = make_instruction("packages/model/src/part/types.ts", impact_section("なし"))
        self.assertIn("対象の識別子", self.joined(self.errors(text)))

    def test_section_present_without_trigger_is_still_verified(self):
        text = make_instruction("packages/model/src/part/foo.ts", impact_section("SweepFeature"))
        self.assertIn("を参照する", self.joined(self.errors(text)))

    # 通る例
    def test_no_trigger_passes(self):
        text = make_instruction("packages/model/src/part/foo.ts", "## 1. 目的\n\n普通の修正。\n")
        self.assertEqual(self.errors(text), [])

    def test_past_tense_negation_quote_and_citation_do_not_trigger(self):
        body = (
            "## 1. 目的\n\n"
            "前の担当が欄を足した結果の修正。\n"
            "既存 cut に省略可能な blade 欄を足す案は旧 reader が誤読するので採らない。\n"
            "規約「kind を足す」包みの題名を引用するだけ。\n\n"
            "## 5. 関係する過去の失敗\n\n"
            "- §10.422（型に欄を足す時は読む側を全て列挙）。\n"
            "- 欄を足す包みの失敗の記録。\n"
        )
        text = make_instruction("packages/model/src/part/foo.ts", body)
        self.assertEqual(self.errors(text), [])

    def test_everything_covered_by_scope_and_notouch_passes(self):
        extra = "- 触らない: packages/ui/src/solid/FeatureTree.tsx（アイコンの表で欄を読まない）\n"
        scope = "packages/model/src/part/types.ts・reader.ts・reader.test.ts"
        text = make_instruction(scope, impact_section("SweepFeature", extra))
        self.assertEqual(self.errors(text), [])

    def test_directory_and_glob_entries_cover(self):
        scope = "packages/model/src/part/ と packages/ui/src/solid/Feature*"
        text = make_instruction(scope, impact_section("SweepFeature"))
        self.assertEqual(self.errors(text), [])

    def test_notouch_directory_and_several_paths_with_reason_cover(self):
        extra = ("- 触らない: packages/model/src/part/（読む側は欄の有無で結果が変わらない）、"
                 "packages/ui/src/solid/FeatureTree.tsx（アイコンの表）\n")
        text = make_instruction("packages/model/src/part/types.ts", impact_section("SweepFeature", extra))
        self.assertEqual(self.errors(text), [])

    def test_command_span_in_scope_is_not_an_edit_range(self):
        # `rg -l … packages/model/src/part` は探し方の例で、編集の範囲ではない。
        scope = "packages/model/src/part/types.ts（実在の名前は `rg -l \"x\" packages/model/src/part` で確かめる）"
        text = make_instruction(scope, impact_section("SweepFeature"))
        self.assertIn("reader.ts", self.joined(self.errors(text)))

    def test_none_declaration_with_reason_passes_with_warning(self):
        text = make_instruction(
            "packages/model/src/part/types.ts", impact_section("なし（コメントの修正だけで型は変えない）"))
        errors, warnings = self.report(text)
        self.assertEqual(errors, [])
        self.assertIn("なし", self.joined(warnings))

    def test_numbered_heading_and_multiple_identifiers_accepted(self):
        self.write("packages/model/src/part/other.ts", "const steelBendX = 1;\n")
        body = "## 3. 影響の列挙\n\n- 対象の識別子: `SweepFeature`、steelBendX（別名）\n"
        scope = "packages/model/src/part/types.ts・reader.ts・reader.test.ts・other.ts、packages/ui/src/solid/"
        self.assertEqual(self.errors(make_instruction(scope, body)), [])

    def test_identifier_without_references_is_warning_only(self):
        text = make_instruction("packages/model/src/part/types.ts", impact_section("NoSuchIdentifierAnywhere"))
        errors, warnings = self.report(text)
        self.assertEqual(errors, [])
        self.assertIn("0 件", self.joined(warnings))

    def test_scan_range_excludes_node_modules_dist_and_outside_src(self):
        self.write("packages/model/src/node_modules/dep/x.ts", "SweepFeature\n")
        self.write("packages/model/src/dist/y.ts", "SweepFeature\n")
        self.write("packages/model/src/scratchpad/z.ts", "SweepFeature\n")
        self.write("packages/model/docs/n.md", "SweepFeature\n")
        self.write("scripts/s.ts", "SweepFeature\n")
        self.write("apps/web/src/main.ts", "SweepFeature\n")
        self.write("e2e/tests/flow.ts", "SweepFeature\n")
        self.write("e2e/other/flow2.ts", "SweepFeature\n")
        found, complete = guard.find_references(self.root, ["SweepFeature"], 30.0, invocation=None)
        self.assertTrue(complete)
        self.assertEqual(found["SweepFeature"], [
            "apps/web/src/main.ts",
            "e2e/tests/flow.ts",
            "packages/model/src/part/reader.test.ts",
            "packages/model/src/part/reader.ts",
            "packages/model/src/part/types.ts",
            "packages/ui/src/solid/FeatureTree.tsx",
        ])

    def test_full_lists_show_every_file_but_hook_mode_truncates(self):
        for number in range(20):
            self.write(f"packages/model/src/many/f{number:02d}.ts", "// SweepFeature\n")
        text = make_instruction("packages/model/src/part/types.ts", impact_section("SweepFeature"))
        short = self.joined(self.errors(text))
        full = self.joined(self.errors(text, full_lists=True))
        self.assertIn("…他", short)
        self.assertNotIn("…他", full)
        self.assertIn("packages/model/src/many/f19.ts", full)
        self.assertNotIn("packages/model/src/many/f19.ts", short)

    def test_scan_over_time_budget_is_a_warning_not_an_error(self):
        text = make_instruction("packages/model/src/part/types.ts", impact_section("SweepFeature"))
        errors, warnings = self.report(text, scan_seconds=-1.0)
        self.assertEqual(errors, [])
        self.assertIn("走査", self.joined(warnings))

    def test_scan_speed_for_hundreds_of_files(self):
        for number in range(600):
            self.write(f"packages/p{number % 6}/src/d{number % 10}/f{number}.ts", "export const a = 1;\n" * 30)
        self.write("packages/p1/src/hit.ts", "// SweepFeature\n")
        import time
        start = time.perf_counter()
        found, complete = guard.find_references(self.root, ["SweepFeature"], 30.0, invocation=None)
        elapsed = time.perf_counter() - start
        self.assertTrue(complete)
        self.assertIn("packages/p1/src/hit.ts", found["SweepFeature"])
        self.assertLess(elapsed, 5.0, f"scan took {elapsed:.2f}s")


FAKE_RG = """\
import os
import sys

args = sys.argv[1:]
log = os.environ.get("FAKE_RG_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(args) + "\\n")
if os.environ.get("FAKE_RG_FAIL"):
    sys.exit(2)
needle = args[args.index("-e") + 1]
dirs = args[args.index("--") + 1:]
skip = {arg[len("--glob=!**/"):-len("/**")] for arg in args if arg.startswith("--glob=!**/")}
found = []
for directory in dirs:
    for base, subdirs, names in os.walk(directory):
        subdirs[:] = [name for name in subdirs if name not in skip]
        for name in names:
            path = os.path.join(base, name)
            with open(path, encoding="utf-8", errors="replace") as handle:
                if needle in handle.read():
                    found.append(path.replace(os.sep, "/"))
sys.stdout.buffer.write(("\\0".join(sorted(found)) + ("\\0" if found else "")).encode("utf-8"))
sys.exit(0 if found else 1)
"""


def embedded_rg():
    """Claude Code が同梱する ripgrep (claude 実行ファイルを ARGV0=rg で呼ぶ)。無い環境では None。"""
    import os
    exe = os.environ.get("CLAUDE_CODE_EXECPATH")
    if not exe or not Path(exe).is_file():
        return None
    try:
        probe = subprocess.run([exe, "--version"], env={**os.environ, "ARGV0": "rg"},
                               capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if probe.returncode == 0 and "ripgrep" in probe.stdout:
        return [exe], {"ARGV0": "rg"}
    return None


class RipgrepPathTests(NewChecksBase):
    """PATH に rg がある時の道(rg --files-with-matches --fixed-strings)。無い・失敗した時は純 Python の走査。"""

    def setUp(self):
        super().setUp()
        self.write("packages/model/src/part/types.ts", "export interface SweepFeature {}\n")
        self.write("packages/model/src/part/reader.ts", "SweepFeature steelBend\n")
        self.write("packages/model/src/part/other.ts", "steelBend only\n")
        self.write("packages/model/src/node_modules/dep/x.ts", "SweepFeature\n")
        self.fake = self.write("fake_rg.py", FAKE_RG)
        self.log = self.root / "fake_rg.log"

    def fake_invocation(self, **extra):
        env = {"FAKE_RG_LOG": str(self.log)}
        env.update(extra)
        return [sys.executable, str(self.fake)], env

    def test_rg_called_once_per_identifier_with_expected_flags(self):
        found, complete = guard.find_references(
            self.root, ["SweepFeature", "steelBend"], 30.0, invocation=self.fake_invocation())
        self.assertTrue(complete)
        self.assertEqual(found["SweepFeature"], [
            "packages/model/src/part/reader.ts", "packages/model/src/part/types.ts"])
        self.assertEqual(found["steelBend"], [
            "packages/model/src/part/other.ts", "packages/model/src/part/reader.ts"])
        calls = self.log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(calls), 2)
        for call, identifier in zip(calls, ("SweepFeature", "steelBend")):
            self.assertIn("--files-with-matches", call)
            self.assertIn("--fixed-strings", call)
            self.assertIn(f"-e {identifier} -- packages/model/src", call)

    def test_rg_failure_falls_back_to_python_scan(self):
        found, complete = guard.find_references(
            self.root, ["SweepFeature"], 30.0, invocation=self.fake_invocation(FAKE_RG_FAIL="1"))
        self.assertTrue(complete)
        self.assertEqual(found["SweepFeature"], [
            "packages/model/src/part/reader.ts", "packages/model/src/part/types.ts"])

    def test_rg_result_feeds_the_coverage_check(self):
        body = impact_section("SweepFeature")
        text = make_instruction("packages/model/src/part/types.ts", body)
        errors, _ = guard.check_instruction_report(
            self.root, "x.md", text, self.now, invocation=self.fake_invocation())
        self.assertIn("packages/model/src/part/reader.ts", self.joined(errors))

    def test_embedded_real_ripgrep_agrees_with_python_scan(self):
        real = embedded_rg()
        if real is None:
            self.skipTest("同梱の ripgrep(CLAUDE_CODE_EXECPATH)が無い環境")
        names = ["SweepFeature", "steelBend", "NoSuchName"]
        by_rg, complete_rg = guard.find_references(self.root, names, 60.0, invocation=real)
        by_python, complete_python = guard.find_references(self.root, names, 60.0, invocation=None)
        self.assertTrue(complete_rg and complete_python)
        self.assertEqual(by_rg, by_python)
        self.assertEqual(by_rg["NoSuchName"], [])

    def test_auto_invocation_never_raises_whether_or_not_rg_is_on_path(self):
        found, complete = guard.find_references(self.root, ["SweepFeature"], 30.0)
        self.assertTrue(complete)
        self.assertEqual(found["SweepFeature"], [
            "packages/model/src/part/reader.ts", "packages/model/src/part/types.ts"])


class ScanCacheTests(NewChecksBase):
    """純 Python の走査の控え(root/scratchpad/temp があるときだけ)。ファイルごとに (mtime_ns, size) が同じなら
    読み直さない。控えが無くても・壊れていても結果は同じで、速さだけが違う。"""

    def setUp(self):
        super().setUp()
        (self.root / "scratchpad" / "temp").mkdir(parents=True)
        self.cache = self.root / "scratchpad" / "temp" / guard.SCAN_CACHE_NAME
        self.a = self.write("packages/model/src/a.ts", "export const A = 'SweepFeature';\n")
        self.write("packages/model/src/b.ts", "nothing here\n")
        self.write("packages/ui/src/c.ts", "SweepFeature and steelBend\n")

    def scan(self, *identifiers, seconds=30.0, **kwargs):
        return guard.find_references(self.root, list(identifiers), seconds, invocation=None, **kwargs)

    def cached(self) -> dict:
        import json
        return json.loads(self.cache.read_text(encoding="utf-8"))

    def test_first_scan_writes_the_cache_and_answers_correctly(self):
        found, complete = self.scan("SweepFeature", "steelBend")
        self.assertTrue(complete)
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/ui/src/c.ts"])
        self.assertEqual(found["steelBend"], ["packages/ui/src/c.ts"])
        data = self.cached()
        self.assertEqual(data["searched"], ["SweepFeature", "steelBend"])
        self.assertEqual(sorted(data["files"]), [
            "packages/model/src/a.ts", "packages/model/src/b.ts", "packages/ui/src/c.ts"])
        self.assertEqual(data["files"]["packages/ui/src/c.ts"][2], ["SweepFeature", "steelBend"])

    def test_unchanged_files_are_not_read_again_and_changed_ones_are(self):
        import os
        self.scan("SweepFeature")
        before = self.a.stat()
        # 同じ大きさ・同じ更新時刻のまま中身を変えると控えの答えを使う(読み直さない証拠)。
        self.a.write_text("export const A = 'XweepFeature';\n", encoding="utf-8")
        os.utime(self.a, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.a.stat().st_size, before.st_size)
        found, _ = self.scan("SweepFeature")
        self.assertIn("packages/model/src/a.ts", found["SweepFeature"])
        # 更新時刻が変われば読み直して、新しい中身で答える。
        os.utime(self.a, ns=(before.st_atime_ns, before.st_mtime_ns + 5_000_000_000))
        found, _ = self.scan("SweepFeature")
        self.assertEqual(found["SweepFeature"], ["packages/ui/src/c.ts"])

    def test_added_and_deleted_files_are_picked_up(self):
        self.scan("SweepFeature")
        self.write("packages/model/src/d.ts", "SweepFeature again\n")
        (self.root / "packages/ui/src/c.ts").unlink()
        found, _ = self.scan("SweepFeature")
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/model/src/d.ts"])
        self.assertNotIn("packages/ui/src/c.ts", self.cached()["files"])

    def test_a_deletion_alone_is_picked_up_and_dropped_from_the_cache(self):
        self.scan("SweepFeature")
        (self.root / "packages/ui/src/c.ts").unlink()
        found, _ = self.scan("SweepFeature")
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts"])
        self.assertNotIn("packages/ui/src/c.ts", self.cached()["files"])

    def test_a_changed_size_with_the_same_mtime_is_read_again(self):
        import os
        self.scan("SweepFeature")
        before = self.a.stat()
        self.a.write_text("export const A = 'nothing';\n", encoding="utf-8")
        os.utime(self.a, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertNotEqual(self.a.stat().st_size, before.st_size)
        found, _ = self.scan("SweepFeature")
        self.assertEqual(found["SweepFeature"], ["packages/ui/src/c.ts"])

    def test_a_new_identifier_is_answered_and_the_old_ones_stay_answered(self):
        self.scan("SweepFeature")
        found, complete = self.scan("steelBend")
        self.assertTrue(complete)
        self.assertEqual(found["steelBend"], ["packages/ui/src/c.ts"])
        self.assertEqual(self.cached()["searched"], ["SweepFeature", "steelBend"])
        found, _ = self.scan("SweepFeature")
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/ui/src/c.ts"])

    def test_corrupt_or_foreign_cache_is_ignored_and_rebuilt(self):
        for content in ("{not json", "[]", '{"version": 2, "searched": [], "files": {}}',
                        '{"version": 1, "searched": ["SweepFeature"], "files": {"packages/model/src/a.ts": "oops"}}'):
            with self.subTest(content=content):
                self.cache.write_text(content, encoding="utf-8")
                found, complete = self.scan("SweepFeature")
                self.assertTrue(complete)
                self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/ui/src/c.ts"])
                self.assertEqual(self.cached()["version"], 1)

    def test_no_cache_file_without_scratchpad_temp_or_when_disabled(self):
        found, _ = self.scan("SweepFeature", use_cache=False)
        self.assertFalse(self.cache.exists())
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/ui/src/c.ts"])
        import shutil
        shutil.rmtree(self.root / "scratchpad" / "temp")
        found, complete = self.scan("SweepFeature")
        self.assertTrue(complete)
        self.assertFalse((self.root / "scratchpad" / "temp").exists())
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/ui/src/c.ts"])

    def test_timed_out_scan_leaves_a_valid_cache_and_the_next_scan_completes(self):
        found, complete = self.scan("SweepFeature", seconds=-1.0)
        self.assertFalse(complete)
        self.assertEqual(found["SweepFeature"], [])
        self.assertEqual(self.cached()["files"], {})
        found, complete = self.scan("SweepFeature")
        self.assertTrue(complete)
        self.assertEqual(found["SweepFeature"], ["packages/model/src/a.ts", "packages/ui/src/c.ts"])

    def test_too_many_identifiers_reset_the_cache_to_the_current_request(self):
        original = guard.SCAN_CACHE_MAX_IDENTIFIERS
        guard.SCAN_CACHE_MAX_IDENTIFIERS = 2
        try:
            self.scan("SweepFeature")
            self.scan("steelBend")
            self.assertEqual(self.cached()["searched"], ["SweepFeature", "steelBend"])
            found, _ = self.scan("nothing")
            self.assertEqual(self.cached()["searched"], ["nothing"])
            self.assertEqual(found["nothing"], ["packages/model/src/b.ts"])
        finally:
            guard.SCAN_CACHE_MAX_IDENTIFIERS = original

    def test_cached_and_uncached_scans_always_agree(self):
        for names in (("SweepFeature",), ("steelBend", "nothing"), ("SweepFeature", "steelBend", "zzz")):
            with self.subTest(names=names):
                cached_result = self.scan(*names)
                plain_result = self.scan(*names, use_cache=False)
                self.assertEqual(cached_result, plain_result)


class CitationTests(NewChecksBase):
    """検査2: 期待値の出典(W11d)。"""

    def setUp(self):
        super().setUp()
        source = "\n".join(f"line {number}" for number in range(1, 31))
        source = source.replace("line 10", '  "cut": "面による切断",')
        self.write("packages/ui/src/i18n/ja/toolbar.json", source + "\n")
        self.cite = "packages/ui/src/i18n/ja/toolbar.json"

    def accept(self, *lines: str) -> str:
        return make_instruction(
            "packages/model/src/part/foo.ts", "## 1. 目的\n\n本文。\n\n## 2. 合格条件（数値）\n\n" +
            "\n".join(lines) + "\n\n## 3. 変えてはいけないもの\n\n- なし。\n")

    # 外れになる例
    def test_quote_not_in_cited_window_denied(self):
        text = self.accept(f"1. 表示は「面で切る」になる（出典 {self.cite}:10）。")
        message = self.joined(self.errors(text))
        self.assertIn("面で切る", message)
        self.assertIn("実在しない", message)

    def test_window_is_three_lines_before_and_after(self):
        inside = self.accept(f"1. 表示は「面による切断」（出典 {self.cite}:13）。")
        outside = self.accept(f"1. 表示は「面による切断」（出典 {self.cite}:14）。")
        before_inside = self.accept(f"1. 表示は「面による切断」（出典 {self.cite}:7）。")
        before_outside = self.accept(f"1. 表示は「面による切断」（出典 {self.cite}:6）。")
        self.assertEqual(self.errors(inside), [])
        self.assertEqual(self.errors(before_inside), [])
        self.assertIn("実在しない", self.joined(self.errors(outside)))
        self.assertIn("実在しない", self.joined(self.errors(before_outside)))

    def test_cited_file_missing_denied(self):
        text = self.accept("1. 表示は「あ」（出典 packages/ui/src/i18n/ja/no-such.json:3）。")
        self.assertIn("のファイルが無い", self.joined(self.errors(text)))

    def test_cited_line_out_of_range_denied(self):
        text = self.accept(f"1. 表示は「あ」（出典 {self.cite}:999）。")
        self.assertIn("範囲外", self.joined(self.errors(text)))

    def test_each_quote_on_a_cited_line_must_exist(self):
        text = self.accept(f"1. 「面による切断」と 'ghost-value' が出る（出典 {self.cite}:10）。")
        errors = self.errors(text)
        self.assertEqual(len(errors), 1, self.joined(errors))
        self.assertIn("ghost-value", errors[0])

    # 通る例
    def test_quote_in_cited_line_passes(self):
        text = self.accept(f"1. 表示は「面による切断」になる（出典 {self.cite}:10）。")
        errors, warnings = self.report(text)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_all_quote_styles_and_backtick_path_and_colon_forms(self):
        text = self.accept(
            f'1. "面による切断" と \'面による切断\' と “面による切断” と 『面による切断』'
            f'（出典 `{self.cite}:10`）。',
            f"2. 「面による切断」（出典: `{self.cite}`:11）。",
            f"3. 「line 12」（出典 {self.cite}：12）。")
        self.assertEqual(self.errors(text), [])

    def test_line_range_and_second_citation_either_window_counts(self):
        text = self.accept(
            f"1. 「line 20」（出典 {self.cite}:19-21）。",
            f"2. 「面による切断」（出典 {self.cite}:25、{self.cite}:11）。")
        self.assertEqual(self.errors(text), [])

    def test_quote_without_citation_is_warning_not_error(self):
        text = self.accept("1. 表示は「面による切断」と 'ok' になる。", "2. 件数は 3 件。")
        errors, warnings = self.report(text)
        self.assertEqual(errors, [])
        self.assertEqual(len(warnings), 2)
        self.assertIn("面による切断", warnings[0])
        self.assertIn("出典", warnings[0])

    def test_quotes_inside_command_spans_are_not_expected_values(self):
        text = self.accept('1. `rg -n -F -e "forbidden-one" -e "forbidden-two" <変えたファイル>` が 0 件。')
        self.assertEqual(self.report(text), ([], []))

    def test_quotes_outside_section_two_are_ignored(self):
        text = make_instruction(
            "packages/model/src/part/foo.ts",
            "## 1. 目的（送信前の合格条件）\n\n前の担当が書いた '面による切断' の話。\n\n"
            "## 2. 合格条件（数値）\n\n1. 件数は 3 件。\n\n## 3. 変えてはいけないもの\n\n- 「あ」のまま。\n")
        self.assertEqual(self.report(text), ([], []))

    def test_no_section_two_means_no_check(self):
        text = make_instruction("packages/model/src/part/foo.ts", "## 1. 目的\n\n「あ」と書く（出典 nowhere.json:1）。\n")
        self.assertEqual(self.report(text), ([], []))

    def test_fenced_code_in_section_two_is_skipped(self):
        text = self.accept("1. 例:", "```", '出力は "面で切る" （出典 none.json:1）', "```")
        self.assertEqual(self.report(text), ([], []))

    def test_citation_without_quote_is_not_checked(self):
        text = self.accept(f"1. 件数は 3 件（出典 {self.cite}:10）。")
        self.assertEqual(self.report(text), ([], []))


class SourceEvidenceTests(NewChecksBase):
    """検査3: 出典の実物(W6)。"""

    def text(self, body: str) -> str:
        return make_instruction("packages/model/src/assembly/standard/steelCatalog.ts", body)

    BASE = "出典は sources.md に記録された PDF とその SHA-256 に一致するものを使う。\n"

    # 外れになる例
    def test_sources_and_sha_without_means_denied(self):
        message = self.joined(self.errors(self.text(self.BASE)))
        self.assertIn("出典の実物が無い", message)
        self.assertIn("手元:", message)

    def test_w6_wording_that_forbids_download_still_denied(self):
        body = self.BASE + "sources.md の SHA-256 と一致する PDF を参照する（ダウンロードはしない）。\n"
        self.assertIn("出典の実物が無い", self.joined(self.errors(self.text(body))))

    def test_negated_permission_denied(self):
        body = self.BASE + "取得を許可しない。取得はしない。\n"
        self.assertIn("出典の実物が無い", self.joined(self.errors(self.text(body))))

    def test_local_copy_path_that_does_not_exist_denied_and_named(self):
        body = self.BASE + "手元: scratchpad/claude/agents/none/source.pdf\n"
        message = self.joined(self.errors(self.text(body)))
        self.assertIn("出典の実物が無い", message)
        self.assertIn("scratchpad/claude/agents/none/source.pdf", message)

    # 通る例
    def test_permission_sentences_pass(self):
        for sentence in ("PDF の取得を許可する（1 回だけ）。", "PDF を取得してよい。", "PDF を取得してもよい。",
                         "自担当フォルダーへ 1 回だけ取得し、SHA-256 が一致した場合だけ出典として使う。"):
            with self.subTest(sentence=sentence):
                self.assertEqual(self.errors(self.text(self.BASE + sentence + "\n")), [])

    def test_existing_local_copy_passes(self):
        self.write_source = self.root / "docs/standards/g3192.pdf"
        self.write_source.parent.mkdir(parents=True)
        self.write_source.write_bytes(b"%PDF")
        body = self.BASE + "手元: docs/standards/g3192.pdf（SHA-256 は sources.md の値と一致を確認済み）\n"
        self.assertEqual(self.errors(self.text(body)), [])

    def test_sources_md_without_sha_or_sha_without_sources_md_passes(self):
        self.assertEqual(self.errors(self.text("sources.md を読む。\n")), [])
        self.assertEqual(self.errors(self.text("SHA-256 を final.md に書く。\n")), [])

    def test_sha256_without_hyphen_counts_too(self):
        self.assertIn("出典の実物が無い", self.joined(self.errors(self.text("sources.md の SHA256 を照合する。\n"))))
        self.assertEqual(self.errors(self.text("sources.md の SHA256 を照合する。取得を許可する。\n")), [])


class HelpContentTests(NewChecksBase):
    """検査4: 画面を変える包みの help-content の検査(§10.427)。"""

    def text(self, scope: str, acceptance: str) -> str:
        return make_instruction(
            scope, "## 1. 目的\n\n本文。\n\n## 2. 合格条件（数値）\n\n" + acceptance + "\n\n## 3. 変えてはいけないもの\n\n- 無し。\n")

    TSX = "packages/ui/src/assembly/AssemblyForm.tsx（欄の説明の追加だけ）"

    # 外れになる例
    def test_ui_tsx_without_both_names_denied(self):
        message = self.joined(self.errors(self.text(self.TSX, "1. 単体が通る。")))
        self.assertIn("help-content", message)
        self.assertIn("controlInventory.test.ts", message)
        self.assertIn("topics.test.ts", message)

    def test_only_one_name_present_names_the_other(self):
        message = self.joined(self.errors(self.text(self.TSX, "1. controlInventory.test.ts が通る。")))
        self.assertIn("topics.test.ts が無い", message)
        self.assertNotIn("controlInventory.test.ts・", message)

    def test_help_content_docs_triggers(self):
        scope = "packages/help-content/docs/ja/mass-properties.md（言い換えだけ）"
        self.assertIn("help-content", self.joined(self.errors(self.text(scope, "1. 単体が通る。"))))

    def test_names_outside_section_two_do_not_count(self):
        text = make_instruction(
            self.TSX,
            "## 1. 目的\n\ncontrolInventory.test.ts と topics.test.ts の失敗の話。\n\n"
            "## 2. 合格条件（数値）\n\n1. 単体が通る。\n")
        self.assertIn("help-content", self.joined(self.errors(text)))

    # 通る例
    def test_both_names_in_section_two_pass(self):
        acceptance = ("1. `diag.py unit --package help-content src/controlInventory.test.ts "
                      "src/topics.test.ts` が exit 0。")
        self.assertEqual(self.errors(self.text(self.TSX, acceptance)), [])

    def test_test_files_and_non_ui_files_do_not_trigger(self):
        scope = "packages/ui/src/assembly/AssemblyForm.test.tsx・packages/ui/src/assembly/helper.ts・packages/model/src/a.ts"
        self.assertEqual(self.errors(self.text(scope, "1. 単体が通る。")), [])

    def test_no_section_two_falls_back_to_whole_text(self):
        text = make_instruction(self.TSX, "controlInventory.test.ts と topics.test.ts を流す。\n")
        self.assertEqual(self.errors(text), [])


class GeneratedSideTests(NewChecksBase):
    """検査5: 生成側の固定値(W6 の2つ目。簡易。警告のみ)。"""

    def test_table_growth_without_generator_or_confirmation_warns_but_never_errors(self):
        for phrase in ("輪郭の行の表を増やす", "steelCatalog.ts（行の加法追加だけ）", "oracle の fixture を足す"):
            with self.subTest(phrase=phrase):
                text = make_instruction(f"packages/model/src/assembly/standard/steelCatalog.ts（{phrase}）")
                errors, warnings = self.report(text)
                self.assertEqual(errors, [])
                self.assertEqual(len(warnings), 1, self.joined(warnings))
                self.assertIn("生成側の確認", warnings[0])

    def test_generator_file_in_scope_silences(self):
        for name in ("steelSectionProfiles.ts", "outlineGenerator.ts", "partBuilder.ts"):
            with self.subTest(name=name):
                text = make_instruction(
                    f"packages/model/src/a/steelCatalog.ts（行の加法追加だけ）、packages/model/src/a/{name}")
                self.assertEqual(self.report(text), ([], []))

    def test_a_similarly_named_file_that_is_not_generator_side_does_not_silence(self):
        text = make_instruction(
            "packages/model/src/a/steelCatalog.ts（行の加法追加だけ）、packages/model/src/a/steelProfile.ts")
        self.assertEqual(len(self.warnings(text)), 1)

    def test_confirmation_line_silences(self):
        text = make_instruction(
            "packages/model/src/a/steelCatalog.ts（行の加法追加だけ）",
            "生成側の確認: packages/model/src/a/steelSectionProfiles.ts（固定値 r1=8・r2=4 は表に無い寸法で効く）\n")
        self.assertEqual(self.report(text), ([], []))

    def test_no_trigger_no_warning(self):
        text = make_instruction("packages/model/src/a/steelCatalog.ts（注記の修正だけ）")
        self.assertEqual(self.report(text), ([], []))


class ScopePathTests(NewChecksBase):
    """検査7: ③のパスの実在(2026-10-25 02:1x の EX-09 W02 の停止。計画書の行から写した存在しない検査ファイルを③に書いた)。"""

    materialize_scope = False

    MARK = "③のパスが実在しない: "

    def missing(self, text: str) -> list[str]:
        """検査 7 の外れだけを、パスの語で返す(順序は出現の順)。"""
        return [m.split(self.MARK, 1)[1].split("（", 1)[0] for m in self.errors(text) if self.MARK in m]

    def files(self, *relatives: str) -> None:
        for relative in relatives:
            self.write(relative)

    # --- 外れになる例 ---

    def test_nonexistent_file_is_denied_and_the_message_says_what_to_fix(self):
        text = make_instruction("packages/model/src/analysis/analysisModel.test.ts（追加だけ）")
        messages = [m for m in self.errors(text) if self.MARK in m]
        self.assertEqual(len(messages), 1)
        self.assertIn("x.md 行3: ③のパスが実在しない: packages/model/src/analysis/analysisModel.test.ts", messages[0])
        self.assertIn("新規なら『新規 packages/model/src/analysis/analysisModel.test.ts』と書く", messages[0])
        self.assertIn("計画書の行から写す前に ls で確かめる", messages[0])

    def test_three_missing_test_files_written_as_full_paths_are_each_denied(self):
        # 本物の W02 の再現(計画書の行から写した、実在しない検査ファイル 3 本)。実在する本体の 3 本は外れにならない。
        self.files("packages/model/src/analysis/analysisModel.ts", "packages/model/src/analysis/analysisValidation.ts",
                   "packages/fem/src/solidAnalysisModel.ts")
        scope = ("packages/model/src/analysis/analysisModel.ts（降伏の値を結ぶ最小の変更）、"
                 "packages/model/src/analysis/analysisValidation.ts（3 負例の拒否）、"
                 "packages/fem/src/solidAnalysisModel.ts（FE 入力へ運ぶ）、"
                 "packages/model/src/analysis/analysisModel.test.ts・packages/model/src/analysis/analysisValidation.test.ts・"
                 "packages/fem/src/solidAnalysisModel.test.ts（追加だけ）")
        self.assertEqual(self.missing(make_instruction(scope)), [
            "packages/model/src/analysis/analysisModel.test.ts",
            "packages/model/src/analysis/analysisValidation.test.ts",
            "packages/fem/src/solidAnalysisModel.test.ts",
        ])

    W02_SCOPE = (
        "packages/model/src/analysis/analysisModel.ts（BeamMaterial に降伏の値と出典 ID を結ぶ最小の変更）、"
        "packages/model/src/analysis/analysisValidation.ts（欠け・熱処理違い・板厚域外の 3 負例の拒否）、"
        "packages/fem/src/solidAnalysisModel.ts（FE 入力へ降伏と出典 ID を運ぶ最小の変更）、"
        "新規 packages/model/src/analysis/analysisMaterialCapacity.test.ts、"
        "既存の analysisModel・analysisValidation・solidAnalysisModel の .test.ts（追加だけ）")

    def test_shorthand_list_of_test_files_is_expanded_in_the_folder_of_each_listed_file(self):
        # 実在の W02 は存在しない 3 本をフルパスではなく「既存の A・B・C の .test.ts」の略記で書いていた。
        self.files("packages/model/src/analysis/analysisModel.ts", "packages/model/src/analysis/analysisValidation.ts",
                   "packages/fem/src/solidAnalysisModel.ts")
        messages = [m for m in self.errors(make_instruction(self.W02_SCOPE)) if self.MARK in m]
        self.assertEqual(self.missing(make_instruction(self.W02_SCOPE)), [
            "packages/model/src/analysis/analysisModel.test.ts",
            "packages/model/src/analysis/analysisValidation.test.ts",
            "packages/fem/src/solidAnalysisModel.test.ts",
        ])
        self.assertIn("略記「analysisModel・analysisValidation・solidAnalysisModel の .test.ts」の展開", messages[0])

    def test_shorthand_passes_when_the_expanded_files_exist(self):
        self.files("packages/model/src/analysis/analysisModel.ts", "packages/model/src/analysis/analysisValidation.ts",
                   "packages/fem/src/solidAnalysisModel.ts", "packages/model/src/analysis/analysisModel.test.ts",
                   "packages/model/src/analysis/analysisValidation.test.ts", "packages/fem/src/solidAnalysisModel.test.ts")
        self.assertEqual(self.missing(make_instruction(self.W02_SCOPE)), [])

    def test_shorthand_with_a_word_that_names_no_listed_file_or_only_a_folder_is_skipped(self):
        self.files("packages/kernel/src/index.ts", "packages/model/src/part/resolvePart.ts")
        scope = ("packages/kernel（読むだけ）、packages/model/src/part/resolvePart.ts、"
                 "製品コードの kernel・model の .test.ts と src の .test.ts、新規 packages/model/src/part/n.test.ts")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_shorthand_marked_new_is_exempt(self):
        self.files("packages/fem/src/solidAnalysisModel.ts")
        scope = "packages/fem/src/solidAnalysisModel.ts（型の変更）、新規の solidAnalysisModel の .test.ts"
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_missing_folder_with_trailing_slash_is_denied_and_existing_folder_passes(self):
        self.files("packages/model/src/part/a.ts")
        self.assertEqual(self.missing(make_instruction("packages/model/src/nosuchdir/（配下）")),
                         ["packages/model/src/nosuchdir/"])
        self.assertEqual(self.missing(make_instruction("packages/model/src/part/（配下）")), [])

    def test_glob_checks_only_the_folder_part(self):
        self.files("packages/model/src/part/a.ts")
        scope = "packages/model/src/part/*.test.ts と packages/model/src/nosuchdir/*.ts と packages/*/src/**/*.ts"
        self.assertEqual(self.missing(make_instruction(scope)), ["packages/model/src/nosuchdir/*.ts"])
        message = next(m for m in self.errors(make_instruction(scope)) if self.MARK in m)
        self.assertIn("glob の手前のフォルダー packages/model/src/nosuchdir が無い", message)

    def test_path_without_extension_or_slash_is_checked_as_it_is_written(self):
        self.files("packages/io/src/a.ts")
        self.assertEqual(self.missing(make_instruction("packages/io の codec と packages/nosuchpkg の codec")),
                         ["packages/nosuchpkg"])
        # 根の名前そのもの(末尾の / が無い)も対象
        self.assertEqual(self.missing(make_instruction("scratchpad/claude/tools の道具")), ["scratchpad/claude/tools"])
        self.files("scratchpad/claude/tools/diag.py")
        self.assertEqual(self.missing(make_instruction("scratchpad/claude/tools の道具")), [])

    def test_every_listed_root_is_checked(self):
        for path in ("packages/model/src/nope.ts", "apps/web/src/nope.ts", "e2e/tests/nope.spec.ts",
                     "scripts/nope.ps1", "docs/plans/nope.md", ".claude/hooks/nope.py", "scratchpad/claude/tools/nope.py"):
            with self.subTest(path=path):
                self.assertEqual(self.missing(make_instruction(f"{path}（追加だけ）")), [path])

    def test_a_dot_slash_prefix_is_resolved_from_the_root(self):
        self.files("packages/io/src/a.ts")
        self.assertEqual(self.missing(make_instruction("./packages/io/src/a.ts と ./packages/io/src/b.ts")),
                         ["packages/io/src/b.ts"])

    def test_the_same_missing_path_is_reported_once_and_in_order_of_appearance(self):
        scope = "packages/a/z.ts（1 回目）、packages/a/y.ts、packages/a/z.ts（2 回目）"
        self.assertEqual(self.missing(make_instruction(scope)), ["packages/a/z.ts", "packages/a/y.ts"])

    def test_line_number_points_at_the_line_holding_the_path_when_the_paragraph_continues(self):
        text = (
            "① 子エージェントを起こさない。\n"
            "② git への書き込み禁止。\n"
            "③ 編集してよいファイルは次だけ。\n"
            "- packages/io/src/a.ts\n"
            "- packages/io/src/missing.ts\n"
            "\n"
            "# 指示書 w\n")
        self.files("packages/io/src/a.ts")
        messages = [m for m in self.errors(text) if self.MARK in m]
        self.assertEqual(len(messages), 1)
        self.assertTrue(messages[0].startswith("x.md 行5: "), messages[0])

    # --- 通る例 ---

    def test_existing_files_pass(self):
        self.files("packages/model/src/part/types.ts", "e2e/tests/a.spec.ts", "docs/plans/p.md")
        scope = "packages/model/src/part/types.ts・e2e/tests/a.spec.ts、docs/plans/p.md"
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_new_prefix_exempts_the_path(self):
        for scope in ("新規 packages/ui/src/x.ts", "新規 `packages/ui/src/x.ts`", "必要なら新規 packages/ui/src/x.ts（切出し）",
                      "新規の検査 e2e/tests/x.spec.ts", "新規packages/ui/src/x.ts", "（新規。packages/ui/src/fixtures/ 配下）"):
            with self.subTest(scope=scope):
                self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_new_word_must_be_within_twelve_characters_before_the_path(self):
        near = "新規" + " " * 10 + "packages/ui/src/x.ts"   # 「新規」の先頭から 12 文字、パスの直前の 12 文字に「新規」が入る
        far = "新規" + " " * 11 + "packages/ui/src/x.ts"    # 13 文字前: 入らない
        self.assertEqual(self.missing(make_instruction(near)), [])
        self.assertEqual(self.missing(make_instruction(far)), ["packages/ui/src/x.ts"])

    def test_new_word_on_the_previous_line_does_not_count(self):
        text = (
            "③ 編集してよいファイルは新規\n"
            "- packages/ui/src/y.ts\n"
            "\n"
            "# 指示書 w\n")
        self.assertEqual(self.missing(text), ["packages/ui/src/y.ts"])

    def test_new_remark_right_after_the_path_exempts_it(self):
        for scope in ("packages/ui/src/x.ts（検査専用の補助。新規）", "packages/ui/src/x.ts (新規 2 件)",
                      "packages/ui/src/x.ts（括り出し先。入れ子の（補足）を含む。新規）"):
            with self.subTest(scope=scope):
                self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_new_chain_and_new_remark_cover_a_list_but_not_a_separate_item_with_its_own_remark(self):
        cases = {
            "新規 packages/ui/src/x.ts・y.ts": [],
            "新規 packages/ui/src/x.ts・新規 packages/ui/src/y.ts": [],
            "packages/ui/src/x.ts・y.ts（どちらも新規）": [],
            "packages/ui/src/x.ts・y.ts（新規）": [],
            "packages/ui/src/x.ts、packages/ui/src/y.ts（いずれも新規）": [],
            "packages/ui/src/x.ts、packages/ui/src/y.ts（新規）": ["packages/ui/src/x.ts"],
            "packages/ui/src/x.ts（既存の説明）・y.ts（新規）": ["packages/ui/src/x.ts"],
            "packages/ui/src/x.ts（既存の説明）、packages/ui/src/y.ts（いずれも新規）": ["packages/ui/src/x.ts"],
        }
        for scope, expected in cases.items():
            with self.subTest(scope=scope):
                self.assertEqual(self.missing(make_instruction(scope)), expected)

    def test_a_path_marked_new_anywhere_is_exempt_everywhere(self):
        scope = "新規 packages/ui/src/x.ts、packages/ui/src/other.ts と、packages/ui/src/x.ts のテスト"
        self.assertEqual(self.missing(make_instruction(scope)), ["packages/ui/src/other.ts"])

    def test_agents_folder_other_scratchpad_and_unknown_roots_are_not_checked(self):
        scope = ("scratchpad/claude/agents/w/progress.md と scratchpad/claude/instructions/other.md、W14/W14b の成果、"
                 "src/nope.ts と foo/bar.ts と https://example.com/packages/x.ts と C:/Users/x/packages/y.ts")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_words_inside_a_backticked_command_are_not_paths(self):
        scope = "packages/io/src/a.ts（実在の名前は `rg -l \"packages/io/src/nope.ts\" packages/io/src --glob \"*.ts\"` で確かめる）"
        self.files("packages/io/src/a.ts")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_quoted_words_of_an_rg_without_backticks_are_exempt_but_the_rest_of_the_line_is_checked(self):
        self.files("packages/io/src/a.ts")
        scope = ("packages/io/src/a.ts（実在の名前は rg -l \"packages/io/src/nope.ts\" packages/io/src --glob '*.ts' で確かめる。"
                 "packages/io/src/after.ts は読むだけ）")
        self.assertEqual(self.missing(make_instruction(scope)), ["packages/io/src/after.ts"])

    def test_a_quote_outside_an_rg_command_is_still_checked(self):
        self.assertEqual(self.missing(make_instruction("'packages/io/src/quoted.ts' を直す")), ["packages/io/src/quoted.ts"])

    def test_ellipsis_and_build_output_folders_are_not_paths_that_must_exist(self):
        self.files("packages/model/src/a.ts")
        scope = ("packages/model/src/... と packages/.../x.ts と apps/desktop/out/make/x.exe と e2e/node_modules と "
                 "packages/ui/dist/a.js")
        self.assertEqual(self.missing(make_instruction(scope)), [])
        # scripts/build は製品の道具の置き場(ビルドの出力ではない)なので、build は生成物の扱いにしない
        self.assertEqual(self.missing(make_instruction("scripts/build/nosuchtool.mjs")), ["scripts/build/nosuchtool.mjs"])

    def test_placeholders_in_angle_brackets_are_not_paths(self):
        self.assertEqual(self.missing(make_instruction("packages/<名前>/src/<ファイル>.ts と docs/<日付>.md")), [])

    def test_a_japanese_file_name_cut_at_its_first_non_ascii_letter_is_found_by_its_prefix(self):
        # 経路の切り出しは ASCII の範囲で切れる(docs/2026-09-23-Claude まで)。同じ名前で始まる実在の名前があれば実在とみなす。
        self.files("docs/2026-09-23-Claudeへの申し送り.md")
        self.assertEqual(self.missing(make_instruction("docs/2026-09-23-Claudeへの申し送り.md は読むだけ")), [])
        self.assertEqual(self.missing(make_instruction("docs/2026-09-24-Claudeへの申し送り.md は読むだけ")),
                         ["docs/2026-09-24-Claude"])

    def test_the_prefix_rule_needs_a_japanese_letter_right_after_the_token(self):
        self.files("packages/io/src/abc.ts")
        self.assertEqual(self.missing(make_instruction("packages/io/src/ab を直す")), ["packages/io/src/ab"])
        self.assertEqual(self.missing(make_instruction("packages/io/src/ab（直す）")), ["packages/io/src/ab"])
        self.assertEqual(self.missing(make_instruction("packages/io/src/abを直す")), [])

    def test_the_prefix_rule_does_not_hide_a_wrong_extension(self):
        self.files("packages/io/src/a.tsx")
        self.assertEqual(self.missing(make_instruction("packages/io/src/a.tsの追加")), ["packages/io/src/a.ts"])

    # --- 裸の名前(スラッシュ無し)は、直前の対象の語に一覧でつながる時だけ ---

    def test_bare_name_joined_by_nakaguro_is_checked_in_the_folder_of_the_previous_path(self):
        self.files("packages/model/src/measure/strengthMaterials.ts")
        scope = "packages/model/src/measure/strengthMaterials.ts・strengthMaterialTypes.ts（型の追加）"
        self.assertEqual(self.missing(make_instruction(scope)), ["packages/model/src/measure/strengthMaterialTypes.ts"])
        message = next(m for m in self.errors(make_instruction(scope)) if self.MARK in m)
        self.assertIn("一覧の続きの `strengthMaterialTypes.ts` を直前の語のフォルダーで補った", message)
        self.files("packages/model/src/measure/strengthMaterialTypes.ts")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_bare_name_after_a_remark_and_a_comma_continues_the_list(self):
        self.files("packages/model/src/assembly/standard/sections.ts")
        scope = ("packages/model/src/assembly/standard/sections.ts（`H_BEAM_TABLE` に 46 行の加法追加。入れ子（括弧）を含む）、"
                 "steelCatalogOracle.ts（oracle の fixture を足す）")
        self.assertEqual(self.missing(make_instruction(scope)),
                         ["packages/model/src/assembly/standard/steelCatalogOracle.ts"])

    def test_a_word_given_only_as_a_place_marker_needs_only_its_folder(self):
        # 「X と同じフォルダーの …」「e2e/tests/cutFlow.ts 系」は、その名前のファイルを編集するとは書いていない(実在の指示書で多用)。
        self.files("packages/model/src/assembly/standard/sections.ts", "e2e/tests/cut.spec.ts")
        for scope in (
            "packages/model/src/assembly/standard/sections.ts（加法追加）、steelCatalogOracle.ts と同じフォルダーの oracle の fixture",
            "packages/model/src/assembly/standard/steelCatalogOracle.ts と同じフォルダーの fixture",
            "packages/model/src/assembly/standard/steelCatalogOracle.ts と同じ場所に",
            "画面検査 e2e/tests/cutFlow.ts 系（実在の名前は `rg -l \"cut\" e2e/tests --glob \"*.ts\"` で確かめる）",
            "e2e/tests/cutFlow.ts系",
            "e2e/tests/cut.spec.ts の隣に e2e/tests/cutMore.spec.ts の隣",
        ):
            with self.subTest(scope=scope):
                self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_a_place_marker_in_a_missing_folder_is_still_denied_with_the_reason(self):
        scope = "packages/model/src/nosuchdir/steelCatalogOracle.ts と同じフォルダーの fixture"
        text = make_instruction(scope)
        self.assertEqual(self.missing(text), ["packages/model/src/nosuchdir/steelCatalogOracle.ts"])
        message = next(m for m in self.errors(text) if self.MARK in m)
        self.assertIn("場所の目印の語（と同じフォルダー・系）なのでフォルダー packages/model/src/nosuchdir の実在だけを確かめたが、それも無い", message)

    def test_a_word_that_merely_looks_like_a_marker_is_still_checked(self):
        self.files("e2e/tests/cut.spec.ts")
        for scope in ("e2e/tests/cutFlow.ts を直す", "e2e/tests/cutFlow.ts の fixture（追加）", "e2e/tests/cutFlow.ts と cut.spec.ts"):
            with self.subTest(scope=scope):
                self.assertEqual(self.missing(make_instruction(scope)), ["e2e/tests/cutFlow.ts"])

    def test_bare_chain_continues_through_several_names_and_stops_at_a_gap(self):
        self.files("e2e/tests/a.spec.ts", "e2e/tests/b.spec.ts")
        scope = "e2e/tests/a.spec.ts・b.spec.ts・c.spec.ts、その flow は d.spec.ts"
        self.assertEqual(self.missing(make_instruction(scope)), ["e2e/tests/c.spec.ts"])

    def test_bare_names_that_are_not_list_items_are_not_checked(self):
        # progress.md・plan.materials・Set.size・e.g は、前のパスのフォルダーに補うと誤検出になる(走査 50 本で実測)。
        self.files("packages/ui/src/assembly/AssemblyContextReferenceForm.tsx")
        scope = ("packages/ui/src/assembly/AssemblyContextReferenceForm.tsx の最小の直し（直す前に progress.md に書く。"
                 "梁の plan.materials と Set.size を使う）、e.g. 前の担当の sections-additions-proposal.patch は読むだけ、"
                 "playwright.config.ts・期限は変えない")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_a_chained_word_without_a_file_extension_is_not_a_file(self):
        self.files("packages/ui/src/a.ts")
        self.assertEqual(self.missing(make_instruction("packages/ui/src/a.ts・e.g・Set.size・plan.materials")), [])

    def test_bare_name_found_at_the_repo_root_passes(self):
        self.files("packages/ui/src/a.ts", "package.json")
        self.assertEqual(self.missing(make_instruction("packages/ui/src/a.ts・package.json")), [])
        self.assertEqual(self.missing(make_instruction("packages/ui/src/a.ts・nosuchfile.json")),
                         ["packages/ui/src/nosuchfile.json"])

    def test_bare_name_uses_the_folder_of_the_previous_listed_path_not_of_a_path_inside_a_remark(self):
        self.files("packages/a/x.ts", "packages/b/z.ts")
        scope = "packages/a/x.ts（packages/b/z.ts を参照する）、y.ts"
        self.assertEqual(self.missing(make_instruction(scope)), ["packages/a/y.ts"])
        self.files("packages/a/y.ts")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_bare_glob_in_a_list_checks_the_folder(self):
        self.files("packages/ui/src/a.ts")
        self.assertEqual(self.missing(make_instruction("packages/ui/src/a.ts・*.test.ts")), [])
        self.files("packages/ui/src/a.test.ts")
        self.assertEqual(self.missing(make_instruction("packages/ui/src/a.ts・*.test.ts")), [])

    # --- 実在の指示書の形(2026-10-25 の③の行の抜粋。実物の scratchpad には頼らず、ここに写す) ---

    def test_real_shaped_scope_of_cycle_reject_passes(self):
        self.files("packages/model/src/assembly/contextReference.test.ts", "packages/io/src/pcad/assemblyContextReference.test.ts",
                   "e2e/tests/context-reference-cycle-open.spec.ts", "e2e/tests/context-reference-repair.spec.ts",
                   "packages/model/src/assembly/contextReference.ts", "packages/io/src/pcad/codecs/a.ts",
                   "packages/ui/src/assembly/AssemblyContextReferenceForm.tsx")
        scope = (
            "packages/model/src/assembly/contextReference.test.ts、packages/io/src/pcad/assemblyContextReference.test.ts"
            "（いずれも追加だけ。既存の期待は変えない）、e2e/tests/context-reference-cycle-open.spec.ts・"
            "context-reference-repair.spec.ts とそれらが import する flow（実在の名前は `rg -l \"context-reference|contextReference\" "
            "e2e/tests --glob \"*.ts\"` で確かめる。追加と最小の変更）、検査で製品の不具合が実際に示された場合だけ "
            "packages/model/src/assembly/contextReference.ts・packages/io/src/pcad/codecs の組立参照の codec・"
            "packages/ui/src/assembly/AssemblyContextReferenceForm.tsx の最小の直し（直す前に progress.md に落ちた検査名と根拠を書く。"
            "既存の拒否の条件は変えない）と、scratchpad/claude/agents/cl-v103-ex18-w09-cycle-reject/ 以下だけ。"
            "playwright.config.ts・期限・再試行・Firefox の許可名簿・依存・設定は変えない。")
        self.assertEqual(self.missing(make_instruction(scope)), [])

    def test_real_shaped_scope_of_sew_model_passes_and_a_deleted_file_is_found(self):
        self.files("packages/model/src/part/types.ts", "packages/model/src/part/resolvePart.ts",
                   "packages/model/src/kernelBridge/solidRequests.ts", "packages/ui/src/solid/solidCommands.ts",
                   "packages/io/src/pcad/codecs/solidBasic.ts", "packages/help-content/docs/ja/solid-combine.md",
                   "packages/kernel/src/index.ts")
        scope = (
            "packages/model/src/part/types.ts（SewFeature の参照を「面の参照（face 入力）」へ拡張する欄の追加）、"
            "packages/model/src/part/resolvePart.ts（planSew で face 入力の縫合を kernel の W14 の入口〔kind: 'sew' の faces〕へ渡す）、"
            "packages/model/src/kernelBridge/solidRequests.ts、packages/ui/src/solid/solidCommands.ts（commitSew）、"
            "packages/io/src/pcad/codecs/solidBasic.ts、対応する各 .test.ts（追加だけ）、"
            "新規 e2e/tests/ex18-surface-sew-solid.spec.ts とその flow（書くだけ。`diag.py e2e -- --list` で登録を確かめる）、"
            "packages/help-content/docs/ja/solid-combine.md（内部用語を書かない）と、"
            "scratchpad/claude/agents/cx-v103-ex18-w15a-sew-model/ 以下だけ。packages/kernel（W14/W14b の成果）は読むだけ。")
        self.assertEqual(self.missing(make_instruction(scope)), [])
        self.assertEqual(self.missing(make_instruction(scope.replace("solidCommands.ts", "solidCommandsOld.ts"))),
                         ["packages/ui/src/solid/solidCommandsOld.ts"])

    # --- 他の検査・本体との関係 ---

    def test_checks_one_to_six_and_the_old_checks_still_run_beside_check_seven(self):
        self.files("already.txt")
        text = make_instruction("packages/model/src/part/types.ts・nope.ts", "新規 `already.txt`\n")
        messages = self.errors(text)
        self.assertTrue(any("`already.txt` が既に存在する" in m for m in messages))
        self.assertTrue(any("影響の列挙が無い" in m for m in messages))
        self.assertTrue(any(self.MARK in m for m in messages))

    def test_documents_without_scope_line_or_instruction_title_are_not_checked(self):
        text = "## 報告\n\npackages/model/src/nope.ts を直した。docs/nope.md も書いた。\n"
        self.assertEqual(self.report(text), ([], []))

    def test_instruction_title_without_scope_line_has_nothing_to_check(self):
        self.assertEqual(self.missing("# 指示書 w\n\npackages/model/src/nope.ts を直す。\n"), [])

    def test_exception_in_check_seven_becomes_a_warning_and_others_still_run(self):
        original = guard.scope_path_findings

        def boom(*args, **kwargs):
            raise RuntimeError("boom")

        guard.scope_path_findings = boom
        try:
            self.files("already.txt")
            errors, warnings = self.report(make_instruction("packages/model/src/nope.ts", "新規 `already.txt`\n"))
        finally:
            guard.scope_path_findings = original
        self.assertTrue(any("`already.txt` が既に存在する" in m for m in errors))
        self.assertFalse(any(self.MARK in m for m in errors))
        self.assertIn("③のパスの実在", self.joined(warnings))
        self.assertIn("内部の例外", self.joined(warnings))

    def test_hook_denies_a_launch_whose_scope_names_a_missing_file(self):
        self.write("scratchpad/claude/instructions/w02.md", make_instruction("packages/model/src/analysis/nope.test.ts"))
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {
            "prompt": "`scratchpad/claude/instructions/w02.md` を読む。", "description": "t"}}
        result = guard.hook(payload, self.now, root=self.root)
        self.assertIsNotNone(result)
        reason = result["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("③のパスが実在しない: packages/model/src/analysis/nope.test.ts", reason)
        self.write("packages/model/src/analysis/nope.test.ts")
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_extraction_is_shared_with_check_one_and_unchanged(self):
        # 検査 1・4・5 が使う _path_entries は、検査 7 の切り出し(_path_entry_spans)の重複を落とした語の一覧そのもの。
        text = ("packages/io/src/a.ts・b.ts（W14/W14b の成果）、./e2e/tests/c.spec.ts と packages/kernel/ と "
                "`rg -l \"x\" packages/nope`、packages/*/src/*.test.ts。 e.g. docs/plans/p.md. 最後の x.json と packages/kernel/ をもう一度")
        # 期待は、検査 7 の追加の前の _path_entries の出力そのもの(裸の「e.g」を前のフォルダーで補う癖も含めて不変)。
        expected = [
            "packages/io/src/a.ts", "packages/io/src/b.ts", "W14/W14b", "e2e/tests/c.spec.ts", "packages/kernel/",
            "packages/*/src/*.test.ts", "packages/*/src/e.g", "docs/plans/p.md", "docs/plans/x.json",
        ]
        self.assertEqual(guard._path_entries(text), expected)
        spans = guard._path_entry_spans(text)
        deduped: list[str] = []
        for entry, _token, _start, _end, _bare in spans:
            if entry not in deduped:
                deduped.append(entry)
        self.assertEqual(deduped, expected)
        for _entry, token, start, end, bare in spans:
            written = text[start:end]
            self.assertEqual(written[2:] if written.startswith("./") else written, token)
            self.assertEqual(bare, "/" not in token)

    def test_speed_for_a_long_scope_with_two_hundred_paths(self):
        paths = [f"packages/model/src/part/file{number:03d}.ts" for number in range(200)]
        scope = "、".join(f"{path}（説明 {number}）" for number, path in enumerate(paths))
        text = make_instruction(scope)
        started = time.perf_counter()
        messages = self.missing(text)
        elapsed = time.perf_counter() - started
        self.assertEqual(len(messages), 200)
        self.assertLess(elapsed, 3.0, f"{elapsed:.2f} 秒")


class UnionTableTests(NewChecksBase):
    """検査8: union 型の固定の表(2026-10-25 03:19 の EX-03 W8 の停止。SteelCondition に値を足す包みが、その値を鍵にした表を持つ
    2 ファイルを③に入れず「触らない:」に書いた)。表のファイルは型の名前を書かない(as const の表を item.condition で引く)ので、
    検査 1 の参照の一覧には入らず、値で探す。"""

    materialize_scope = False

    MARK = "の値を鍵にした固定の表を持つ "
    CATALOG = "packages/model/src/steel/catalog.ts"
    PANEL = "packages/ui/src/panel/Panel.tsx"
    CSV = "packages/ui/src/panel/csv.ts"
    UNION_SOURCE = (
        "export type Cond = 'hotRolled-x'\n"
        "  | 'brightBar-x' | 'blackPipe-x';\n"
        "export interface Row { readonly condition: Cond }\n")
    PANEL_TABLE = (
        "const LABELS = {\n"
        "  'hotRolled-x': 'assembly.hot',\n"
        "  'brightBar-x': 'assembly.bright',\n"
        "  'blackPipe-x': 'assembly.black',\n"
        "} as const;\n"
        "export const label = (condition: keyof typeof LABELS) => LABELS[condition];\n")
    CSV_TABLE = "export const CONDITIONS = { \"hotRolled-x\": 'a', \"brightBar-x\": 'b', \"blackPipe-x\": 'c' } as const;\n"

    def setUp(self):
        super().setUp()
        self.write(self.CATALOG, self.UNION_SOURCE)
        self.write(self.PANEL, self.PANEL_TABLE)
        self.write(self.CSV, self.CSV_TABLE)
        self.write("packages/model/src/steel/reader.ts", "import type { Cond } from './catalog';\nexport const read = (c: Cond) => c;\n")

    def instruction(self, scope: str = CATALOG, extra: str = "", identifiers: str = "Cond") -> str:
        return make_instruction(f"{scope}・packages/model/src/steel/reader.ts", impact_section(identifiers, extra))

    def flagged(self, text: str) -> list[str]:
        """検査 8 の外れだけを、表のファイルのパスで返す(出現の順)。"""
        return [m.split(self.MARK, 1)[1].split(" が③に無い", 1)[0] for m in self.errors(text) if self.MARK in m]

    def line_of_identifiers(self, text: str, name: str = "Cond") -> int:
        return next(number for number, line in enumerate(text.splitlines(), start=1) if "対象の識別子" in line and name in line)

    # --- 外れになる例 ---

    def test_table_files_written_only_under_notouch_are_denied_with_the_exact_message(self):
        # 本物の W8 の再現: 触らないに書いても通らない。表のファイルは型の名前を書かない。
        self.assertNotIn("Cond", self.PANEL_TABLE + self.CSV_TABLE)
        extra = "- 触らない: packages/ui/src/panel/（表示表。読むだけ）\n"
        text = self.instruction(extra=extra)
        self.assertEqual(self.flagged(text), [self.PANEL, self.CSV])
        line = self.line_of_identifiers(text)
        messages = [m for m in self.errors(text) if self.MARK in m]
        self.assertEqual(messages[0], (
            f"x.md 行{line}: 影響の列挙: union 型 Cond の値を鍵にした固定の表を持つ {self.PANEL} が③に無い"
            "(触らないに書いても通らない。値を足すと TS7053 になる。rules/06 §10.423)"))

    def test_table_files_not_mentioned_at_all_are_denied(self):
        self.assertEqual(self.flagged(self.instruction()), [self.PANEL, self.CSV])

    def test_record_typed_table_in_a_file_naming_the_type_is_denied(self):
        self.write("packages/ui/src/typed/Typed.tsx",
                   "import type { Cond } from '../x';\nexport const T: Record<Cond, number> = build();\n")
        self.write("packages/ui/src/typed/Mapped.ts",
                   "import type { Cond } from '../x';\nexport type M = { [key in Cond]: number };\n")
        self.write("packages/ui/src/typed/Wrapped.ts",
                   "import type { Cond } from '../x';\nexport const W = {} satisfies Readonly<Record<\n  Cond,\n  string>>;\n")
        flagged = self.flagged(self.instruction(scope=f"{self.CATALOG}・{self.PANEL}・{self.CSV}"))
        self.assertEqual(sorted(flagged), [
            "packages/ui/src/typed/Mapped.ts", "packages/ui/src/typed/Typed.tsx", "packages/ui/src/typed/Wrapped.ts"])

    def test_partial_record_and_optional_mapped_type_do_not_need_every_value(self):
        self.write("packages/ui/src/typed/Partial.ts",
                   "import type { Cond } from '../x';\nexport const P: Partial<Record<Cond, number>> = {};\n"
                   "export type O = { [key in Cond]?: number };\n")
        flagged = self.flagged(self.instruction(scope=f"{self.CATALOG}・{self.PANEL}・{self.CSV}"))
        self.assertEqual(flagged, [])

    def test_a_record_of_another_type_with_a_similar_name_is_not_a_table(self):
        self.write("packages/ui/src/typed/Other.ts",
                   "import type { CondExtra } from '../x';\nexport const P: Record<CondExtra, number> = {};\n")
        self.assertEqual(self.flagged(self.instruction(scope=f"{self.CATALOG}・{self.PANEL}・{self.CSV}")), [])

    def test_the_declaring_file_is_checked_like_any_other_file(self):
        self.write(self.CATALOG, self.UNION_SOURCE + "export const NAMES = {\n  'hotRolled-x': 1, 'brightBar-x': 2, 'blackPipe-x': 3,\n};\n")
        text = make_instruction(f"{self.PANEL}・{self.CSV}", impact_section("Cond"))
        self.assertEqual(self.flagged(text), [self.CATALOG])

    # --- 通る例(③にある・表ではない) ---

    def test_table_files_inside_the_scope_pass(self):
        text = self.instruction(scope=f"{self.CATALOG}・{self.PANEL}・{self.CSV}")
        self.assertEqual(self.flagged(text), [])

    def test_a_folder_or_a_glob_in_the_scope_covers_the_table_files(self):
        for scope in (f"{self.CATALOG}・packages/ui/src/panel/", f"{self.CATALOG}・packages/ui/src/panel/*.ts*"):
            with self.subTest(scope=scope):
                self.assertEqual(self.flagged(self.instruction(scope=scope)), [])

    def test_a_scope_file_listed_as_new_still_counts_as_in_scope(self):
        text = self.instruction(scope=f"{self.CATALOG}・{self.PANEL}、新規 {self.CSV}")
        self.assertEqual(self.flagged(text), [])

    def test_fewer_than_two_keys_pass(self):
        self.write(self.PANEL, "const ONE = { 'hotRolled-x': 'a', other: 'b' } as const;\n")
        self.write(self.CSV, "const NONE = { first: 1, second: 2 };\nexport const v = 'hotRolled-x';\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_a_table_with_only_some_of_the_values_passes_because_indexing_by_the_union_needs_every_one(self):
        # 規則の調整(指示書の「2 つ以上」から「全ての値」へ): union で引く表は全ての値を鍵に持たないと今でも型エラーになる。
        self.write(self.PANEL, "const TWO = { 'hotRolled-x': 'a', 'brightBar-x': 'b' };\n")
        self.write(self.CSV, "export const NONE = 1;\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_an_object_with_the_values_plus_other_keys_is_not_the_table(self):
        self.write(self.PANEL, "const MORE = { 'hotRolled-x': 1, 'brightBar-x': 2, 'blackPipe-x': 3, extra: 4 };\n")
        self.write(self.CSV, "export const NONE = 1;\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_keys_spread_over_different_objects_are_not_a_table(self):
        self.write(self.PANEL, "const A = { 'hotRolled-x': 1 };\nconst B = { 'brightBar-x': 2 };\nconst C = { 'blackPipe-x': 3 };\n")
        self.write(self.CSV, "export const NONE = 1;\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_a_table_nested_inside_another_object_is_found(self):
        self.write(self.PANEL, "export const UI = {\n  title: 't',\n  labels: {\n    'hotRolled-x': 'a',\n"
                               "    'brightBar-x': 'b',\n    'blackPipe-x': 'c',\n  },\n};\n")
        self.write(self.CSV, "export const NONE = 1;\n")
        self.assertEqual(self.flagged(self.instruction()), [self.PANEL])

    def test_keys_in_comments_strings_and_function_parameters_are_not_table_keys(self):
        # コメントと文字列が {…} の中にある形(表の中に消した行・埋め込みの文)。鍵に数えれば、ちょうど値の集合の表に見える。
        body = (
            "export const A = {\n  /*\n  'hotRolled-x': 1,\n  'brightBar-x': 2,\n  'blackPipe-x': 3,\n  */\n};\n"
            "export const B = {\n  q: `\n  'hotRolled-x': 1,\n  'brightBar-x': 2,\n  'blackPipe-x': 3,\n  `,\n};\n")
        self.write(self.PANEL, body)
        self.write(self.CSV, "export function f(\n  'hotRolled-x': number,\n  'brightBar-x': number,\n  'blackPipe-x': number,\n) {}\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_ternary_and_case_labels_are_not_keys(self):
        self.write(self.PANEL, "export const f = (c: string) => {\n  switch (c) {\n    case 'hotRolled-x': return 1;\n"
                               "    case 'brightBar-x': return 2;\n    case 'blackPipe-x': return 3;\n    default: return 0;\n  }\n};\n"
                               "export const g = (c: string) => c === 'hotRolled-x' ? 'a' : c === 'brightBar-x' ? 'b' : 'blackPipe-x';\n")
        self.write(self.CSV, "export const NONE = 1;\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_value_tables_in_e2e_specs_and_in_non_typescript_files_are_ignored_but_a_typed_record_in_e2e_is_not(self):
        self.write("e2e/tests/copy.spec.ts", self.PANEL_TABLE)
        self.write("packages/ui/src/panel/fixture.json", "{ \"hotRolled-x\": 1, \"brightBar-x\": 2, \"blackPipe-x\": 3 }\n")
        self.write("packages/ui/src/panel/notes.md", self.PANEL_TABLE)
        self.write(self.PANEL, "export const NONE = 1;\n")
        self.write(self.CSV, "export const NONE = 1;\n")
        self.assertEqual(self.flagged(self.instruction()), [])
        self.write("e2e/tests/typed.spec.ts", "import type { Cond } from 'x';\nconst T: Record<Cond, number> = build();\n")
        self.assertEqual(self.flagged(self.instruction()), ["e2e/tests/typed.spec.ts"])

    # --- union の書き方 ---

    def test_declaration_forms_are_recognised(self):
        forms = {
            "one line": "export type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x';\n",
            "leading bar and comments": "export type Cond =\n  // 熱間圧延\n  | 'hotRolled-x'\n  /* 光沢 */ | 'brightBar-x'\n  | 'blackPipe-x'; // 黒管\n",
            "double quotes": "export type Cond = \"hotRolled-x\" | \"brightBar-x\" | \"blackPipe-x\";\n",
            "backticks": "export type Cond = `hotRolled-x` | `brightBar-x` | `blackPipe-x`;\n",
            "declare": "export declare type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x';\n",
            "followed by code": "export type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x'\nexport const z = 1;\n",
        }
        for label, source in forms.items():
            with self.subTest(form=label):
                self.write(self.CATALOG, source)
                self.assertEqual(self.flagged(self.instruction()), [self.PANEL, self.CSV])

    def test_declarations_that_are_not_a_plain_string_union_are_not_targets(self):
        not_unions = {
            "interface": "export interface Cond { 'hotRolled-x': string; 'brightBar-x': string; 'blackPipe-x': string }\n",
            "numbers": "export type Cond = 1 | 2 | 3;\n",
            "mixed with a type reference": "export type Cond = 'hotRolled-x' | 'brightBar-x' | Other;\n",
            "with undefined": "export type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x' | undefined;\n",
            "single literal": "export type Cond = 'hotRolled-x';\n",
            "generic": "export type Cond<T> = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x';\n",
            "array of a union": "export type Cond = ('hotRolled-x' | 'brightBar-x' | 'blackPipe-x')[];\n",
            "array of the last member": "export type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x'[];\n",
            "intersection": "export type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x' & Other;\n",
            "template literal": "export type Cond = `hot-${string}` | 'brightBar-x' | 'blackPipe-x';\n",
            "typeof array": "const ALL = ['hotRolled-x', 'brightBar-x', 'blackPipe-x'] as const;\nexport type Cond = typeof ALL[number];\n",
            "not exported": "type Cond = 'hotRolled-x' | 'brightBar-x' | 'blackPipe-x';\n",
            "a value constant": "export const Cond = 'hotRolled-x' as 'hotRolled-x' | 'brightBar-x';\n",
        }
        self.write("packages/ui/src/panel/One.ts", "export const ONE = { 'hotRolled-x': 1 };\n")  # 値が 1 つだけの表
        for label, source in not_unions.items():
            with self.subTest(declaration=label):
                self.write(self.CATALOG, source)
                self.assertEqual(self.flagged(self.instruction()), [])

    def test_an_identifier_without_a_declaration_is_not_a_target(self):
        self.write(self.CATALOG, "export const x = 1;\n")
        self.write("packages/ui/src/typed/Typed.tsx", "const T: Record<Cond, number> = build();\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    def test_only_the_listed_identifiers_are_looked_at(self):
        self.assertEqual(self.flagged(self.instruction(identifiers="Row")), [])
        self.assertEqual(self.flagged(self.instruction(identifiers="Row, Cond")), [self.PANEL, self.CSV])

    def test_documents_without_the_impact_section_are_not_scanned_for_tables(self):
        text = make_instruction(f"{self.CATALOG}・packages/model/src/steel/reader.ts", "## 1. 目的\n\n値を足す。\n")
        self.assertEqual(self.flagged(text), [])

    # --- 一般的な語・件数の上限 ---

    def test_a_value_set_that_many_unrelated_objects_share_is_not_searched_by_value(self):
        self.write("packages/model/src/geo/axis.ts", "export type Axis = 'x' | 'y' | 'z';\n")
        for number in range(9):
            self.write(f"packages/ui/src/geo/vec{number}.ts", "export const P = { x: 1, y: 2, z: 3 };\n")
        text = make_instruction("packages/model/src/geo/axis.ts", impact_section("Axis"))
        errors, warnings = self.report(text)
        self.assertEqual([m for m in errors if self.MARK in m], [])
        message = self.joined(warnings)
        self.assertIn("一般的な語とみなして型の名前を書かない表は探していない", message)
        self.assertIn("9 個のファイル", message)
        self.assertIn("Record<Axis,…> の表は探した", message)

    def test_a_value_set_in_a_few_files_is_still_searched_by_value(self):
        self.write("packages/model/src/geo/axis.ts", "export type Axis = 'x' | 'y' | 'z';\n")
        for number in range(8):
            self.write(f"packages/ui/src/geo/vec{number}.ts", "export const P = { x: 1, y: 2, z: 3 };\n")
        text = make_instruction("packages/model/src/geo/axis.ts", impact_section("Axis"))
        self.assertEqual(len(self.flagged(text)), 8)

    def test_a_generic_value_set_still_finds_typed_tables(self):
        self.write("packages/model/src/geo/axis.ts", "export type Axis = 'x' | 'y' | 'z';\n")
        for number in range(9):
            self.write(f"packages/ui/src/geo/vec{number}.ts", "export const P = { x: 1, y: 2, z: 3 };\n")
        self.write("packages/ui/src/geo/typed.ts", "import type { Axis } from 'a';\nexport const T: Record<Axis, string> = build();\n")
        text = make_instruction("packages/model/src/geo/axis.ts", impact_section("Axis"))
        self.assertEqual(self.flagged(text), ["packages/ui/src/geo/typed.ts"])

    def test_too_many_candidate_files_are_a_warning_and_the_limit_is_adjustable(self):
        # 値を全て含む .ts/.tsx は、宣言のファイル・表の 2 ファイル・下の 3 ファイルの 6 個。上限ちょうどなら探す(6 個目まで)。
        for number in range(3):
            self.write(f"packages/ui/src/many/m{number}.ts", "// hotRolled-x brightBar-x blackPipe-x\n")
        text = self.instruction()
        original = guard.UNION_CANDIDATE_LIMIT
        try:
            guard.UNION_CANDIDATE_LIMIT = 6
            at_limit_errors, at_limit_warnings = self.report(text)
            guard.UNION_CANDIDATE_LIMIT = 5
            over_errors, over_warnings = self.report(text)
        finally:
            guard.UNION_CANDIDATE_LIMIT = original
        self.assertEqual(len([m for m in at_limit_errors if self.MARK in m]), 2)
        self.assertNotIn("を全て含むファイルが", self.joined(at_limit_warnings))
        self.assertIn("を全て含むファイルが 6 個あり", self.joined(over_warnings))
        self.assertEqual([m for m in over_errors if self.MARK in m], [])

    def test_an_incomplete_value_scan_is_a_warning_and_not_an_error(self):
        original = guard.find_references
        calls = []

        def second_scan_times_out(root, identifiers, seconds, invocation="auto", use_cache=True):
            calls.append(list(identifiers))
            result, complete = original(root, identifiers, seconds, invocation, use_cache)
            return ({name: [] for name in identifiers}, False) if len(calls) == 2 else (result, complete)

        guard.find_references = second_scan_times_out
        try:
            errors, warnings = self.report(self.instruction())
        finally:
            guard.find_references = original
        self.assertEqual(len(calls), 2)
        self.assertEqual([m for m in errors if self.MARK in m], [])
        self.assertIn("union 型の値の走査が", self.joined(warnings))
        self.assertIn("一部未確認", self.joined(warnings))

    def test_a_longer_type_name_that_starts_with_the_identifier_is_not_the_declaration(self):
        self.write(self.CATALOG, "export type CondOther = 'p-1' | 'q-1';\n")
        self.write("packages/ui/src/panel/Other.ts", "export const OTHER = { 'p-1': 1, 'q-1': 2 };\n")
        self.assertEqual(self.flagged(self.instruction()), [])

    # --- 文言・行番号・まとめ方 ---

    def test_the_line_number_is_the_line_that_lists_the_union(self):
        text = make_instruction(self.CATALOG, "## 影響の列挙\n\n- 対象の識別子: Row\n- 対象の識別子: Cond\n")
        line = self.line_of_identifiers(text, "Cond")
        self.assertNotEqual(line, self.line_of_identifiers(text, "Row"))
        messages = [m for m in self.errors(text) if self.MARK in m]
        self.assertEqual(len(messages), 2)
        self.assertTrue(all(m.startswith(f"x.md 行{line}: ") for m in messages))

    def test_two_unions_in_one_file_are_reported_once_each(self):
        self.write("packages/model/src/steel/verify.ts", "export type Verify = 'verified' | 'unverified' | 'pending';\n")
        self.write(self.PANEL, self.PANEL_TABLE + "const V = { verified: 1, unverified: 2, pending: 3 };\n")
        text = make_instruction(
            f"{self.CATALOG}・packages/model/src/steel/verify.ts", impact_section("Cond, Verify"))
        messages = [m for m in self.errors(text) if self.MARK in m]
        self.assertEqual(len(messages), 3)
        self.assertEqual(sum(1 for m in messages if "union 型 Cond " in m), 2)
        self.assertEqual(sum(1 for m in messages if "union 型 Verify " in m and self.PANEL in m), 1)

    def test_a_file_found_by_both_rules_is_reported_once(self):
        self.write(self.PANEL, self.PANEL_TABLE + "import type { Cond } from 'x';\nconst R: Record<Cond, number> = build();\n")
        self.assertEqual(self.flagged(self.instruction()).count(self.PANEL), 1)

    def test_the_same_declaration_in_two_files_does_not_duplicate_the_findings(self):
        self.write("packages/kernel/src/steel/catalog2.ts", self.UNION_SOURCE)
        text = self.instruction(scope=f"{self.CATALOG}・packages/kernel/src/steel/catalog2.ts")
        self.assertEqual(self.flagged(text), [self.PANEL, self.CSV])

    # --- 他の検査・走査との関係 ---

    def test_check_one_and_check_eight_report_independently(self):
        # reader.ts は型の名前を書くので検査 1 の対象(③に入れない)、表の 2 ファイルは検査 8 の対象。
        text = make_instruction(self.CATALOG, impact_section("Cond"))
        messages = self.errors(text)
        self.assertTrue(any("識別子 `Cond` を参照する" in m and "reader.ts" in m for m in messages))
        self.assertEqual(self.flagged(text), [self.PANEL, self.CSV])

    def test_the_scan_of_check_one_is_reused_and_only_one_value_scan_is_added(self):
        calls: list[list[str]] = []
        original = guard.find_references

        def counting(root, identifiers, seconds, invocation="auto", use_cache=True):
            calls.append(list(identifiers))
            return original(root, identifiers, seconds, invocation, use_cache)

        guard.find_references = counting
        try:
            self.errors(self.instruction())
            with_union = list(calls)
            calls.clear()
            self.errors(self.instruction(identifiers="Row"))
            without_union = list(calls)
            calls.clear()
            self.errors(make_instruction(self.CATALOG, "## 1. 目的\n\n普通の修正。\n"))
            without_section = list(calls)
        finally:
            guard.find_references = original
        self.assertEqual(with_union, [["Cond"], ["hotRolled-x", "brightBar-x", "blackPipe-x"]])
        self.assertEqual(without_union, [["Row"]])
        self.assertEqual(without_section, [])

    def test_an_exception_in_check_eight_becomes_a_warning_and_the_others_still_run(self):
        original = guard.union_table_findings

        def boom(*args, **kwargs):
            raise RuntimeError("boom")

        guard.union_table_findings = boom
        try:
            errors, warnings = self.report(make_instruction(self.CATALOG, impact_section("Cond")))
        finally:
            guard.union_table_findings = original
        self.assertTrue(any("識別子 `Cond` を参照する" in m for m in errors))
        self.assertFalse(any(self.MARK in m for m in errors))
        self.assertIn("union 型の固定の表", self.joined(warnings))
        self.assertIn("内部の例外", self.joined(warnings))

    def test_a_scan_that_ran_out_of_time_is_not_an_error(self):
        errors, warnings = self.report(self.instruction(), scan_seconds=-1.0)
        self.assertFalse(any(self.MARK in m for m in errors))
        self.assertFalse(any("内部の例外" in m for m in warnings))

    def test_report_like_documents_are_not_checked(self):
        text = "## 報告\n\n対象の識別子: Cond\n\npackages/ui/src/panel/Panel.tsx を直した。\n"
        self.assertEqual(self.report(text), ([], []))

    def test_the_hook_denies_a_launch_whose_scope_misses_a_table_and_allows_it_once_added(self):
        extra = ("- 触らない: packages/ui/src/panel/（表示表。読むだけ）\n\n"
                 "画面を変えるので controlInventory.test.ts と topics.test.ts を流す。\n")
        self.write("scratchpad/claude/instructions/union.md", self.instruction(extra=extra))
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {
            "prompt": "`scratchpad/claude/instructions/union.md` を読む。", "description": "t"}}
        result = guard.hook(payload, self.now, root=self.root)
        self.assertIsNotNone(result)
        reason = result["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn(f"union 型 Cond の値を鍵にした固定の表を持つ {self.PANEL} が③に無い", reason)
        self.write("scratchpad/claude/instructions/union.md",
                   self.instruction(scope=f"{self.CATALOG}・{self.PANEL}・{self.CSV}", extra=extra))
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_many_candidate_files_stay_fast(self):
        for number in range(140):
            self.write(f"packages/ui/src/many/m{number:03d}.ts", "// hotRolled-x brightBar-x blackPipe-x\nexport const n = " + str(number) + ";\n")
        started = time.perf_counter()
        flagged = self.flagged(self.instruction())
        elapsed = time.perf_counter() - started
        self.assertEqual(flagged, [self.PANEL, self.CSV])
        self.assertLess(elapsed, 3.0, f"{elapsed:.2f} 秒")

    def test_the_value_scan_goes_through_ripgrep_when_it_is_available(self):
        fake = self.write("fake_rg.py", FAKE_RG)
        log = self.root / "fake_rg.log"
        invocation = ([sys.executable, str(fake)], {"FAKE_RG_LOG": str(log)})
        self.assertEqual(self.flagged_with(self.instruction(), invocation), [self.PANEL, self.CSV])
        calls = log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(calls), 4)
        for call, needle in zip(calls, ("Cond", "hotRolled-x", "brightBar-x", "blackPipe-x")):
            self.assertIn(f"--fixed-strings", call)
            self.assertIn(f"-e {needle} -- ", call)

    def test_embedded_real_ripgrep_agrees_with_the_python_scan_for_check_eight(self):
        real = embedded_rg()
        if real is None:
            self.skipTest("同梱の ripgrep(CLAUDE_CODE_EXECPATH)が無い環境")
        text = self.instruction()
        self.assertEqual(self.flagged_with(text, real), self.flagged_with(text, None))
        self.assertEqual(self.flagged_with(text, real), [self.PANEL, self.CSV])

    def flagged_with(self, text: str, invocation) -> list[str]:
        errors, _ = guard.check_instruction_report(self.root, "x.md", text, self.now, invocation=invocation)
        return [m.split(self.MARK, 1)[1].split(" が③に無い", 1)[0] for m in errors if self.MARK in m]


class ReportContractTests(NewChecksBase):
    """検査どうしの独立・既存の検査との共存・フックの出口。"""

    def test_exception_in_a_new_check_becomes_a_warning_and_old_checks_still_run(self):
        (self.root / "already.txt").write_text("x", encoding="utf-8")
        text = make_instruction("packages/model/src/a.ts", "新規 `already.txt`\n")
        original = guard.citation_findings

        def boom(*args, **kwargs):
            raise RuntimeError("boom")

        guard.citation_findings = boom
        try:
            errors, warnings = self.report(text)
        finally:
            guard.citation_findings = original
        self.assertIn("`already.txt` が既に存在する", self.joined(errors))
        self.assertIn("期待値の出典", self.joined(warnings))
        self.assertIn("内部の例外", self.joined(warnings))

    def test_report_like_document_without_scope_line_or_instruction_title_is_not_checked(self):
        # v103_publish_report.py は報告の下書きにも --check をかける。報告の文には「kind を足す」や
        # sources.md・SHA-256 の話が出ても、指示書の雛形(③の行・「# 指示書」の見出し)が無いので当てない。
        text = (
            "## 2026-10-25 01:00 報告\n\n"
            "新しい kind を足す包みの規約を整えた。sources.md の SHA-256 の話もした。\n\n"
            "## 2. 合格条件\n\n表示は「面による切断」。controlInventory は別の話。\n"
        )
        self.assertEqual(self.report(text), ([], []))

    def test_instruction_title_alone_enables_the_new_checks(self):
        text = "# 指示書 w\n\nsources.md と SHA-256 を使う。\n"
        self.assertIn("出典の実物が無い", self.joined(self.errors(text)))

    def test_scope_line_alone_enables_the_new_checks(self):
        text = "③ 編集してよいファイルは packages/model/src/part/types.ts だけ。\n"
        self.assertIn("影響の列挙が無い", self.joined(self.errors(text)))

    def test_existing_three_checks_still_apply_to_any_document(self):
        (self.root / "already.txt").write_text("x", encoding="utf-8")
        self.assertIn("`already.txt` が既に存在する", self.joined(self.errors("報告\n新規 `already.txt`\n")))

    def test_check_instruction_text_returns_errors_only(self):
        text = make_instruction("packages/model/src/part/types.ts")
        self.materialize(text)
        messages = guard.check_instruction_text(self.root, "x.md", text, self.now)
        self.assertEqual(len(messages), 1)
        self.assertIn("影響の列挙が無い", messages[0])

    def test_hook_denies_on_new_check_and_names_it(self):
        self.materialize(make_instruction("packages/model/src/part/types.ts"))
        self.write("scratchpad/claude/instructions/new.md", make_instruction("packages/model/src/part/types.ts"))
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {
            "prompt": "`scratchpad/claude/instructions/new.md` を読む。", "description": "t"}}
        result = guard.hook(payload, self.now, root=self.root)
        self.assertIsNotNone(result)
        reason = result["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("影響の列挙が無い", reason)

    def test_hook_allows_warning_only_instruction(self):
        body = "## 2. 合格条件（数値）\n\n1. 表示は「面による切断」になる。\n"
        self.materialize(make_instruction("packages/model/src/part/foo.ts", body))
        self.write("scratchpad/claude/instructions/warn.md", make_instruction("packages/model/src/part/foo.ts", body))
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {
            "prompt": "`scratchpad/claude/instructions/warn.md` を読む。", "description": "t"}}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))

    def test_crlf_instruction_is_parsed_like_lf(self):
        body = impact_section("SweepFeature")
        text = make_instruction("packages/model/src/part/types.ts", body).replace("\n", "\r\n")
        self.materialize(text)
        errors, warnings = self.report(text)
        self.assertEqual(errors, [])
        # 節と識別子の行が読めた証拠: 参照 0 件の警告(この一時の根には packages/*/src が無い)。
        self.assertIn("0 件", self.joined(warnings))
        path = self.write("scratchpad/claude/instructions/crlf.md", "")
        path.write_bytes(text.encode("utf-8"))
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {
            "prompt": "`scratchpad/claude/instructions/crlf.md` を読む。", "description": "t"}}
        self.assertIsNone(guard.hook(payload, self.now, root=self.root))


if __name__ == "__main__":
    unittest.main()
