"""orchestrator_scope_guard.py の自己試験（rules/06 §10.485）。

- AllowCaseTests: 通す例（統括の本来の仕事の実例をそのままの形と具体の値の両方で、担当の R1〜R5、引用の中だけの語、
  1 つの容れ物に収まる走査、1 つのファイルの検索）。
- DenyCaseTests: 拒否する例（今日の調査の命令の実例、指示書の拒否の例、その別名・入れ子）。
- UnresolvedFormsPassTests: 解けない書式は「通す」に倒す（負例として明記。フックの限界）。
- MarkerTests: 緊急時の印（有効なら通して記録、期限切れ・30 分超・reason が空などは拒否）。
- SubprocessContractTests: 実プロセスで 1 秒未満、壊れた入力は通す、拒否は終了コード 2 と stderr 1 行。
- PipefailR6Tests（2026-11-11 追加）: 区分 R6（道具の失敗をパイプで隠す命令）の拒否・通過・解けない書式・印でも通さない。

実行: python -B -X utf8 .claude/hooks/orchestrator_scope_guard.selftest.py
（scratchpad の既存のファイルを読まない。使い捨ての根は <根>/scratchpad/temp/ に作り、終わりに消す）
"""

from __future__ import annotations

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

# check.ps1 は `<根>\scripts\..\.claude\hooks\...` の道のりで起動するので resolve() を挟む
# （instruction_check_guard.selftest.py と同じ）。
HOOK = Path(__file__).resolve().with_name("orchestrator_scope_guard.py")
ROOT = HOOK.parents[2]

spec = importlib.util.spec_from_file_location("orchestrator_scope_guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

TMP = ROOT / "scratchpad" / "temp" / f"orchestrator-scope-guard-selftest-{uuid.uuid4().hex[:8]}"
TMP_STR = str(TMP)
TMP_POSIX = TMP.as_posix()
TMP_MSYS = "/" + TMP_POSIX[0].lower() + TMP_POSIX[2:]
CREATED: list[Path] = []

MAIN_TRANSCRIPT = ("C:/Users/oltot/.claude/projects/C--Users-oltot-Documents-git-projects-PointerCAD/"
                   "0d1c2b3a-4e5f-4789-abcd-ef0123456789.jsonl")
SUB_TRANSCRIPT = ("C:/Users/oltot/.claude/projects/C--Users-oltot-Documents-git-projects-PointerCAD/"
                  "0d1c2b3a-4e5f-4789-abcd-ef0123456789/subagents/agent-a1b2c3d4.jsonl")
NOW = datetime(2026, 11, 11, 19, 30)
DLV = "scratchpad/claude/deliveries/20261111-184904"
ME = "scratchpad/claude/agents/cl-v103-orchestrator-scope-guard-1111"
PY = "python -B -X utf8"


def setUpModule():
    node = TMP
    while not node.exists():
        CREATED.append(node)
        node = node.parent
    TMP.mkdir(parents=True)


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)
    for created in CREATED:
        try:
            created.rmdir()
        except OSError:
            pass


def payload(command: str, tool: str = "Bash", who: str = "main", cwd: str = TMP_STR) -> dict:
    data = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {"command": command}, "cwd": cwd}
    if who == "main":
        data["transcript_path"] = MAIN_TRANSCRIPT
    elif who == "agent_id":
        data["transcript_path"] = MAIN_TRANSCRIPT
        data["agent_id"] = "a1b2c3d4"
    elif who == "subagent_transcript":
        data["transcript_path"] = SUB_TRANSCRIPT
    return data


def run_hook(command: str, tool: str = "Bash", who: str = "main") -> tuple:
    return guard.hook(payload(command, tool, who), NOW, root=TMP_STR)


