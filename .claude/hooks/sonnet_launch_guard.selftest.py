"""実フックの stdin・終了コードを、使い捨ての根で検査する。"""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = Path(__file__).resolve().with_name('sonnet_launch_guard.py')
ROOT = HOOK.parents[2]


class SonnetLaunchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parent = ROOT / 'scratchpad/temp'
        cls.created = []
        node = parent
        while not node.exists():
            cls.created.append(node)
            node = node.parent
        parent.mkdir(parents=True, exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='sonnet-launch-', dir=parent)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()
        for directory in cls.created:
            directory.rmdir()

    def setUp(self):
        self.temp_case = tempfile.TemporaryDirectory(dir=self.temp.name)
        self.addCleanup(self.temp_case.cleanup)
        self.root = Path(self.temp_case.name)
        self.hook = self.root / '.claude/hooks/sonnet_launch_guard.py'
        self.hook.parent.mkdir(parents=True)
        shutil.copyfile(HOOK, self.hook)
        self.marker = self.root / 'scratchpad/claude/root-runtime/sonnet-allowed.json'

    def invoke(self, model=None, **overrides):
        payload = {'hook_event_name': 'PreToolUse', 'tool_name': 'Agent',
                   'tool_input': {} if model is None else {'model': model}}
        payload.update(overrides)
        return subprocess.run([sys.executable, '-B', '-X', 'utf8', str(self.hook)],
                              input=json.dumps(payload), text=True, encoding='utf-8', capture_output=True)

    def test_sonnet_without_marker_denied(self):
        result = self.invoke('sonnet')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertEqual(len(result.stderr.splitlines()), 1)
        self.assertIn('利用者の指示 2026-11-01 19:3x: Sonnet は出さない', result.stderr)

    def test_full_and_uppercase_model_names_denied(self):
        for model in ('claude-sonnet-5-5', 'SONNET'):
            self.assertEqual(self.invoke(model).returncode, 2)

    def test_marker_allows_sonnet(self):
        self.marker.parent.mkdir(parents=True)
        self.marker.write_text(json.dumps({'openedBy': '統括', 'reason': '利用者の許可',
                                            'openedAt': '2026-11-01T20:00:00+09:00'}), encoding='utf-8')
        result = self.invoke('sonnet')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_directory_is_not_marker(self):
        self.marker.mkdir(parents=True)
        self.assertEqual(self.invoke('sonnet').returncode, 2)

    def test_missing_model_allowed(self):
        self.assertEqual(self.invoke().returncode, 0)

    def test_opus_allowed(self):
        self.assertEqual(self.invoke('opus').returncode, 0)

    def test_haiku_allowed(self):
        self.assertEqual(self.invoke('haiku').returncode, 0)

    def test_other_tool_and_event_are_unchanged(self):
        self.assertEqual(self.invoke('sonnet', tool_name='SendMessage').returncode, 0)
        self.assertEqual(self.invoke('sonnet', hook_event_name='PostToolUse').returncode, 0)

    def test_unreadable_payload_denied(self):
        result = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(self.hook)],
                                input='{', text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
