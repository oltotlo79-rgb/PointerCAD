"""Reject outside task output before any creation; all test artifacts stay in this project."""
import os
from pathlib import Path
import subprocess
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch
from lib.task_workspace import create_workspace, project_temp_directory

ROOT = Path(__file__).resolve().parents[1]
GIT_ENV = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
COMMON = Path(subprocess.check_output(['git', '--no-optional-locks', '-C', str(ROOT),
    'rev-parse', '--path-format=absolute', '--git-common-dir'], env=GIT_ENV, text=True).strip()).resolve(strict=True)
PROJECT = COMMON.parent
assert COMMON.name == '.git' and ROOT.is_relative_to(PROJECT)


class TaskWorkspaceTests(unittest.TestCase):
    def test_default_is_unique_ignored_project_output(self):
        first = create_workspace(ROOT, 'workspace-selftest')
        second = create_workspace(ROOT, 'workspace-selftest')
        for directory in (first, second):
            self.addCleanup(directory.rmdir)
            self.assertTrue(directory.resolve().is_relative_to(PROJECT / 'scratchpad'))
            result = subprocess.run(['git', '--no-optional-locks', '-C', str(PROJECT), 'check-ignore', str(directory)],
                                    capture_output=True, timeout=10, env=GIT_ENV)
            self.assertEqual(result.returncode, 0)
        self.assertNotEqual(first, second)

    def test_external_git_and_traversal_paths_fail_before_creation(self):
        for base in (PROJECT.parent / 'must-not-create-pointercad-task', COMMON,
                     COMMON / 'new-task', PROJECT / 'scratchpad/../../must-not-create-task',
                     ROOT / '.git', ROOT / '.git/new-task'):
            with self.subTest(base=str(base)), patch.object(Path, 'mkdir', side_effect=AssertionError('Creation was attempted')) as mkdir:
                with patch.object(tempfile, 'mkdtemp', side_effect=AssertionError('Creation was attempted')) as temporary:
                    with self.assertRaises(ValueError):
                        create_workspace(ROOT, 'workspace-selftest', base)
                    mkdir.assert_not_called()
                    temporary.assert_not_called()

    def test_escaping_directory_link_is_rejected_without_creating_a_child(self):
        directory = create_workspace(ROOT, 'workspace-link-selftest')
        self.addCleanup(directory.rmdir)
        link = directory / 'escape'
        if os.name == 'nt':
            quote = lambda value: "'" + str(value).replace("'", "''") + "'"
            command = 'New-Item -ItemType Junction -Path ' + quote(link) + ' -Target ' + quote(PROJECT.parent) + ' | Out-Null'
            subprocess.run(['powershell.exe', '-NoProfile', '-Command', command], check=True, capture_output=True, timeout=15)
            self.addCleanup(link.rmdir)  # Remove only the link; never recurse into its target.
        else:
            link.symlink_to(PROJECT.parent, target_is_directory=True)
            self.addCleanup(link.unlink)
        self.assertEqual(link.resolve(), PROJECT.parent.resolve())
        with patch.object(Path, 'mkdir', side_effect=AssertionError('Creation was attempted')):
            with self.assertRaises(ValueError):
                create_workspace(ROOT, 'workspace-selftest', link / 'must-not-create')

    def test_inherited_git_context_cannot_redirect_project_output(self):
        with patch.dict(os.environ, {'GIT_DIR': str(ROOT.parent / 'foreign.git'), 'GIT_WORK_TREE': str(ROOT.parent)}):
            self.assertEqual(project_temp_directory(ROOT), PROJECT / 'scratchpad/temp')

    def test_real_linked_worktree_keeps_output_in_the_common_project(self):
        fixture = create_workspace(ROOT, 'workspace-linked-selftest').resolve(strict=True)
        linked = fixture / 'scratchpad/check-copy'
        def git(*args):
            return subprocess.check_output(['git', '--no-optional-locks', '-C', str(fixture), *args],
                                           env=GIT_ENV, stderr=subprocess.STDOUT, timeout=15)
        try:
            git('init', '--quiet')
            (fixture / '.gitignore').write_text('scratchpad/\n', encoding='utf-8')
            git('add', '.gitignore')
            git('-c', 'user.name=workspace selftest', '-c', 'user.email=selftest@example.invalid',
                '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'workspace fixture')
            git('worktree', 'add', '--quiet', '--detach', str(linked), 'HEAD')
            output = create_workspace(linked, 'workspace-selftest')
            self.assertTrue(output.is_relative_to(fixture / 'scratchpad/tasks'))
            self.assertFalse(output.is_relative_to(linked))
            self.assertEqual(project_temp_directory(linked), fixture / 'scratchpad/temp')
            for base in (linked / '.git', linked / '.git/new-task', linked / '.GIT/new-task',
                         linked / '.git/../new-task', fixture / '.git/new-task'):
                with self.subTest(base=str(base)), patch.object(Path, 'mkdir', side_effect=AssertionError('Creation was attempted')) as mkdir:
                    with self.assertRaises(ValueError):
                        create_workspace(linked, 'workspace-selftest', base)
                    mkdir.assert_not_called()
        finally:
            if linked.exists():
                git('worktree', 'remove', str(linked))
            # Delete only this test-owned repository, after checking its absolute boundary.
            assert fixture.is_relative_to((PROJECT / 'scratchpad').resolve()) and fixture != PROJECT / 'scratchpad'
            def remove_readonly(function, name, error):
                if not isinstance(error[1], PermissionError):
                    raise error[1]
                path = Path(name).resolve()
                assert path.is_relative_to(fixture)
                path.chmod(stat.S_IREAD | stat.S_IWRITE)
                function(name)
            shutil.rmtree(fixture, onerror=remove_readonly)


if __name__ == '__main__':
    unittest.main(verbosity=2)