# 統括の本来の仕事（指示書 §1 の実例。<…> は具体の値に置き換えた形）
ORCHESTRATOR_DUTIES = [
    ("date", "Bash", "date '+%Y-%m-%d %H:%M'"),
    ("git_log", "Bash", "git --no-optional-locks log --oneline -5"),
    ("git_status", "Bash", "git --no-optional-locks status --short"),
    ("git_diff", "Bash", "git --no-optional-locks diff --stat"),
    ("git_ls_remote", "Bash", "git --no-optional-locks ls-remote origin main"),
    ("git_worktree_list", "Bash", "git --no-optional-locks worktree list"),
    ("gh_run_list", "Bash", "gh run list --limit 5"),
    ("gh_run_view_log_failed", "Bash",
     "gh run view 19234567890 --log-failed > scratchpad/claude/root-runtime/ci-19234567890-failed.log"),
    ("deliver_prepare", "Bash", f"{PY} scratchpad/claude/tools/deliver.py prepare-main-merge"),
    ("deliver_gate", "Bash", f"{PY} scratchpad/claude/tools/deliver.py gate --delivery 20261111-184904"),
    ("deliver_status", "Bash", f"{PY} scratchpad/claude/tools/deliver.py status 20261111-184904"),
    ("quiet_open", "Bash", f"{PY} scratchpad/claude/tools/quiet_window.py open --minutes 30"),
    ("quiet_close", "Bash", f"{PY} scratchpad/claude/tools/quiet_window.py close"),
    ("quiet_status", "Bash", f"{PY} scratchpad/claude/tools/quiet_window.py status"),
    ("registry_add", "Bash", f"{PY} scratchpad/claude/tools/registry.py add cl-v103-orchestrator-scope-guard-1111"),
    ("registry_set_status", "Bash",
     f"{PY} scratchpad/claude/tools/registry.py set-status cl-v103-orchestrator-scope-guard-1111 running"),
    ("registry_list", "Bash", f"{PY} scratchpad/claude/tools/registry.py list"),
    ("diag_e2e", "Bash",
     f"{PY} scratchpad/claude/tools/diag.py e2e --owner root-claude-1111 --bg -- smoke.spec.ts --project=firefox"),
    ("diag_wait", "Bash",
     f"{PY} scratchpad/claude/tools/diag.py wait --run 20261111-181824-root-claude-1111-e2e --timeout 540"),
    ("diag_status", "Bash", f"{PY} scratchpad/claude/tools/diag.py status"),
    ("sync_forecast", "Bash",
     f"{PY} scratchpad/claude/root-runtime/sync-current-forecast-summary-1110.py {DLV}/receipt.json"),
    ("report_capture", "Bash",
     f"{PY} scratchpad/claude/root-runtime/report-capture-progress-1110.py {DLV}/receipt.json"),
    ("instruction_check", "Bash",
     f"{PY} .claude/hooks/instruction_check_guard.py --check "
     "scratchpad/claude/instructions/cl-v103-orchestrator-scope-guard-1111.md"),
    ("commit_message", "Bash", f"{PY} scripts/lib/commit_message.py scratchpad/claude/root-runtime/commit-message.txt"),
    ("python_c_state_json", "Bash",
     "python -X utf8 -c \"import json;print(json.load(open('scratchpad/claude/deliveries/20261111-184904/"
     "state.json',encoding='utf-8'))['status'])\""),
    ("ls_delivery", "Bash", f"ls -la {DLV}/"),
    ("cat_root_runtime", "Bash", "cat scratchpad/claude/root-runtime/gate-env.json"),
    ("head_report", "Bash", "head -12 docs/報告記録2.md"),
    ("tail_gate_log", "Bash", f"tail -c 6000 {DLV}/gate.log"),
    ("grep_gate_log_failures", "Bash", r"grep -a -n '\[終了\]\|\[NG\]' " + f"{DLV}/gate.log"),
    ("sed_rules", "Bash", "sed -n '121,134p' rules/01-役割と委譲.md"),
    ("cp_root_runtime", "Bash",
     "cp scratchpad/claude/root-runtime/workers-pause.json scratchpad/claude/root-runtime/workers-pause.json.bak"),
    ("wc_c", "Bash", "wc -c docs/報告記録2.md"),
]

# 同じ実例を指示書のとおりの字面（<…>・… を含む）で。bash では <…> が向け先になるが、通すことを確かめる。
ORCHESTRATOR_DUTIES_LITERAL = [
    ("lit_git", "git --no-optional-locks log|status|diff|ls-remote|worktree list …"),
    ("lit_gh_list", "gh run list …"),
    ("lit_gh_view", "gh run view <id> --log-failed > <ファイル>"),
    ("lit_deliver", f"{PY} scratchpad/claude/tools/deliver.py prepare-main-merge|gate|status …"),
    ("lit_quiet", f"{PY} scratchpad/claude/tools/quiet_window.py open|close|status …"),
    ("lit_registry", f"{PY} scratchpad/claude/tools/registry.py add|set-status|list …"),
    ("lit_diag", f"{PY} scratchpad/claude/tools/diag.py e2e|wait|status …"),
    ("lit_sync", f"{PY} scratchpad/claude/root-runtime/sync-current-forecast-summary-1110.py <receipt>"),
    ("lit_report", f"{PY} scratchpad/claude/root-runtime/report-capture-progress-1110.py <receipt>"),
    ("lit_instruction_check", f"{PY} .claude/hooks/instruction_check_guard.py --check <指示書>"),
    ("lit_commit_message", f"{PY} scripts/lib/commit_message.py <ファイル>"),
    ("lit_python_c", "python -X utf8 -c \"…json.load(open('scratchpad/claude/deliveries/<ID>/state.json'…\""),
    ("lit_ls", "ls -la scratchpad/claude/deliveries/<ID>/"),
    ("lit_cat", "cat scratchpad/claude/root-runtime/<票>.json"),
    ("lit_head", "head -12 docs/報告記録2.md"),
    ("lit_tail", "tail -c 6000 scratchpad/claude/deliveries/<ID>/gate.log"),
    ("lit_grep", r"grep -a -n '\[終了\]\|\[NG\]' scratchpad/claude/deliveries/<ID>/gate.log"),
    ("lit_sed", "sed -n '121,134p' rules/01-役割と委譲.md"),
    ("lit_cp", "cp <票> <控え>"),
    ("lit_wc", "wc -c <ファイル>"),
]

