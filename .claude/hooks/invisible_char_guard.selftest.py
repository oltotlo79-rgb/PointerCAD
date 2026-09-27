"""Subprocess and direct-call tests for invisible_char_guard.py's JSON protocol and --scan mode.

2026-09-24 OPS-24(w35b): check.ps1 runs this selftest from a clean copy via a path that contains
"..\\" (`<copy>\\scripts\\..\\.claude\\hooks\\invisible_char_guard.selftest.py`; PowerShell's
Join-Path does not collapse ".."). Without .resolve(), __file__ would literally keep that
"scripts\\.." segment, which would not match the hook's own resolved ROOT
(`Path(__file__).resolve().parents[2]`) and break relative_to()-based comparisons. Resolve the
same way the hook itself does.

Every real invisible character used as test data below is built with chr(<hex codepoint>) -- a
plain hex *integer* literal, no backslash involved -- never with an escape-style string notation
(backslash + the letter u + four hex digits). Typing that notation directly in a Write/Edit tool
call body is exactly the anti-pattern rules/06 10.346 records: the tool layer silently replaced
such a notation with the real character it names, and no check caught it before this hook existed.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path


HOOK = Path(__file__).resolve().with_name("invisible_char_guard.py")
ROOT = HOOK.parents[2]
spec = importlib.util.spec_from_file_location("invisible_char_guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

# 実文字はすべてchr(コード点)で組み立てる(バックスラッシュ+uの表記は道具の入力に書かない)。
NBSP = chr(0x00A0)
ZWSP = chr(0x200B)
ZWNJ = chr(0x200C)
ZWJ = chr(0x200D)
LINE_SEP = chr(0x2028)
PARA_SEP = chr(0x2029)
BOM = chr(0xFEFF)
IDEOGRAPHIC_SPACE = chr(0x3000)
BACKSLASH = chr(0x5C)


def dummy_path(extension: str) -> str:
    """Writeツールの検査だけに使う、実在しなくてよい相対パス
    (scan_write()はtool=="Write"のとき対象ファイルを一切読み書きしない)。"""
    return f"scratchpad/temp/invisible-char-guard-selftest-write-dummy{extension}"


def invoke(event="PreToolUse", tool="Write", path=None, **entry):
    if path is None:
        path = dummy_path(".ts")
    data = {"hook_event_name": event, "tool_name": tool,
            "tool_input": {"file_path": path, **entry}}
    return subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                          input=json.dumps(data, ensure_ascii=False), text=True,
                          capture_output=True, cwd=ROOT, check=False, encoding="utf-8")


def run_scan(*paths):
    return subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK), "--scan",
                           *[str(p) for p in paths]],
                          text=True, capture_output=True, cwd=ROOT, check=False, encoding="utf-8")


class InvisibleCharGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_root = ROOT / "scratchpad/temp" / f"invisible-char-guard-selftest-{uuid.uuid4().hex[:8]}"
        # 2026-09-24 OPS-24(w35b): まっさらな写し(scratchpad/自体が無い環境)では
        # scratchpad/・scratchpad/temp/もこのtemp_rootと一緒に新規作成される。
        # tearDownClassでtemp_root自身をshutil.rmtreeした後、この2つの祖先も
        # 新規作成した場合だけ(深い方から)rmdirし、写しの中にscratchpad/を残さない
        # (rules/06 §10.344、record_time_guard.selftest.pyの既存の各試験と同じ形)。
        cls._created_ancestors = []
        node = cls.temp_root
        while not node.exists():
            cls._created_ancestors.append(node)
            node = node.parent
        cls.temp_root.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.temp_root, ignore_errors=True)
        for created in cls._created_ancestors[1:]:  # [0]=temp_root自身は上のrmtreeで既に消えている
            try:
                created.rmdir()
            except OSError:
                pass

    def fixture_path(self, name: str) -> Path:
        return self.temp_root / name

    def deny(self, result, expect_substring=None):
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["hookSpecificOutput"]["permissionDecision"], "deny")
        if expect_substring:
            self.assertIn(expect_substring, payload["hookSpecificOutput"]["permissionDecisionReason"])
        return payload

    def allow(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    # --- 各文字を拒否する(常時禁止の7種。U+3000は2026-09-24の追加指示で禁止から外れ、下の
    #     「通す側」節と test_ideographic_space_allowed_in_code で確認する) ---

    def test_nbsp_denied(self):
        self.deny(invoke(content=f"const x = 1;{NBSP}\n"), "U+00A0")

    def test_zero_width_space_denied(self):
        self.deny(invoke(content=f"const x = 1;{ZWSP}\n"), "U+200B")

    def test_zero_width_non_joiner_denied(self):
        self.deny(invoke(content=f"const x = 1;{ZWNJ}\n"), "U+200C")

    def test_zero_width_joiner_denied(self):
        self.deny(invoke(content=f"const x = 1;{ZWJ}\n"), "U+200D")

    def test_line_separator_denied(self):
        self.deny(invoke(content=f"const x = 1;{LINE_SEP}\n"), "U+2028")

    def test_paragraph_separator_denied(self):
        self.deny(invoke(content=f"const x = 1;{PARA_SEP}\n"), "U+2029")

    def test_bom_mid_content_denied(self):
        self.deny(invoke(content=f"const x = 1;{BOM}\n"), "U+FEFF")

    def test_ideographic_space_allowed_in_code(self):
        # 2026-09-24 追加指示: U+3000(全角スペース)は禁止から外れた
        # (ESLintのno-irregular-whitespaceが文字列の外を既に止める・文字列の中では
        # 実文字とエスケープ表記の値が同じ・commandLine.ts等が意図して使う)。
        self.allow(invoke(content=f"const x ={IDEOGRAPHIC_SPACE}1;\n"))

    def test_nbsp_denied_in_json(self):
        self.deny(invoke(path=dummy_path(".json"), content='{"a":' + NBSP + '1}'), "U+00A0")

    def test_nbsp_denied_in_markdown(self):
        self.deny(invoke(path=dummy_path(".md"), content=f"見出し{NBSP}\n"), "U+00A0")

    # --- 通す側(先頭のBOM・全角スペース(全ての対象拡張子で許可)・エスケープに見えるだけの文字列・対象外拡張子) ---

    def test_bom_at_start_allowed_via_write(self):
        self.allow(invoke(path=dummy_path(".ps1"), content=f"{BOM}Write-Host 'hi'\n"))

    def test_ideographic_space_allowed_in_markdown(self):
        self.allow(invoke(path=dummy_path(".md"), content=f"日本語の本文{IDEOGRAPHIC_SPACE}続き\n"))

    def test_ideographic_space_allowed_in_json(self):
        self.allow(invoke(path=dummy_path(".json"), content='{"note":"a' + IDEOGRAPHIC_SPACE + 'b"}'))

    def test_ideographic_space_allowed_across_all_target_extensions(self):
        # 2026-09-24 追加指示: 拡張子による分けを撤廃したので、対象9拡張子の全てで
        # 全角スペースを含む書き込みが許可されることを直接(Write経由で)確認する。
        for extension in sorted(guard.TARGET_EXTENSIONS):
            with self.subTest(extension=extension):
                self.allow(invoke(path=dummy_path(extension), content=f"x{IDEOGRAPHIC_SPACE}y\n"))

    def test_escape_lookalike_text_allowed(self):
        # バックスラッシュ・u・0・0・a・0という6個の普通の文字であり、実際のU+00A0(NBSP)
        # 1文字ではない。エスケープの見た目をしているだけの文字列を誤って拒否しない。
        lookalike = BACKSLASH + "u00a0"
        self.allow(invoke(content=f"const pattern = {lookalike};\n"))

    def test_extension_not_targeted_allowed(self):
        self.allow(invoke(path=dummy_path(".txt"),
                          content=f"x{NBSP}y{ZWSP}z{LINE_SEP}w{BOM}v{IDEOGRAPHIC_SPACE}u\n"))

    def test_non_target_extensions_allowed(self):
        for extension in (".txt", ".yml", ".yaml", ".csv", ".vue", ""):
            with self.subTest(extension=extension or "(none)"):
                self.allow(invoke(path=dummy_path(extension), content=f"x{NBSP}y\n"))

    def test_all_target_extensions_denied(self):
        for extension in sorted(guard.TARGET_EXTENSIONS):
            with self.subTest(extension=extension):
                self.deny(invoke(path=dummy_path(extension), content=f"x{NBSP}y\n"))

    # --- Edit / MultiEdit(既存ファイルを読んで現在地を追う経路) ---

    def test_edit_new_string_denied(self):
        path = self.fixture_path("edit-insert.ts")
        path.write_text("const x = 1;\n", encoding="utf-8")
        result = invoke(tool="Edit", path=str(path),
                        old_string="const x = 1;", new_string=f"const x = 1;{ZWSP}")
        self.deny(result, "U+200B")

    def test_edit_old_string_only_not_flagged(self):
        # 消える側(old_string)にだけ禁止文字があり、書く側(new_string)には無い → 通す。
        path = self.fixture_path("edit-removal.ts")
        path.write_text(f"const x = 1;{NBSP}\n", encoding="utf-8")
        result = invoke(tool="Edit", path=str(path),
                        old_string=f"const x = 1;{NBSP}", new_string="const x = 1;")
        self.allow(result)

    def test_multiedit_second_edit_denied(self):
        path = self.fixture_path("multiedit.ts")
        path.write_text("const a = 1;\nconst b = 2;\n", encoding="utf-8")
        result = invoke(tool="MultiEdit", path=str(path), edits=[
            {"old_string": "const a = 1;", "new_string": "const a = 10;"},
            {"old_string": "const b = 2;", "new_string": f"const b = 2;{ZWJ}"},
        ])
        self.deny(result, "U+200D")

    def test_multiedit_all_clean_allowed(self):
        path = self.fixture_path("multiedit-clean.ts")
        path.write_text("const a = 1;\nconst b = 2;\n", encoding="utf-8")
        result = invoke(tool="MultiEdit", path=str(path), edits=[
            {"old_string": "const a = 1;", "new_string": "const a = 10;"},
            {"old_string": "const b = 2;", "new_string": "const b = 20;"},
        ])
        self.allow(result)

    def test_bom_preserved_via_edit_when_truly_at_file_start_allowed(self):
        # ファイルが本当に先頭にBOMを持ち、編集後もそのBOMが先頭のまま残るなら許す
        # (.ps1はBOM付きが規則)。
        path = self.fixture_path("bom-preserved.ps1")
        path.write_text(f"{BOM}original text\n", encoding="utf-8")
        result = invoke(tool="Edit", path=str(path),
                        old_string=f"{BOM}original text", new_string=f"{BOM}changed text")
        self.allow(result)

    def test_bom_introduced_via_edit_not_at_file_start_denied(self):
        # old_stringがファイル先頭(位置0)ではない場所にあるとき、new_stringの先頭のBOMは
        # 「ファイル先頭のBOM」ではないので拒否する。
        path = self.fixture_path("bom-not-at-start.ps1")
        path.write_text("prefix\noriginal text\n", encoding="utf-8")
        result = invoke(tool="Edit", path=str(path),
                        old_string="original text", new_string=f"{BOM}changed text")
        self.deny(result, "U+FEFF")

    # --- 対象外の道具・イベント、壊れた入力 ---

    def test_other_tool_passthrough(self):
        data = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                "tool_input": {"command": f"echo {NBSP}"}}
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input=json.dumps(data, ensure_ascii=False), text=True,
                                capture_output=True, cwd=ROOT, encoding="utf-8")
        self.allow(result)

    def test_other_event_passthrough(self):
        data = {"hook_event_name": "PostToolUse", "tool_name": "Write",
                "tool_input": {"file_path": dummy_path(".ts"), "content": NBSP}}
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input=json.dumps(data, ensure_ascii=False), text=True,
                                capture_output=True, cwd=ROOT, encoding="utf-8")
        self.allow(result)

    def test_invalid_json_fail_open(self):
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input="{", text=True, capture_output=True, cwd=ROOT, encoding="utf-8")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("FAIL_OPEN", result.stderr)

    def test_missing_file_path_allowed(self):
        data = {"hook_event_name": "PreToolUse", "tool_name": "Write",
                "tool_input": {"content": f"x{NBSP}y"}}
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)],
                                input=json.dumps(data, ensure_ascii=False), text=True,
                                capture_output=True, cwd=ROOT, encoding="utf-8")
        self.allow(result)

    # --- 拒否理由の中身(行番号・案内文) ---

    def test_line_number_reported_correctly(self):
        payload = self.deny(invoke(content=f"line1\nline2\nline3{NBSP}end\n"))
        reason_text = payload["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("3行目", reason_text)

    def test_guidance_text_present_in_reason(self):
        payload = self.deny(invoke(content=f"x{NBSP}\n"))
        reason_text = payload["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("コードで組み立てる", reason_text)
        self.assertIn("バックスラッシュ", reason_text)

    # --- --scan (点検専用モード) ---

    def test_scan_cli_reports_and_exits_nonzero(self):
        path = self.fixture_path("scan-dirty.ts")
        path.write_text(f"line1\nline2 has {NBSP} here\n", encoding="utf-8")
        result = run_scan(path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("U+00A0", result.stdout)
        relative = str(path.relative_to(ROOT)).replace("\\", "/")
        first_fields = result.stdout.splitlines()[0].split("\t")
        self.assertEqual(first_fields[0], relative)
        self.assertEqual(first_fields[1], "2")

    def test_scan_cli_allows_clean_file(self):
        path = self.fixture_path("scan-clean.ts")
        path.write_text("line1\nline2 clean\n", encoding="utf-8")
        result = run_scan(path)
        self.assertEqual(result.returncode, 0)
        self.assertIn("0 件", result.stdout)

    def test_scan_cli_skips_non_target_extension(self):
        path = self.fixture_path("scan-dirty.txt")
        path.write_text(f"has {NBSP} but wrong extension\n", encoding="utf-8")
        result = run_scan(path)
        self.assertEqual(result.returncode, 0)
        self.assertIn("0 件", result.stdout)

    # --- 内部関数の直接確認 ---

    def test_find_banned_bom_allowed_only_at_index_zero_of_file_start_chunk(self):
        banned = guard.ALWAYS_BANNED
        self.assertEqual(guard.find_banned(BOM + "x", banned, True), [])
        self.assertEqual(len(guard.find_banned("x" + BOM, banned, True)), 1)
        self.assertEqual(len(guard.find_banned(BOM + "x", banned, False)), 1)

    def test_ideographic_space_not_in_always_banned(self):
        # 2026-09-24 追加指示: U+3000は拡張子を問わず禁止一覧(ALWAYS_BANNED)に含めない
        # (拡張子による分け(banned_for/CODE_ONLY_BANNED)自体を撤廃した)。
        self.assertNotIn(0x3000, guard.ALWAYS_BANNED)

    def test_target_extensions_matches_instruction_list(self):
        self.assertEqual(guard.TARGET_EXTENSIONS,
                         {".ts", ".tsx", ".mts", ".mjs", ".js", ".ps1", ".py", ".json", ".md"})


if __name__ == "__main__":
    unittest.main()
