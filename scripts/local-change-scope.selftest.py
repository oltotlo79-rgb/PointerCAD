"""Exercise local scope against real Git indexes and real PowerShell/hooks."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
from lib.task_workspace import configure_project_temp

configure_project_temp(Path(__file__).resolve().parents[1])
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load('local_change_scope', HERE / 'lib/local_change_scope.py')
hooks = load('receipt_hook_fixtures', HERE / 'validation-receipt.integration.selftest.py')


# Deliberately independent from production's folder mapping and closure algorithm.
FIXTURE_FOLDERS = {
    'expression': 'packages/expression', 'kernel': 'packages/kernel',
    'model': 'packages/model', 'drawing': 'packages/drawing', 'io': 'packages/io',
    'ui': 'packages/ui', 'help-content': 'packages/help-content',
    'test-utils': 'packages/test-utils', 'desktop': 'apps/desktop', 'web': 'apps/web',
}
FIXTURE_DEPENDENCIES = {
    'model': ['expression', 'kernel', 'drawing'], 'io': ['model'],
    'ui': ['model', 'io', 'help-content'], 'desktop': ['ui'], 'web': ['ui'],
}


def install_workspace_fixture(write):
    for name, folder in FIXTURE_FOLDERS.items():
        write(folder + '/package.json', json.dumps({
            'name': '@pointercad/' + name,
            'scripts': {} if name == 'web' else {'test': 'fixture'},
            'dependencies': {'@pointercad/' + dependency: 'workspace:*'
                             for dependency in FIXTURE_DEPENDENCIES.get(name, [])},
        }))


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

    def install_workspace(self):
        install_workspace_fixture(self.write)
        self.git('add', '.')
        self.git('commit', '-qm', 'complete dependency fixture')
        self.base = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.base)

    def test_runtime_changes_select_direct_and_indirect_consumers_with_performance_and_startup(self):
        self.install_workspace()
        self.write('packages/expression/src/evaluate.ts', 'changed mathematics')
        result = self.inspect()
        self.assertEqual(result['mode'], 'targeted')
        self.assertEqual(result['packages'], ['expression', 'desktop', 'io', 'model', 'test-utils', 'ui'])
        self.assertTrue(result['runtimeChecks'])
        self.assertEqual(result['changedPackages'], ['expression'])
        self.write('packages/drawing/src/project.ts', 'changed drawing')
        result = self.inspect()
        self.assertEqual(result['packages'], ['expression', 'desktop', 'drawing', 'io', 'model', 'test-utils', 'ui'])

    def test_runtime_deletion_rename_and_all_unsent_commits_keep_their_consumers(self):
        self.install_workspace()
        self.git('rm', 'packages/model/src/runtime.ts')
        self.git('commit', '-qm', 'remove runtime')
        self.write('README.md', 'last commit is documentation')
        self.git('add', '.')
        self.git('commit', '-qm', 'documentation')
        result = self.inspect('Push', 'Push', self.base)
        self.assertEqual(result['packages'], ['desktop', 'help-content', 'io', 'model', 'test-utils', 'ui'])
        self.assertTrue(result['runtimeChecks'])
        self.write('packages/kernel/src/original.ts', 'kernel')
        self.git('add', '.')
        self.git('commit', '-qm', 'new kernel source')
        self.git('mv', 'packages/kernel/src/original.ts', 'docs/moved.md')
        self.assertIn('kernel', self.inspect('Commit', 'Commit')['packages'])

    def test_runtime_commit_reads_staged_dependencies_while_manual_sees_unstaged_manifest_changes(self):
        self.install_workspace()
        self.write('packages/model/src/runtime.ts', 'changed')
        self.git('add', 'packages/model/src/runtime.ts')
        self.write('packages/ui/package.json', json.dumps({'name': '@pointercad/ui', 'scripts': {'test': 'fixture'}}))
        staged = self.inspect('Commit', 'Commit')
        self.assertTrue(staged['runtimeChecks'])
        self.assertEqual(staged['packages'], ['desktop', 'io', 'model', 'test-utils', 'ui'])
        self.assertEqual(self.inspect()['mode'], 'full')

    def test_peer_optional_dev_dependencies_and_cycles_do_not_omit_consumers(self):
        self.install_workspace()
        for name, field, target in [('drawing', 'peerDependencies', 'expression'),
                                    ('kernel', 'optionalDependencies', 'drawing'),
                                    ('expression', 'devDependencies', 'kernel')]:
            path = FIXTURE_FOLDERS[name] + '/package.json'
            manifest = json.loads((self.root / path).read_text(encoding='utf8'))
            manifest[field] = {'@pointercad/' + target: 'workspace:*'}
            self.write(path, json.dumps(manifest))
        self.git('add', '.')
        self.git('commit', '-qm', 'cyclic fixture dependencies')
        self.git('update-ref', 'refs/remotes/origin/main', self.git('rev-parse', 'HEAD').decode().strip())
        self.write('packages/expression/src/evaluate.ts', 'changed')
        result = self.inspect()
        self.assertEqual(result['packages'], ['expression', 'desktop', 'drawing', 'io', 'kernel', 'model', 'test-utils', 'ui'])

    def test_missing_unknown_invalid_manifests_and_unmapped_local_dependencies_fall_back(self):
        self.install_workspace()
        self.write('packages/model/src/runtime.ts', 'changed')
        self.git('add', 'packages/model/src/runtime.ts')
        path = 'packages/ui/package.json'
        original = (self.root / path).read_text(encoding='utf8')
        for invalid in [None, [], {'name': '@pointercad/wrong'},
                        {'name': '@pointercad/ui', 'scripts': {}},
                        {'name': '@pointercad/ui', 'scripts': {'test': 'fixture'}, 'dependencies': {'other': 'file:../other'}},
                        {'name': '@pointercad/ui', 'scripts': {'test': 'fixture'}, 'dependencies': {'@pointercad/unknown': 'workspace:*'}}]:
            with self.subTest(invalid=invalid):
                self.write(path, json.dumps(invalid))
                self.git('add', path)
                with self.assertRaises(ValueError):
                    scope.workspace_dependencies(self.git)
                self.assertEqual(self.inspect('Commit', 'Commit')['mode'], 'full')
        self.write(path, '{broken json')
        self.git('add', path)
        with self.assertRaises(ValueError):
            scope.workspace_dependencies(self.git)
        self.write(path, original)
        self.git('add', path)
        self.git('rm', 'packages/drawing/package.json')
        with self.assertRaises(ValueError):
            scope.workspace_dependencies(self.git)
        self.assertEqual(self.inspect('Commit', 'Commit')['mode'], 'full')

    def test_deleted_git_links_and_unknown_workspace_manifests_remain_full(self):
        self.install_workspace()
        self.write('link-target.txt', 'target')
        self.git('add', '.')
        blob = subprocess.run(['git', '-C', str(self.root), 'hash-object', '-w', '--stdin'],
                              input=b'../../../../link-target.txt', env=self.environment,
                              capture_output=True, check=True, timeout=15).stdout.decode().strip()
        link = 'packages/model/src/linked.ts'
        # An index link reproduces removed-link detection without requiring OS link privileges.
        self.git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',' + link)
        self.git('commit', '-qm', 'link in baseline')
        self.git('update-index', '--force-remove', link)
        self.assertEqual(self.inspect('Commit', 'Commit')['mode'], 'full')
        self.write('packages/new/package.json', '{"name":"@pointercad/new"}')
        self.git('add', 'packages/new/package.json')
        with self.assertRaises(ValueError):
            scope.workspace_dependencies(self.git)

    def test_web_runtime_retains_global_builds_and_local_startup_without_inventing_a_unit_command(self):
        self.install_workspace()
        self.write('apps/web/src/main.tsx', 'changed')
        result = self.inspect()
        self.assertEqual(result['packages'], ['test-utils'])
        self.assertTrue(result['runtimeChecks'])
        self.assertEqual(result['changedPackages'], ['web'])
        self.assertEqual(self.inspect(force=True)['mode'], 'full')
        with patch.dict(os.environ, {'CI': 'true'}):
            self.assertEqual(scope.inspect(self.root, 'Push', 'Manual', '', False)['mode'], 'full')

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
        self.write('.gitattributes', '*.ps1 text\nscripts/hooks/commit-msg text eol=lf\n')
        self.assertEqual(self.inspect()['mode'], 'targeted')
        self.write('.gitattributes', '*.ps1 text\nscripts/hooks/pre-push -text\n')
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

    def test_e2e_helpers_and_specs_keep_all_operations_with_runtime_consumers(self):
        self.install_workspace()
        self.write('packages/ui/src/newFeature.tsx', 'changed UI')
        self.write('e2e/tests/newFeatureFlow.ts', 'shared operation')
        self.write('e2e/tests/new-feature.spec.ts', 'browser test')
        result = self.inspect()
        self.assertEqual(result['packages'], ['desktop', 'test-utils', 'ui'])
        self.assertTrue(result['runtimeChecks'])
        self.assertTrue(result['allE2EChecks'])
        self.assertEqual(self.inspect(force=True)['mode'], 'full')

    def test_e2e_deletion_and_rename_do_not_hide_the_all_operations_requirement(self):
        self.write('e2e/tests/sharedFlow.ts', 'old operation')
        self.git('add', '.')
        self.git('commit', '-qm', 'operation baseline')
        self.git('update-ref', 'refs/remotes/origin/main', self.git('rev-parse', 'HEAD').decode().strip())
        self.git('mv', 'e2e/tests/sharedFlow.ts', 'docs/removed-flow.md')
        result = self.inspect('Commit', 'Commit')
        self.assertEqual(result['packages'], ['help-content', 'test-utils'])
        self.assertTrue(result['allE2EChecks'])

    def test_help_images_have_bounded_paths_and_do_not_skip_changed_operations(self):
        result = scope.classify(['packages/help-content/docs/ja/images/new-detail.png',
                                 'packages/help-content/docs/ja/images/new-capture-details.json'])
        self.assertEqual(result['packages'], ['help-content'])
        self.assertFalse(result['allE2EChecks'])
        result = scope.classify(['packages/help-content/docs/ja/images/new-detail.png',
                                 'e2e/tests/captureManualDetail.ts'])
        self.assertEqual(result['packages'], ['help-content', 'test-utils'])
        self.assertTrue(result['allE2EChecks'])
        for path in ['e2e/playwright.config.ts', 'e2e/tests/config.json', 'e2e/fixtures/shape.pcad',
                     'packages/help-content/docs/ja/images/tool.js', 'e2e/scripts/setup.ts']:
            self.assertEqual(scope.classify([path])['mode'], 'full', path)

    def test_ci_forced_full_multiple_updates_and_unknown_configuration_remain_full(self):
        self.write('README.md', 'updated')
        self.assertEqual(self.inspect(force=True)['mode'], 'full')
        self.assertEqual(self.inspect(phase='Disabled')['mode'], 'full')
        with patch.dict(os.environ, {'CI': 'true'}):
            self.assertEqual(scope.inspect(self.root, 'Push', 'Manual', '', False)['mode'], 'full')
        for path in ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'e2e/playwright.config.ts', 'scripts/unknown.py']:
            self.assertEqual(scope.classify(['README.md', path])['mode'], 'full', path)

    def test_unit_changes_select_the_whole_package_and_gate_changes_test_the_gate(self):
        result = scope.classify(['packages/io/src/format.test.ts', 'apps/desktop/src/main/mathNoticeCheckout.test.ts'])
        self.assertEqual(result['packages'], ['desktop', 'io'])
        self.assertEqual(scope.classify(['scripts/check.ps1'])['packages'], ['desktop', 'test-utils'])
        self.assertEqual(scope.classify(['scripts/hooks/commit-msg', 'scripts/lib/commit_message.py',
                                        'scripts/commit-message.selftest.py'])['packages'], ['desktop', 'test-utils'])
        for path in ['scripts/lib/task_workspace.py', 'scripts/task-workspace.selftest.py']:
            self.assertEqual(scope.classify([path])['packages'], ['desktop', 'test-utils'], path)
        self.assertEqual(scope.classify(['packages/unknown/src/new.test.ts'])['mode'], 'full')
        self.assertEqual(scope.classify(['packages/expression/vitest.config.ts'])['packages'], ['expression', 'test-utils'])
        self.assertEqual(scope.classify(['packages/expression/unknown.config.ts'])['mode'], 'full')

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

    def install_runtime_workspace(self):
        fixture = self.fixture
        install_workspace_fixture(fixture.write)
        fixture.git('add', '.')
        # Seed only the throwaway remote; the changes under test use the real hooks below.
        fixture.git('-c', 'core.hooksPath=', 'commit', '-qm', 'complete workspace fixture')
        fixture.git('-c', 'core.hooksPath=', 'push', 'origin', 'HEAD:main')
        self.base = fixture.git('rev-parse', 'HEAD').strip()

    def test_runtime_commit_and_actual_push_keep_consumers_and_startup_then_ci_runs_everything(self):
        self.install_runtime_workspace()
        fixture = self.fixture
        fixture.write('packages/expression/src/evaluate.ts', 'changed mathematics')
        fixture.git('add', 'packages/expression/src/evaluate.ts')
        fixture.git('commit', '-qm', 'runtime change')
        unit_calls = ['--filter @pointercad/' + name + ' run test'
                      for name in ['expression', 'desktop', 'io', 'model', 'test-utils', 'ui']]
        expected_checks = ['run typecheck', 'run lint', *unit_calls, 'run build']
        self.assertEqual(fixture.calls(), expected_checks)
        before = len(fixture.calls())
        fixture.git('push', 'origin', 'HEAD:main')
        actual_push = fixture.calls()[before:]
        # The real Unix gate installs browser OS dependencies; Windows does not.
        # Compare the complete sequence so missing preparation or extra calls cannot hide in a filter.
        browser_install = 'exec playwright install ' + ('--with-deps ' if os.name != 'nt' else '') + 'chromium firefox'
        self.assertEqual(actual_push, [browser_install,
                         '--filter @pointercad/desktop exec install-electron', *expected_checks,
                         'run test:e2e --project=viewport-performance --project=startup-firefox --project=startup-electron'])
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())
        fixture.env['CI'] = 'true'
        before = len(fixture.calls())
        fixture.full_check()
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])

    def test_e2e_changes_keep_every_operation_on_actual_push_and_ci_keeps_all_units(self):
        self.install_runtime_workspace()
        fixture = self.fixture
        fixture.write('packages/ui/src/feature.tsx', 'changed UI')
        fixture.write('e2e/tests/sharedFlow.ts', 'changed operation helper')
        fixture.git('add', '.')
        fixture.git('commit', '-qm', 'UI and operation change')
        expected = ['run typecheck', 'run lint', '--filter @pointercad/desktop run test',
                    '--filter @pointercad/test-utils run test', '--filter @pointercad/ui run test', 'run build']
        self.assertEqual(fixture.calls(), expected)
        before = len(fixture.calls())
        fixture.git('push', 'origin', 'HEAD:main')
        browser_install = 'exec playwright install ' + ('--with-deps ' if os.name != 'nt' else '') + 'chromium firefox'
        self.assertEqual(fixture.calls()[before:], [browser_install,
                         '--filter @pointercad/desktop exec install-electron', *expected, 'run test:e2e'])
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())
        fixture.env['CI'] = 'true'
        before = len(fixture.calls())
        fixture.full_check()
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])

    def test_e2e_only_failure_fails_gate_and_never_creates_full_success_receipt(self):
        fixture = self.fixture
        fixture.write('e2e/tests/new-operation.spec.ts', 'new operation')
        fixture.write('.git/fail-step', 'run test:e2e')
        fixture.full_check(success=False)
        self.assertIn('--filter @pointercad/test-utils run test', fixture.calls())
        self.assertEqual(fixture.calls()[-1], 'run test:e2e')
        self.assertNotIn('run test', fixture.calls())
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())

    def test_runtime_manual_scope_has_startup_and_explicit_full_has_no_project_filter(self):
        self.install_runtime_workspace()
        fixture = self.fixture
        fixture.write('packages/model/src/runtime.ts', 'changed model')
        fixture.full_check()
        self.assertEqual(fixture.calls()[-1], 'run test:e2e --project=viewport-performance --project=startup-firefox --project=startup-electron')
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())
        before = len(fixture.calls())
        fixture.command([fixture.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                         str(fixture.root / 'scripts/check.ps1'), '-Full'])
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])

    def test_runtime_failure_stops_before_build_and_invalidates_any_old_receipt(self):
        self.install_runtime_workspace()
        fixture = self.fixture
        fixture.write('packages/model/src/runtime.ts', 'changed model')
        fixture.write('.git/fail-step', '--filter @pointercad/model run test')
        fixture.write('.git/validation-receipt.json', '{"notAValidPriorReceipt":true}')
        fixture.full_check(success=False)
        self.assertNotIn('run build', fixture.calls())
        self.assertFalse(any(call.startswith('run test:e2e') for call in fixture.calls()))
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())

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
