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


if __name__ == "__main__":
    unittest.main()
