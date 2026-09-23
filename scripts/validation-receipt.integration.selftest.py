"""Check the real check.ps1 and Git hooks against observable, inexpensive gate commands.

Only the five product test commands and browser executables are fixtures. The real
receipt, PowerShell boundary, batch guard, Git commit and local push run unchanged.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from lib.task_workspace import configure_project_temp

configure_project_temp(Path(__file__).resolve().parents[1])

SOURCE = Path(__file__).resolve().parent


class ReceiptHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pointercad-receipt-hooks-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'working'
        self.root.mkdir()
        self.shell = next((shutil.which(name) for name in ('powershell.exe', 'pwsh', 'powershell') if shutil.which(name)), None)
        self.assertIsNotNone(self.shell, 'The normal quality gate requires PowerShell')
        self.node = shutil.which('node')
        self.assertIsNotNone(self.node, 'The normal quality gate requires Node')
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        self.env.update(CI='', POINTERCAD_PERF_STRICT='1', PYTHONDONTWRITEBYTECODE='1',
                        LANG='C.UTF-8', LC_ALL='C.UTF-8', LC_CTYPE='C.UTF-8')
        # The fixture intentionally fixes its locale. Git's Windows shell fills
        # absent locale variables; that is a real input difference, not reusable
        # evidence. Production receipt checks still compare locale unchanged.
        self.env['PATH'] = str(self.root / 'test-bin') + os.pathsep + self.env['PATH']
        if os.name == 'nt':
            selected_git = shutil.which('git')
            self.assertIsNotNone(selected_git)
            core = Path(subprocess.check_output([selected_git, '--exec-path']).decode().strip()).resolve()
            runner_launcher = core.parent.parent.parent / 'bin/git.exe'
            if runner_launcher.is_file():
                # Exercise the Actions runner's entry point even on a developer
                # machine whose normal PATH selects cmd/git.exe instead.
                self.env['PATH'] = str(runner_launcher.parent) + os.pathsep + self.env['PATH']
        self.env['PCAD_SELFTEST_CALL_LOG'] = str(self.root / 'gate-calls.log')
        # Reproduce a PowerShell 7 parent launching Windows PowerShell 5 through
        # Git hooks. It must build its own module path, not inherit another edition.
        self.env['PSModulePath'] = str(self.base / 'unavailable-parent-edition-modules')
        for relative in ('check.ps1', 'check-commit-batch.ps1', 'hooks/pre-commit', 'hooks/pre-push',
                         'lib/gitTreeGuard.ps1', 'lib/pushTreeFingerprint.ps1', 'lib/directoryLinks.ps1',
                         'lib/commitBatchGuard.ps1', 'lib/validationReceipt.ps1',
                         'lib/validation_receipt.py', 'lib/validationRuntime.mjs', 'lib/WindowsValidationQos.cs',
                         'lib/local_change_scope.py', 'lib/task_workspace.py'):
            target = self.root / 'scripts' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / relative, target)
            if relative.startswith('hooks/'):
                target.chmod(0o755)
        # The real self-test launches a missing-test diagnostic against the same
        # repository. Its invalidation must not erase the enclosing full check.
        self.write('scripts/check.selftest.ps1', '''
$shell = (Get-Process -Id $PID).Path
& $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'check.ps1') -Level Push -UnitPackage ui -UnitTests src/missing.test.ts
if ($LASTEXITCODE -eq 0) { exit 1 }
exit 0
''')
        self.write('.gitignore', 'node_modules/\ndist/\nbrowsers/\ngate-calls.log\nscratchpad/\n')
        self.write('a.txt', 'baseline')
        self.write('package.json', json.dumps({'scripts': {name: 'fixture' for name in (
            'typecheck', 'lint', 'test', 'build', 'test:e2e', 'validation:runtime')}}))
        # Match the real workspace: the app exists before building its ignored output.
        self.write('apps/web/package.json', '{"name":"fixture-web"}')
        self.write('apps/desktop/package.json', '{"name":"@pointercad/desktop"}')
        planned = [f'P0-{number}' for number in range(1, 13)]
        self.write('docs/progress.json', json.dumps({
            'schemaVersion': 1, 'totalTasks': 12, 'futureEstimateTasks': 0,
            'completedBeforeTrackedPhases': 0, 'reportedCompleted': 0,
            'phases': [{'id': 'P0', 'plannedTaskCount': 12, 'plannedTaskIds': planned, 'completedTaskIds': []}]}))
        # No downloaded runtime initially: preparation must precede the receipt.
        self.write('node_modules/@playwright/test/index.js', """
