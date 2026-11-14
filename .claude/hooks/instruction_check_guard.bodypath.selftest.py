"""検査14（本文の実在しないパスの警告）の自己試験: 警告する 3 件・警告しない 5 件以上。"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().with_name('instruction_check_guard.py')
spec = importlib.util.spec_from_file_location('instruction_check_guard', HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

SCOPE = '③ 編集してよいのは scratchpad/claude/agents/worker-a/ 以下だけ。'


class BodyPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'packages/ui/src').mkdir(parents=True)
        (self.root / 'packages/ui/src/real.ts').write_text('x\n', encoding='utf-8')
        (self.root / 'packages/help-content/docs/ja/images').mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def find(self, text):
        return guard.body_path_findings(self.root, 'x.md', text.splitlines(), SCOPE)

    def test_warns_missing_folder(self):
        found = self.find('画像は docs/manual にある。')
        self.assertEqual(len(found), 1)
        self.assertIn('docs/manual', found[0])

    def test_warns_missing_file(self):
        self.assertEqual(len(self.find('`packages/ui/src/none.ts` を読む。')), 1)

    def test_warns_missing_file_with_line_number(self):
        found = self.find('出典 packages/ui/src/none.ts:12-15 の通り。')
        self.assertEqual(len(found), 1)
        self.assertIn('`packages/ui/src/none.ts`', found[0])

    def test_quiet_existing_file(self):
        self.assertEqual(self.find('packages/ui/src/real.ts を読む。'), [])

    def test_quiet_existing_file_with_line_number(self):
        self.assertEqual(self.find('packages/ui/src/real.ts:30 と packages/ui/src/real.ts:3-9。'), [])

    def test_quiet_existing_folder_with_and_without_slash(self):
        self.assertEqual(self.find('packages/help-content/docs/ja/images/ と packages/help-content/docs/ja/images。'), [])

    def test_quiet_own_folder(self):
        self.assertEqual(self.find('進捗は scratchpad/claude/agents/worker-a/progress.md と scratchpad/claude/agents/worker-a/cand/ へ。'), [])

    def test_quiet_other_worker_folder_still_warns(self):
        self.assertEqual(len(self.find('scratchpad/claude/agents/worker-b/final.md を読む。')), 1)

    def test_quiet_new_line(self):
        self.assertEqual(self.find('新規 packages/ui/src/brand_new.ts を作る。'), [])

    def test_quiet_new_in_fullwidth_paren_after_path(self):
        self.assertEqual(self.find('2. 先に失敗する単体 packages/ui/src/shell/none.test.ts（新規）を書く: x'), [])

    def test_quiet_new_path_reappearing_on_other_lines(self):
        text = '③ 新規の単体 packages/ui/src/shell/none.test.ts\\n\\n1. packages/ui/src/shell/none.test.ts が成功する。'
        self.assertEqual(self.find(text.replace(chr(92) + 'n', chr(10))), [])

    def test_still_warns_on_line_without_marker_when_not_marked_anywhere(self):
        self.assertEqual(len(self.find('1. packages/ui/src/shell/none.test.ts が成功する。')), 1)

    def test_quiet_format_example(self):
        self.assertEqual(self.find('例: docs/<名前>.md と packages/*/src と docs/….md。'), [])

    def test_quiet_command_span(self):
        self.assertEqual(self.find('`python -B scripts/none.py check` を流す。'), [])

    def test_quiet_line_and_column_number(self):
        self.assertEqual(self.find('✘ packages/ui/src/real.ts:8:3 › 名前'), [])

    def test_quiet_rule_number_shorthand(self):
        (self.root / 'rules').mkdir()
        (self.root / 'rules/06-x.md').write_text('x\n', encoding='utf-8')
        self.assertEqual(self.find('rules/06 の記録。'), [])
        self.assertEqual(len(self.find('rules/07 の記録。')), 1)

    def test_nakaguro_joined(self):
        self.assertEqual(self.find('packages/ui/src/real.ts・packages/ui/src/real.ts'), [])


if __name__ == '__main__':
    unittest.main()
