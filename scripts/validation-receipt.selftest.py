"""Exercise the actual B3 receipt with temporary Git trees and independent input mutations."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('validation_receipt', Path(__file__).parent / 'lib/validation_receipt.py')
assert spec is not None and spec.loader is not None
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pointercad-receipt-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.environment = patch.dict(os.environ, {'CI': '', 'POINTERCAD_PERF_STRICT': '1'})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.tools = {name: sys.executable for name in ('node', 'pnpm', 'git', 'shell', 'node_runtime', 'pnpm_runtime')}
        # Receipt state tests use real files without launching or downloading browsers.
        # The production resolver is separately exercised with a deterministic executable listing.
        self.write('browser/runtime.bin', 'browser build')
        self.browser_lookup = patch.object(receipt, 'browser_roots', return_value=[self.root / 'browser'])
        self.browser_lookup.start(); self.addCleanup(self.browser_lookup.stop)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Receipt self-test')
        self.git('config', 'user.email', 'receipt-test@example.invalid')
        self.write('.gitignore', 'node_modules/\ndist/\n.env*\nbrowser/\n')
        self.write('a.txt', 'old')
        self.git('add', '.'); self.git('commit', '-qm', 'baseline')
        self.write('a.txt', 'new'); self.git('add', 'a.txt')
        self.write('node_modules/fixture/index.js', 'export const dependency=1;')
        self.write('apps/web/dist/index.js', 'old output')
        self.folder = receipt.storage(self.root)

    def git(self, *args):
        return receipt.git(self.root, *args)

    def write(self, name, value):
        path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding='utf-8')
        return path

    def run_action(self, action, phase='Manual', token='', repeats=1):
        return receipt.run(action, self.root, self.tools, phase, token, repeats)

    def complete(self):
        start = self.run_action('start')
        self.assertTrue(start['ok'])
        self.write('apps/web/dist/index.js', 'checked output')
        self.assertTrue(self.run_action('finish', token=start['token'])['ok'])

    def assert_no_receipt(self):
        self.assertFalse((self.folder / 'validation-receipt.json').exists())

    def test_same_content_commit_then_push_consumes_receipt_once(self):
        self.complete()
        self.assertTrue(self.run_action('reuse', 'Commit')['used'])
        self.git('commit', '-qm', 'checked change')
        self.assertTrue(self.run_action('reuse', 'Push')['used'])
        self.assert_no_receipt()
        with self.assertRaises(OSError):
            self.run_action('reuse', 'Push')

    def test_unix_hook_git_hashes_both_shipped_entries_and_rejects_other_copies(self):
        core = self.root / 'git-layout/lib/git-core'
        core.mkdir(parents=True)
        runtime = self.write('git-layout/lib/git-core/git', 'actual git executable')
        selected = self.root / 'git-layout/bin/git'
        selected.parent.mkdir(parents=True)
        os.link(runtime, selected)
        from types import SimpleNamespace
        output = SimpleNamespace(stdout=str(core).encode())
        # Avoid changing os.name: pathlib must keep the real host path semantics.
        with patch.object(receipt, 'os', SimpleNamespace(name='posix')), patch.object(receipt.subprocess, 'run', return_value=output):
            expected = (runtime.resolve(), [selected.resolve()])
            self.assertEqual(receipt.git_tool_inputs(selected), expected)
            self.assertEqual(receipt.git_tool_inputs(runtime), expected)
            copied = self.write('git-layout/another/git', runtime.read_text())
            self.assertEqual(receipt.git_tool_inputs(copied), (copied, []))
            runtime.write_text('changed executable', encoding='utf8')
            self.assertEqual(receipt.file_hash(runtime), receipt.file_hash(selected))
            self.assertNotEqual(receipt.file_hash(runtime), receipt.file_hash(copied))
            # Debian/Ubuntu packages may install the two shipped entries as copies.
            selected.unlink()
            selected.write_bytes(runtime.read_bytes())
            self.assertFalse(selected.samefile(runtime))
            self.assertEqual(receipt.git_tool_inputs(selected), expected)
            self.assertEqual(receipt.git_tool_inputs(runtime), expected)
            selected.write_text('different installed entry', encoding='utf8')
            self.assertEqual(receipt.git_tool_inputs(selected), (selected, []))
            self.assertEqual(receipt.git_tool_inputs(runtime), (runtime, []))

    def test_commit_cannot_consume_twice_or_leave_stale_success(self):
        self.complete(); self.run_action('reuse', 'Commit')
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.assert_no_receipt()

    def test_windows_git_launchers_share_all_inputs_for_x64_and_arm64(self):
        from types import SimpleNamespace
        for architecture in ('mingw64', 'clangarm64'):
            with self.subTest(architecture=architecture):
                base = 'windows-git/' + architecture
                core = self.root / base / architecture / 'libexec/git-core'
                runtime = self.write(base + '/' + architecture + '/libexec/git-core/git.exe', 'runtime')
                shipped = [self.write(base + '/cmd/git.exe', 'cmd launcher'),
                           self.write(base + '/bin/git.exe', 'bin launcher'),
                           self.write(base + '/' + architecture + '/bin/git.exe', 'architecture launcher'), runtime]
                output = SimpleNamespace(stdout=str(core).encode())
                with patch.object(receipt, 'os', SimpleNamespace(name='nt')), patch.object(receipt.subprocess, 'run', return_value=output):
                    expected = (runtime.resolve(), shipped)
                    for selected in shipped:
                        self.assertEqual(receipt.git_tool_inputs(selected), expected)
                    before = receipt.directory_digest(shipped, self.root, dependencies=False)
                    shipped[1].write_text('changed bin launcher', encoding='utf8')
                    self.assertNotEqual(receipt.directory_digest(shipped, self.root, dependencies=False), before)
                    outside = self.write(base + '/unrecognized/git.exe', 'runtime')
                    self.assertEqual(receipt.git_tool_inputs(outside), (outside, []))

    def test_browser_debug_output_does_not_change_runtime_inputs_but_code_always_does(self):
        browser = self.root / 'browser/chromium_headless_shell-1234'
        executable = self.write('browser/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe', 'browser')
        before = receipt.browser_digest([browser], self.root)
        log = self.write('browser/chromium_headless_shell-1234/chrome-headless-shell-win64/debug.log', 'GPU diagnostic')
        self.assertEqual(receipt.browser_digest([browser], self.root), before)
        log.write_text('another diagnostic', encoding='utf8')
        self.assertEqual(receipt.browser_digest([browser], self.root), before)
        log.unlink()
        self.assertEqual(receipt.browser_digest([browser], self.root), before)
        executable.write_text('changed browser', encoding='utf8')
        self.assertNotEqual(receipt.browser_digest([browser], self.root), before)
        executable.write_text('browser', encoding='utf8')
        self.write('browser/chromium_headless_shell-1234/chrome-headless-shell-win64/resources.pak', 'changed resource')
        self.assertNotEqual(receipt.browser_digest([browser], self.root), before)

    def test_browser_log_exemption_is_not_a_general_filename_exemption(self):
        browser = self.root / 'browser/chromium_headless_shell-1234'
        self.write('browser/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe', 'browser')
        before = receipt.browser_digest([browser], self.root)
        arbitrary = self.write('browser/chromium_headless_shell-1234/debug.log', 'not the known browser output')
        self.assertNotEqual(receipt.browser_digest([browser], self.root), before)
        arbitrary.unlink()
        invalid = browser / 'chrome-headless-shell-win64/debug.log'
        invalid.mkdir()
        with self.assertRaises(ValueError):
            receipt.browser_digest([browser], self.root)
        invalid.rmdir()
        target = self.write('browser/actual-input.js', 'real code')
        try:
            invalid.symlink_to(target)
        except OSError as error:
            if os.name != 'nt' or error.winerror != 1314:
                raise
            # Exercise the refusal on Windows without granting extra privilege.
            # Linux and Windows with symlink rights use the actual link below.
            invalid.write_text('not an ordinary output', encoding='utf8')
            original = Path.is_symlink
            with patch.object(Path, 'is_symlink', lambda path: path == invalid or original(path)):
                with self.assertRaises(ValueError):
                    receipt.browser_digest([browser], self.root)
            return
        with self.assertRaises(ValueError):
            receipt.browser_digest([browser], self.root)

    def test_browser_generated_log_during_check_allows_receipt_without_ignoring_runtime_changes(self):
        browser = self.root / 'browser/chromium_headless_shell-1234'
        self.write('browser/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe', 'browser')
        with patch.object(receipt, 'browser_roots', return_value=[browser]):
            start = self.run_action('start')
            self.assertTrue(start['ok'])
            self.write('browser/chromium_headless_shell-1234/chrome-headless-shell-win64/debug.log', 'diagnostic from actual rendering')
            self.assertTrue(self.run_action('finish', token=start['token'])['ok'])
            self.assertTrue(self.run_action('reuse', 'Commit')['used'])

    def test_push_cannot_send_a_different_head_or_uncommitted_index(self):
        self.complete()
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Push')
        self.assert_no_receipt()

    def test_current_clean_head_can_use_manual_full_check_for_immediate_push(self):
        self.git('commit', '-qm', 'already committed change'); self.complete()
        self.assertTrue(self.run_action('reuse', 'Push')['used'])
        self.assert_no_receipt()

    def test_source_dependency_generated_output_and_ignored_environment_mutations_invalidate(self):
        for name in ('a.txt', 'node_modules/fixture/index.js', 'apps/web/dist/index.js', '.env.local', 'browser/runtime.bin'):
            with self.subTest(path=name):
                self.git('add', '-A'); self.complete()
                self.write(name, 'changed after the full check')
                with self.assertRaises(ValueError):
                    self.run_action('reuse', 'Commit')
                self.assert_no_receipt()

    def test_same_length_and_mtime_rewrite_is_detected_by_bytes(self):
        self.complete(); path = self.root / 'node_modules/fixture/index.js'; stamp = path.stat()
        path.write_text('export const dependency=2;', encoding='utf-8')
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.assert_no_receipt()

    def test_lazy_runtime_download_must_finish_before_recording_inputs(self):
        start = self.run_action('start')
        self.write('node_modules/electron/dist/electron.bin', 'downloaded runtime')
        self.write('browser/new-build/runtime.bin', 'downloaded browser')
        with self.assertRaisesRegex(ValueError, 'changed: dependencies, browsers'):
            self.run_action('finish', token=start['token'])
        self.assert_no_receipt()
        # Once preparation is complete, a fresh unchanged full check can be shared.
        self.complete()
        self.assertTrue(self.run_action('reuse', 'Commit')['used'])

    def test_actual_runtime_package_is_checked_beyond_unchanged_launcher(self):
        ignore = self.root / '.gitignore'
        ignore.write_text(ignore.read_text(encoding='utf-8') + 'external-tools/\n', encoding='utf-8')
        self.git('add', '.gitignore')
        runtime = self.write('external-tools/pnpm/bin/pnpm.mjs', '// unchanged launcher')
        self.write('external-tools/pnpm/package.json', '{"name":"pnpm","version":"11.25.0"}')
        self.write('external-tools/pnpm/dist/runtime.mjs', '// actual runtime v1')
        self.tools['pnpm_runtime'] = str(runtime)
        self.complete()
        self.write('external-tools/pnpm/dist/runtime.mjs', '// actual runtime v2')
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.assert_no_receipt()

    def test_new_untracked_file_and_staged_changes_are_not_omitted(self):
        self.complete(); self.write('記録 with spaces.txt', 'new file')
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.git('add', '.'); self.complete()
        self.write('a.txt', 'another staged version'); self.git('add', 'a.txt')
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.assert_no_receipt()

    def test_runtime_environment_change_and_more_required_repeats_reject_reuse(self):
        self.complete()
        with patch.dict(os.environ, {'NODE_OPTIONS': '--no-warnings'}), self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.complete()
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit', repeats=2)
        self.assert_no_receipt()

    def test_external_user_configuration_change_is_detected_without_printing_values(self):
        config = self.write('.git/user-config', 'ignore-scripts=false\n')
        with patch.dict(os.environ, {'NPM_CONFIG_USERCONFIG': str(config)}):
            self.complete()
            config.write_text('ignore-scripts=true\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'changed: environment'):
                self.run_action('reuse', 'Commit')
            self.assert_no_receipt()

    def test_partial_failure_interruption_and_wrong_completion_token_cannot_publish_success(self):
        start = self.run_action('start'); self.assert_no_receipt()
        with self.assertRaises(ValueError):
            self.run_action('finish', token='not-the-running-check')
        self.assert_no_receipt(); self.assertFalse((self.folder / 'validation-running.json').exists())
        start = self.run_action('start'); self.run_action('invalidate')
        with self.assertRaises(OSError):
            self.run_action('finish', token=start['token'])
        self.assert_no_receipt()

    def test_files_changed_during_the_check_do_not_create_a_receipt(self):
        start = self.run_action('start')
        self.write('node_modules/fixture/index.js', 'changed during check')
        with self.assertRaises(ValueError):
            self.run_action('finish', token=start['token'])
        self.assert_no_receipt()

    def test_modified_receipt_and_missing_key_are_not_trusted(self):
        self.complete(); path = self.folder / 'validation-receipt.json'
        raw = json.loads(path.read_text()); raw['payload']['at'] = time.time() + 10
        path.write_text(json.dumps(raw), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.complete(); (self.folder / 'validation-receipt.key').unlink()
        with self.assertRaises(OSError):
            self.run_action('reuse', 'Commit')
        self.assert_no_receipt()

    def test_time_expiry_clock_changes_and_different_commit_parent_are_rejected(self):
        self.complete(); key = (self.folder / 'validation-receipt.key').read_bytes()
        value = receipt.read_record(self.folder / 'validation-receipt.json', key)
        current = receipt.capture(self.root, self.tools)
        self.assertTrue(receipt.eligible(value, current, 'Commit', '', value['at'], value['monotonic'], 1))
        for seconds, uptime in ((1201, 1201), (-1, -1), (10, -10)):
            self.assertFalse(receipt.eligible(value, current, 'Commit', '', value['at'] + seconds, value['monotonic'] + uptime, 1))
        current['head'] = 'different-head'; value['phase'] = 'commit'
        self.assertFalse(receipt.eligible(value, current, 'Push', 'different-parent', value['at'], value['monotonic'], 1))

    def test_ci_and_non_strict_diagnostics_cannot_issue_or_use_a_receipt(self):
        self.complete()
        with patch.dict(os.environ, {'CI': 'true'}):
            self.assertFalse(self.run_action('reuse', 'Commit')['ok'])
        self.assert_no_receipt()
        with patch.dict(os.environ, {'POINTERCAD_PERF_STRICT': ''}):
            self.assertFalse(self.run_action('start')['ok'])
        self.assert_no_receipt()

    def test_assume_unchanged_and_alternate_index_do_not_hide_changed_files(self):
        self.complete(); self.git('update-index', '--assume-unchanged', 'a.txt')
        with self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.git('update-index', '--no-assume-unchanged', 'a.txt'); self.complete()
        with patch.dict(os.environ, {'GIT_INDEX_FILE': str(self.folder / 'another-index')}), self.assertRaises(ValueError):
            self.run_action('reuse', 'Commit')
        self.assert_no_receipt()

    def test_runtime_log_updates_are_distinct_from_dependency_code_changes(self):
        self.complete(); self.write('node_modules/.pnpm-task-run-state-v1/log.json', 'runtime bookkeeping')
        self.assertTrue(self.run_action('reuse', 'Commit')['used'])

    def test_two_hooks_cannot_consume_the_same_record_concurrently(self):
        self.complete()
        with receipt.receipt_lock(self.folder), self.assertRaises(OSError):
            self.run_action('reuse', 'Commit')
        self.assertTrue(self.run_action('reuse', 'Commit')['used'])

    def test_selected_browser_folders_include_headless_shell_and_missing_binaries_are_rejected(self):
        self.browser_lookup.stop()
        chrome = self.write('browser/chromium-123/chrome/chrome.exe', 'chrome')
        firefox = self.write('browser/firefox-456/firefox/firefox.exe', 'firefox')
        self.write('browser/chromium_headless_shell-123/shell.exe', 'headless')
        self.write('browser/ffmpeg-123/ffmpeg.exe', 'ffmpeg')
        response = type('Output', (), {'stdout': json.dumps([str(chrome), str(firefox)]).encode()})()
        with patch.object(receipt.subprocess, 'run', return_value=response):
            self.assertEqual({path.name for path in receipt.browser_roots(self.root, sys.executable)},
                             {'chromium-123', 'firefox-456', 'chromium_headless_shell-123', 'ffmpeg-123'})
            firefox.unlink()
            with self.assertRaises(OSError):
                receipt.browser_roots(self.root, sys.executable)


if __name__ == '__main__':
    unittest.main(verbosity=2)