const path = require('node:path');
module.exports = Object.fromEntries(['chromium','firefox'].map((name, i) =>
  [name, {executablePath: () => path.resolve('browsers', name + '-' + (i ? 456 : 123), 'browser.exe')} ]));
""")
        self.write('test-bin/pnpm-fixture.mjs', """
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2).join(' ');
if (args === '--silent run validation:runtime') {
  process.env.npm_execpath = process.argv[1];
  await import('../scripts/lib/validationRuntime.mjs');
} else {
  fs.appendFileSync(process.env.PCAD_SELFTEST_CALL_LOG, args + '\\n');
  if (args.includes('playwright install')) {
    for (const browser of ['chromium-123','firefox-456']) {
      fs.mkdirSync('browsers/' + browser, {recursive:true});
      fs.writeFileSync('browsers/' + browser + '/browser.exe','fixture browser, never executed');
    }
  }
  if (args === '--filter @pointercad/desktop exec install-electron') {
    fs.mkdirSync('apps/desktop/node_modules/electron/dist', {recursive:true});
    fs.writeFileSync('apps/desktop/node_modules/electron/dist/electron.bin','fixture runtime, never executed');
  }
  if (args.startsWith('run ') && !fs.existsSync('apps/desktop/node_modules/electron/dist/electron.bin')) {
    throw new Error('Product check started before the first runtime download');
  }
  if (args === 'run build') {
    fs.mkdirSync('apps/web/dist', {recursive: true});
    fs.writeFileSync('apps/web/dist/index.js', 'the checked build');
  }
  const failure = path.resolve('.git/fail-step');
  if (fs.existsSync(failure) && fs.readFileSync(failure, 'utf8') === args) process.exitCode = 1;
}
""")
        if os.name == 'nt':
            self.write('test-bin/pnpm.cmd', '@echo off\r\n"' + self.node + '" "%~dp0pnpm-fixture.mjs" %*\r\n')
        else:
            stub = self.write('test-bin/pnpm', '#!/bin/sh\nexec node "$(dirname "$0")/pnpm-fixture.mjs" "$@"\n')
            stub.chmod(0o755)
        self.git('init', '-q', '-b', 'feature/receipt')
        self.git('config', 'user.name', 'Receipt hook self-test')
        self.git('config', 'user.email', 'receipt-hooks@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture baseline')
        self.git('config', 'core.hooksPath', 'scripts/hooks')
        self.remote = self.base / 'remote.git'
        self.git('init', '--bare', '-q', str(self.remote))
        self.git('remote', 'add', 'origin', str(self.remote))
        self.write('a.txt', 'checked change')
        self.git('add', 'a.txt')

    def write(self, name: str, content: str) -> Path:
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('w', encoding='utf-8', newline='') as output:
            output.write(content)
        return target

    def command(self, args, success=True):
        child_environment = {key: value for key, value in self.env.items() if key.upper() != 'PSMODULEPATH'}
        result = subprocess.run(args, cwd=self.root, env=child_environment, capture_output=True, timeout=100)
        text = (result.stdout + result.stderr).decode('utf-8', errors='replace')
        if success:
            self.assertEqual(result.returncode, 0, text[-12000:])
        else:
            self.assertNotEqual(result.returncode, 0, text[-12000:])
        return text

    def git(self, *args, success=True):
        return self.command(['git', *args], success)

    def full_check(self, success=True):
        return self.command([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                             '-File', str(self.root / 'scripts/check.ps1')], success)

    def calls(self):
        target = self.root / 'gate-calls.log'
        return target.read_text(encoding='utf-8').splitlines() if target.exists() else []

    def exercise_product_git_isolation(self, *, linked=False, failure=False):
        # These are private repositories, including the deliberately exposed index.
        # Run the real check.ps1 entry; an unprotected child reproduces the damage.
        foreign = self.base / 'protected'
        foreign.mkdir()
        clean = {key: value for key, value in self.env.items() if not key.upper().startswith('GIT_')}

        def git(where, *args):
            return subprocess.check_output(['git', '--no-optional-locks', '-C', str(where), *args],
                                           env=clean, stderr=subprocess.PIPE)

        git(foreign, 'init', '--quiet')
        git(foreign, 'config', 'user.name', 'Protected fixture')
        git(foreign, 'config', 'user.email', 'protected@example.invalid')
        (foreign / 'keep.txt').write_text('committed', encoding='utf8')
        git(foreign, 'add', 'keep.txt')
        git(foreign, 'commit', '--quiet', '-m', 'fixture')
        selected = foreign
        if linked:
            selected = self.base / 'protected-worktree'
            git(foreign, 'worktree', 'add', '--quiet', '-b', 'protected-branch', str(selected))
        (selected / 'keep.txt').write_text('staged', encoding='utf8')
        git(selected, 'add', 'keep.txt')
        (selected / 'keep.txt').write_text('unstaged', encoding='utf8')
        gitdir = Path(git(selected, 'rev-parse', '--absolute-git-dir').decode().strip())
        paths = [foreign / '.git/config', gitdir / 'HEAD', gitdir / 'index', selected / 'keep.txt',
                 self.root / '.git/config', self.root / '.git/HEAD', self.root / '.git/index']
        before = {str(path): path.read_bytes() for path in paths}
        self.write('apps/desktop/src/git-isolation.test.ts', '// Private command fixture\n')
        self.write('test-bin/pnpm-fixture.mjs', '''
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const folder = resolve('scratchpad/product-fixture');
mkdirSync(folder, {recursive:true});
const git = (...args) => execFileSync('git', args, {cwd:folder, stdio:'pipe'});
git('init', '--quiet');
writeFileSync(resolve(folder,'fixture.txt'), 'product fixture');
git('add', 'fixture.txt');
git('init', '--bare', '--quiet', resolve('scratchpad/product-remote.git'));
writeFileSync(resolve('scratchpad/product-ran'), 'yes');
process.exitCode = process.env.PCAD_PRODUCT_EXIT === '7' ? 7 : 0;
''')
        self.env.update(GIT_DIR=str(gitdir), GIT_INDEX_FILE=str(gitdir / 'index'),
                        GIT_COMMON_DIR=str(foreign / '.git'), PCAD_PRODUCT_EXIT='7' if failure else '0')
        # Do not hide the resulting status with a retry. Assert that the child ran,
        # and compare bytes even when the gate correctly reports its failure.
        environment = {key: value for key, value in self.env.items() if key.upper() != 'PSMODULEPATH'}
        result = subprocess.run([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                 str(self.root / 'scripts/check.ps1'), '-UnitPackage', 'desktop',
                                 '-UnitTests', 'src/git-isolation.test.ts'], cwd=self.root, env=environment,
                                capture_output=True, timeout=40)
        self.assertTrue((self.root / 'scratchpad/product-ran').is_file(), repr(result.stdout + result.stderr))
        self.assertEqual({str(path): path.read_bytes() for path in paths}, before,
                         'A product check changed the caller or foreign Git metadata')
        self.assertEqual(result.returncode, 7 if failure else 0, repr(result.stdout + result.stderr))
        self.assertEqual(git(self.root / 'scratchpad/product-fixture', 'show', ':fixture.txt'), b'product fixture')

    def test_product_commands_cannot_modify_a_foreign_repository(self):
        self.exercise_product_git_isolation()

    def test_product_commands_cannot_modify_a_linked_worktree(self):
        self.exercise_product_git_isolation(linked=True)

    def test_product_failure_keeps_its_exit_code_and_foreign_git_bytes(self):
        self.exercise_product_git_isolation(linked=True, failure=True)

    def test_real_hooks_share_once_and_failed_send_cannot_reuse_fallback_success(self):
        output = self.full_check()
        proof = self.root / '.git/validation-receipt.json'
        self.assertTrue(proof.is_file(), 'The actual PowerShell boundary must issue a receipt\n' + output[-4000:])
        checked = self.calls()
        full_calls = checked[:]
        self.assertEqual([line for line in checked if line.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])
        output = self.git('commit', '-qm', 'checked change')
        self.assertEqual(self.calls(), checked, 'The real pre-commit must share the full check\n' + output)
        output = self.git('push', 'origin', 'HEAD:main')
        self.assertEqual(self.calls(), checked, 'The real pre-push must share the full check\n' + output)
        self.assertFalse(proof.exists())

        self.write('a.txt', 'next change'); self.git('add', 'a.txt')
        self.full_check()
        checked = self.calls()
        self.git('commit', '-qm', 'next checked change')
        reject = self.remote / 'hooks/pre-receive'
        reject.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8'); reject.chmod(0o755)
        self.git('push', 'origin', 'HEAD:main', success=False)
        self.assertEqual(self.calls(), checked)
        self.assertFalse(proof.exists(), 'Consume before the rejected send')
        self.git('push', 'origin', 'HEAD:main', success=False)
        after_fallback = self.calls()
        self.assertEqual(after_fallback[len(checked):], full_calls)
        self.assertFalse(proof.exists(), 'Ordinary pre-push must not publish another reusable success')
        reject.unlink()
        self.git('push', 'origin', 'HEAD:main')
        self.assertGreater(len(self.calls()), len(after_fallback))
        self.assertFalse(proof.exists())

    def test_real_gate_failure_or_changed_source_falls_back_to_required_checks(self):
        self.write('.git/fail-step', 'run test:e2e')
        self.full_check(success=False)
        proof = self.root / '.git/validation-receipt.json'
        self.assertFalse(proof.exists())
        (self.root / '.git/fail-step').unlink()
        self.full_check()
        self.assertTrue(proof.exists())
        before = self.calls()
        self.write('a.txt', 'changed after check'); self.git('add', 'a.txt')
        self.git('commit', '-qm', 'changed source')
        self.assertFalse(proof.exists())
        self.assertEqual(self.calls()[len(before):], ['run typecheck', 'run lint', 'run test', 'run build'])

    def test_real_hooks_share_a_checked_merge_without_repeating_the_full_check(self):
        self.full_check()
        self.git('commit', '-qm', 'feature change')
        base = self.git('rev-parse', 'HEAD^').strip()
        tree = self.git('rev-parse', base + '^{tree}').strip()
        other = self.git('commit-tree', tree, '-p', base, '-m', 'parallel history').strip()
        self.git('merge', '--no-ff', '--no-commit', other)
        self.full_check()
        checked = self.calls()
        output = self.git('commit', '-qm', 'checked merge')
        self.assertEqual(self.calls(), checked, output)
        output = self.git('push', 'origin', 'HEAD:main')
        self.assertEqual(self.calls(), checked, output)
        self.assertFalse((self.root / '.git/validation-receipt.json').exists())

    def test_ci_shards_preserve_all_product_stages_and_cannot_replace_local_full_checks(self):
        entry = [self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(self.root / 'scripts/check.ps1')]
        self.command(entry + ['-E2EShard', '1/3'], success=False)
        self.assertEqual(self.calls(), [])
        self.env['CI'] = 'true'
        for arguments in [['-E2EShard', value] for value in ['0/3', '4/3', '1/2', '1/3 --no-deps']] + [
            ['-E2EShard', '1/3', '-E2EOnly'], ['-E2EShard', '1/3', '-StaticOnly'],
            ['-E2EShard', '1/3', '-ReceiptPhase', 'Push'], ['-E2EShard', '1/3', '-Level', 'Commit'],
            ['-E2EShard', '1/3', '-E2ERepeats', '2'],
        ]:
            with self.subTest(arguments=arguments):
                self.command(entry + arguments, success=False)
                self.assertEqual(self.calls(), [], 'Invalid shards must not start package commands')
        for shard in [1, 2, 3]:
            before = len(self.calls())
            self.command(entry + ['-E2EShard', f'{shard}/3'])
            self.assertEqual([call for call in self.calls()[before:] if call.startswith('run ')],
                             ['run typecheck', 'run lint', 'run test', 'run build', f'run test:e2e --shard={shard}/3'])
            self.assertFalse((self.root / '.git/validation-receipt.json').exists())
        self.write('.git/fail-step', 'run test:e2e --shard=2/3')
        self.command(entry + ['-E2EShard', '2/3'], success=False)
        self.assertFalse((self.root / '.git/validation-receipt.json').exists())
        self.env['CI'] = ''
        before = len(self.calls())
        self.full_check()
        self.assertEqual([call for call in self.calls()[before:] if call.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])

    def test_e2e_target_diagnostic_cannot_replace_full_ci_or_hook_checks(self):
        entry = [self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(self.root / 'scripts/check.ps1')]
        selected = ['-E2EOnly', '-E2EGrep', 'fixture-selected', '-E2ENoDependencies']
        for arguments in [
            ['-E2ENoDependencies'], ['-E2EOnly', '-E2ENoDependencies'],
            selected + ['-Full'], selected + ['-Install'], selected + ['-Level', 'Commit'],
            selected + ['-ReceiptPhase', 'Push'], selected + ['-E2ERepeats', '2'],
        ]:
            with self.subTest(arguments=arguments):
                self.command(entry + arguments, success=False)
                self.assertEqual(self.calls(), [], 'Invalid combinations must stop before any package command')
        self.env['CI'] = 'true'
        self.command(entry + selected, success=False)
        self.assertEqual(self.calls(), [])
        self.env['CI'] = ''
        self.command(entry + selected)
        self.assertEqual([line for line in self.calls() if line.startswith('run ')],
                         ['run test:e2e --grep fixture-selected --no-deps'])
        proof = self.root / '.git/validation-receipt.json'
        self.assertFalse(proof.exists(), 'A diagnostic must never issue reusable full-check evidence')
        before = self.calls()
        self.full_check()
        self.assertEqual([line for line in self.calls()[len(before):] if line.startswith('run ')],
                         ['run typecheck', 'run lint', 'run test', 'run build', 'run test:e2e'])
        self.assertTrue(proof.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
