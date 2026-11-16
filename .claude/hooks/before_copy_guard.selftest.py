"""before_copy_guard.py の自己試験（止める 3 件・通す 5 件以上）。一時フォルダーの小さな git の倉庫で試す。"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().with_name('before_copy_guard.py')
spec = importlib.util.spec_from_file_location('before_copy_guard', HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

SUB = 'C:/Users/x/.claude/projects/p/abc/subagents/agent-aaaa1111.jsonl'
MAIN = 'C:/Users/x/.claude/projects/p/abc.jsonl'
NAME = 'cl-test-worker-1114'


def git(root, *args):
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=t', '-c', 'user.email=t@t', *args], check=True, capture_output=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        git(self.root, 'init', '-q')
        (self.root / 'e2e/tests').mkdir(parents=True)
        (self.root / 'e2e/tests/a.spec.ts').write_text('a\n', encoding='utf-8')
        (self.root / 'docs').mkdir()
        (self.root / 'docs/x.md').write_text('x\n', encoding='utf-8')
        git(self.root, 'add', '-A')
        git(self.root, 'commit', '-q', '-m', 'init')
        (self.root / 'scratchpad/claude/agents' / NAME).mkdir(parents=True)
        (self.root / 'scratchpad/claude/agents' / NAME / 'progress.md').write_text('p\n', encoding='utf-8')
        registry = '| 担当名 | モデル | 起動 | 指示書 | 内容 | 状態 | agentId |\n|---|---|---|---|---|---|---|\n'
        registry += f'| {NAME} | sonnet | 11-14 18:00 | x | y | 稼働 | aaaa1111 |\n'
        (self.root / 'scratchpad/claude/agents/registry.md').write_text(registry, encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def payload(self, rel, tool='Edit', transcript=SUB, agent_id='aaaa1111', absolute=True):
        path = str(self.root / rel) if absolute else rel
        data = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'transcript_path': transcript,
                'tool_input': {'file_path': path}}
        if agent_id:
            data['agent_id'] = agent_id
        return data

    def run_hook(self, payload):
        return guard.hook(payload, root=str(self.root))

    def copy(self, rel, deeper=None):
        base = self.root / 'scratchpad/claude/agents' / NAME
        target = (base / deeper if deeper else base) / 'before' / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('orig\n', encoding='utf-8')


class StopTests(Base):
    def test_edit_without_copy_is_refused(self):
        line, _ = self.run_hook(self.payload('e2e/tests/a.spec.ts'))
        self.assertIsNotNone(line)
        self.assertIn('先に before/ へ写してから編集する', line)
        self.assertIn(f'scratchpad/claude/agents/{NAME}/before/e2e/tests/a.spec.ts', line)
        self.assertIn('cp e2e/tests/a.spec.ts', line)

    def test_write_without_copy_is_refused(self):
        line, _ = self.run_hook(self.payload('docs/x.md', tool='Write', absolute=False))
        self.assertIsNotNone(line)

    def test_copy_in_another_deeper_folder_name_only_is_not_enough(self):
        # 1 段深い before/ にも、同じ相対パスが無い(別のパスの写しだけ)
        self.copy('docs/x.md', deeper='c02c')
        line, _ = self.run_hook(self.payload('e2e/tests/a.spec.ts'))
        self.assertIsNotNone(line)

    def test_unknown_name_with_no_copy_in_recent_folders_is_refused(self):
        line, _ = self.run_hook(self.payload('e2e/tests/a.spec.ts', agent_id='zzzz9999'))
        self.assertIsNotNone(line)
        self.assertIn('担当名が分からない', line)

    def test_main_output_is_a_deny_json_and_exit_0(self):
        proc = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(HOOK)], input=json.dumps(
            self.payload('e2e/tests/a.spec.ts')).encode('utf-8'), capture_output=True, cwd=self.root)
        self.assertEqual(proc.returncode, 0)  # 実の根は本物の倉庫なので、ここでは入力の読み込みと終了コードだけ確かめる


class PassTests(Base):
    def test_copy_exists(self):
        self.copy('e2e/tests/a.spec.ts')
        self.assertEqual(self.run_hook(self.payload('e2e/tests/a.spec.ts')), (None, []))

    def test_copy_in_deeper_before(self):
        self.copy('e2e/tests/a.spec.ts', deeper='c02c')
        self.assertEqual(self.run_hook(self.payload('e2e/tests/a.spec.ts')), (None, []))

    def test_new_untracked_file(self):
        (self.root / 'e2e/tests/new.spec.ts').write_text('n\n', encoding='utf-8')
        self.assertEqual(self.run_hook(self.payload('e2e/tests/new.spec.ts')), (None, []))
        self.assertEqual(self.run_hook(self.payload('e2e/tests/not-yet-created.ts', tool='Write')), (None, []))

    def test_inside_own_scratchpad_folder(self):
        self.assertEqual(self.run_hook(self.payload(f'scratchpad/claude/agents/{NAME}/final.md', tool='Write')), (None, []))

    def test_orchestrator_edit(self):
        self.assertEqual(self.run_hook(self.payload('docs/x.md', transcript=MAIN, agent_id=None)), (None, []))

    def test_unknown_name_passes_when_a_recent_folder_has_the_copy(self):
        self.copy('e2e/tests/a.spec.ts')
        self.assertEqual(self.run_hook(self.payload('e2e/tests/a.spec.ts', agent_id='zzzz9999')), (None, []))

    def test_name_from_transcript_instruction(self):
        transcript = self.root / 'agent-aaaa1111.jsonl'
        transcript.write_text(json.dumps({'message': f'指示書 scratchpad/claude/instructions/{NAME}.md を読め'}, ensure_ascii=False), encoding='utf-8')
        self.copy('e2e/tests/a.spec.ts')
        payload = self.payload('e2e/tests/a.spec.ts', agent_id=None, transcript=str(self.root / 'x/subagents/agent-aaaa1111.jsonl'))
        # 実在しない会話記録でも落ちない(名前不明の経路)
        self.assertEqual(self.run_hook(payload), (None, []))
        self.assertEqual(guard.name_from_transcript(str(self.root), str(transcript)), NAME)

    def test_outside_root_and_no_path(self):
        self.assertEqual(guard.hook({'hook_event_name': 'PreToolUse', 'tool_name': 'Edit', 'agent_id': 'a',
                                     'tool_input': {'file_path': 'C:/elsewhere/x.ts'}}, root=str(self.root)), (None, []))
        self.assertEqual(guard.hook({'hook_event_name': 'PreToolUse', 'tool_name': 'Edit', 'agent_id': 'a',
                                     'tool_input': {}}, root=str(self.root)), (None, []))

    def test_unknown_caller_is_passed_with_a_warning(self):
        line, warnings = self.run_hook(self.payload('docs/x.md', transcript=None, agent_id=None))
        self.assertIsNone(line)
        self.assertTrue(warnings)


if __name__ == '__main__':
    unittest.main()
