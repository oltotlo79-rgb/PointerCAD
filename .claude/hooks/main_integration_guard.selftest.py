"""Subprocess checks for main_integration_guard.py's real stdin/stdout contract.

Follows the same convention as opus_concurrency_guard.selftest.py for a hook whose state lives
under the real scratchpad/claude/state/: back up the real judgment record file (if any) before
touching it, write only synthetic content for the duration of a test, and restore the original
content (or remove the file, and any parent directories this test itself created) afterward. If
the record does not exist yet (a fresh/hermetic checkout, or a session that has not been judged),
parent directories are created only as needed and removed again at the end, exactly like
opus_concurrency_guard.selftest.py's EXCEPTIONS handling and record_time_guard.selftest.py's own
cleanup of directories it created.

For the git-merge/rebase-on-main scenarios, this file creates disposable git repositories under
scratchpad/temp/ (never touching the real repository) and invokes the hook with an explicit
"cwd" in the JSON payload pointing at one of them, matching how the hook itself resolves the
current branch (payload["cwd"], falling back to the real process cwd only in production).
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

HOOK = Path(__file__).resolve().with_name("main_integration_guard.py")
ROOT = HOOK.parents[2]
JUDGMENT_PATH = ROOT / "scratchpad/claude/state/main-integration-judgment.json"
WORK = ROOT / "scratchpad/temp" / f"main-integration-guard-selftest-{uuid.uuid4().hex[:8]}"

VALID_RECORD = {
    "commit": "a" * 40,
    "completedTaskIds": [f"ADD-{i}" for i in range(10)],
    "count": 10,
    "judgedAt": "2026-09-25T08:00:00+09:00",
    "evidence": "scratchpad/claude/agents/w48a-add-completion-judgment/judgment.md",
}


def _run_git(args: list[str], cwd: Path) -> None:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr}")


class MainIntegrationGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._work_created_ancestors = []
        node = WORK
        while not node.exists():
            cls._work_created_ancestors.append(node)
            node = node.parent
        WORK.mkdir(parents=True, exist_ok=True)

        cls._record_original = JUDGMENT_PATH.read_bytes() if JUDGMENT_PATH.exists() else None
        cls._record_created_ancestors = []
        node = JUDGMENT_PATH.parent
        while not node.exists():
            cls._record_created_ancestors.append(node)
            node = node.parent

    @classmethod
    def tearDownClass(cls):
        # .git internals on Windows sometimes carry a read-only attribute that plain rmtree
        # cannot remove (the same issue scripts/check.selftest.ps1 documents for its own
        # temp git repositories); clear it and retry once before giving up.
        def _on_rm_error(func, path, exc_info):
            try:
                os.chmod(path, stat.S_IWRITE)
                func(path)
            except OSError:
                pass

        if sys.version_info >= (3, 12):
            shutil.rmtree(WORK, onexc=lambda func, path, exc: _on_rm_error(func, path, exc))
        else:
            shutil.rmtree(WORK, onerror=_on_rm_error)
        for created in cls._work_created_ancestors[1:]:
            try:
                created.rmdir()
            except OSError:
                pass

        if cls._record_original is None:
            JUDGMENT_PATH.unlink(missing_ok=True)
            for created in cls._record_created_ancestors:  # deepest first (JUDGMENT_PATH.parent)
                try:
                    created.rmdir()
                except OSError:
                    pass
        else:
            JUDGMENT_PATH.parent.mkdir(parents=True, exist_ok=True)
            JUDGMENT_PATH.write_bytes(cls._record_original)

    def setUp(self):
        self.addCleanup(self._clear_record)

    def _clear_record(self):
        JUDGMENT_PATH.unlink(missing_ok=True)

    def _write_record(self, data) -> None:
        JUDGMENT_PATH.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            JUDGMENT_PATH.write_text(data, encoding="utf-8")
        else:
            JUDGMENT_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def _make_repo(self, *, branch: str) -> Path:
        repo = Path(tempfile.mkdtemp(dir=WORK))
        _run_git(["init", "--quiet", "."], cwd=repo)
        _run_git(["config", "user.email", "selftest@example.invalid"], cwd=repo)
        _run_git(["config", "user.name", "main-integration-guard-selftest"], cwd=repo)
        (repo / "a.txt").write_text("one", encoding="utf-8")
        _run_git(["add", "a.txt"], cwd=repo)
        _run_git(["commit", "--quiet", "-m", "base"], cwd=repo)
        _run_git(["branch", "-M", "main"], cwd=repo)
        if branch != "main":
            _run_git(["checkout", "--quiet", "-b", branch], cwd=repo)
        return repo

    def invoke(self, *, tool="Bash", command, cwd=None, raw=None):
        payload = {
            "hook_event_name": "PreToolUse", "tool_name": tool,
            "tool_input": {"command": command},
        }
        if cwd is not None:
            payload["cwd"] = str(cwd)
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps(payload) if raw is None else raw,
            text=True, capture_output=True, cwd=ROOT, timeout=10,
        )

    def assert_denied(self, result, *, contains=None):
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn("rules/03 §6", output["permissionDecisionReason"])
        if contains is not None:
            self.assertIn(contains, output["permissionDecisionReason"])

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    # --- record presence / shape / count ---

    def test_no_record_denied(self):
        self.assert_denied(self.invoke(command="gh pr create --title x --body y"),
                            contains="判定の記録が無い")

    def test_count_9_denied(self):
        self._write_record({**VALID_RECORD, "count": 9, "completedTaskIds": [f"ADD-{i}" for i in range(9)]})
        self.assert_denied(self.invoke(command="git push origin HEAD:main"), contains="count が10未満")

    def test_count_10_valid_allowed(self):
        self._write_record(VALID_RECORD)
        self.assert_allowed(self.invoke(command="git push origin HEAD:main"))

    def test_count_mismatch_with_task_ids_denied(self):
        self._write_record({**VALID_RECORD, "count": 10, "completedTaskIds": [f"ADD-{i}" for i in range(9)]})
        self.assert_denied(self.invoke(command="gh pr merge 19 --squash"), contains="一致しない")

    def test_count_not_integer_denied(self):
        self._write_record({**VALID_RECORD, "count": "10"})
        self.assert_denied(self.invoke(command="gh pr ready 19"), contains="count が整数")

    def test_task_ids_not_array_denied(self):
        self._write_record({**VALID_RECORD, "completedTaskIds": "ADD-1"})
        self.assert_denied(self.invoke(command="gh pr create"), contains="配列になっていない")

    def test_record_not_object_denied(self):
        self._write_record([1, 2, 3])
        self.assert_denied(self.invoke(command="gh pr create"), contains="オブジェクトの形")

    def test_record_malformed_json_denied(self):
        self._write_record("{not valid json")
        self.assert_denied(self.invoke(command="gh pr create"), contains="判定の記録を読み取れない")

    # --- gh pr create ---

    def test_gh_pr_create_base_develop_allowed(self):
        self.assert_allowed(self.invoke(command="gh pr create --base develop --title x --body y"))

    def test_gh_pr_create_base_develop_inline_allowed(self):
        self.assert_allowed(self.invoke(command="gh pr create --base=develop --title x"))

    def test_gh_pr_create_default_base_main_denied(self):
        self.assert_denied(self.invoke(command="gh pr create --title x --body y"), contains="gh pr create")

    def test_gh_pr_create_explicit_base_main_denied(self):
        self.assert_denied(self.invoke(command="gh pr create --base main --title x"), contains="gh pr create")

    def test_gh_pr_create_base_refs_heads_main_denied(self):
        self.assert_denied(self.invoke(command="gh pr create --base refs/heads/main --title x"))

    # --- gh pr ready / merge: undecidable target -> deny side ---

    def test_gh_pr_ready_denied_without_record(self):
        self.assert_denied(self.invoke(command="gh pr ready 19"), contains="gh pr ready")

    def test_gh_pr_merge_denied_without_record(self):
        self.assert_denied(self.invoke(command="gh pr merge 19 --squash"), contains="gh pr merge")

    def test_gh_pr_merge_allowed_with_valid_record(self):
        self._write_record(VALID_RECORD)
        self.assert_allowed(self.invoke(command="gh pr merge 19 --squash"))

    # --- git push ---

    def test_git_push_feature_branch_allowed(self):
        self.assert_allowed(self.invoke(command="git push origin feature/x"))

    def test_git_push_head_main_denied(self):
        self.assert_denied(self.invoke(command="git push origin HEAD:main"), contains="git push")

    def test_git_push_plain_main_denied(self):
        self.assert_denied(self.invoke(command="git push origin main"))

    def test_git_push_refs_heads_main_denied(self):
        self.assert_denied(self.invoke(command="git push origin refs/heads/main"))

    def test_git_push_force_with_lease_head_main_denied(self):
        self.assert_denied(self.invoke(command="git push --force-with-lease origin HEAD:main"))

    # --- PowerShell: same results ---

    def test_powershell_head_main_denied(self):
        self.assert_denied(self.invoke(tool="PowerShell", command="git push origin HEAD:main"))

    def test_powershell_feature_branch_allowed(self):
        self.assert_allowed(self.invoke(tool="PowerShell", command="git push origin feature/x"))

    def test_powershell_valid_record_allowed(self):
        self._write_record(VALID_RECORD)
        self.assert_allowed(self.invoke(tool="PowerShell", command="git push origin HEAD:main"))

    # --- git merge / rebase on the real current branch ---

    def test_git_merge_on_main_denied(self):
        repo = self._make_repo(branch="main")
        self.assert_denied(self.invoke(command="git merge feature-x", cwd=repo), contains="git merge")

    def test_git_rebase_on_main_denied(self):
        repo = self._make_repo(branch="main")
        self.assert_denied(self.invoke(command="git rebase origin/main", cwd=repo), contains="git rebase")

    def test_git_merge_on_feature_branch_allowed(self):
        repo = self._make_repo(branch="feature-y")
        self.assert_allowed(self.invoke(command="git merge main", cwd=repo))

    def test_git_merge_abort_on_main_allowed(self):
        repo = self._make_repo(branch="main")
        self.assert_allowed(self.invoke(command="git merge --abort", cwd=repo))

    def test_git_rebase_continue_on_main_allowed(self):
        repo = self._make_repo(branch="main")
        self.assert_allowed(self.invoke(command="git rebase --continue", cwd=repo))

    def test_git_merge_on_main_allowed_with_valid_record(self):
        repo = self._make_repo(branch="main")
        self._write_record(VALID_RECORD)
        self.assert_allowed(self.invoke(command="git merge feature-x", cwd=repo))

    # --- pass-through ---

    def test_unrelated_command_allowed(self):
        self.assert_allowed(self.invoke(command="git status"))

    def test_unrelated_tool_allowed(self):
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps({
                "hook_event_name": "PreToolUse", "tool_name": "Read",
                "tool_input": {"file_path": "x"},
            }),
            text=True, capture_output=True, cwd=ROOT, timeout=10,
        )
        self.assert_allowed(result)

    def test_gh_pr_list_allowed(self):
        self.assert_allowed(self.invoke(command="gh pr list"))

    # --- fail-open on unreadable hook input ---

    def test_bad_json_fail_open(self):
        result = self.invoke(command="unused", raw="{")
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_missing_tool_input_fail_open(self):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash"}
        result = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(HOOK)],
            input=json.dumps(payload), text=True, capture_output=True, cwd=ROOT, timeout=10,
        )
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_HOOK_FAIL_OPEN", result.stderr)

    def test_execution_under_two_seconds(self):
        self._write_record(VALID_RECORD)
        start = time.perf_counter()
        result = self.invoke(command="gh pr create --base main")
        elapsed = time.perf_counter() - start
        self.assert_allowed(result)
        self.assertLess(elapsed, 2.0, f"hook took {elapsed:.3f}s")


if __name__ == "__main__":
    unittest.main()
