"""Check independent copies with real Git, dependency resolution and local hooks."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from lib.isolated_checkout_preflight import checked_root, check_fixture_path, inspect, push_checked, git_environment
from lib.task_workspace import configure_project_temp

ROOT = Path(__file__).resolve().parents[1]
PROJECT = configure_project_temp(ROOT).parent.parent


class IndependentCheckoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.area = Path(tempfile.mkdtemp(prefix='ic-', dir=PROJECT / 'scratchpad'))

    def setUp(self):
        self.checkout = Path(tempfile.mkdtemp(prefix='r-', dir=self.area))
        self.env = git_environment()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.checkout), *args], env=self.env,
                                           stderr=subprocess.STDOUT, timeout=15).decode().strip()
        self.git = git
        git('init', '--quiet')
        self.write('.gitignore', 'node_modules/\nhook-ran\n')
        for app in ['web', 'desktop']:
            self.write(f'apps/{app}/package.json', json.dumps({
                'name': f'fixture-{app}', 'version': '1.0.0', 'dependencies': {'fixture-runtime': '1.0.0'}}))
        # Exercise the real inventory, including its dependency selection and
        # the workspace/lock declarations that selection validates.
        for relative in ['scripts/vite/runtimeDependencyInventory.mjs',
                         'scripts/vite/runtimeDependencySelection.mjs',
                         'pnpm-workspace.yaml', 'pnpm-lock.yaml']:
            target = self.checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        self.write('node_modules/fixture-runtime/package.json',
                   '{"name":"fixture-runtime","version":"1.0.0","license":"MIT"}')
        hook = self.write('scripts/hooks/pre-push', '#!/bin/sh\nprintf checked > hook-ran\n')
        hook.chmod(0o755)
        git('add', '.')
        git('-c', 'user.name=Preparation selftest', '-c', 'user.email=selftest@example.invalid',
            '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', '準備確認の初期状態')
        git('config', 'core.hooksPath', 'scripts/hooks')
        self.commit = git('rev-parse', 'HEAD')

    def write(self, relative, text):
        path = self.checkout / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf8', newline='')
        return path

    def test_complete_copy_resolves_dependencies_and_ordinary_push_hook(self):
        before = {name: (self.checkout / '.git' / name).read_bytes() for name in ['HEAD', 'index', 'config']}
        with patch.dict(os.environ, {'GIT_DIR': str(PROJECT / '.git'), 'GIT_WORK_TREE': str(PROJECT)}):
            result = inspect(PROJECT, self.checkout, self.commit)
        self.assertEqual(result['runtimePackages'], [{'name': 'fixture-runtime', 'version': '1.0.0'}])
        self.assertEqual(before, {name: (self.checkout / '.git' / name).read_bytes() for name in before})
        remote = self.area / ('remote-' + self.checkout.name + '.git')
        self.git('init', '--bare', '--quiet', str(remote))
        push_checked(PROJECT, self.checkout, self.commit, str(remote), 'refs/heads/main')
        self.assertEqual((self.checkout / 'hook-ran').read_text(), 'checked')
        actual = subprocess.check_output(['git', '--git-dir', str(remote), 'rev-parse', 'refs/heads/main'], env=self.env)
        self.assertEqual(actual.decode().strip(), self.commit)

    def test_wrong_commit_dirty_tree_index_and_disabled_hooks_stop_before_push(self):
        with self.assertRaisesRegex(ValueError, 'approved commit'):
            inspect(PROJECT, self.checkout, '0' * 40)
        self.write('unexpected.txt', 'changed')
        with self.assertRaisesRegex(ValueError, 'unexpected source'):
            push_checked(PROJECT, self.checkout, self.commit, 'must-not-send', 'refs/heads/main')
        self.git('add', 'unexpected.txt')
        with self.assertRaisesRegex(ValueError, 'unexpected source'):
            inspect(PROJECT, self.checkout, self.commit)
        self.assertFalse((self.checkout / 'hook-ran').exists())
        self.git('rm', '--quiet', '--cached', 'unexpected.txt')
        (self.checkout / 'unexpected.txt').unlink()
        self.git('config', 'core.hooksPath', '')
        with self.assertRaisesRegex(ValueError, 'hooks'):
            inspect(PROJECT, self.checkout, self.commit)

    def test_missing_and_foreign_dependencies_are_rejected(self):
        metadata = self.checkout / 'node_modules/fixture-runtime/package.json'
        metadata.unlink()
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            inspect(PROJECT, self.checkout, self.commit)
        # A broken helper import must not masquerade as the expected rejection
        # of an absent application dependency.
        self.assertIn(b"Cannot find module 'fixture-runtime'", failure.exception.output)
        metadata.parent.rmdir()
        link = metadata.parent
        target = self.area / 'foreign-package'
        target.mkdir(exist_ok=True)
        if os.name == 'nt':
            quote = lambda value: "'" + str(value).replace("'", "''") + "'"
            subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                'New-Item -ItemType Junction -Path ' + quote(link) + ' -Target ' + quote(target) + ' | Out-Null'],
                check=True, capture_output=True, timeout=15)
        else:
            link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'leaves'):
            inspect(PROJECT, self.checkout, self.commit)

    def test_scope_git_namespace_and_windows_nested_path_are_checked_first(self):
        for path in [PROJECT, PROJECT / '.git', PROJECT / 'scratchpad/../.git']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                checked_root(PROJECT, path)
        self.assertLess(check_fixture_path(self.checkout), 240)
        with patch('lib.isolated_checkout_preflight.os.name', 'nt'):
            with self.assertRaisesRegex(ValueError, 'too long'):
                check_fixture_path(self.checkout / ('long-' * 50))


if __name__ == '__main__':
    unittest.main(verbosity=2)