# その他の通す例（tool, command, who）
OTHER_ALLOW = [
    ("agent_rg_product", "Bash", "rg -n foo packages/ui/src", "agent_id"),
    ("agent_get_process", "PowerShell", "Get-Process | Sort-Object CPU -Descending", "subagent_transcript"),
    ("agent_cat_product", "Bash", "cat packages/fem/src/worker.ts", "agent_id"),
    ("agent_loop_deliveries", "Bash", "for d in scratchpad/claude/deliveries/*; do grep x $d/gate.log; done",
     "subagent_transcript"),
    ("agent_stop_process", "PowerShell", "Stop-Process -Id 1 -Force", "agent_id"),
    ("agent_find_agents", "Bash", "find scratchpad/claude/agents -newermt '2026-11-11 18:00'", "agent_id"),
    ("echo_quoted_get_process", "Bash", 'echo "Get-Process | Stop-Process -Force"', "main"),
    ("ps_write_output_quoted", "PowerShell", "Write-Output 'Get-Process と taskkill は担当へ出す'", "main"),
    ("grep_one_doc", "Bash", "grep -n '統括' docs/報告記録2.md", "main"),
    ("find_own_agent_maxdepth", "Bash", f"find {ME}/ -maxdepth 2 -name final.md", "main"),
    ("heredoc_commit_message", "Bash",
     "git commit -F - <<'EOF'\nGet-Process と taskkill /F を統括から止める\nfor d in *; do grep x $d; done\nEOF",
     "main"),
    ("commit_m_quoted", "Bash", 'git commit -m "Stop-Process・Get-WinEvent を統括から止める"', "main"),
    ("grep_r_one_agent", "Bash", f"grep -rn NG {ME}/", "main"),
    ("rg_instructions", "Bash", "rg -n foo scratchpad/claude/instructions", "main"),
    ("gci_recurse_one_delivery", "PowerShell", f"Get-ChildItem -Recurse {DLV}", "main"),
    ("du_one_run", "Bash", "du -sh scratchpad/claude/runs/20261111-181824-root-claude-1111-e2e", "main"),
    ("ls_r_root_runtime", "Bash", "ls -R scratchpad/claude/root-runtime", "main"),
    ("loop_patterns_one_log", "Bash", f"for p in NG FAIL; do grep -c $p {DLV}/gate.log; done", "main"),
    ("loop_files_one_delivery", "Bash",
     f"for f in {DLV}/gate.log {DLV}/state.json; do grep -c NG \"$f\"; done", "main"),
    ("pc_state_tool", "Bash", f"{PY} scratchpad/claude/tools/pc_state.py --json", "main"),
    ("pipe_into_grep", "Bash", "gh run view 19234567890 --log-failed | grep -n -i error", "main"),
    ("ps_get_content_tail", "PowerShell", f"Get-Content {DLV}/gate.log -Tail 40", "main"),
    ("ps_select_string_one_log", "PowerShell", f"Select-String -Path {DLV}/gate.log -Pattern 'NG'", "main"),
    ("git_diff_product", "Bash", "git --no-optional-locks diff -- packages/ui/src/App.tsx", "main"),
    ("ls_product_not_recursive", "Bash", "ls packages/ui/src", "main"),
    ("ps_git_status", "PowerShell", "git --no-optional-locks status --short", "main"),
    ("ps_get_date", "PowerShell", "Get-Date -Format 'yyyy-MM-dd HH:mm'", "main"),
    ("cd_delivery_grep_r_dot", "Bash", f"cd {DLV} && grep -rn NG .", "main"),
    ("env_assignment_prefix", "Bash", f"PCAD_DIAG_NORMAL_PRIORITY=1 {PY} scratchpad/claude/tools/diag.py status", "main"),
    ("ps_test_path_marker", "PowerShell",
     "Test-Path scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json", "main"),
]

