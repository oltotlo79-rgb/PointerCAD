"""Exercise local scope against real Git indexes and real PowerShell/hooks."""
import importlib.util
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load('local_change_scope', HERE / 'lib/local_change_scope.py')
hooks = load('receipt_hook_fixtures', HERE / 'validation-receipt.integration.selftest.py')


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pointercad-scope-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
        self.environment['CI'] = ''
        self.git('init', '-q')
        self.git('config', 'user.name', 'Local scope tests')
        self.git('config', 'user.email', 'scope@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.write('README.md', 'baseline\n')
        self.write('.gitattributes', '*.ps1 text\n')
        self.write('packages/model/src/runtime.ts', 'original')
        self.write('docs/standards/licenses/notice.txt', 'original')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.base)

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], env=self.environment,
                              capture_output=True, check=True, timeout=15).stdout

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf8')

    def inspect(self, level='Push', phase='Manual', base='', force=False):
        with patch.dict(os.environ, self.environment, clear=True):
            return scope.inspect(self.root, level, phase, base, force)

    def test_notice_and_documentation_are_targeted_but_runtime_is_not(self):
        self.write('README.md', 'updated')
        self.assertEqual(self.inspect()['mode'], 'targeted')
        self.write('docs/standards/licenses/notice.txt', 'updated')
        self.assertIn('desktop', self.inspect()['packages'])
        self.write('packages/model/src/runtime.ts', 'changed')
        self.assertEqual(self.inspect()['mode'], 'full')

    def test_commit_only_reads_the_index_and_manual_checks_both_index_and_worktree(self):
        self.write('README.md', 'updated')
        self.git('add', 'README.md')
        self.write('packages/model/src/runtime.ts', 'unstaged source')
        self.assertEqual(self.inspect('Commit', 'Commit')['mode'], 'targeted')
        self.git('add', 'packages/model/src/runtime.ts')
        self.write('packages/model/src/runtime.ts', 'original')
        self.assertEqual(self.inspect()['mode'], 'full')
        self.assertEqual(self.inspect('Commit', 'Commit')['mode'], 'full')

    def test_untracked_rename_and_delete_cannot_hide_runtime_changes(self):
        self.write('README.md', 'updated')
        self.write('packages/ui/src/new-runtime.ts', 'new')
        self.assertEqual(self.inspect()['mode'], 'full')
        (self.root / 'packages/ui/src/new-runtime.ts').unlink()
        self.git('mv', 'packages/model/src/runtime.ts', 'docs/renamed.md')
        self.assertEqual(self.inspect()['mode'], 'full')

    def test_attributes_only_allow_the_original_notice_byte_rule(self):
        self.write('.gitattributes', '*.ps1 text\ndocs/standards/licenses/*.txt -text\n')
        self.assertEqual(self.inspect()['mode'], 'targeted')
        self.write('.gitattributes', '*.ps1 text\n*.ts -text\n')
        self.assertEqual(self.inspect()['mode'], 'full')

    def test_actual_push_base_includes_all_unsent_commits(self):
        self.write('packages/model/src/runtime.ts', 'changed')
        self.git('add', '.')
        self.git('commit', '-qm', 'runtime change')
        intermediate = self.git('rev-parse', 'HEAD').decode().strip()
        self.write('README.md', 'latest documentation change')
        self.git('add', '.')
        self.git('commit', '-qm', 'documentation change')
        self.assertEqual(self.inspect('Push', 'Push', self.base)['mode'], 'full')
        self.assertEqual(self.inspect('Push', 'Push', intermediate)['mode'], 'targeted')
        self.assertEqual(self.inspect('Push', 'Push', '')['mode'], 'full')
        self.assertEqual(self.inspect('Push', 'Push', '0' * 40)['mode'], 'full')
        self.write('README.md', 'dirty after commit')
        self.assertEqual(self.inspect('Push', 'Push', intermediate)['mode'], 'full')

    def test_ci_forced_full_multiple_updates_and_unknown_configuration_remain_full(self):
        self.write('README.md', 'updated')
        self.assertEqual(self.inspect(force=True)['mode'], 'full')
        self.assertEqual(self.inspect(phase='Disabled')['mode'], 'full')
        with patch.dict(os.environ, {'CI': 'true'}):
            self.assertEqual(scope.inspect(self.root, 'Push', 'Manual', '', False)['mode'], 'full')
        for path in ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'e2e/tests/smoke.spec.ts', 'scripts/unknown.py']:
            self.assertEqual(scope.classify(['README.md', path])['mode'], 'full', path)

    def test_unit_changes_select_the_whole_package_and_gate_changes_test_the_gate(self):
        result = scope.classify(['packages/io/src/format.test.ts', 'apps/desktop/src/main/mathNoticeCheckout.test.ts'])
        self.assertEqual(result['packages'], ['desktop', 'io'])
        self.assertEqual(scope.classify(['scripts/check.ps1'])['packages'], ['desktop', 'test-utils'])
        self.assertEqual(scope.classify(['packages/unknown/src/new.test.ts'])['mode'], 'full')

    def test_commit_copy_uses_staged_attributes_even_for_unchanged_originals(self):
        self.git('config', 'core.autocrlf', 'true')
        self.write('docs/standards/licenses/notice.txt', 'original\nsecond line\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'LF original before changing attributes')
        self.write('.gitattributes', '*.ps1 text\ndocs/standards/licenses/*.txt -text\n')
        self.git('add', '.gitattributes')
        before = self.git('write-tree')
        shell = next((shutil.which(name) for name in ['powershell.exe', 'pwsh', 'powershell'] if shutil.which(name)), None)
        self.assertIsNotNone(shell)
        quote = lambda path: "'" + str(path).replace("'", "''") + "'"
        script = self.root / 'exercise-commit-copy.ps1'
        script.write_text(
            "$ErrorActionPreference = 'Stop'\n. " + quote(HERE / 'lib/gitTreeGuard.ps1') + '\n' +
            '$copy = New-StagedTreeWorktree -Root ' + quote(self.root) + '\n' +
            "try {\n if (-not $copy.Ok) { throw $copy.Reason }\n" +
            ' [IO.File]::WriteAllBytes(' + quote(self.root / 'copied-original.bin') +
            ", [IO.File]::ReadAllBytes((Join-Path $copy.Path 'docs/standards/licenses/notice.txt')))\n" +
            '} finally { Remove-StagedTreeWorktree -Root ' + quote(self.root) + ' -WorktreePath $copy.Path }\n',
            encoding='utf-8-sig')
        result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                                env=self.environment, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode('utf8', errors='replace'))
        self.assertEqual((self.root / 'copied-original.bin').read_bytes(), b'original\nsecond line\n')
        self.assertEqual(self.git('write-tree'), before, 'The real staged index must remain unchanged')


