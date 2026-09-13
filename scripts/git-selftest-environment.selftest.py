"""Run the production self-test entry with real foreign Git repositories."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
NAMES = ('GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
         'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH')


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


class SelftestEnvironmentTests(unittest.TestCase):
    def exercise(self, *, linked=False, relative=False, failure=False, inherited=True):
        clean = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        shell = next((shutil.which(name) for name in ('powershell.exe', 'pwsh', 'powershell') if shutil.which(name)), None)
        self.assertIsNotNone(shell)
        with tempfile.TemporaryDirectory(prefix='pointercad-selftest-isolation-') as folder:
            base = Path(folder).resolve()
            foreign = base / 'foreign'
            foreign.mkdir()

            def git(where, *args):
                return subprocess.check_output(['git', '-C', str(where), *args], env=clean, stderr=subprocess.PIPE)

            git(foreign, 'init', '--quiet')
            git(foreign, 'config', 'user.name', 'Foreign owner')
            git(foreign, 'config', 'user.email', 'foreign@example.invalid')
            (foreign / 'keep.txt').write_text('precious original', encoding='utf8')
            git(foreign, 'add', 'keep.txt')
            git(foreign, 'commit', '--quiet', '-m', 'foreign original')
            selected = foreign
            if linked:
                selected = base / 'linked'
                git(foreign, 'worktree', 'add', '--quiet', '-b', 'fixture', str(selected))
            (selected / 'keep.txt').write_text('precious staged', encoding='utf8')
            git(selected, 'add', 'keep.txt')
            (selected / 'keep.txt').write_text('precious unstaged', encoding='utf8')
            gitdir = Path(git(selected, 'rev-parse', '--absolute-git-dir').decode().strip())
            tracked = [foreign / '.git/config', gitdir / 'HEAD', gitdir / 'index', selected / 'keep.txt']
            before = {str(path): path.read_bytes() for path in tracked}
            head = git(selected, 'rev-parse', 'HEAD')
            status = git(selected, 'status', '--porcelain=v1', '-z')
            target = base / 'selftest'
            target.mkdir()
            script = base / 'entry.ps1'
            script.write_text("\n".join([
                "$ErrorActionPreference = 'Stop'",
                '. ' + quote(SOURCE / 'lib/gitTreeGuard.ps1'),
                '$entry = Start-IsolatedGitSelftest -ScriptPath $MyInvocation.MyCommand.Path',
                'if ($entry.Restarted) { exit $entry.ExitCode }',
                'foreach ($name in $script:PointerCadInheritedGitEnvNames) {',
                '  if (Test-Path "Env:$name") { throw "Inherited Git target remains: $name" }',
                '}',
                '$target = ' + quote(target),
                '& git -C $target init --quiet',
                'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
                '& git -C $target config user.name "Selftest owner"',
                '& git -C $target config user.email "selftest@example.invalid"',
                '[IO.File]::WriteAllText((Join-Path $target "created.txt"), "isolated content")',
                '& git -C $target add created.txt',
                '& git -C $target commit --quiet -m "selftest original"',
                'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
                'exit ' + ('7' if failure else '0'),
            ]), encoding='utf-8-sig')
            env = dict(clean)
            if inherited:
                env.update({name: str(base / ('invalid-' + name)) for name in NAMES})
                env.update(GIT_DIR='.git' if relative else str(gitdir),
                           GIT_INDEX_FILE='.git/index' if relative else str(gitdir / 'index'),
                           GIT_WORK_TREE=str(selected), GIT_COMMON_DIR=str(foreign / '.git'))
            completed = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                                       cwd=selected, env=env, capture_output=True, timeout=30)
            self.assertEqual(completed.returncode, 7 if failure else 0, repr(completed.stdout + completed.stderr))
            self.assertTrue((target / '.git').is_dir())
            self.assertEqual(git(target, 'show', 'HEAD:created.txt'), b'isolated content')
            self.assertEqual(git(selected, 'rev-parse', 'HEAD'), head)
            self.assertEqual(git(selected, 'status', '--porcelain=v1', '-z'), status)
            self.assertEqual({str(path): path.read_bytes() for path in tracked}, before)

    def test_absolute_foreign_repository_is_unchanged(self):
        self.exercise()

    def test_linked_worktree_index_and_common_config_are_unchanged(self):
        self.exercise(linked=True)

    def test_relative_hook_index_is_not_resolved_in_the_selftest(self):
        self.exercise(relative=True)

    def test_failed_selftest_preserves_exit_code_and_foreign_contents(self):
        self.exercise(linked=True, failure=True)

    def test_clean_entry_runs_the_same_selftest(self):
        self.exercise(inherited=False)


if __name__ == '__main__':
    unittest.main()
