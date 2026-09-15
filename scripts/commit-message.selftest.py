"""Exercise the shipped commit-msg hook through real Git in an isolated repository."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from lib.task_workspace import configure_project_temp

configure_project_temp(Path(__file__).resolve().parents[1])

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('commit_message', HERE / 'lib/commit_message.py')
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class CommitMessageTests(unittest.TestCase):
    def test_shipped_hooks_are_tracked_as_executable_and_keep_lf(self):
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
        for name in ['pre-commit', 'commit-msg', 'pre-push']:
            relative = 'scripts/hooks/' + name
            result = subprocess.run(['git', '-C', str(HERE.parent), 'ls-files', '--stage', '--', relative],
                                    env=environment, capture_output=True, timeout=15, check=True)
            self.assertTrue(result.stdout.startswith(b'100755 '), relative + ' must be executable on Linux')
            self.assertNotIn(b'\r', (HERE.parent / relative).read_bytes(), relative)

    def test_japanese_subjects_preserve_technical_names_and_both_line_endings(self):
        for message in ['許諾文書の改行を保つ\n', 'Git の改行変換から許諾原文を保護する\r\n\r\n本文\r\n',
                        '描画性能改善\n', 'ひらがなのけんめい\n', 'ファイルを保存する\n']:
            with self.subTest(message=message):
                self.assertIsNone(validator.validate_message(message.encode()))

    def test_english_subjects_cannot_be_hidden_by_japanese_body_or_comments(self):
        for message in ['fix: preserve original mathematics notice bytes across Git checkouts\n',
                        'Preserve notice bytes\n\n本文だけ日本語\n', '\n# 日本語の説明\nEnglish subject\n',
                        '# 日本語のコメントだけ\n', '', '1234 !!!\n']:
            with self.subTest(message=message):
                self.assertIsNotNone(validator.validate_message(message.encode()))

    def test_prefixes_are_rejected_even_with_a_japanese_subject(self):
        for prefix in ['fix:', 'feat(ui):', 'refactor!:', 'CI:', 'docs：', 'fixup!', 'squash!', 'amend!']:
            with self.subTest(prefix=prefix):
                self.assertIsNotNone(validator.validate_message((prefix + ' 保存を直す\n').encode()))

    def test_bad_encoding_bom_and_control_characters_are_rejected(self):
        for data in [b'\xef\xbb\xbf' + '保存を直す\n'.encode(), b'\xff\xfe',
                     '保存を直す\0\n'.encode(), '保存を直す\n'.encode('cp932')]:
            with self.subTest(data=data):
                self.assertIsNotNone(validator.validate_message(data))

    def test_real_hook_rejects_bad_commit_without_advancing_head_then_accepts_japanese(self):
        with tempfile.TemporaryDirectory(prefix='pointercad-commit-message-') as temp:
            root = Path(temp)
            environment = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
            empty_config = root / 'empty.config'
            empty_config.touch()
            environment.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(empty_config))

            def git(*args, check=True):
                result = subprocess.run(['git', '-C', str(root), *args], env=environment,
                                        capture_output=True, timeout=15)
                if check:
                    self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode('utf8', errors='replace'))
                return result

            git('init', '--quiet')
            git('config', 'user.name', 'commit message selftest')
            git('config', 'user.email', 'selftest@example.invalid')
            git('config', 'core.autocrlf', 'false')
            git('commit', '--allow-empty', '-qm', '初期状態を保存する')
            baseline = git('rev-parse', 'HEAD').stdout
            for relative in ['hooks/commit-msg', 'lib/commit_message.py']:
                destination = root / 'scripts' / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(HERE / relative, destination)
                destination.chmod(0o755)
            git('config', 'core.hooksPath', 'scripts/hooks')
            shutil.copyfile(HERE.parent / '.gitattributes', root / '.gitattributes')
            git('add', 'scripts', '.gitattributes')
            message_file = root / '日本語 空白付きの件名.txt'
            for message in ['Preserve notices\n\n日本語の本文', 'fix: 許諾文書を保護する', '\ufeff許諾文書を保護する']:
                message_file.write_bytes(message.encode())
                rejected = git('commit', '--allow-empty', '-F', str(message_file), check=False)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn(b'[NG]', rejected.stderr)
                self.assertEqual(git('rev-parse', 'HEAD').stdout, baseline)
            message_file.write_bytes('許諾文書の改行を保つ\n\nGitで原文が変わらないことを確かめる。\n'.encode())
            git('commit', '--allow-empty', '-F', str(message_file))
            self.assertEqual(git('log', '-1', '--format=%s').stdout.decode().strip(), '許諾文書の改行を保つ')
            # A Windows checkout must keep the shipped shell entry point executable.
            (root / 'scripts/hooks/commit-msg').unlink()
            git('-c', 'core.autocrlf=true', 'checkout-index', '--all', '--force')
            self.assertNotIn(b'\r', (root / 'scripts/hooks/commit-msg').read_bytes())
            git('commit', '--allow-empty', '-F', str(message_file))
            before_missing = git('rev-parse', 'HEAD').stdout
            (root / 'scripts/lib/commit_message.py').unlink()
            self.assertNotEqual(git('commit', '--allow-empty', '-F', str(message_file), check=False).returncode, 0)
            self.assertEqual(git('rev-parse', 'HEAD').stdout, before_missing)


if __name__ == '__main__':
    unittest.main(verbosity=2)