# 拒否する例（tool, command, 区分）。d01〜d12 は今日の調査の命令の実例（<…>・… は具体の値に置き換えた）。
DENY_CASES = [
    ("d01_get_process_cpu_top", "PowerShell",
     "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, WorkingSet64", "R4"),
    ("d02_cpu_diff_6s", "PowerShell",
     "$a = Get-Process | Select-Object Id, ProcessName, CPU; Start-Sleep -Seconds 6; "
     "$b = Get-Process | Select-Object Id, ProcessName, CPU; $b | ForEach-Object { $p = $_; "
     "$o = $a | Where-Object { $_.Id -eq $p.Id }; if ($o) { [pscustomobject]@{ Name = $p.ProcessName; "
     "Id = $p.Id; Cores = ($p.CPU - $o.CPU) / 6 } } } | Sort-Object Cores -Descending | Select-Object -First 10",
     "R4"),
    ("d03_cim_win32_process", "PowerShell",
     "Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | Format-List", "R4"),
    ("d04_cim_perfos_memory", "PowerShell",
     "Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableMBytes, CommittedBytes, "
     "CommitLimit", "R4"),
    ("d05_winevent_defender", "PowerShell",
     "Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; "
     "StartTime = (Get-Date).AddHours(-6) } -MaxEvents 50 | Select-Object TimeCreated, Id, Message", "R4"),
    ("d06_winevent_system", "PowerShell",
     "Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = (Get-Date).AddHours(-6) } | "
     "Where-Object { $_.Level -le 3 }", "R4"),
    ("d07_winevent_windowsupdate", "PowerShell",
     "Get-WinEvent -FilterHashtable @{ ProviderName = 'Microsoft-Windows-WindowsUpdateClient'; "
     "StartTime = (Get-Date).AddHours(-12) }", "R4"),
    ("d08_powercfg_batteryreport", "PowerShell", "powercfg /batteryreport /output scratchpad/temp/battery.html", "R4"),
    ("d09_loop_four_delivery_logs", "Bash",
     "for d in scratchpad/claude/deliveries/20261107-154132 scratchpad/claude/deliveries/20261109-093012 "
     "scratchpad/claude/deliveries/20261110-201500 scratchpad/claude/deliveries/20261111-032926; "
     "do echo \"== $d\"; grep -a -n '所要' $d/gate.log | tail -3; done", "R2"),
    ("d10_loop_runs_ls_d", "Bash",
     "cd scratchpad/claude && for r in $(ls -d runs/2026110[7-9]*-e2e); do echo \"$r\"; "
     "grep -a -c passed $r/result.json; done", "R2"),
    ("d11_find_agents_newermt", "Bash",
     "find scratchpad/claude/agents -maxdepth 2 -newermt '2026-11-11 18:00' -name progress.md", "R2"),
    ("d12_grep_transcript_jsonl", "Bash",
     "grep -a -o '\"text\":\"[^\"]*監視[^\"]*\"' /c/Users/oltot/.claude/projects/"
     "C--Users-oltot-Documents-git-projects-PointerCAD/0d1c2b3a-4e5f-4789-abcd-ef0123456789.jsonl | tail -20", "R2"),
    ("d13_rg_product", "Bash", "rg -n foo packages/ui/src", "R1"),
    ("d14_cd_then_grep_r", "Bash", "cd packages/kernel && grep -rn foo src", "R1"),
    ("d15_gci_recurse_e2e", "PowerShell", "Get-ChildItem -Recurse e2e", "R1"),
    ("d16_cat_product", "Bash", "cat packages/fem/src/worker.ts", "R3"),
    ("d17_sed_product", "Bash", "sed -n '1,50p' e2e/tests/smoke.spec.ts", "R3"),
    ("d18_loop_delivery_glob", "Bash", "for d in scratchpad/claude/deliveries/*; do grep x $d/gate.log; done", "R2"),
    ("d19_find_agents_no_maxdepth", "Bash", "find scratchpad/claude/agents -newermt '2026-11-11 18:00'", "R2"),
    ("d20_stop_process", "PowerShell", "Stop-Process -Id 1 -Force", "R5"),
    ("d21_taskkill_bash", "Bash", "taskkill /PID 1 /F", "R5"),
    ("d22_taskkill_ps", "PowerShell", "taskkill /PID 1 /F", "R5"),
    ("d23_grep_r_root", "Bash", 'grep -rn "recompute" .', "R2"),
    ("d24_gci_recurse_runs", "PowerShell", "Get-ChildItem -Path scratchpad/claude/runs -Recurse -Filter result.json",
     "R2"),
    ("d25_ls_r_scratchpad", "Bash", "ls -R scratchpad", "R2"),
    ("d26_du_runs", "Bash", "du -sh scratchpad/claude/runs", "R2"),
    ("d27_kill_9", "Bash", "kill -9 1234", "R5"),
    ("d28_pkill", "Bash", "pkill -f vitest", "R5"),
    ("d29_tasklist", "Bash", "tasklist /v", "R4"),
    ("d30_typeperf", "Bash", 'typeperf "\\Processor(_Total)\\% Processor Time" -sc 3', "R4"),
    ("d31_wmic", "Bash", "wmic process list brief", "R4"),
    ("d32_systeminfo", "Bash", "systeminfo", "R4"),
    ("d33_get_counter", "PowerShell", "Get-Counter '\\Memory\\Available MBytes'", "R4"),
    ("d34_git_grep_whole_repo", "Bash", "git grep -n useStore", "R1"),
    ("d35_select_string_product", "PowerShell", "Select-String -Path packages/ui/src/*.ts -Pattern 'foo'", "R1"),
    ("d36_findstr_s", "PowerShell", "findstr /s /n foo *.ts", "R2"),
    ("d37_get_content_product", "PowerShell", "Get-Content packages/ui/src/App.tsx -TotalCount 40", "R3"),
    ("d38_head_product", "Bash", "head -50 apps/web/src/main.ts", "R3"),
    ("d39_bash_powershell_command", "Bash",
     'powershell -NoProfile -Command "Get-Process | Sort-Object WS -Descending"', "R4"),
    ("d40_ps_bash_c", "PowerShell", 'bash -c "grep -rn foo packages/kernel/src"', "R1"),
    ("d41_ps_aux", "Bash", "ps aux", "R4"),
    ("d42_cat_transcript_home", "Bash",
     "cat ~/.claude/projects/C--Users-oltot-Documents-git-projects-PointerCAD/0d1c2b3a.jsonl | grep -c 監視", "R2"),
    ("d43_grep_glob_deliveries", "Bash", "grep -c NG scratchpad/claude/deliveries/*/gate.log", "R2"),
    ("d44_dotnet_process_type", "PowerShell", "[System.Diagnostics.Process]::GetProcesses() | Measure-Object", "R4"),
    ("d45_foreach_object_logs", "PowerShell",
     "Get-ChildItem scratchpad/claude/deliveries -Directory | ForEach-Object { Select-String -Path "
     "\"$($_.FullName)/gate.log\" -Pattern '所要' }", "R2"),
    ("d46_xargs_grep", "Bash",
     "ls scratchpad/claude/deliveries | xargs -I{} grep -c NG scratchpad/claude/deliveries/{}/gate.log", "R2"),
    ("d47_get_process_pipe_stop", "PowerShell", "Get-Process node | Stop-Process -Force", "R4"),
    ("d48_cmd_c_tasklist", "Bash", 'cmd /c "tasklist | findstr node"', "R4"),
    ("d49_get_wmiobject", "PowerShell", "Get-WmiObject Win32_Process", "R4"),
    ("d50_rg_folder", "Bash", "rg -n foo docs", "R2"),
    ("d51_while_read_loop", "Bash",
     "while read d; do grep -c NG \"$d/gate.log\"; done < scratchpad/claude/root-runtime/delivery-list.txt", "R2"),
    ("d52_timeout_wrapper", "Bash", "timeout 30 grep -rn foo packages", "R1"),
    ("d53_git_c_grep", "Bash", "git -C packages/ui grep -n foo", "R1"),
    ("d54_eval_grep_r", "Bash", 'eval "grep -rn foo ."', "R2"),
    ("d55_ps_foreach_two_deliveries", "PowerShell",
     "foreach ($d in 'scratchpad/claude/deliveries/20261107-154132', 'scratchpad/claude/deliveries/20261111-032926')"
     " { Select-String -Path \"$d/gate.log\" -Pattern '所要' }", "R2"),
    ("d56_ps_assignment_no_space", "PowerShell", "$a=Get-Process", "R4"),
    ("d57_subshell_cd_grep", "Bash", "(cd packages && grep -rn foo .)", "R1"),
    ("d58_start_process_taskkill", "PowerShell", "Start-Process taskkill -ArgumentList '/F /PID 1'", "R5"),
    ("d59_wevtutil", "Bash", "wevtutil qe System /c:20 /f:text", "R4"),
    ("d60_cat_product_absolute", "Bash", f"cat {TMP_POSIX}/packages/fem/src/worker.ts", "R3"),
    ("d61_cat_product_msys_path", "Bash", f"cat {TMP_MSYS}/packages/fem/src/worker.ts", "R3"),
    ("d62_ps_kill_alias", "PowerShell", "kill -Id 1234", "R5"),
    ("d63_cd_up_then_product", "Bash", "cd scratchpad/claude && grep -n foo ../../packages/ui/src/App.tsx", "R1"),
    ("d64_ps_call_operator_quoted_path", "PowerShell", "& 'C:\\Windows\\System32\\taskkill.exe' /PID 1 /F", "R5"),
]

