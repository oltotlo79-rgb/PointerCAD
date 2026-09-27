"""Subprocess checks for the search-scope guard's real stdin/stdout contract."""

from __future__ import annotations

import json
import subprocess
import sys
import time
import unittest
from pathlib import Path


# 2026-09-24 OPS-14追記: check.ps1はこの自己試験を`<根>\scripts\..\.claude\hooks\...`の
# ように`..`を含む道のりで起動する(PowerShellのJoin-Pathは`..`を畳み込まない)。
# .resolve()を挟まないと{ROOT}を埋め込んだコマンド文字列(test_grep_absolute_root_denied
# 等)がフック本体の解決済みROOTと文字列不一致になり、本来拒否されるべき呼出しが
# 素通りしてassert_deniedがJSONDecodeErrorで落ちる(実測で確認)。フック本体
# (subagent_search_scope_guard.py)と同じ解決方法にする。
HOOK = Path(__file__).resolve().with_name("subagent_search_scope_guard.py")
ROOT = HOOK.parents[2]
SESSION = r"C:\Users\oltot\.claude\projects\PointerCAD\session-1"
AGENT = SESSION + r"\subagents\agent-a6e1bbbebf07c7a6c.jsonl"
MAIN = SESSION + ".jsonl"


class SearchScopeGuardTests(unittest.TestCase):
    def invoke(self, command, *, tool="Bash", transcript=AGENT, agent_id=None, raw=None):
        payload = {
            "hook_event_name": "PreToolUse", "tool_name": tool,
            "tool_input": {"command": command},
        }
        if transcript is not None:
            payload["transcript_path"] = transcript
        if agent_id is not None:
            payload["agent_id"] = agent_id
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps(payload) if raw is None else raw,
            text=True, capture_output=True, cwd=ROOT, timeout=2,
        )

    def assert_denied(self, result, *, tool_substring=None):
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn("rules/06 §10.330", output["permissionDecisionReason"])
        if tool_substring is not None:
            self.assertIn(tool_substring, output["permissionDecisionReason"])

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    # --- rules/06 §10.330 の明示的な受入条件そのもの ---

    def test_grep_dash_rn_dot_denied(self):
        self.assert_denied(self.invoke('grep -rn x .'), tool_substring="grep -r")

    def test_grep_dash_rn_scoped_to_packages_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x packages/ui/src'))

    # --- grep のその他の形 ---

    def test_grep_dash_R_denied(self):
        self.assert_denied(self.invoke('grep -R x .'))

    def test_grep_dash_rl_denied(self):
        self.assert_denied(self.invoke('grep -rln x .'))

    def test_grep_recursive_long_flag_denied(self):
        self.assert_denied(self.invoke('grep --recursive x .'))

    def test_grep_omitted_path_denied(self):
        self.assert_denied(self.invoke('grep -rn pattern'))

    def test_grep_absolute_root_denied(self):
        self.assert_denied(self.invoke(f'grep -rn pattern "{ROOT}"'))

    def test_grep_non_recursive_root_allowed(self):
        self.assert_allowed(self.invoke('grep -n x .'))

    def test_grep_exclude_dir_scratchpad_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x . --exclude-dir=scratchpad'))

    def test_grep_scratchpad_claude_runs_denied(self):
        # 2026-09-24 OPS-23: scratchpad/claude/runs(検査記録)は根と同じ大きな木として
        # 拒否する方針に変更。旧・test_grep_scratchpad_scoped_allowedはこの変更で前提が
        # 崩れたため置き換える(rules/06 §10.330 追補)。
        self.assert_denied(self.invoke('grep -rn x scratchpad/claude/runs'))

    def test_grep_two_explicit_scoped_paths_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x packages/ui/src packages/expression/src'))

    def test_grep_mixed_scoped_and_root_denied(self):
        # 2026-09-24統括の指摘: 一部の引数が絞られていても、他の対象が根なら見逃さない
        # (旧実装は「どれか1トークンがpackages/等に一致すれば全体を許可」していた誤り)。
        self.assert_denied(self.invoke('grep -rn x packages/ui/src .'))

    def test_grep_pattern_containing_pipe_with_scoped_path_allowed(self):
        # 2026-09-24統括の誤検出報告(§10.330の再発): クォート非対応のセグメント分割だと
        # パターン中の|でコマンドが分断され、パス引数が別セグメントに切り離されて
        # 「パス省略の根への検索」と誤認されていた。
        self.assert_allowed(self.invoke('grep -rn "foo|bar" packages/ui/src'))

    def test_grep_pattern_containing_pipe_at_root_denied(self):
        self.assert_denied(self.invoke('grep -rn "foo|bar" .'))

    def test_cd_root_then_grep_two_scoped_paths_allowed(self):
        self.assert_allowed(
            self.invoke(f'cd "{ROOT}" && grep -rn x packages/ui/src packages/expression/src'))

    def test_cd_root_then_grep_dot_denied(self):
        self.assert_denied(self.invoke(f'cd "{ROOT}" && grep -rn x .'))

    def test_cd_root_then_grep_omitted_path_denied(self):
        self.assert_denied(self.invoke(f'cd "{ROOT}" && grep -rn x'))

    def test_cd_root_then_grep_absolute_root_denied(self):
        self.assert_denied(self.invoke(f'cd "{ROOT}" && grep -rn x "{ROOT}"'))

    def test_cd_root_then_chained_commands_then_grep_scoped_allowed(self):
        self.assert_allowed(
            self.invoke(f'cd "{ROOT}" && echo hi ; grep -rn x packages/ui/src packages/expression/src'))

    # --- find ---

    def test_find_dot_denied(self):
        self.assert_denied(self.invoke('find . -name "*.ts"'), tool_substring="find")

    def test_find_scoped_allowed(self):
        self.assert_allowed(self.invoke('find packages/ui -name "*.ts"'))

    def test_find_root_absolute_denied(self):
        self.assert_denied(self.invoke(f'find "{ROOT}" -name "*.ts"'))

    def test_find_two_scoped_paths_allowed(self):
        self.assert_allowed(self.invoke('find packages/ui apps/web -name "*.ts"'))

    def test_cd_root_then_find_scoped_allowed(self):
        self.assert_allowed(self.invoke(f'cd "{ROOT}" && find packages/ui -name "*.ts"'))

    def test_cd_root_then_find_dot_denied(self):
        self.assert_denied(self.invoke(f'cd "{ROOT}" && find . -name "*.ts"'))

    # --- PowerShell Get-ChildItem -Recurse ---

    def test_gci_recurse_denied(self):
        self.assert_denied(self.invoke('Get-ChildItem -Recurse', tool="PowerShell"),
                            tool_substring="Get-ChildItem")

    def test_gci_alias_recurse_denied(self):
        self.assert_denied(self.invoke('gci -Recurse', tool="PowerShell"))

    def test_gci_recurse_scoped_allowed(self):
        self.assert_allowed(self.invoke('Get-ChildItem -Path packages -Recurse', tool="PowerShell"))

    def test_gci_without_recurse_allowed(self):
        self.assert_allowed(self.invoke('Get-ChildItem', tool="PowerShell"))

    # --- Select-String の再帰(直接指定・パイプ経由の両方) ---

    def test_select_string_recurse_denied(self):
        self.assert_denied(self.invoke('Select-String -Pattern foo -Recurse', tool="PowerShell"))

    def test_gci_pipe_select_string_denied(self):
        self.assert_denied(
            self.invoke('Get-ChildItem -Recurse | Select-String foo', tool="PowerShell"))

    def test_gci_pipe_select_string_scoped_allowed(self):
        self.assert_allowed(
            self.invoke('Get-ChildItem -Path packages -Recurse | Select-String foo', tool="PowerShell"))

    # --- rg ---

    def test_rg_no_ignore_denied(self):
        self.assert_denied(self.invoke('rg --no-ignore foo'), tool_substring="rg")

    def test_rg_dash_u_denied(self):
        self.assert_denied(self.invoke('rg -u foo .'))

    def test_rg_dash_uuu_denied(self):
        self.assert_denied(self.invoke('rg -uuu foo .'))

    def test_rg_default_allowed(self):
        self.assert_allowed(self.invoke('rg foo'))

    def test_rg_default_dot_allowed(self):
        self.assert_allowed(self.invoke('rg foo .'))

    def test_rg_no_ignore_scoped_allowed(self):
        self.assert_allowed(self.invoke('rg --no-ignore foo packages/ui/src'))

    def test_rg_no_ignore_two_scoped_paths_allowed(self):
        self.assert_allowed(self.invoke('rg --no-ignore foo packages/ui/src packages/expression/src'))

    def test_rg_no_ignore_mixed_scoped_and_root_denied(self):
        self.assert_denied(self.invoke('rg --no-ignore foo packages/ui/src .'))

    def test_cd_root_then_rg_no_ignore_scoped_allowed(self):
        self.assert_allowed(self.invoke(f'cd "{ROOT}" && rg --no-ignore foo packages/ui/src'))

    # --- scratchpad配下の大きな木(OPS-23、rules/06 §10.330 追補) ---
    # scratchpadそのもの・scratchpad/c3(とその中)・scratchpad/claude/runs・
    # scratchpad/temp・scratchpad/tasks(あれば)は根と同じく拒否する。担当自身の
    # scratchpad/claude/agents/<名前>/・scratchpad/claude/instructions/・
    # scratchpad/claude/plans/は今までどおり通す。

    def test_grep_scratchpad_bare_trailing_slash_denied(self):
        self.assert_denied(self.invoke('grep -rln x scratchpad/'), tool_substring="grep -r")

    def test_grep_scratchpad_bare_no_slash_denied(self):
        self.assert_denied(self.invoke('grep -rn x scratchpad'))

    def test_grep_scratchpad_like_name_allowed(self):
        # 'scratchpad'に前方一致するだけの別名(境界のない誤爆でないこと)を確かめる。
        self.assert_allowed(self.invoke('grep -rn x scratchpadArchive'))

    def test_grep_scratchpad_c3_exact_denied(self):
        self.assert_denied(self.invoke('grep -rn x scratchpad/c3'))

    def test_grep_scratchpad_c3_subpath_denied(self):
        self.assert_denied(self.invoke('grep -rn x scratchpad/c3/packages'))

    def test_grep_scratchpad_temp_denied(self):
        self.assert_denied(self.invoke('grep -rn x scratchpad/temp'))

    def test_grep_scratchpad_tasks_denied(self):
        self.assert_denied(self.invoke('grep -rn x scratchpad/tasks'))

    def test_grep_scratchpad_runs_like_name_allowed(self):
        # 'scratchpad/claude/runs'に前方一致するだけの別名を境界なしで誤爆しないこと。
        self.assert_allowed(self.invoke('grep -rn x scratchpad/claude/runsArchive'))

    def test_rg_scratchpad_claude_runs_denied(self):
        # 既定のrg(unignoreフラグ無し)でも、この5つの木を明示指定したら拒否する
        # (ignoreが実際に効くかはコマンド文字列だけからは保証できないため)。
        self.assert_denied(self.invoke('rg x scratchpad/claude/runs'), tool_substring="rg")

    def test_gci_scratchpad_c3_recurse_denied(self):
        self.assert_denied(
            self.invoke('Get-ChildItem -Path scratchpad/c3 -Recurse', tool="PowerShell"),
            tool_substring="Get-ChildItem")

    def test_grep_e2e_tests_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x e2e/tests'))

    def test_grep_scratchpad_own_agent_dir_allowed(self):
        self.assert_allowed(
            self.invoke('grep -rn x scratchpad/claude/agents/w30b-t2-capture-registry/'))

    def test_grep_scratchpad_instructions_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x scratchpad/claude/instructions'))

    def test_grep_scratchpad_plans_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x scratchpad/claude/plans'))

    def test_grep_scratchpad_tools_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x scratchpad/claude/tools'))

    # --- 呼出元の判別(統括は常に通す) ---

    def test_main_grep_root_allowed(self):
        self.assert_allowed(self.invoke('grep -rn x .', transcript=MAIN))

    def test_agent_id_without_transcript_denied(self):
        self.assert_denied(self.invoke('grep -rn x .', transcript=None, agent_id="a6e1bbbebf07c7a6c"))

    # --- 頑健性 ---

    def test_unrelated_command_allowed(self):
        self.assert_allowed(self.invoke('git status'))

    def test_chained_command_with_violation_denied(self):
        self.assert_denied(self.invoke('cd packages && grep -rn x .'))

    def test_unrelated_tool_allowed(self):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps({
                "hook_event_name": "PreToolUse", "tool_name": "Read",
                "tool_input": {"file_path": "x"}, "transcript_path": AGENT,
            }),
            text=True, capture_output=True, cwd=ROOT, timeout=2,
        )
        self.assert_allowed(result)

    def test_bad_json_fail_open(self):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input="{", text=True, capture_output=True, cwd=ROOT, timeout=2,
        )
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_missing_transcript_fail_open(self):
        result = self.invoke('grep -rn x .', transcript=None)
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_malformed_subagent_path_fail_open(self):
        result = self.invoke('grep -rn x .', transcript=SESSION + r"\subagents\other.jsonl")
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_empty_command_allowed(self):
        self.assert_allowed(self.invoke(''))

    def test_execution_under_half_second(self):
        start = time.perf_counter()
        result = self.invoke('grep -rn x .')
        elapsed = time.perf_counter() - start
        self.assert_denied(result)
        self.assertLess(elapsed, 0.5, f"hook took {elapsed:.3f}s")


if __name__ == "__main__":
    unittest.main()
