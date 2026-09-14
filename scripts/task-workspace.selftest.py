"""Reject outside task output before any creation; all test artifacts stay in this project."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from lib.task_workspace import create_workspace, project_temp_directory

ROOT = Path(__file__).resolve().parents[1]


class TaskWorkspaceTests(unittest.TestCase):
    def test_default_is_unique_ignored_project_output(self):
        first = create_workspace(ROOT, 'workspace-selftest')
        second = create_workspace(ROOT, 'workspace-selftest')
        for directory in (first, second):
            self.assertTrue(directory.resolve().is_relative_to(ROOT / 'scratchpad'))
            self.addCleanup(directory.rmdir)
            result = subprocess.run(['git', '--no-optional-locks', '-C', str(ROOT), 'check-ignore', str(directory)],
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
        self.assertNotEqual(first, second)

    def test_external_git_and_traversal_paths_fail_before_creation(self):
        for base in (ROOT.parent / 'must-not-create-pointercad-task', ROOT / '.git',
                     ROOT / '.git/new-task', ROOT / 'scratchpad/../../must-not-create-task'):
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
            command = 'New-Item -ItemType Junction -Path ' + quote(link) + ' -Target ' + quote(ROOT.parent) + ' | Out-Null'
            subprocess.run(['powershell.exe', '-NoProfile', '-Command', command], check=True, capture_output=True, timeout=15)
            self.addCleanup(link.rmdir)  # Remove only the link; never recurse into its target.
        else:
            link.symlink_to(ROOT.parent, target_is_directory=True)
            self.addCleanup(link.unlink)
        self.assertEqual(link.resolve(), ROOT.parent.resolve())
        with patch.object(Path, 'mkdir', side_effect=AssertionError('Creation was attempted')):
            with self.assertRaises(ValueError):
                create_workspace(ROOT, 'workspace-selftest', link / 'must-not-create')

    def test_inherited_git_context_cannot_redirect_project_output(self):
        with patch.dict(os.environ, {'GIT_DIR': str(ROOT.parent / 'foreign.git'), 'GIT_WORK_TREE': str(ROOT.parent)}):
            self.assertEqual(project_temp_directory(ROOT), ROOT / 'scratchpad/temp')


if __name__ == '__main__':
    unittest.main(verbosity=2)