# 解けない書式（通すに倒す。フックの限界として final にも書く）
UNRESOLVED_PASS = [
    ("u01_python_c_subprocess", "Bash",
     "python -c \"import subprocess; subprocess.run(['taskkill', '/F', '/PID', '1'])\""),
    ("u02_invoke_expression", "PowerShell", "Invoke-Expression 'Get-Process'"),
    ("u03_command_in_variable", "PowerShell", "$c = 'Get-Process'; & $c"),
    ("u04_encoded_command", "Bash", "powershell -EncodedCommand RwBlAHQALQBQAHIAbwBjAGUAcwBzAA=="),
    ("u05_script_file", "Bash", "bash scratchpad/claude/root-runtime/investigate.sh"),
    ("u06_variable_target", "Bash", 'cat "$F"'),
    ("u07_unterminated_quote", "Bash", "echo 'unterminated; Get-Process"),
    ("u08_node_e", "Bash", "node -e \"require('child_process').execSync('tasklist')\""),
    ("u09_xargs_cat_from_stdin", "Bash", "git ls-files packages | xargs cat"),
    ("u10_start_process_string_args", "PowerShell", "Start-Process powershell -ArgumentList '-Command Get-Process'"),
    ("u11_cd_to_variable", "Bash", 'cd "$D" && grep -n foo src/a.ts'),
    ("u12_dotnet_read_all_text", "PowerShell", "[IO.File]::ReadAllText('packages/ui/src/App.tsx')"),
    ("u13_scriptblock_create", "PowerShell", "& ([scriptblock]::Create('Get-Process'))"),
]


def _allow_test(tool: str, command: str, who: str):
    def test(self):
        line, warnings = run_hook(command, tool, who)
        self.assertIsNone(line, f"拒否された: {command!r} -> {line}")
        self.assertEqual(warnings, [])
    return test


def _deny_test(tool: str, command: str, category: str):
    def test(self):
        line, _ = run_hook(command, tool)
        self.assertIsNotNone(line, f"通ってしまった: {command!r}")
        self.assertTrue(line.startswith(guard.REASON_PREFIX), line)
        self.assertIn(f"区分: {category}。", line)
        self.assertNotIn("\n", line)
    return test


class AllowCaseTests(unittest.TestCase):
    """通す例（統括の本来の仕事と、担当・引用・1 つの容れ物）。"""


class DenyCaseTests(unittest.TestCase):
    """拒否する例。"""


class UnresolvedFormsPassTests(unittest.TestCase):
    """負例: 文字列から解けない書式は通す（フックの限界。R4 の語が文字列の中にあっても止められない）。"""


for _name, _tool, _command in ORCHESTRATOR_DUTIES:
    setattr(AllowCaseTests, f"test_allow_duty_{_name}", _allow_test(_tool, _command, "main"))
for _name, _command in ORCHESTRATOR_DUTIES_LITERAL:
    setattr(AllowCaseTests, f"test_allow_duty_{_name}", _allow_test("Bash", _command, "main"))
for _name, _tool, _command, _who in OTHER_ALLOW:
    setattr(AllowCaseTests, f"test_allow_{_name}", _allow_test(_tool, _command, _who))
for _name, _tool, _command, _category in DENY_CASES:
    setattr(DenyCaseTests, f"test_deny_{_name}", _deny_test(_tool, _command, _category))
for _name, _tool, _command in UNRESOLVED_PASS:
    setattr(UnresolvedFormsPassTests, f"test_pass_{_name}", _allow_test(_tool, _command, "main"))


