"""Exercise local scope against real Git indexes and real PowerShell/hooks."""
import importlib.util
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
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
            'scripts': {'test': 'fixture'},
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
        self.assertEqual(result['packages'], ['expression', 'desktop', 'io', 'model', 'test-utils', 'ui', 'web'])
        self.assertTrue(result['runtimeChecks'])
        self.assertEqual(result['changedPackages'], ['expression'])
        self.write('packages/drawing/src/project.ts', 'changed drawing')
        result = self.inspect()
        self.assertEqual(result['packages'], ['expression', 'desktop', 'drawing', 'io', 'model', 'test-utils', 'ui', 'web'])

    def test_runtime_deletion_rename_and_all_unsent_commits_keep_their_consumers(self):
        self.install_workspace()
        self.git('rm', 'packages/model/src/runtime.ts')
        self.git('commit', '-qm', 'remove runtime')
        self.write('README.md', 'last commit is documentation')
        self.git('add', '.')
        self.git('commit', '-qm', 'documentation')
        result = self.inspect('Push', 'Push', self.base)
        self.assertEqual(result['packages'], ['desktop', 'help-content', 'io', 'model', 'test-utils', 'ui', 'web'])
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
        self.assertEqual(staged['packages'], ['desktop', 'io', 'model', 'test-utils', 'ui', 'web'])
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
        self.assertEqual(result['packages'], ['expression', 'desktop', 'drawing', 'io', 'kernel', 'model', 'test-utils', 'ui', 'web'])

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

    def test_web_runtime_includes_its_unit_suite_and_retains_builds_startup_and_full_ci(self):
        self.install_workspace()
        self.write('apps/web/src/main.tsx', 'changed')
        result = self.inspect()
        self.assertEqual(result['packages'], ['test-utils', 'web'])
        self.assertTrue(result['runtimeChecks'])
        self.assertEqual(result['changedPackages'], ['web'])
        self.assertEqual(self.inspect(force=True)['mode'], 'full')
        with patch.dict(os.environ, {'CI': 'true'}):
            self.assertEqual(scope.inspect(self.root, 'Push', 'Manual', '', False)['mode'], 'full')

    def test_web_test_file_maps_to_web_and_missing_test_script_fails_closed(self):
        self.install_workspace()
        self.write('apps/web/src/pwa/offlinePreparation.test.ts', 'new unit coverage')
        self.assertEqual(self.inspect()['packages'], ['web'])
        path = 'apps/web/package.json'
        manifest = json.loads((self.root / path).read_text(encoding='utf8'))
        manifest['scripts'].pop('test')
        self.write(path, json.dumps(manifest))
        self.git('add', path)
        with self.assertRaises(ValueError):
            scope.workspace_dependencies(self.git)

    def test_notice_and_documentation_are_targeted_but_runtime_is_not(self):
        self.write('README.md', 'updated')
        self.assertEqual(self.inspect()['mode'], 'targeted')
        self.write('docs/standards/licenses/notice.txt', 'updated')
        self.assertIn('desktop', self.inspect()['packages'])
        self.write('packages/model/src/runtime.ts', 'changed')
        self.assertEqual(self.inspect()['mode'], 'full')

    def test_wrangler_config_stays_desktop_only_and_root_package_json_remains_full(self):
        # 2026-09-28の事故(gate.log 20260928-051433で555件へ広がった)の再発防止。
        # 配信だけの設定は desktop の単体にとどまり、画面検査は広がらない。
        result = scope.classify(['wrangler.jsonc'])
        self.assertEqual(result['mode'], 'targeted')
        self.assertEqual(result['packages'], ['desktop'])
        self.assertFalse(result['allE2EChecks'])
        # 一方、根のpackage.json(ビルド・全パッケージへ実際に効く)は従来どおり判定不能で全体へ倒す。
        self.assertEqual(scope.classify(['package.json'])['mode'], 'full')
        # 実際のGit差分でも同じ結果になることを確かめる(untrackedの新規ファイルとして)。
        self.write('wrangler.jsonc', '{"name": "pointercad-test"}\n')
        real = self.inspect()
        self.assertEqual(real['mode'], 'targeted')
        self.assertEqual(real['packages'], ['desktop'])
        self.assertFalse(real['allE2EChecks'])

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
        self.assertEqual(result['packages'], ['desktop', 'test-utils', 'ui', 'web'])
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
        for path in ['pnpm-lock.yaml', '.github/workflows/unknown.yml', 'e2e/playwright.config.ts', 'scripts/unknown.py']:
            self.assertEqual(scope.classify(['README.md', path])['mode'], 'full', path)

    def test_unit_changes_select_the_whole_package_and_gate_changes_test_the_gate(self):
        result = scope.classify(['packages/io/src/format.test.ts', 'apps/desktop/src/main/mathNoticeCheckout.test.ts'])
        self.assertEqual(result['packages'], ['desktop', 'io'])
        self.assertEqual(scope.classify(['scripts/check.ps1'])['packages'], ['desktop', 'test-utils'])
        self.assertEqual(scope.classify(['scripts/hooks/commit-msg', 'scripts/lib/commit_message.py',
                                        'scripts/commit-message.selftest.py'])['packages'], ['desktop', 'test-utils'])
        for path in ['scripts/lib/task_workspace.py', 'scripts/task-workspace.selftest.py']:
            self.assertEqual(scope.classify([path])['packages'], ['desktop', 'test-utils'], path)
        for path in ['.github/workflows/ci.yml', 'scripts/lib/ci_stage_evidence.py',
                     'scripts/lib/isolated_checkout_preflight.py',
                     'scripts/isolated-checkout-preflight.selftest.py', 'scripts/lib/gitEnvironment.mjs',
                     'scripts/lib/gitEnvironment.d.mts', 'scripts/vite/webBuildSources.mjs',
                     'scripts/vite/webBuildSources.d.mts']:
            self.assertEqual(scope.classify([path])['packages'], ['desktop', 'test-utils'], path)
        self.assertEqual(scope.classify(['packages/unknown/src/new.test.ts'])['mode'], 'full')
        self.assertEqual(scope.classify(['packages/expression/vitest.config.ts'])['packages'], ['expression', 'test-utils'])
        self.assertEqual(scope.classify(['packages/expression/unknown.config.ts'])['mode'], 'full')

    def install_operations(self):
        # Specs reach the shared helper directly, transitively, without an extension and via re-export.
        self.write('e2e/tests/sharedFlow.ts', 'export const shared = 1;\n')
        self.write('e2e/tests/stepFlow.ts', "import { shared } from './sharedFlow.js';\nexport const step = shared;\n")
        self.write('e2e/tests/reexport.ts', "export * from './sharedFlow';\n")
        self.write('e2e/tests/unrelatedFlow.ts', 'export const unrelated = 2;\n')
        self.write('e2e/tests/alpha.spec.ts', "import { shared } from './sharedFlow.js';\n")
        self.write('e2e/tests/beta.spec.ts', "import type { step } from './stepFlow.js';\n")
        self.write('e2e/tests/electron-delta.spec.ts', "const loaded = await import('./reexport.js');\n")
        self.write('e2e/tests/gamma.spec.ts', "import './unrelatedFlow.js';\n")
        self.write('e2e/tests/nested/omega.spec.ts', "import { shared } from '../sharedFlow.js';\n")
        self.git('add', '.')
        self.git('commit', '-qm', 'operation baseline')
        self.base = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.base)

    def inspect_light(self, level='Push', phase='Manual', base='', force=False):
        with patch.dict(os.environ, self.environment, clear=True):
            return scope.inspect(self.root, level, phase, base, force, True)

    def test_light_changed_helper_runs_only_the_specs_that_reach_it_with_startup(self):
        self.install_operations()
        self.write('e2e/tests/sharedFlow.ts', 'export const shared = 3;\n')
        result = self.inspect_light(base=self.base)
        self.assertEqual(result['mode'], 'targeted')
        self.assertTrue(result['light'])
        self.assertTrue(result['runtimeChecks'], 'The three startup projects always run locally')
        self.assertFalse(result['allE2EChecks'])
        self.assertEqual(result['packages'], ['test-utils'])
        self.assertEqual(result['e2eSpecs'], ['e2e/tests/alpha.spec.ts', 'e2e/tests/beta.spec.ts',
                                              'e2e/tests/electron-delta.spec.ts', 'e2e/tests/nested/omega.spec.ts'])
        self.assertEqual(result['base'], self.base)
        self.write('e2e/tests/gamma.spec.ts', "import './unrelatedFlow.js';\n// changed spec\n")
        self.assertIn('e2e/tests/gamma.spec.ts', self.inspect_light(base=self.base)['e2eSpecs'])
        # The ordinary (non-light) scope keeps every operation for the same change.
        ordinary = self.inspect(base=self.base)
        self.assertTrue(ordinary['allE2EChecks'])
        self.assertNotIn('light', ordinary)
        self.assertNotIn('e2eSpecs', ordinary)

    def test_light_untraceable_operation_changes_are_left_to_ci_every_operation(self):
        # 2026-09-28 19:5x owner decision "3": a light check never runs every operation
        # locally. An untraceable change keeps the startup projects and is marked for CI.
        self.install_operations()
        self.write('e2e/tests/orphanFlow.ts', 'export const nobodyImportsThis = 1;\n')
        result = self.inspect_light(base=self.base)
        self.assertEqual(result['mode'], 'targeted')
        self.assertFalse(result['allE2EChecks'], 'The light check leaves every operation to CI')
        self.assertTrue(result['e2eDeferredToCI'], 'A helper that no spec reaches cannot be bounded')
        self.assertTrue(result['runtimeChecks'], 'The three startup projects always run locally')
        self.assertIn('deferred-e2e', result['reason'])
        self.assertEqual(result['e2eSpecs'], [])
        # One untraceable helper does not hide the specs known to reach another changed helper.
        self.write('e2e/tests/sharedFlow.ts', 'export const shared = 5;\n')
        mixed = self.inspect_light(base=self.base)
        self.assertTrue(mixed['e2eDeferredToCI'])
        self.assertFalse(mixed['allE2EChecks'])
        self.assertEqual(mixed['e2eSpecs'], ['e2e/tests/alpha.spec.ts', 'e2e/tests/beta.spec.ts',
                                             'e2e/tests/electron-delta.spec.ts', 'e2e/tests/nested/omega.spec.ts'])
        self.write('e2e/tests/sharedFlow.ts', 'export const shared = 1;\n')
        (self.root / 'e2e/tests/orphanFlow.ts').unlink()
        self.write('e2e/tests/odd name.spec.ts', 'unsafe as a file filter')
        odd = self.inspect_light(base=self.base)
        self.assertTrue(odd['e2eDeferredToCI'])
        self.assertFalse(odd['allE2EChecks'])
        (self.root / 'e2e/tests/odd name.spec.ts').unlink()
        unavailable = scope.classify(['e2e/tests/sharedFlow.ts'], light=True)
        self.assertTrue(unavailable['e2eDeferredToCI'], 'Unavailable sources leave the operations to CI')
        self.assertFalse(unavailable['allE2EChecks'])
        self.git('rm', '-q', 'e2e/tests/unrelatedFlow.ts', 'e2e/tests/gamma.spec.ts')
        deleted = self.inspect_light(base=self.base)
        self.assertFalse(deleted['allE2EChecks'], 'A removed spec and its removed helper have no present importer')
        self.assertFalse(deleted['e2eDeferredToCI'])
        self.assertEqual(deleted['e2eSpecs'], [])
        self.assertTrue(deleted['runtimeChecks'])
        # The ordinary (non-light) scope still keeps every operation for an e2e change.
        self.assertTrue(scope.classify(['e2e/tests/orphanFlow.ts'])['allE2EChecks'])
        self.assertNotIn('e2eDeferredToCI', scope.classify(['e2e/tests/orphanFlow.ts']))

    def test_light_documentation_and_runtime_keep_units_builds_and_startup(self):
        self.write('README.md', 'updated')
        result = self.inspect_light()
        self.assertEqual((result['mode'], result['packages'], result['e2eSpecs']),
                         ('targeted', ['help-content', 'test-utils'], []))
        self.assertTrue(result['runtimeChecks'])
        self.install_workspace()
        self.write('packages/expression/src/evaluate.ts', 'changed mathematics')
        result = self.inspect_light()
        self.assertEqual(result['packages'], ['expression', 'desktop', 'io', 'model', 'test-utils', 'ui', 'web'])
        self.assertEqual(result['changedPackages'], ['expression'])
        self.assertTrue(result['runtimeChecks'] and result['light'])

    def test_light_is_manual_push_only_and_unknown_ci_or_forced_changes_are_full(self):
        self.install_operations()
        self.write('e2e/tests/sharedFlow.ts', 'export const shared = 4;\n')
        self.git('add', '.')
        # Hooks, CI and an explicit full run never receive the light (deferred) result.
        for result in [self.inspect_light('Commit', 'Commit'), self.inspect_light('Push', 'Push', self.base),
                       self.inspect_light(force=True)]:
            self.assertEqual(result['mode'], 'full')
            self.assertNotIn('light', result)
            self.assertNotIn('e2eDeferredToCI', result)
        with patch.dict(os.environ, {'CI': 'true'}):
            ci = scope.inspect(self.root, 'Push', 'Manual', '', False, True)
            self.assertEqual(ci['mode'], 'full')
            self.assertNotIn('light', ci)
        for path in ['e2e/playwright.config.ts', 'pnpm-lock.yaml', 'e2e/tests/data.json', 'eslint.config.js']:
            with self.subTest(path=path):
                self.write(path, 'changed')
                # 2026-09-29 owner decision "5" (replaces the 2026-09-28 19:5x decision "3"):
                # every unit suite, both builds and the self-tests still run; locally the
                # browser operations are only the three startup projects. Every spec a
                # changed e2e/tests helper reaches is deferred to CI on both OSes, never
                # widened to "the known related specs" as decision "3" had it.
                result = self.inspect_light(base=self.base)
                self.assertEqual(result['mode'], 'full')
                self.assertIn(path, result['reason'])
                self.assertEqual(result['packages'], [])
                self.assertTrue(result['light'] and result['runtimeChecks'] and result['e2eDeferredToCI'])
                self.assertFalse(result['allE2EChecks'])
                self.assertEqual(result['e2eSpecs'], [])
                self.assertEqual(result['base'], self.base)
                ordinary = self.inspect(base=self.base)
                self.assertEqual(ordinary['mode'], 'full')
                self.assertNotIn('light', ordinary)
                (self.root / path).unlink()

    def test_light_full_keeps_the_reason_for_links_manifests_and_scope_errors(self):
        self.install_workspace()
        self.write('packages/model/src/runtime.ts', 'changed')
        self.write('packages/ui/package.json', '{broken json')
        self.git('add', 'packages/ui/package.json')
        result = self.inspect_light()
        self.assertEqual((result['mode'], result['reason']),
                         ('full', 'The checked workspace dependency coverage could not be established'))
        self.assertTrue(result['light'] and result['e2eDeferredToCI'])
        self.assertEqual((result['e2eSpecs'], result['base']), ([], self.base))
        self.assertEqual(self.inspect()['reason'], 'The checked workspace dependency coverage could not be established')
        self.assertNotIn('light', self.inspect())
        self.git('checkout', 'HEAD', '--', 'packages/ui/package.json')
        blob = subprocess.run(['git', '-C', str(self.root), 'hash-object', '-w', '--stdin'],
                              input=b'../../../../README.md', env=self.environment,
                              capture_output=True, check=True, timeout=15).stdout.decode().strip()
        self.git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',packages/model/src/linked.ts')
        linked = self.inspect_light()
        self.assertEqual((linked['mode'], linked['reason']), ('full', 'Changed links or submodules require full validation'))
        self.assertTrue(linked['light'] and linked['e2eDeferredToCI'])
        self.assertEqual((linked['e2eSpecs'], linked['base']), ([], self.base))
        self.assertNotIn('light', self.inspect())
        self.assertEqual(scope.classify([], light=True)['e2eDeferredToCI'], True)
        self.assertNotIn('light', scope.classify([]))

    def test_related_specs_follow_every_static_import_form_and_ignore_outside_modules(self):
        sources = {
            'e2e/tests/a.spec.ts': "export { value } from './helpers/value.js';\n",
            'e2e/tests/helpers/value.ts': "import '../side.js';\nexport const value = 1;\n",
            'e2e/tests/side.ts': "import { launch } from '../firefoxLaunch.js';\n",
            'e2e/tests/b.spec.ts': "const late = import('./helpers/value.js');\n",
            'e2e/tests/c.spec.ts': "import { test } from '@playwright/test';\n",
        }
        self.assertEqual(scope.related_e2e_specs(['e2e/tests/side.ts'], sources),
                         ['e2e/tests/a.spec.ts', 'e2e/tests/b.spec.ts'])
        self.assertEqual(scope.related_e2e_specs(['e2e/tests/c.spec.ts'], sources), ['e2e/tests/c.spec.ts'])
        self.assertIsNone(scope.related_e2e_specs(['e2e/tests/unused.ts'], {**sources, 'e2e/tests/unused.ts': ''}))
        self.assertIsNone(scope.related_e2e_specs(['e2e/tests/a b.ts'], sources))
        self.assertIsNone(scope.related_e2e_specs(['e2e/tests/side.ts'], None))
        # A removed helper that a present spec still imports runs that spec (it reports the break).
        remaining = {path: text for path, text in sources.items() if path != 'e2e/tests/side.ts'}
        self.assertEqual(scope.related_e2e_specs(['e2e/tests/side.ts'], remaining),
                         ['e2e/tests/a.spec.ts', 'e2e/tests/b.spec.ts'])
        self.assertEqual(scope.related_e2e_specs(['e2e/tests/gone.ts', 'e2e/tests/gone.spec.ts'], sources), [])
        # Playwright also runs *.test.ts by default; such a test cannot be a light filter.
        self.assertIsNone(scope.related_e2e_specs(
            ['e2e/tests/side.ts'], {**sources, 'e2e/tests/d.test.ts': "import './side.js';\n"}))

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
                      for name in ['expression', 'desktop', 'io', 'model', 'test-utils', 'ui', 'web']]
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
                    '--filter @pointercad/test-utils run test', '--filter @pointercad/ui run test',
                    '--filter @pointercad/web run test', 'run build']
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

    def test_web_diagnostic_resolves_apps_folder_and_a_failed_web_suite_stops_the_real_gate(self):
        self.install_runtime_workspace()
        fixture = self.fixture
        name = 'src/pwa/offlinePreparation.test.ts'
        fixture.write('apps/web/' + name, 'Web unit fixture')
        fixture.command([fixture.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                         str(fixture.root / 'scripts/check.ps1'), '-Level', 'Push',
                         '-UnitPackage', 'web', '-UnitTests', name])
        self.assertEqual(fixture.calls(), ['--filter @pointercad/web exec vitest run ' + name])
        fixture.write('apps/web/src/main.tsx', 'changed browser preparation')
        fixture.write('.git/fail-step', '--filter @pointercad/web run test')
        before = len(fixture.calls())
        fixture.full_check(success=False)
        calls = fixture.calls()[before:]
        self.assertIn('--filter @pointercad/web run test', calls)
        self.assertNotIn('run build', calls)
        self.assertFalse(any(call.startswith('run test:e2e') for call in calls))

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

    # 2026-09-27 owner decision "leave every browser operation to CI": -Scope Local.
    # 2026-09-28: these are plain relative paths, not regular expressions. Playwright's
    # createFileMatcher (playwright/lib/util.js) treats a plain string filter as a glob
    # via minimatch unless it is already a RegExp object, which CLI arguments never are.
    # The previous backslash-escaped "\." plus trailing "$" was matched literally, so the
    # "$" never matched any real file path and the run reported "No tests found."
    # (gate 20260928-065436).
    LIGHT_E2E = ('run test:e2e --project=startup-firefox --project=startup-electron --project=functional '
                 '--project=electron e2e/tests/smoke.spec.ts e2e/tests/firefox-graphics.spec.ts '
                 'e2e/tests/electron-startup.spec.ts')

    def install_operations(self):
        fixture = self.fixture
        fixture.write('e2e/tests/sharedFlow.ts', 'export const shared = 1;\n')
        fixture.write('e2e/tests/alpha.spec.ts', "import { shared } from './sharedFlow.js';\n")
        fixture.write('e2e/tests/gamma.spec.ts', 'export {};\n')
        fixture.git('add', '.')
        # Seed only the throwaway remote; the changes under test use the real hooks below.
        fixture.git('-c', 'core.hooksPath=', 'commit', '-qm', 'operation fixture')
        fixture.git('-c', 'core.hooksPath=', 'push', 'origin', 'HEAD:main')
        self.base = fixture.git('rev-parse', 'HEAD').strip()

    def light_check(self, *extra, success=True):
        fixture = self.fixture
        return fixture.command([fixture.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                str(fixture.root / 'scripts/check.ps1'), '-Scope', 'Local', *extra], success)

    def browser_preparation(self):
        return ['exec playwright install ' + ('--with-deps ' if os.name != 'nt' else '') + 'chromium firefox',
                '--filter @pointercad/desktop exec install-electron']

    def test_light_scope_runs_related_operations_and_real_hooks_accept_it_once(self):
        self.install_operations()
        fixture = self.fixture
        fixture.write('e2e/tests/sharedFlow.ts', 'export const shared = 2;\n')
        fixture.git('add', '.')
        output = self.light_check('-ComparisonBase', self.base)
        expected = [*self.browser_preparation(), 'run typecheck', 'run lint',
                    '--filter @pointercad/test-utils run test', 'run build',
                    self.LIGHT_E2E + ' e2e/tests/alpha.spec.ts']
        self.assertEqual(fixture.calls(), expected, output[-4000:])
        light = fixture.root / '.git/local-light-receipt.json'
        self.assertTrue(light.is_file(), output[-4000:])
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists(), 'A light check is never a B3 receipt')
        output = fixture.git('commit', '-qm', 'operation helper change')
        self.assertEqual(fixture.calls(), expected, 'The real pre-commit must accept the light check\n' + output)
        output = fixture.git('push', 'origin', 'HEAD:main')
        self.assertEqual(fixture.calls(), expected, 'The real pre-push must accept the light check\n' + output)
        self.assertFalse(light.exists(), 'The push consumes the light record')

    def test_light_scope_is_rejected_with_full_ci_hooks_and_diagnostics_before_any_command(self):
        fixture = self.fixture
        fixture.write('e2e/tests/new-operation.spec.ts', 'new operation')
        for arguments in [['-Full'], ['-Install'], ['-Level', 'Commit'], ['-ReceiptPhase', 'Push'],
                          ['-ReceiptPhase', 'Commit'], ['-E2ERepeats', '2'], ['-StaticOnly'],
                          ['-E2EOnly', '-E2EGrep', 'fixture-selected'], ['-UnitPackage', 'ui', '-UnitTests', 'src/a.test.ts']]:
            with self.subTest(arguments=arguments):
                self.light_check(*arguments, success=False)
                self.assertEqual(fixture.calls(), [], 'Invalid combinations must stop before any package command')
        fixture.command([fixture.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                         str(fixture.root / 'scripts/check.ps1'), '-Scope', 'Everything'], success=False)
        fixture.env['CI'] = 'true'
        self.light_check(success=False)
        self.assertEqual(fixture.calls(), [])
        self.assertFalse((fixture.root / '.git/local-light-receipt.json').exists())

    STARTUP_E2E = 'run test:e2e --project=viewport-performance --project=startup-firefox --project=startup-electron'

    def test_untraceable_and_unknown_changes_leave_every_operation_to_ci_while_full_and_ci_run_it(self):
        # 2026-09-28 19:5x owner decision "3": -Scope Local never runs every operation. An
        # unknown change runs every unit suite, both builds and the self-tests locally, and
        # records a light receipt (never B3); -Full and CI still run every operation.
        self.install_operations()
        fixture = self.fixture
        light = fixture.root / '.git/local-light-receipt.json'
        full_receipt = fixture.root / '.git/validation-receipt.json'
        fixture.write('e2e/tests/orphanFlow.ts', 'export const nobodyImportsThis = 1;\n')
        fixture.git('add', '.')
        output = self.light_check('-ComparisonBase', self.base)
        self.assertEqual(fixture.calls(), [*self.browser_preparation(), 'run typecheck', 'run lint',
                                           '--filter @pointercad/test-utils run test', 'run build', self.STARTUP_E2E],
                         'An untraceable operation change is left to CI\n' + output[-4000:])
        self.assertTrue(light.exists())
        self.assertFalse(full_receipt.exists(), 'A light check is never a B3 receipt')
        before = len(fixture.calls())
        fixture.command([fixture.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                         str(fixture.root / 'scripts/check.ps1'), '-Full'])
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])
        self.assertFalse(light.exists(), 'A new check drops the light record')
        self.assertTrue(full_receipt.exists())
        fixture.write('pnpm-lock.yaml', 'unknown impact')
        fixture.git('add', '.')
        before = len(fixture.calls())
        output = self.light_check('-ComparisonBase', self.base)
        self.assertEqual(fixture.calls()[before:], [*self.browser_preparation(), 'run typecheck', 'run lint',
                                                    'run test', 'run build', self.STARTUP_E2E], output[-4000:])
        self.assertTrue(light.exists(), 'The widened light check records its own light receipt')
        self.assertFalse(full_receipt.exists(), 'A widened light check never issues or keeps a B3 receipt')
        fixture.env['CI'] = 'true'
        before = len(fixture.calls())
        fixture.full_check()
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])

    def test_widened_light_check_defers_related_specs_and_real_hooks_accept_it_once(self):
        # 2026-09-29 owner decision "5" (replaces the 2026-09-28 19:5x decision "3"): a
        # configuration change that widens the units to every suite runs only the three
        # startup projects locally; the changed helper's specs (e.g. alpha.spec.ts here)
        # are deferred to CI on both OSes, never added to the local browser run.
        self.install_operations()
        fixture = self.fixture
        fixture.write('e2e/tests/sharedFlow.ts', 'export const shared = 7;\n')
        fixture.write('eslint.config.js', 'export default [];\n')
        fixture.git('add', '.')
        output = self.light_check('-ComparisonBase', self.base)
        expected = [*self.browser_preparation(), 'run typecheck', 'run lint', 'run test', 'run build',
                    self.STARTUP_E2E]
        self.assertEqual(fixture.calls(), expected, output[-4000:])
        light = fixture.root / '.git/local-light-receipt.json'
        self.assertTrue(light.is_file(), output[-4000:])
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists(), 'A light check is never a B3 receipt')
        output = fixture.git('commit', '-qm', 'configuration and operation helper change')
        self.assertEqual(fixture.calls(), expected, 'The real pre-commit must accept the light check\n' + output)
        output = fixture.git('push', 'origin', 'HEAD:main')
        self.assertEqual(fixture.calls(), expected, 'The real pre-push must accept the light check\n' + output)
        self.assertFalse(light.exists(), 'The push consumes the light record')

    def test_a_failed_widened_light_check_leaves_no_receipt(self):
        self.install_operations()
        fixture = self.fixture
        fixture.write('pnpm-lock.yaml', 'unknown impact')
        fixture.git('add', '.')
        fixture.write('.git/fail-step', self.STARTUP_E2E)
        self.light_check('-ComparisonBase', self.base, success=False)
        self.assertEqual(fixture.calls()[-1], self.STARTUP_E2E)
        self.assertIn('run test', fixture.calls())
        self.assertFalse((fixture.root / '.git/local-light-receipt.json').exists())
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())

    def test_changed_content_failure_or_different_push_range_fall_back_to_ordinary_hook_checks(self):
        self.install_operations()
        fixture = self.fixture
        fixture.write('e2e/tests/gamma.spec.ts', 'export const changed = 1;\n')
        fixture.git('add', '.')
        fixture.write('.git/fail-step', self.LIGHT_E2E + ' e2e/tests/gamma.spec.ts')
        self.light_check('-ComparisonBase', self.base, success=False)
        light = fixture.root / '.git/local-light-receipt.json'
        self.assertFalse(light.exists(), 'A failed light check leaves no record')
        (fixture.root / '.git/fail-step').unlink()
        self.light_check('-ComparisonBase', self.base)
        self.assertTrue(light.exists())
        fixture.write('e2e/tests/gamma.spec.ts', 'export const changed = 2;\n')
        fixture.git('add', '.')
        before = len(fixture.calls())
        fixture.git('commit', '-qm', 'changed after the light check')
        self.assertEqual(fixture.calls()[before:], ['run typecheck', 'run lint',
                         '--filter @pointercad/test-utils run test', 'run build'])
        self.assertFalse(light.exists())
        # A checked commit sent to a new reference sends a different range than the check compared.
        fixture.write('e2e/tests/gamma.spec.ts', 'export const changed = 3;\n')
        fixture.git('add', '.')
        head = fixture.git('rev-parse', 'HEAD').strip()
        self.light_check('-ComparisonBase', head)
        before = len(fixture.calls())
        fixture.git('commit', '-qm', 'checked change')
        self.assertEqual(len(fixture.calls()), before)
        fixture.git('push', 'origin', 'HEAD:refs/heads/other')
        self.assertEqual([call for call in fixture.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])
        self.assertFalse(light.exists())

    def test_a_failed_local_package_stops_the_actual_gate_and_cannot_make_a_receipt(self):
        fixture = self.fixture
        fixture.write('docs/standards/licenses/notice.txt', 'changed original')
        fixture.write('.git/fail-step', '--filter @pointercad/desktop run test')
        fixture.full_check(success=False)
        self.assertNotIn('run build', fixture.calls())
        self.assertFalse((fixture.root / '.git/validation-receipt.json').exists())


