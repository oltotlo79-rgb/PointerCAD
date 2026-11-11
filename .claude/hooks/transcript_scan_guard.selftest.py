"""transcript_scan_guard の自己試験(rules/06 §10.484)。

命令の文字列だけを判定するので、本物の会話記録(~/.claude/projects)・scratchpad・本物の .claude/hooks には触れない。
判定は関数を直接呼び、stdin・stdout・終了コードの約束だけを同じフォルダーのフックを子の python で流して確かめる。"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
HOOK = HERE / 'transcript_scan_guard.py'
sys.path.insert(0, str(HERE))
import transcript_scan_guard as guard  # noqa: E402

BS = chr(92)


def win(*parts: str) -> str:
    return BS.join(parts)


PROJECT = 'C--Users-oltot-Documents-git-projects-PointerCAD'
SESSION = 'db671ad6-0a30-48c9-8179-a11382028740.jsonl'
BASH_DIR = f'/c/Users/oltot/.claude/projects/{PROJECT}'
TILDE_DIR = f'~/.claude/projects/{PROJECT}'
WIN_DIR = win('C:', 'Users', 'oltot', '.claude', 'projects', PROJECT)


def payload(command, tool='Bash', **extra):
    data = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'tool_input': {'command': command}}
    data.update(extra)
    return data


class TranscriptScanGuardTests(unittest.TestCase):
    def assert_denied(self, command, tool='Bash'):
        result = guard.hook(payload(command, tool))
        self.assertIsNotNone(result, command)
        output = result['hookSpecificOutput']
        self.assertEqual((output['hookEventName'], output['permissionDecision']), ('PreToolUse', 'deny'))
        self.assertIn('§10.484', output['permissionDecisionReason'])

    def assert_allowed(self, command, tool='Bash'):
        self.assertIsNone(guard.hook(payload(command, tool)), command)

    def invoke(self, raw):
        return subprocess.run([sys.executable, '-B', '-X', 'utf8', str(HOOK)], input=raw, text=True, encoding='utf-8',
                              capture_output=True, timeout=30)

    # --- 拒否(正例) ---------------------------------------------------------------------------------------------

    def test_bash_grep_like_the_incident_is_denied(self):
        self.assert_denied(f"grep -a -o -E '監視.{{0,80}}' {BASH_DIR}/{SESSION}")

    def test_bash_rg_is_denied(self):
        self.assert_denied(f'rg -n "監視" {TILDE_DIR}/{SESSION}')

    def test_bash_cat_is_denied(self):
        self.assert_denied(f'cat {TILDE_DIR}/{SESSION}')

    def test_bash_tail_with_quoted_path_is_denied(self):
        self.assert_denied(f'tail -n 5 "{BASH_DIR}/{SESSION}"')

    def test_bash_wc_with_glob_is_denied(self):
        self.assert_denied(f'wc -l {TILDE_DIR}/*.jsonl')

    def test_powershell_select_string_is_denied(self):
        self.assert_denied(f"Select-String -Path {WIN_DIR}{BS}*.jsonl -Pattern '監視'", 'PowerShell')

    def test_powershell_get_content_is_denied(self):
        self.assert_denied(f'Get-Content "{WIN_DIR}{BS}{SESSION}" -Tail 3', 'PowerShell')

    def test_reader_in_the_middle_of_a_pipeline_is_denied(self):
        self.assert_denied(f'cd /c/tmp && cat {TILDE_DIR}/{SESSION} | grep -a 監視 | head -3')
        self.assert_denied(f'ls {TILDE_DIR} ; grep -a 監視 {TILDE_DIR}/{SESSION} | sort | head -3')
        self.assert_denied(f'echo start 2>&1 | grep -a 監視 {TILDE_DIR}/{SESSION} | head -1')

    def test_powershell_pipeline_reading_enumerated_transcripts_is_denied(self):
        root = win('$env:USERPROFILE', '.claude', 'projects')
        self.assert_denied(f"Get-ChildItem {root} -Recurse -Filter *.jsonl | Select-String -Pattern '監視'", 'PowerShell')
        self.assert_denied(f'Get-ChildItem {WIN_DIR} -Filter *.jsonl | ForEach-Object {{ Get-Content $_.FullName -Tail 1 }}',
                           'PowerShell')
        self.assert_denied(f"Get-ChildItem {root} -Recurse | Select-String -Pattern '監視'", 'PowerShell')

    def test_xargs_and_find_exec_readers_are_denied(self):
        self.assert_denied("find ~/.claude/projects -name '*.jsonl' | xargs grep -a 監視")
        self.assert_denied(f'ls -t {TILDE_DIR}/*.jsonl | head -1 | xargs -0 tail -n 5')
        self.assert_denied("find ~/.claude/projects -name '*.jsonl' -exec grep -a 監視 {} +")

    def test_changing_into_the_transcripts_folder_then_reading_jsonl_is_denied(self):
        self.assert_denied(f'cd {TILDE_DIR} && grep -a 監視 *.jsonl')
        self.assert_denied(f'Set-Location {WIN_DIR}; Get-Content {SESSION} -Tail 2', 'PowerShell')

    def test_recursive_search_over_the_transcripts_folder_is_denied(self):
        self.assert_denied('rg 監視 ~/.claude/projects')
        self.assert_denied(f'grep -rn 監視 {TILDE_DIR}/')
        self.assert_denied(f'findstr /s /c:"監視" {WIN_DIR}', 'PowerShell')
        self.assert_denied(f'cat {TILDE_DIR}/*')

    def test_exe_path_upper_case_and_call_operator_are_denied(self):
        grep = win('C:', 'Program Files', 'Git', 'usr', 'bin', 'GREP.EXE')
        target = win('C:', 'Users', 'oltot', '.CLAUDE', 'Projects', PROJECT, 'ABC.JSONL')
        self.assert_denied(f'& "{grep}" -a 監視 {target}', 'PowerShell')
        self.assert_denied(f'/usr/bin/rg.exe 監視 {TILDE_DIR}/{SESSION}')

    def test_other_listed_readers_and_aliases_are_denied(self):
        for command, tool in ((f'sed -n 1p {TILDE_DIR}/{SESSION}', 'Bash'),
                              (f"awk 'NR==1' {TILDE_DIR}/{SESSION}", 'Bash'),
                              (f'head -c 200 {TILDE_DIR}/{SESSION}', 'Bash'),
                              (f'sort {TILDE_DIR}/{SESSION}', 'Bash'),
                              (f'timeout 30 grep -a x {TILDE_DIR}/{SESSION}', 'Bash'),
                              (f'LC_ALL=C grep -a x {TILDE_DIR}/{SESSION}', 'Bash'),
                              (f"rg --glob '*.jsonl' 監視 {TILDE_DIR}", 'Bash'),
                              (f'findstr /c:"x" {WIN_DIR}{BS}{SESSION}', 'PowerShell'),
                              (f'(gc {WIN_DIR}{BS}{SESSION}).Count', 'PowerShell'),
                              (f'type {WIN_DIR}{BS}{SESSION}', 'PowerShell'),
                              (f'sls 監視 {WIN_DIR}{BS}{SESSION}', 'PowerShell'),
                              (f"Get-Content (Join-Path $env:USERPROFILE '.claude{BS}projects{BS}{PROJECT}{BS}{SESSION}')",
                               'PowerShell')):
            with self.subTest(command=command):
                self.assert_denied(command, tool)

    def test_both_the_orchestrator_and_a_worker_are_denied(self):
        command = f'grep -a x {TILDE_DIR}/{SESSION}'
        main = payload(command, transcript_path=f'{TILDE_DIR}/{SESSION}')
        worker = payload(command, agent_id='a1b2c3', transcript_path=f'{TILDE_DIR}/subagents/agent-a1b2c3.jsonl')
        for data in (main, worker):
            with self.subTest(agent=data.get('agent_id')):
                self.assertEqual(guard.hook(data)['hookSpecificOutput']['permissionDecision'], 'deny')

    # --- 通過(負例) ---------------------------------------------------------------------------------------------

    def test_memory_markdown_under_the_same_project_is_allowed(self):
        self.assert_allowed(f'cat {TILDE_DIR}/memory/MEMORY.md')
        self.assert_allowed(f'grep -n 統括 {TILDE_DIR}/memory/*.md')
        self.assert_allowed(f'cd {TILDE_DIR}/memory && cat *.md')

    def test_non_jsonl_file_in_the_same_folder_is_allowed(self):
        self.assert_allowed(f'head -5 {TILDE_DIR}/notes.md')
        self.assert_allowed(f'Get-Content "{WIN_DIR}{BS}settings.json"', 'PowerShell')

    def test_jsonl_outside_claude_projects_is_allowed(self):
        self.assert_allowed('grep -n x scratchpad/claude/agents/cl-x/events.jsonl')
        self.assert_allowed('rg x C:/Users/oltot/Documents/git-projects/PointerCAD/.claude/hooks/events.jsonl')
        self.assert_allowed(f'tail -n 3 {win("C:", "Users", "oltot", "Documents", "git-projects", "PointerCAD", ".claude", "x.jsonl")}',
                            'PowerShell')

    def test_listing_only_is_allowed(self):
        self.assert_allowed(f'ls -la {TILDE_DIR}/')
        self.assert_allowed(f'ls -S {TILDE_DIR}/*.jsonl | head -3')
        self.assert_allowed(f'Get-ChildItem {WIN_DIR} -Filter *.jsonl | Sort-Object Length -Descending | Select-Object -First 3',
                            'PowerShell')
        self.assert_allowed('rg --files ~/.claude/projects')

    def test_echo_of_a_string_that_mentions_the_command_is_allowed(self):
        self.assert_allowed(f'echo "grep -a x {TILDE_DIR}/{SESSION} は禁止"')
        self.assert_allowed(f"Write-Output 'Get-Content {WIN_DIR}{BS}{SESSION}'", 'PowerShell')

    def test_search_under_packages_is_allowed(self):
        self.assert_allowed('grep -rn "useStore" packages/ui/src')
        self.assert_allowed('rg -n "projects" packages/model/src .claude/hooks')

    def test_changing_away_from_the_transcripts_folder_resets_the_folder(self):
        self.assert_allowed(f'cd {TILDE_DIR} && cd /c/Users/oltot/Documents/git-projects/PointerCAD && grep -n x scratchpad/a.jsonl')

    def test_read_tool_other_tools_events_and_empty_commands_are_allowed(self):
        read = {'hook_event_name': 'PreToolUse', 'tool_name': 'Read',
                'tool_input': {'file_path': f'{TILDE_DIR}/{SESSION}', 'offset': 1, 'limit': 20}}
        self.assertIsNone(guard.hook(read))
        self.assertIsNone(guard.hook({'hook_event_name': 'PreToolUse', 'tool_name': 'Grep',
                                      'tool_input': {'pattern': 'x', 'path': f'{TILDE_DIR}/{SESSION}'}}))
        self.assertIsNone(guard.hook(payload(f'cat {TILDE_DIR}/{SESSION}', hook_event_name='PostToolUse')))
        self.assertIsNone(guard.hook(payload('   ')))

    # --- stdin・stdout・終了コードの約束(heredoc_backslash_guard と同じ) ----------------------------------------

    def test_subprocess_denies_with_json_and_exit_zero(self):
        result = self.invoke(json.dumps(payload(f'grep -a -o x {TILDE_DIR}/{SESSION}')))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, '')
        output = json.loads(result.stdout)['hookSpecificOutput']
        self.assertEqual(output['permissionDecision'], 'deny')
        for required in ('17.7GB', '620MB', 'offset/limit', '§10.484'):
            self.assertIn(required, output['permissionDecisionReason'])

    def test_subprocess_allows_with_empty_output(self):
        result = self.invoke(json.dumps(payload('git --no-optional-locks status')))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_unreadable_input_fails_open_like_the_other_shell_hooks(self):
        for raw in ('{', '[1, 2]', json.dumps({'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_input': 'x'})):
            with self.subTest(raw=raw):
                result = self.invoke(raw)
                self.assertEqual((result.returncode, result.stdout), (0, ''))
                self.assertIn('POINTERCAD_HOOK_FAIL_OPEN', result.stderr)


if __name__ == '__main__':
    unittest.main()