class CaseCountTests(unittest.TestCase):
    def test_at_least_30_allow_and_30_deny_examples(self):
        allow = len(ORCHESTRATOR_DUTIES) + len(ORCHESTRATOR_DUTIES_LITERAL) + len(OTHER_ALLOW)
        self.assertGreaterEqual(allow, 30)
        self.assertGreaterEqual(len(DENY_CASES), 30)

    def test_hook_module_starts_no_child_process(self):
        self.assertNotIn("subprocess", vars(guard))


class CallerTests(unittest.TestCase):
    def test_agent_id_is_subagent(self):
        self.assertEqual(guard.caller(payload("x", who="agent_id")), "subagent")

    def test_subagent_transcript_is_subagent(self):
        self.assertEqual(guard.caller(payload("x", who="subagent_transcript")), "subagent")

    def test_main_transcript_is_main(self):
        self.assertEqual(guard.caller(payload("x")), "main")

    def test_unknown_caller_passes(self):
        line, _ = guard.hook(payload("Get-Process", "PowerShell", who="none"), NOW, root=TMP_STR)
        self.assertIsNone(line)

    def test_non_shell_tool_passes(self):
        data = payload("Get-Process")
        data["tool_name"] = "Read"
        self.assertEqual(guard.hook(data, NOW, root=TMP_STR), (None, []))


class MarkerTests(unittest.TestCase):
    """緊急時の印。印の拒否の例（期限切れ・30 分超・reason が空）は拒否の例の一部として数える。"""

    def setUp(self):
        self.marker = TMP / "scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json"
        self.log = TMP / "scratchpad/claude/state/orchestrator-scope-exceptions.jsonl"
        self.marker.parent.mkdir(parents=True, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(TMP / "scratchpad", ignore_errors=True))

    def place(self, reason="CI の失敗の切り分けで利用者が許可", placed="2026-11-11T19:20:00",
              until="2026-11-11T19:45:00", raw=None):
        text = raw if raw is not None else json.dumps({"reason": reason, "placedAt": placed, "until": until},
                                                      ensure_ascii=False)
        self.marker.write_text(text, encoding="utf-8")

    def test_valid_marker_allows_r4_and_records(self):
        self.place()
        command = "Get-Process | Sort-Object CPU -Descending; " + "echo padding " * 40
        line, warnings = run_hook(command, "PowerShell")
        self.assertIsNone(line)
        self.assertEqual(warnings, [])
        rows = [json.loads(r) for r in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["category"], "R4")
        self.assertEqual(rows[0]["reason"], "CI の失敗の切り分けで利用者が許可")
        self.assertEqual(rows[0]["command"], command[:200])
        self.assertEqual(rows[0]["at"], "2026-11-11T19:30:00")

    def test_valid_marker_with_timezone_allows(self):
        self.place(placed="2026-11-11T19:20:00+09:00", until="2026-11-11T19:45:00+09:00")
        local_now = datetime.fromisoformat("2026-11-11T19:30:00+09:00").astimezone().replace(tzinfo=None)
        line, _ = guard.hook(payload("taskkill /PID 1 /F"), local_now, root=TMP_STR)
        self.assertIsNone(line)

    def test_valid_marker_does_not_record_ordinary_commands(self):
        self.place()
        line, _ = run_hook("git --no-optional-locks status --short")
        self.assertIsNone(line)
        self.assertFalse(self.log.exists())

    def assert_denied(self, needle: str | None):
        line, _ = run_hook("Get-Process", "PowerShell")
        self.assertIsNotNone(line)
        self.assertIn("区分: R4。Get-Process", line)
        if needle is not None:
            self.assertIn(needle, line)
        self.assertFalse(self.log.exists())

    def test_expired_marker_denies(self):
        self.place(placed="2026-11-11T19:00:00", until="2026-11-11T19:25:00")
        self.assert_denied("印は無効（期限切れ")

    def test_window_over_30_minutes_denies(self):
        self.place(placed="2026-11-11T19:20:00", until="2026-11-11T19:51:00")
        self.assert_denied("期間が 30 分を超える")

    def test_empty_reason_denies(self):
        self.place(reason="   ")
        self.assert_denied("reason が空")

    def test_future_placed_at_denies(self):
        self.place(placed="2026-11-11T19:35:00", until="2026-11-11T19:50:00")
        self.assert_denied("placedAt が未来")

    def test_broken_json_denies(self):
        self.place(raw="{reason:")
        self.assert_denied("JSON ではない")

    def test_until_before_placed_denies(self):
        self.place(placed="2026-11-11T19:40:00", until="2026-11-11T19:20:00")
        self.assert_denied("until が placedAt 以前")

    def test_no_marker_reason_format(self):
        line, _ = run_hook("Get-Process", "PowerShell")
        self.assertEqual(line, guard.REASON_PREFIX + "区分: R4。Get-Process")


# ---------------------------------------------------------------------------
# 区分 R6（2026-11-11 cl-v103-enforcement-integration-1111、rules/06 §10.485 の誤り B）: python で道具を実行する部分が
# `|` で別の命令へ流れ、その後ろに && ・ || ・ ; ・改行で別の命令が続くのに、最初の `|` より前に set -o pipefail が無い。
# ---------------------------------------------------------------------------

R6_TOOL = f"{PY} scratchpad/claude/tools/deliver.py status 20261111-184904"
R6_MISTAKE_B = (
    f"{PY} scratchpad/claude/root-runtime/adopt-forecast-0021-1110.py {ME}/adopt-forecast.json 2>&1 | tail -3 && "
    f"{PY} scratchpad/claude/root-runtime/sync-current-forecast-summary-1110.py {DLV}/receipt.json | tail -1 && "
    f"{PY} scratchpad/claude/tools/registry.py set-status cl-v103-forecast-0021-1110 adopted")

