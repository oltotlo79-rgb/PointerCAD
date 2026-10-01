"""Subprocess checks of the real stdin/stdout contract, without Git writes or network access.

Each run copies the hook into an isolated .claude/hooks/ layout under scratchpad/temp/ and
creates its own synthetic records. No existing state is read, overwritten, or restored.
The child runner mocks only subprocess.run inside the hook: rev-parse reads a synthetic branch
marker, and ls-remote returns the selected tag response. Unknown commands fail immediately.
The hook itself still reads stdin, resolves its real file location, loads JSON from disk, and
emits its production stdout/stderr. The existing 55 test expectations remain unchanged.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

SOURCE_HOOK = Path(__file__).resolve().with_name("main_integration_guard.py")
ROOT = SOURCE_HOOK.parents[2]
WORK = ROOT / "scratchpad/temp" / f"main-integration-guard-selftest-{uuid.uuid4().hex[:8]}"
FIXTURE = WORK / "fixture"
HOOK = FIXTURE / ".claude/hooks/main_integration_guard.py"
JUDGMENT_PATH = FIXTURE / "scratchpad/claude/state/main-integration-judgment.json"
RELEASE_PATH = FIXTURE / "scratchpad/claude/state/main-release-integration.json"
RUNNER = WORK / "invoke.py"
CALLS = WORK / "git-calls.jsonl"

SHA = "bb4e1612fa80bf8200034f84f11813536820e3b2"
OTHER_SHA = "c" * 40
VALID_RELEASE = {
    "approvedBy": "user",
    "reason": "公開した版は完了した原タスクの件数に関係なく main へ統合する",
    "tag": "v1.0.0",
    "sha": SHA,
    "recordedBy": "orchestrator",
    "recordedAt": "2026-09-30T10:05:00+09:00",
}
RELEASE_PUSH = f"git push origin {SHA}:refs/heads/main"

# This mock exists only in the disposable test runner; production has no environment switch
# or other test backdoor. No real git command (including init/config/add/commit) is executed.
RUNNER_SOURCE = r'''
import json
import os
import runpy
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

remote = json.loads(os.environ["MAIN_GUARD_SELFTEST_REMOTE"])
calls = Path(os.environ["MAIN_GUARD_SELFTEST_CALLS"])

def fake_git(args, **kwargs):
    env = kwargs.get("env", {})
    with calls.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "args": args, "cwd": str(kwargs.get("cwd")),
            "timeout": kwargs.get("timeout"),
            "stdinClosed": kwargs.get("stdin") == subprocess.DEVNULL,
            "prompt": env.get("GIT_TERMINAL_PROMPT"),
            "locks": env.get("GIT_OPTIONAL_LOCKS"),
            "shell": kwargs.get("shell", False),
        }) + chr(10))
    if args == ["git", "rev-parse", "--abbrev-ref", "HEAD"]:
        marker = Path(kwargs["cwd"]) / "selftest-branch.txt"
        if marker.exists():
            return subprocess.CompletedProcess(args, 0, marker.read_text(encoding="utf-8"), "")
        return subprocess.CompletedProcess(args, 1, "", "no synthetic branch")
    if args[:4] == ["git", "ls-remote", "--tags", "origin"]:
        error = remote.get("error")
        if error == "timeout":
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])
        if error == "missing":
            raise FileNotFoundError("git is unavailable")
        if error == "decode":
            raise UnicodeError("invalid remote output")
        if error == "unexpected":
            raise RuntimeError("unexpected lookup failure")
        return subprocess.CompletedProcess(args, remote.get("returncode", 0),
                                           remote.get("stdout", ""), "synthetic stderr")
    raise AssertionError(f"unexpected subprocess: {args}")

with patch("subprocess.run", side_effect=fake_git):
    runpy.run_path(sys.argv[1], run_name="__main__")
'''

VALID_RECORD = {
    "commit": "a" * 40,
    "completedTaskIds": [f"ADD-{i}" for i in range(10)],
    "count": 10,
    "judgedAt": "2026-09-25T08:00:00+09:00",
    "evidence": "scratchpad/claude/agents/w48a-add-completion-judgment/judgment.md",
}


class MainIntegrationGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._work_created_ancestors = []
        node = WORK
        while not node.exists():
            cls._work_created_ancestors.append(node)
            node = node.parent
        WORK.mkdir(parents=True, exist_ok=True)

        HOOK.parent.mkdir(parents=True)
        shutil.copyfile(SOURCE_HOOK, HOOK)
        RUNNER.write_text(RUNNER_SOURCE, encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        # Resolve and check the exact deletion target before recursive cleanup.
        resolved = WORK.resolve()
        if resolved.parent != (ROOT / "scratchpad/temp").resolve():
            raise RuntimeError(f"unsafe cleanup target: {resolved}")
        shutil.rmtree(resolved)
        for created in cls._work_created_ancestors[1:]:
            try:
                created.rmdir()
            except OSError:
                pass

    def setUp(self):
        self.remote = {"stdout": f"{SHA}\trefs/tags/v1.0.0\n"}
        CALLS.unlink(missing_ok=True)
        self.addCleanup(self._clear_record)

    def _clear_record(self):
        JUDGMENT_PATH.unlink(missing_ok=True)
        RELEASE_PATH.unlink(missing_ok=True)

    def _write_record(self, data) -> None:
        JUDGMENT_PATH.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            JUDGMENT_PATH.write_text(data, encoding="utf-8")
        else:
            JUDGMENT_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def _make_repo(self, *, branch: str) -> Path:
        repo = Path(tempfile.mkdtemp(dir=WORK))
        (repo / "selftest-branch.txt").write_text(branch, encoding="utf-8")
        return repo

    def _write_release(self, data=VALID_RELEASE):
        RELEASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        RELEASE_PATH.write_text(data if isinstance(data, str) else json.dumps(data),
                                encoding="utf-8")

    def _calls(self):
        if not CALLS.exists():
            return []
        return [json.loads(line) for line in CALLS.read_text(encoding="utf-8").splitlines()]

    def invoke(self, *, tool="Bash", command, cwd=None, raw=None):
        payload = {
            "hook_event_name": "PreToolUse", "tool_name": tool,
            "tool_input": {"command": command},
        }
        if cwd is not None:
            payload["cwd"] = str(cwd)
        env = os.environ.copy()
        env["MAIN_GUARD_SELFTEST_REMOTE"] = json.dumps(self.remote)
        env["MAIN_GUARD_SELFTEST_CALLS"] = str(CALLS)
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(RUNNER), str(HOOK)],
            input=json.dumps(payload) if raw is None else raw,
            text=True, encoding="utf-8", capture_output=True, cwd=ROOT, timeout=10, env=env,
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

    # --- git push with global options before the subcommand (rules/06 §10.357 loophole: these
    # used to slip past because only tokens[0]/tokens[1] were checked) ---

    def test_git_dash_capital_c_push_main_denied(self):
        self.assert_denied(self.invoke(command="git -C scratchpad/c3 push origin main"),
                            contains="git push")

    def test_git_dash_capital_c_push_feature_allowed(self):
        self.assert_allowed(self.invoke(command="git -C scratchpad/c3 push origin feature/x"))

    def test_git_dash_lower_c_push_head_main_denied(self):
        self.assert_denied(self.invoke(command="git -c user.name=x push origin HEAD:main"))

    def test_git_dash_lower_c_multiple_push_main_denied(self):
        self.assert_denied(self.invoke(
            command="git -c user.name=x -c user.email=y@example.invalid push origin main"))

    def test_git_dash_dash_git_dir_inline_push_main_denied(self):
        self.assert_denied(self.invoke(command="git --git-dir=scratchpad/c3/.git push origin main"))

    def test_git_dash_dash_git_dir_separate_push_main_denied(self):
        self.assert_denied(
            self.invoke(command="git --git-dir scratchpad/c3/.git push origin main"))

    def test_git_dash_dash_work_tree_push_main_denied(self):
        self.assert_denied(self.invoke(
            command="git --work-tree=scratchpad/c3 --git-dir=scratchpad/c3/.git push origin main"))

    def test_git_no_pager_push_main_denied(self):
        self.assert_denied(self.invoke(command="git --no-pager push origin main"))

    def test_git_dash_capital_c_push_main_allowed_with_valid_record(self):
        self._write_record(VALID_RECORD)
        self.assert_allowed(self.invoke(command="git -C scratchpad/c3 push origin main"))

    def test_powershell_git_dash_capital_c_push_main_denied(self):
        self.assert_denied(self.invoke(tool="PowerShell",
                                        command="git -C scratchpad/c3 push origin main"))

    # --- git merge / rebase with global options before the subcommand ---

    def test_git_dash_capital_c_merge_on_main_denied(self):
        repo = self._make_repo(branch="main")
        self.assert_denied(self.invoke(command="git -C unrelated merge feature-x", cwd=repo),
                            contains="git merge")

    def test_git_dash_lower_c_rebase_on_main_denied(self):
        repo = self._make_repo(branch="main")
        self.assert_denied(self.invoke(command="git -c rebase.autoStash=true rebase origin/main",
                                        cwd=repo), contains="git rebase")

    # --- deliver.py gate --push-ref / isolated_checkout_preflight.py --push-ref (rules/06 §10.357:
    # these push an explicit ref without the literal text "git push" ever appearing) ---

    def test_deliver_gate_push_ref_refs_heads_main_denied(self):
        self.assert_denied(self.invoke(
            command="python -B -X utf8 scratchpad/claude/tools/deliver.py gate "
                     "--delivery x --message m.txt --push-ref refs/heads/main"),
            contains="deliver.py")

    def test_deliver_gate_push_ref_bare_main_denied(self):
        self.assert_denied(self.invoke(
            command="python scratchpad/claude/tools/deliver.py gate --push-ref main"))

    def test_deliver_gate_push_ref_feature_branch_allowed(self):
        self.assert_allowed(self.invoke(
            command="python scratchpad/claude/tools/deliver.py gate "
                     "--push-ref refs/heads/feature/math-extensions-20260913"))

    def test_deliver_gate_push_ref_main_allowed_with_valid_record(self):
        self._write_record(VALID_RECORD)
        self.assert_allowed(self.invoke(
            command="python scratchpad/claude/tools/deliver.py gate --push-ref refs/heads/main"))

    def test_isolated_checkout_preflight_push_ref_main_denied(self):
        self.assert_denied(self.invoke(
            command="python -B -X utf8 scripts/lib/isolated_checkout_preflight.py "
                     "--project . --checkout scratchpad/c3 --commit " + "a" * 40 +
                     " --push-ref refs/heads/main"),
            contains="isolated_checkout_preflight.py")

    def test_isolated_checkout_preflight_push_ref_feature_allowed(self):
        self.assert_allowed(self.invoke(
            command="python scripts/lib/isolated_checkout_preflight.py "
                     "--project . --checkout scratchpad/c3 --commit " + "a" * 40 +
                     " --push-ref refs/heads/feature/x"))

    def test_isolated_checkout_preflight_without_push_ref_allowed(self):
        self.assert_allowed(self.invoke(
            command="python scripts/lib/isolated_checkout_preflight.py "
                     "--project . --checkout scratchpad/c3 --commit " + "a" * 40))

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

    # --- published-release exception: actual files and actual child hook entry point ---

    def assert_release_allowed(self, result):
        self.assert_allowed(result)
        self.assertIn("POINTERCAD_MAIN_RELEASE_INTEGRATION:", result.stderr)
        self.assertIn(VALID_RELEASE["reason"], result.stderr)
        self.assertIn("tag=v1.0.0", result.stderr)
        self.assertIn(f"sha={SHA}", result.stderr)
        self.assertNotIn("FAIL_OPEN", result.stderr)

    def test_release_sha_matching_published_tag_allowed(self):
        self._write_release()
        self.assert_release_allowed(self.invoke(command=RELEASE_PUSH))
        self.assertEqual(self._calls(), [{
            "args": ["git", "ls-remote", "--tags", "origin", "refs/tags/v1.0.0",
                     "refs/tags/v1.0.0^{}"],
            "cwd": str(ROOT), "timeout": 3, "stdinClosed": True,
            "prompt": "0", "locks": "0", "shell": False,
        }])

    def test_release_count_below_ten_allowed_in_both_shells(self):
        self._write_release()
        self._write_record({**VALID_RECORD, "count": 0, "completedTaskIds": []})
        for tool in ("Bash", "PowerShell"):
            with self.subTest(tool=tool):
                self.assert_release_allowed(self.invoke(tool=tool, command=RELEASE_PUSH))

    def test_release_missing_or_broken_judgment_allowed(self):
        self._write_release()
        for record in ("{", [], {"count": "10"}):
            with self.subTest(record=record):
                self._write_record(record)
                self.assert_release_allowed(self.invoke(command=RELEASE_PUSH))

    def test_release_literal_ref_spellings_allowed(self):
        self._write_release()
        for destination in ("main", "refs/heads/main"):
            for quote in ("", "'", '"'):
                with self.subTest(destination=destination, quote=quote):
                    command = f"git push origin {quote}{SHA}:{destination}{quote}"
                    self.assert_release_allowed(self.invoke(command=command))

    def test_release_lookup_uses_payload_cwd(self):
        self._write_release()
        checkout = self._make_repo(branch="release")
        self.assert_release_allowed(self.invoke(command=RELEASE_PUSH, cwd=checkout))
        self.assertEqual(self._calls()[0]["cwd"], str(checkout))

    def test_release_lookup_uses_git_dash_c_relative_to_payload(self):
        self._write_release()
        checkout = WORK / "checkout with spaces"
        checkout.mkdir()
        for tool in ("Bash", "PowerShell"):
            with self.subTest(tool=tool):
                command = f'git -C "checkout with spaces" push origin {SHA}:main'
                self.assert_release_allowed(self.invoke(tool=tool, command=command, cwd=WORK))
                self.assertEqual(self._calls()[-1]["cwd"], str(checkout.resolve()))

    def test_release_lookup_uses_git_dash_c_absolute_path(self):
        self._write_release()
        checkout = self._make_repo(branch="release")
        command = f"git -C {checkout.as_posix()} push origin {SHA}:main"
        self.assert_release_allowed(self.invoke(command=command))
        self.assertEqual(self._calls()[0]["cwd"], str(checkout.resolve()))

    def test_release_annotated_tag_uses_peeled_commit(self):
        self._write_release()
        self.remote["stdout"] = (
            f"{OTHER_SHA}\trefs/tags/v1.0.0\n{SHA}\trefs/tags/v1.0.0^{{}}\n"
        )
        self.assert_release_allowed(self.invoke(command=RELEASE_PUSH))

    def test_release_annotated_tag_object_is_not_commit(self):
        self._write_release()
        self.remote["stdout"] = (
            f"{SHA}\trefs/tags/v1.0.0\n{OTHER_SHA}\trefs/tags/v1.0.0^{{}}\n"
        )
        self.assert_denied(self.invoke(command=RELEASE_PUSH))

    def test_release_missing_record_denied_without_lookup(self):
        self.assert_denied(self.invoke(command=RELEASE_PUSH))
        self.assertEqual(self._calls(), [])

    def test_release_malformed_record_denied_without_lookup(self):
        invalid = [None, [], 10, True, "{bad json", {}, {"sha": SHA}]
        invalid.extend({key: value for key, value in VALID_RELEASE.items() if key != missing}
                       for missing in VALID_RELEASE)
        for record in invalid:
            with self.subTest(record=record):
                self._write_release(record)
                self.assert_denied(self.invoke(command=RELEASE_PUSH))
        self.assertEqual(self._calls(), [])

    def test_release_invalid_field_values_denied_without_lookup(self):
        invalid = {
            "approvedBy": ["orchestrator", True, None],
            "recordedBy": ["user", 1, None],
            "reason": ["", "  ", False, "line\nbreak", "escape" + chr(27)],
            "sha": [SHA[:7], "g" * 40, SHA + " ", 1, None],
            "tag": ["", "-v1.0.0", "v*", "v?", "v[1]", "v1.0.0^{}", "v1..0",
                    "refs/tags/v1.0.0", "v//x", "v/x.lock", "v/.x", "v/x.",
                    "v1.0.0;echo", "$TAG", "v1.0.0\n", None],
            "recordedAt": ["", "yesterday", "2026-02-30T10:00:00+09:00", "2026-09-30",
                           "2026-09-30T25:00:00+09:00", None, True],
        }
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self._write_release({**VALID_RELEASE, key: value})
                    self.assert_denied(self.invoke(command=RELEASE_PUSH))
        self.assertEqual(self._calls(), [])

    def test_release_unreadable_record_denied_without_fail_open(self):
        RELEASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        RELEASE_PATH.write_bytes(bytes([255]))
        result = self.invoke(command=RELEASE_PUSH)
        self.assert_denied(result)
        self.assertNotIn("FAIL_OPEN", result.stderr)
        self.assertEqual(self._calls(), [])

    def test_release_missing_tag_denied(self):
        self._write_release()
        self.remote["stdout"] = ""
        self.assert_denied(self.invoke(command=RELEASE_PUSH))

    def test_release_remote_tag_mismatch_denied(self):
        self._write_release()
        self.remote["stdout"] = f"{OTHER_SHA}\trefs/tags/v1.0.0\n"
        self.assert_denied(self.invoke(command=RELEASE_PUSH))

    def test_release_remote_malformed_or_ambiguous_response_denied(self):
        self._write_release()
        for output in (
            "not a ref", f"{SHA}\trefs/tags/v1.0.1\n", f"{SHA}\trefs/tags/v1.0.0^{{}}\n",
            f"{SHA[:7]}\trefs/tags/v1.0.0\n", f"{SHA}\trefs/tags/v1.0.0 extra\n",
            f"{SHA}\trefs/tags/v1.0.0\n{SHA}\trefs/tags/v1.0.0\n",
            f"{SHA}\trefs/tags/v1.0.0\n{OTHER_SHA}\trefs/tags/other\n",
        ):
            with self.subTest(output=output):
                self.remote["stdout"] = output
                self.assert_denied(self.invoke(command=RELEASE_PUSH))

    def test_release_remote_failure_with_matching_stdout_denied(self):
        self._write_release()
        self.remote["returncode"] = 128
        self.assert_denied(self.invoke(command=RELEASE_PUSH))

    def test_release_lookup_errors_denied_without_fail_open(self):
        self._write_release()
        for error in ("timeout", "missing", "decode", "unexpected"):
            with self.subTest(error=error):
                self.remote["error"] = error
                result = self.invoke(command=RELEASE_PUSH)
                self.assert_denied(result)
                self.assertNotIn("FAIL_OPEN", result.stderr)

    def test_release_different_sent_sha_denied_without_lookup(self):
        self._write_release()
        self.assert_denied(self.invoke(command=f"git push origin {OTHER_SHA}:main"))
        self.assertEqual(self._calls(), [])

    def test_release_undecidable_sent_commit_denied_without_lookup(self):
        self._write_release()
        for source in ("HEAD", "main", "v1.0.0", SHA[:7], "$SHA", "${SHA}", f"{SHA}^{{}}"):
            with self.subTest(source=source):
                self.assert_denied(self.invoke(command=f"git push origin {source}:main"))
        self.assertEqual(self._calls(), [])

    def test_release_extra_actions_options_and_expansion_denied(self):
        self._write_release()
        commands = [
            RELEASE_PUSH + " && git push origin HEAD:main",
            "git push origin HEAD:main; " + RELEASE_PUSH,
            RELEASE_PUSH + "\ngit push origin HEAD:main",
            RELEASE_PUSH + " & git push origin HEAD:main",
            RELEASE_PUSH + " | cat", RELEASE_PUSH + " > output.txt",
            RELEASE_PUSH + "\n", RELEASE_PUSH + " # comment",
            RELEASE_PUSH + " HEAD:main", RELEASE_PUSH + " --all",
            f"git push --force origin {SHA}:main", f"git push origin +{SHA}:main",
            f"git push origin {SHA}:main HEAD:feature/x",
            f"git push upstream {SHA}:main", f"git push --repo origin {SHA}:main",
            f"git -c remote.origin.url=other push origin {SHA}:main",
            f"git --git-dir=somewhere push origin {SHA}:main",
            f'git -C "$CHECKOUT" push origin {SHA}:main',
            f"git -C `pwd` push origin {SHA}:main",
            'git push origin "$(git rev-parse HEAD)":main',
            f"git push origin {SHA[:-1]}{chr(92)}{SHA[-1]}:main",
        ]
        for command in commands:
            with self.subTest(command=command):
                self.assert_denied(self.invoke(command=command))
        self.assertEqual(self._calls(), [])

    def test_release_does_not_allow_pr_or_script_routes(self):
        self._write_release()
        commands = [
            "gh pr create --base main", "gh pr ready 19", "gh pr merge 19 --squash",
            "python scratchpad/claude/tools/deliver.py gate --push-ref main",
            f"python scripts/lib/isolated_checkout_preflight.py --commit {SHA} --push-ref main",
        ]
        for command in commands:
            with self.subTest(command=command):
                self.assert_denied(self.invoke(command=command))
        self.assertEqual(self._calls(), [])

    def test_release_does_not_allow_merge_or_rebase_on_main(self):
        self._write_release()
        repo = self._make_repo(branch="main")
        for verb in ("merge", "rebase"):
            with self.subTest(verb=verb):
                self.assert_denied(self.invoke(command=f"git {verb} {SHA}", cwd=repo))
        self.assertTrue(all(call["args"][1] == "rev-parse" for call in self._calls()))

    def test_release_record_does_not_affect_non_main_commands(self):
        self._write_release()
        for command in ("git status", f"git push origin {SHA}:refs/heads/feature/release"):
            with self.subTest(command=command):
                result = self.invoke(command=command)
                self.assert_allowed(result)
                self.assertEqual(result.stderr, "")
        self.assertEqual(self._calls(), [])

    def test_valid_ordinary_judgment_does_not_need_release_exception(self):
        self._write_record(VALID_RECORD)
        self._write_release({**VALID_RELEASE, "sha": OTHER_SHA})
        self.remote["error"] = "timeout"
        result = self.invoke(command=RELEASE_PUSH)
        self.assert_allowed(result)
        self.assertEqual(result.stderr, "")
        self.assertEqual(self._calls(), [])


if __name__ == "__main__":
    unittest.main()