class ScopeHookTests(unittest.TestCase):
    def setUp(self):
        self.fixture = hooks.ReceiptHookTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        fixture = self.fixture
        # Keep the original fixture's product commands cheap. Exercise the real gate and hooks.
        fixture.git('restore', '--staged', '--worktree', 'a.txt')
        fixture.write('apps/desktop/node_modules/electron/dist/electron.bin', 'fixture runtime, never executed')
        fixture.write('packages/help-content/package.json', '{"name":"@pointercad/help-content","scripts":{"test":"fixture"}}')
        fixture.write('packages/test-utils/package.json', '{"name":"@pointercad/test-utils","scripts":{"test":"fixture"}}')
        fixture.write('docs/standards/licenses/notice.txt', 'original')
        fixture.write('apps/desktop/package.json', '{"name":"@pointercad/desktop","scripts":{"test":"fixture"}}')
        fixture.git('add', '.')
        # This fixture setup is not a product delivery. Its original test baseline uses the same convention.
        fixture.git('-c', 'core.hooksPath=', 'commit', '-qm', 'scope fixture inputs')
        self.base = fixture.git('rev-parse', 'HEAD').strip()
        fixture.git('update-ref', 'refs/remotes/origin/main', self.base)

    def test_real_hooks_use_targeted_commands_and_ci_still_executes_all_five(self):
        fixture = self.fixture
        fixture.write('docs/standards/licenses/notice.txt', 'changed original')
        fixture.git('add', 'docs/standards/licenses/notice.txt')
        fixture.git('commit', '-qm', 'notice repair')
        self.assertEqual(fixture.calls(), ['run typecheck', 'run lint', '--filter @pointercad/desktop run test', 'run build'])
        before = len(fixture.calls())
        output = fixture.command([fixture.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            str(fixture.root / 'scripts/check.ps1'), '-Level', 'Push', '-ReceiptPhase', 'Push', '-ComparisonBase', self.base])
        self.assertEqual(fixture.calls()[before:], ['run typecheck', 'run lint', '--filter @pointercad/desktop run test', 'run build'])
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists(), output)
        fixture.env['CI'] = 'true'
        before = len(fixture.calls())
        fixture.full_check()
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])

    def test_a_failed_local_package_stops_the_actual_gate_and_cannot_make_a_receipt(self):
        fixture = self.fixture
        fixture.write('docs/standards/licenses/notice.txt', 'changed original')
        fixture.write('.git/fail-step', '--filter @pointercad/desktop run test')
        fixture.full_check(success=False)
        self.assertNotIn('run build', fixture.calls())
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