# 拒否する例（name, command）。全て Bash・統括。
R6_DENY = [
    ("r6d01_actual_mistake_b", R6_MISTAKE_B),
    ("r6d02_semicolon", f"{R6_TOOL} | tail -5; echo done"),
    ("r6d03_newline", f"{PY} .claude/hooks/instruction_check_guard.py --check scratchpad/claude/instructions/x.md "
                      f"| head -3\n{PY} scratchpad/claude/tools/registry.py list"),
    ("r6d04_or_list", f"{PY} scratchpad/claude/tools/diag.py status | grep -c ok || echo NG"),
    ("r6d05_absolute_path", f"python {TMP_POSIX}/scratchpad/claude/tools/registry.py list | tail -1 && echo ok"),
    ("r6d06_msys_path_python3",
     f"python3 {TMP_MSYS}/scratchpad/claude/root-runtime/adopt-reviewed-1109.py {ME}/adopt-A.json | tail -2 && echo ok"),
    ("r6d07_cd_then_relative", "cd scratchpad/claude && python -B tools/registry.py list | tail -1 && echo ok"),
    ("r6d08_subshell", f"( {R6_TOOL} | tail -3 ) && echo next"),
    ("r6d09_pipefail_after_first_pipe",
     f"{R6_TOOL} | tail -1 && set -o pipefail && {PY} scratchpad/claude/tools/registry.py list | tail -1 && echo ok"),
    ("r6d10_pipefail_turned_off", f"set -o pipefail; set +o pipefail; {R6_TOOL} | tail -1; echo ok"),
    ("r6d11_pipefail_only_in_closed_subshell", f"(set -o pipefail); {R6_TOOL} | tail -1 && echo ok"),
    ("r6d12_env_prefix_tee", f"PYTHONUTF8=1 {R6_TOOL} 2>&1 | tee {ME}/status.log && echo ok"),
    ("r6d13_quoted_backslash_path",
     'python -B -X utf8 "scratchpad\\claude\\tools\\registry.py" list | tail -1 && echo ok'),
    ("r6d14_pipe_into_subshell", f"{R6_TOOL} | (tail -3) && echo ok"),
    ("r6d15_if_condition", f"if {PY} scratchpad/claude/tools/diag.py status | grep -q ok; then echo yes; fi"),
]

# 通す例（name, tool, command, who）
R6_ALLOW = [
    ("r6a01_mistake_b_with_pipefail", "Bash", "set -o pipefail && " + R6_MISTAKE_B, "main"),
    ("r6a02_nothing_after_the_pipe", "Bash", f"{R6_TOOL} | tail -3", "main"),
    ("r6a03_set_euo_pipefail_cluster", "Bash",
     f"set -euo pipefail; {R6_TOOL} | tail -3; {PY} scratchpad/claude/tools/registry.py list", "main"),
    ("r6a04_trailing_newline_only", "Bash", f"{PY} scratchpad/claude/tools/registry.py list | tail -1\n", "main"),
    ("r6a05_commands_split_without_pipe", "Bash", f"{R6_TOOL} && {PY} scratchpad/claude/tools/registry.py list", "main"),
    ("r6a06_not_a_tool_folder", "Bash",
     f"{PY} scripts/lib/commit_message.py scratchpad/claude/root-runtime/m.txt | tail -1 && echo ok", "main"),
    ("r6a07_tool_is_the_last_of_the_pipe", "Bash",
     f"cat {ME}/rows.json | {PY} scratchpad/claude/tools/registry.py list && echo ok", "main"),
    ("r6a08_subshell_with_pipefail", "Bash", f"(set -o pipefail; {R6_TOOL} | tail -3) && echo ok", "main"),
    ("r6a09_brace_group_alone", "Bash", f"{{ {R6_TOOL} | tail -3; }}", "main"),
    ("r6a10_python_c", "Bash", "python -X utf8 -c \"print(1)\" | tail -1 && echo ok", "main"),
    ("r6a11_quoted_in_echo", "Bash", f"echo \"{R6_TOOL} | tail -1 && echo ok\"", "main"),
    ("r6a12_heredoc_body", "Bash",
     f"cat > {ME}/notes.md <<'EOF'\n{R6_TOOL} | tail -1 && echo ok\nEOF", "main"),
    ("r6a13_redirect_then_tail", "Bash", f"{R6_TOOL} > {ME}/status.txt 2>&1; tail -3 {ME}/status.txt", "main"),
    ("r6a14_powershell_is_out_of_scope", "PowerShell", f"{R6_TOOL} | Select-Object -Last 3; Write-Output done", "main"),
    ("r6a15_worker_is_out_of_scope", "Bash", R6_MISTAKE_B, "agent_id"),
    ("r6a16_background_at_the_end", "Bash", f"{R6_TOOL} | tail -3 &", "main"),
    ("r6a17_set_o_errexit_o_pipefail_first", "Bash",
     f"set -o errexit -o pipefail\n{R6_TOOL} | tail -3\necho ok", "main"),
]