class PlaywrightFileFilterFormatTests(unittest.TestCase):
    """Runs the real `pnpm run test:e2e --list` against the actual repository (not a
    fixture, not a fake pnpm shim) with the exact spec-filter tokens scripts/check.ps1
    builds for the light local check, to prove the fix is not just a string-shape
    assertion but actually lists a non-zero number of tests.

    2026-09-28 gate 20260928-065436: `pnpm run test:e2e` failed with
    "Error: No tests found." even though every named spec file existed. Calling
    Playwright's own CLI directly (node node_modules/@playwright/test/cli.js) with the
    same backslash-escaped, "$"-anchored tokens (e.g. `e2e/tests/smoke\\.spec\\.ts$`)
    lists the tests correctly, so Playwright's own argument matching is not at fault.
    The corruption happens one layer up: `pnpm run <script>` always runs the resolved
    command through a shell (cmd.exe on Windows) and pnpm's own quoting doubles every
    backslash in a forwarded argument regardless of whether a following character
    requires it, turning `smoke\\.spec\\.ts$` into a `\\\\.` (escaped literal backslash
    followed by a wildcard dot in glob terms) that cannot match any real file path.
    scripts/check.ps1 used to build exactly such tokens for its base filters (line
    ~534) and for each related spec found by scripts/lib/local_change_scope.py (line
    ~326). This regressed silently because no earlier light check had happened to add
    a related-spec filter, and scripts/local-change-scope.selftest.py's
    ScopeHookTests only records the shell-quoted call string against a fake pnpm shim,
    so it could not catch an argument the real pnpm would corrupt. The fix removes the
    backslash escaping and the trailing "$" anchor entirely: Playwright's
    createFileMatcher (node_modules/@playwright/test -> playwright's lib/util.js)
    treats a plain string CLI argument as a glob via minimatch (never as a regular
    expression, since CLI arguments are never RegExp objects), so a plain relative
    path such as `e2e/tests/smoke.spec.ts` already matches the file directly and
    carries no backslash for pnpm to mangle.
    """

    ROOT = HERE.parent

    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which('node') or shutil.which('node.exe')
        if not cls.node:
            raise unittest.SkipTest('node not found on PATH')
        cls.pnpm_cjs = cls.resolve_pnpm_cjs()
        if not cls.pnpm_cjs:
            raise unittest.SkipTest('pnpm.cjs not found (see resolve_pnpm_cjs candidates)')
        # 2026-09-28 coordinator review (gate 20260928-081320's (0) self-test): this class must
        # stand on files a clean checkout (CI, the coordinator's independent c3 copy) actually
        # has, never on another worker's uncommitted work-in-progress spec. `git ls-files`
        # reads HEAD's index, not the work tree, so an uncommitted file such as
        # e2e/tests/startup-navigation-smoke.spec.ts (w81a, unstaged at the time of this fix)
        # is absent from it even though it exists on disk here.
        listing = subprocess.run(['git', 'ls-files', 'e2e/tests'], cwd=cls.ROOT, capture_output=True,
                                  text=True, check=True, timeout=30)
        cls.committed_e2e_tests = frozenset(listing.stdout.splitlines())

    def assert_committed(self, *relative_paths):
        for relative_path in relative_paths:
            self.assertIn(relative_path, self.committed_e2e_tests,
                           f'{relative_path} must be committed (git ls-files e2e/tests) for this self-test '
                           'to hold on a clean checkout; an uncommitted file must not be used here')

    @staticmethod
    def resolve_pnpm_cjs():
        # Mirrors scratchpad/claude/tools/diag.py's resolve_pnpm_and_node, kept
        # independent here because a self-test must not depend on scratchpad
        # (absent from a clean checkout and from CI).
        candidates = []
        pnpm_path = shutil.which('pnpm')
        if pnpm_path:
            candidates.append(Path(pnpm_path).parent / 'node_modules' / 'pnpm' / 'bin' / 'pnpm.cjs')
        appdata = os.environ.get('APPDATA')
        if appdata:
            candidates.append(Path(appdata) / 'npm' / 'node_modules' / 'pnpm' / 'bin' / 'pnpm.cjs')
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        return None

    LIST_LINE = re.compile(r'^\s*\[(?P<project>[\w-]+)\]\s*›\s*(?P<file>[\w.-]+\.spec\.ts):', re.MULTILINE)

    def listed_files(self, *args):
        """Runs `pnpm run test:e2e --list <args>` for real (the same node+pnpm.cjs
        invocation scripts/check.ps1's production path and scratchpad/claude/tools/
        diag.py use) and returns the exact set of (project, file) pairs Playwright
        actually lists -- never just a count, so an unexpectedly broad match (a
        similarly-named file, an unlisted project) cannot hide behind a non-zero
        total."""
        temp_root = self.ROOT / 'scratchpad' / 'temp'
        temp_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='pointercad-pw-list-', dir=str(temp_root)) as output:
            argv = [self.node, str(self.pnpm_cjs), 'run', 'test:e2e', '--list', *args, '--output', output]
            started = time.monotonic()
            try:
                completed = subprocess.run(argv, cwd=self.ROOT, capture_output=True, text=True, timeout=90)
            except subprocess.TimeoutExpired as error:
                elapsed = time.monotonic() - started

                def observed(stream):
                    if stream is None:
                        return '<none>'
                    decoded = stream.decode('utf-8', errors='replace') if isinstance(stream, bytes) else stream
                    return f'<{len(stream)} captured>\n{decoded[-12000:]}'

                raw_capture = '<disabled>'
                raw_root = os.environ.get('POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR')
                if raw_root:
                    raw_folder = None
                    try:
                        raw_parent = Path(raw_root)
                        if not raw_parent.is_absolute() or not raw_parent.is_dir():
                            raise ValueError('POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR must be an existing absolute directory')
                        raw_folder = Path(tempfile.mkdtemp(prefix='playwright-list-timeout-', dir=str(raw_parent)))
                        streams = {}
                        for name, stream in (('stdout', error.stdout), ('stderr', error.stderr)):
                            if stream is None:
                                streams[name] = {'type': 'none', 'encoding': None, 'file': None, 'stored_bytes': 0}
                                continue
                            is_bytes = isinstance(stream, bytes)
                            data = stream if is_bytes else stream.encode('utf-8')
                            filename = f'{name}.bin'
                            (raw_folder / filename).write_bytes(data)
                            streams[name] = {'type': 'bytes' if is_bytes else 'str',
                                             'encoding': None if is_bytes else 'utf-8',
                                             'file': filename, 'stored_bytes': len(data)}
                        metadata = {'argv': [str(part) for part in argv], 'timeout_seconds': 90,
                                    'elapsed_seconds': elapsed, 'streams': streams}
                        (raw_folder / 'metadata.json').write_text(
                            json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                        raw_capture = str(raw_folder)
                    except Exception as save_error:
                        raw_capture = (f'<failed at {raw_folder or raw_root}: '
                                       f'{type(save_error).__name__}: {save_error}>')

                error.add_note(
                    f'Playwright --list timed out: argv={argv!r}, timeout=90s, '
                    f'elapsed={elapsed:.3f}s, raw capture={raw_capture}\n'
                    f'partial stdout: {observed(error.stdout)}\n'
                    f'partial stderr: {observed(error.stderr)}'
                )
                raise
            combined = completed.stdout + completed.stderr
            pairs = {(m.group('project'), m.group('file')) for m in self.LIST_LINE.finditer(combined)}
            if pairs:
                self.assertEqual(completed.returncode, 0,
                                 f'Playwright --list failed after a partial listing (exit {completed.returncode}):\n'
                                 f'{combined[-12000:]}')
            else:
                self.assertIn('No tests found', combined, f'Unexpected playwright --list output:\n{combined}')
            return pairs

    def test_the_previous_backslash_escaped_dollar_anchored_filter_matches_nothing_through_pnpm(self):
        # Locks in the regression through the real production path (pnpm run
        # test:e2e). The corruption comes from pnpm always running the script through
        # a shell; on Windows that shell is cmd.exe and pnpm's quoting doubles the
        # backslashes, which is what gate 20260928-065436 hit. This is asserted only
        # on Windows because a POSIX shell's argument passing does not go through the
        # same cmd.exe quoting path, so the same tokens are not guaranteed to corrupt
        # there. The cross-platform requirement is carried by the *fixed* form below,
        # which every platform must list successfully.
        if os.name != 'nt':
            self.skipTest('The pnpm/cmd.exe backslash-doubling this locks in is Windows-only')
        self.assertEqual(self.listed_files('--project=functional', 'e2e/tests/smoke\\.spec\\.ts$'), set())

    # 2026-09-28 coordinator review: confirm precisely *why* the light gate's actual
    # command (gate 20260928-065436's base 3 specs + 10 related specs, across its 4
    # projects) lists more than the 13 requested files, and prove the extra files are
    # exactly the declared project `dependencies` in e2e/playwright.config.ts (never a
    # too-broad glob match). Playwright always runs a project's *entire* dependency
    # project regardless of any CLI file filter (the filter only narrows the
    # dependent project itself), which is why `--project=functional` (dependencies:
    # ['viewport-performance']) always drags in every viewport-performance spec.
    BASE_SPECS = ('e2e/tests/smoke.spec.ts', 'e2e/tests/firefox-graphics.spec.ts', 'e2e/tests/electron-startup.spec.ts')
    RELATED_SPECS = ('e2e/tests/electron-function-plot.spec.ts', 'e2e/tests/electron-history-notes.spec.ts',
                      'e2e/tests/electron-math-input.spec.ts', 'e2e/tests/electron-name-search.spec.ts',
                      'e2e/tests/function-plot.spec.ts', 'e2e/tests/geometry-math-input.spec.ts',
                      'e2e/tests/history-notes.spec.ts', 'e2e/tests/math-high-dpi.spec.ts',
                      'e2e/tests/math-input.spec.ts', 'e2e/tests/name-search.spec.ts')
    # The only dependency project any of startup-firefox/startup-electron/functional/electron
    # declares is viewport-performance (e2e/playwright.config.ts); Playwright always runs it
    # in full, so its 5 specs appear regardless of the requested file filters.
    VIEWPORT_PERFORMANCE_FILES = ('assembly.spec.ts', 'drawing-performance.spec.ts', 'p8-drawing.spec.ts',
                                   'script-performance.spec.ts', 'sheet-performance.spec.ts')

    def test_the_light_gates_actual_command_lists_exactly_the_requested_specs_plus_their_declared_dependency(self):
        # Every spec this test requests, and every dependency file the projects are expected to
        # drag in, must be committed (git ls-files): a clean checkout (CI, the coordinator's
        # independent c3 copy) has none of this session's other uncommitted work-in-progress.
        self.assert_committed(*self.BASE_SPECS, *self.RELATED_SPECS,
                               *(f'e2e/tests/{name}' for name in self.VIEWPORT_PERFORMANCE_FILES))
        args = ['--project=startup-firefox', '--project=startup-electron', '--project=functional', '--project=electron',
                *self.BASE_SPECS, *self.RELATED_SPECS]
        pairs = self.listed_files(*args)
        # Each requested spec runs under whichever project(s) its own testMatch/testIgnore in
        # e2e/playwright.config.ts already select it for -- a file filter can only narrow a
        # project's own tests, never add a file the project would not otherwise run.
        expected = {
            ('startup-firefox', 'smoke.spec.ts'), ('startup-firefox', 'firefox-graphics.spec.ts'),
            ('startup-electron', 'electron-startup.spec.ts'),
            ('functional', 'smoke.spec.ts'), ('functional', 'function-plot.spec.ts'),
            ('functional', 'geometry-math-input.spec.ts'), ('functional', 'history-notes.spec.ts'),
            ('functional', 'math-high-dpi.spec.ts'), ('functional', 'math-input.spec.ts'),
            ('functional', 'name-search.spec.ts'),
            ('electron', 'electron-function-plot.spec.ts'), ('electron', 'electron-history-notes.spec.ts'),
            ('electron', 'electron-math-input.spec.ts'), ('electron', 'electron-name-search.spec.ts'),
        }
        expected |= {('viewport-performance', name) for name in self.VIEWPORT_PERFORMANCE_FILES}
        self.assertEqual(pairs, expected)

    def test_a_plain_filter_does_not_also_match_a_committed_spec_whose_name_shares_its_suffix(self):
        # e2e/tests/auto-save-settings.spec.ts and e2e/tests/tool-defaults-auto-save-settings.spec.ts
        # are both committed (git ls-files, asserted below) and both fall inside the same `firefox`
        # project's own testMatch, which matches on a "...auto-save-settings.spec.ts" suffix, not an
        # exact filename (e2e/playwright.config.ts's alternation list has no start anchor, so
        # "tool-defaults-auto-save-settings.spec.ts" also ends in the listed word "auto-save-settings"
        # immediately followed by ".spec.ts$"). Confirmed with a real --list of the whole `firefox`
        # project below: without any CLI filter, both files are already listed under it. The CLI file
        # filter itself must not repeat that broad suffix match: minimatch treats an un-wildcarded
        # segment as an exact equality check, so "e2e/tests/auto-save-settings.spec.ts" must select
        # only the file named exactly that.
        self.assert_committed('e2e/tests/auto-save-settings.spec.ts', 'e2e/tests/tool-defaults-auto-save-settings.spec.ts')
        both_unfiltered = {file for _project, file in self.listed_files('--project=firefox')}
        self.assertLessEqual({'auto-save-settings.spec.ts', 'tool-defaults-auto-save-settings.spec.ts'}, both_unfiltered,
                              'Both specs must already be in scope for the firefox project with no filter, '
                              'or this test is not exercising the suffix-overlap it claims to')
        pairs = self.listed_files('--project=firefox', 'e2e/tests/auto-save-settings.spec.ts')
        files = {file for _project, file in pairs}
        self.assertIn('auto-save-settings.spec.ts', files)
        self.assertNotIn('tool-defaults-auto-save-settings.spec.ts', files)

    def test_a_plain_name_search_filter_does_not_also_match_electron_name_search(self):
        # electron-name-search.spec.ts only matches the `electron` project's own testMatch
        # (ELECTRON_TEST_FILE), so `--project=functional` alone already excludes it; this proves
        # the CLI filter itself is exact even when the `electron` project (whose testMatch would
        # otherwise admit it) is included in the same run. Both files are committed (git ls-files).
        self.assert_committed('e2e/tests/name-search.spec.ts', 'e2e/tests/electron-name-search.spec.ts')
        pairs = self.listed_files('--project=functional', '--project=electron', 'e2e/tests/name-search.spec.ts')
        files = {file for _project, file in pairs}
        self.assertIn('name-search.spec.ts', files)
        self.assertNotIn('electron-name-search.spec.ts', files)


class PlaywrightListObservationTests(unittest.TestCase):
    def fixture(self, root):
        fixture = PlaywrightFileFilterFormatTests('runTest')
        fixture.ROOT = Path(root)
        fixture.node = 'node-fixture'
        fixture.pnpm_cjs = Path(root) / 'pnpm.cjs'
        return fixture

    def test_timeout_preserves_bytes_argv_and_deadline(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-timeout-unit-') as temporary:
            fixture = self.fixture(temporary)
            timeout = subprocess.TimeoutExpired(['node-fixture'], 90,
                                                output=b'list-stage', stderr=b'list-cause')
            with patch.object(subprocess, 'run', side_effect=timeout) as run:
                with self.assertRaises(subprocess.TimeoutExpired) as raised:
                    fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, timeout)
            note = '\n'.join(timeout.__notes__)
            for expected in ('node-fixture', 'test:e2e', '--project=firefox', 'timeout=90s',
                             'list-stage', 'list-cause'):
                self.assertIn(expected, note)
            self.assertEqual(run.call_args.kwargs['timeout'], 90)
            self.assertTrue(run.call_args.kwargs['text'])

    def test_timeout_preserves_text_and_missing_stream(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-timeout-unit-') as temporary:
            fixture = self.fixture(temporary)
            timeout = subprocess.TimeoutExpired(['node-fixture'], 90, output='text-stage', stderr=None)
            with patch.object(subprocess, 'run', side_effect=timeout):
                with self.assertRaises(subprocess.TimeoutExpired) as raised:
                    fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, timeout)
            note = '\n'.join(timeout.__notes__)
            self.assertIn('text-stage', note)
            self.assertIn('partial stderr: <none>', note)

    def test_partial_listing_with_nonzero_exit_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-timeout-unit-') as temporary:
            fixture = self.fixture(temporary)
            listed = '[firefox] › auto-save-settings.spec.ts:1:1\n'
            completed = subprocess.CompletedProcess(['node-fixture'], 7, listed, 'failure-marker')
            with patch.object(subprocess, 'run', return_value=completed):
                with self.assertRaisesRegex(AssertionError, 'partial listing'):
                    fixture.listed_files('--project=firefox')

    def test_zero_exit_listing_and_no_tests_negative_case(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-timeout-unit-') as temporary:
            fixture = self.fixture(temporary)
            listed = '[firefox] › auto-save-settings.spec.ts:1:1\n'
            completed = subprocess.CompletedProcess(['node-fixture'], 0, listed, '')
            with patch.object(subprocess, 'run', return_value=completed):
                self.assertEqual(fixture.listed_files('--project=firefox'),
                                 {('firefox', 'auto-save-settings.spec.ts')})
            empty = subprocess.CompletedProcess(['node-fixture'], 1, '', 'No tests found')
            with patch.object(subprocess, 'run', return_value=empty):
                self.assertEqual(fixture.listed_files('--project=firefox'), set())
            invalid = subprocess.CompletedProcess(['node-fixture'], 1, '', 'module load failed')
            with patch.object(subprocess, 'run', return_value=invalid):
                with self.assertRaises(AssertionError):
                    fixture.listed_files('--project=firefox')

    def test_opt_in_raw_capture_keeps_large_bytes_and_stream_types(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-raw-unit-') as temporary:
            root = Path(temporary)
            raw_parent = root / 'raw'
            raw_parent.mkdir()
            fixture = self.fixture(root)
            large_stdout = b'begin-' + b'x' * 13000 + b'-end'
            timeout = subprocess.TimeoutExpired(['node-fixture'], 90,
                                                output=large_stdout, stderr='text-cause\u2713')
            with patch.dict(os.environ, {'POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR': str(raw_parent)}):
                with patch.object(subprocess, 'run', side_effect=timeout):
                    with self.assertRaises(subprocess.TimeoutExpired) as raised:
                        fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, timeout)
            folder, = raw_parent.iterdir()
            metadata = json.loads((folder / 'metadata.json').read_text(encoding='utf-8'))
            self.assertEqual((folder / 'stdout.bin').read_bytes(), large_stdout)
            self.assertEqual((folder / 'stderr.bin').read_bytes(), 'text-cause\u2713'.encode('utf-8'))
            self.assertEqual(metadata['streams']['stdout']['type'], 'bytes')
            self.assertEqual(metadata['streams']['stderr']['type'], 'str')
            self.assertEqual(metadata['streams']['stderr']['encoding'], 'utf-8')
            self.assertEqual(metadata['timeout_seconds'], 90)
            self.assertIn(str(folder), '\n'.join(timeout.__notes__))

    def test_missing_stream_and_save_failure_keep_original_timeout(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-raw-unit-') as temporary:
            root = Path(temporary)
            raw_parent = root / 'raw'
            raw_parent.mkdir()
            fixture = self.fixture(root)
            timeout = subprocess.TimeoutExpired(['node-fixture'], 90, output=None, stderr=None)
            with patch.dict(os.environ, {'POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR': str(raw_parent)}):
                with patch.object(subprocess, 'run', side_effect=timeout):
                    with self.assertRaises(subprocess.TimeoutExpired) as raised:
                        fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, timeout)
            folder, = raw_parent.iterdir()
            metadata = json.loads((folder / 'metadata.json').read_text(encoding='utf-8'))
            self.assertEqual(metadata['streams']['stdout']['type'], 'none')
            self.assertEqual(metadata['streams']['stderr']['type'], 'none')
            self.assertFalse((folder / 'stdout.bin').exists())
            self.assertFalse((folder / 'stderr.bin').exists())
            failure = subprocess.TimeoutExpired(['node-fixture'], 90, output=b'partial', stderr=None)
            with patch.dict(os.environ, {'POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR': str(raw_parent)}):
                with patch.object(subprocess, 'run', side_effect=failure):
                    with patch.object(Path, 'write_bytes', side_effect=OSError('disk full')):
                        with self.assertRaises(subprocess.TimeoutExpired) as raised:
                            fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, failure)
            self.assertIn('OSError: disk full', '\n'.join(failure.__notes__))
            self.assertIn('raw capture=<failed at ', '\n'.join(failure.__notes__))

    def test_disabled_or_relative_capture_keeps_original_timeout(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-list-raw-unit-') as temporary:
            root = Path(temporary)
            fixture = self.fixture(root)
            disabled = subprocess.TimeoutExpired(['node-fixture'], 90, output=b'partial', stderr=None)
            with patch.dict(os.environ, {'POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR': ''}):
                with patch.object(subprocess, 'run', side_effect=disabled):
                    with self.assertRaises(subprocess.TimeoutExpired) as raised:
                        fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, disabled)
            self.assertFalse((root / 'raw').exists())
            self.assertIn('raw capture=<disabled>', '\n'.join(disabled.__notes__))
            relative = subprocess.TimeoutExpired(['node-fixture'], 90, output=None, stderr=None)
            with patch.dict(os.environ, {'POINTERCAD_TIMEOUT_DIAGNOSTICS_DIR': 'relative-path'}):
                with patch.object(subprocess, 'run', side_effect=relative):
                    with self.assertRaises(subprocess.TimeoutExpired) as raised:
                        fixture.listed_files('--project=firefox')
            self.assertIs(raised.exception, relative)
            self.assertIn('raw capture=<failed at relative-path: ValueError:', '\n'.join(relative.__notes__))
            self.assertFalse((root / 'raw').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