# 解けない書式（通すに倒す。フックの限界）
R6_UNRESOLVED_PASS = [
    ("r6u01_command_substitution", f"out=$({PY} scratchpad/claude/tools/registry.py list | tail -1) && echo \"$out\""),
    ("r6u02_bash_c_string", f"bash -c \"{PY} scratchpad/claude/tools/registry.py list | tail -1\" && echo ok"),
    ("r6u03_cd_to_variable", "cd \"$D\" && python tools/registry.py list | tail -1 && echo ok"),
]


def _r6_deny_test(command: str):
    def test(self):
        line, warnings = run_hook(command)
        self.assertIsNotNone(line, f"通ってしまった: {command!r}")
        self.assertTrue(line.startswith(guard.R6_REASON), line)
        self.assertIn("区分: R6。", line)
        self.assertNotIn("\n", line)
        self.assertEqual(warnings, [])
    return test


class PipefailR6Tests(unittest.TestCase):
    """区分 R6: 道具の失敗をパイプで隠す命令を拒否し、set -o pipefail のある命令・後ろが無い命令は通す。"""

    def test_reason_format_of_mistake_b(self):
        line, _ = run_hook(R6_MISTAKE_B)
        self.assertEqual(line, guard.R6_REASON + "区分: R6。python … adopt-forecast-0021-1110.py | tail")

    def test_at_least_3_deny_and_4_allow_examples(self):
        self.assertGreaterEqual(len(R6_DENY), 3)
        self.assertGreaterEqual(len(R6_ALLOW), 4)

    def test_r1_to_r5_keep_their_category_when_r6_also_matches(self):
        line, _ = run_hook(f"cat packages/fem/src/worker.ts | tail -3; {R6_TOOL} | tail -1 && echo ok")
        self.assertIn("区分: R3。", line)

    def test_valid_marker_does_not_open_r6_and_records_nothing(self):
        marker = TMP / "scratchpad/claude/root-runtime/orchestrator-investigation-allowed.json"
        log = TMP / "scratchpad/claude/state/orchestrator-scope-exceptions.jsonl"
        marker.parent.mkdir(parents=True, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(TMP / "scratchpad", ignore_errors=True))
        marker.write_text(json.dumps({"reason": "CI の失敗の切り分けで利用者が許可", "placedAt": "2026-11-11T19:20:00",
                                      "until": "2026-11-11T19:45:00"}, ensure_ascii=False), encoding="utf-8")
        line, _ = run_hook(R6_MISTAKE_B)
        self.assertTrue(line.startswith(guard.R6_REASON), line)
        line, _ = run_hook(f"tasklist /v | findstr node; {R6_TOOL} | tail -1 && echo ok")
        self.assertTrue(line.startswith(guard.R6_REASON), line)
        self.assertFalse(log.exists())

    def test_deny_exit_2_and_one_stderr_line(self):
        body = json.dumps(payload(R6_MISTAKE_B, cwd=str(ROOT)), ensure_ascii=False)
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)], input=body.encode("utf-8"),
                                capture_output=True, cwd=ROOT, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        stderr = result.stderr.decode("utf-8")
        self.assertEqual(len(stderr.strip().splitlines()), 1, stderr)
        self.assertIn("区分: R6。", stderr)


for _name, _command in R6_DENY:
    setattr(PipefailR6Tests, f"test_deny_{_name}", _r6_deny_test(_command))
for _name, _tool, _command, _who in R6_ALLOW:
    setattr(PipefailR6Tests, f"test_allow_{_name}", _allow_test(_tool, _command, _who))
for _name, _command in R6_UNRESOLVED_PASS:
    setattr(PipefailR6Tests, f"test_pass_{_name}", _allow_test("Bash", _command, "main"))


class SubprocessContractTests(unittest.TestCase):
    """実プロセスの stdin/stdout/stderr と終了コード（instruction_check_guard.selftest.py と同じ書き方）。"""

    def invoke(self, data=None, raw=None):
        body = json.dumps(data, ensure_ascii=False) if raw is None else raw
        return subprocess.run([sys.executable, "-B", "-X", "utf8", str(HOOK)], input=body.encode("utf-8"),
                              capture_output=True, cwd=ROOT, timeout=10)

    def real_marker_valid(self) -> bool:
        return guard.read_marker(guard.ROOT, datetime.now())[0] == "valid"

    def test_deny_exit_2_and_one_stderr_line(self):
        if self.real_marker_valid():
            self.skipTest("本物の印が有効な間は拒否の契約を確かめられない")
        result = self.invoke(payload("taskkill /PID 1 /F", cwd=str(ROOT)))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        stderr = result.stderr.decode("utf-8")
        self.assertEqual(len(stderr.strip().splitlines()), 1, stderr)
        self.assertIn("区分: R5。", stderr)

    def test_subagent_allowed_silently(self):
        result = self.invoke(payload("taskkill /PID 1 /F", who="agent_id", cwd=str(ROOT)))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    def test_malformed_json_fail_open(self):
        result = self.invoke(raw="{")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr.decode("utf-8"))

    def test_unknown_caller_allowed(self):
        result = self.invoke(payload("Get-Process", "PowerShell", who="none", cwd=str(ROOT)))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")

    def test_execution_under_one_second(self):
        start = time.perf_counter()
        result = self.invoke(payload("rg -n foo packages/ui/src", cwd=str(ROOT)))
        elapsed = time.perf_counter() - start
        self.assertIn(result.returncode, (0, 2))
        self.assertLess(elapsed, 1.0, f"hook took {elapsed:.3f}s")


if __name__ == "__main__":
    unittest.main(verbosity=1)
