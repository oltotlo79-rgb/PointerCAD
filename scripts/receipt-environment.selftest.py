"""Real capture/seal/receipt transitions with owner-local files and read-only Git fixtures.

Never starts Git, hooks, gates, browsers or any subprocess. The Git and browser-location
boundaries are fixtures; environment capture, hashing, seals and receipt operations are real.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPTS = Path(__file__).resolve().parent
vr = load('candidate_receipt', SCRIPTS / 'lib/validation_receipt.py')
light = load('candidate_light', SCRIPTS / 'lib/local_change_scope.py')


class EnvironmentReceiptTests(unittest.TestCase):
    def setUp(self):
        temporary_root = SCRIPTS.parent / 'scratchpad/temp/receipt-environment-selftest'
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='receipt-fixture-', dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.records = self.root / 'records'
        self.records.mkdir()
        self.base = 'a' * 40
        self.head, self.parent = self.base, ''
        self.tree = 'b' * 40
        self.source = self.root / 'a.txt'
        self.source.write_text('unchanged checked source', encoding='utf-8')
        (self.root / 'node_modules').mkdir()
        (self.root / 'browser').mkdir()
        executable = self.root / 'tools/bin/runtime.bin'
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b'fixed fixture runtime')
        self.tools = {name: str(executable) for name in
                      ('node', 'pnpm', 'git', 'shell', 'node_runtime', 'pnpm_runtime')}
        self.environment = {'POINTERCAD_PERF_STRICT': '1', 'LOCALAPPDATA': str(self.root / 'config')}
        self.patch(patch.dict(os.environ, self.environment, clear=True))
        self.patch(patch.object(vr.sys, 'executable', str(executable)))
        self.patch(patch.object(Path, 'home', return_value=self.root / 'home'))
        self.patch(patch.object(vr, 'storage', return_value=self.records))
        self.patch(patch.object(vr, 'git', side_effect=self.git_read))
        self.patch(patch.object(vr, 'browser_roots', return_value=[self.root / 'browser']))
        self.patch(patch.object(vr.platform, 'platform', return_value='fixture-os'))
        self.patch(patch.object(vr.platform, 'machine', return_value='fixture-architecture'))
        self.patch(patch.object(light, 'receipt_module', return_value=vr))
        self.no_process = self.patch(patch.object(vr.subprocess, 'run', side_effect=AssertionError('No process is permitted')))
        self.addCleanup(self.no_process.assert_not_called)

    def patch(self, context):
        value = context.start()
        self.addCleanup(context.stop)
        return value

    def git_read(self, root, *args):
        if args == ('rev-parse', 'HEAD'):
            return self.head.encode()
        if args == ('rev-parse', 'HEAD^{tree}') or args == ('write-tree',):
            return self.tree.encode()
        if args == ('ls-files', '--stage', '-z'):
            return ('100644 ' + 'd' * 40 + ' 0\ta.txt\0').encode()
        if args == ('ls-files', '-v', '-z'):
            return b'H a.txt\0'
        if args in (('diff', '--name-only', '-z'), ('ls-files', '--others', '--exclude-standard', '-z')):
            return b''
        if args == ('rev-list', '--parents', '-n', '1', 'HEAD'):
            return (self.head + (' ' + self.parent if self.parent else '')).encode()
        raise AssertionError(('Unexpected Git boundary', args))

    def action(self, kind, action, phase='Manual', token='', base=None):
        if kind == 'full':
            return vr.run(action, self.root, self.tools, phase, token)
        return light.run_light_receipt(action, self.root, self.tools, phase, token, self.base if base is None else base)

    def receipt_path(self, kind):
        return self.records / ('validation-receipt.json' if kind == 'full' else light.LIGHT_RECEIPT)

    def complete(self, kind):
        start = self.action(kind, 'start')
        self.assertTrue(self.action(kind, 'finish', token=start['token'])['ok'])
        return self.receipt_path(kind)

    def read(self, kind):
        key = (self.records / 'validation-receipt.key').read_bytes()
        return vr.read_record(self.receipt_path(kind), key)

    def reseal(self, kind, value):
        vr.write_record(self.receipt_path(kind), value, (self.records / 'validation-receipt.key').read_bytes())

    def test_same_environment_commit_then_push_once(self):
        for kind in ('full', 'light'):
            with self.subTest(kind=kind):
                self.head, self.parent = self.base, ''
                self.complete(kind)
                self.assertIn('environmentKeys', self.read(kind))
                self.assertTrue(self.action(kind, 'reuse', 'Commit')['used'])
                self.parent, self.head = self.head, 'c' * 40
                self.assertTrue(self.action(kind, 'reuse', 'Push')['used'])
                with self.assertRaises(FileNotFoundError):
                    self.action(kind, 'reuse', 'Push')

    def test_changed_added_removed_key_names_without_secret_values(self):
        secret, other = 'synthetic-private-value-12345', 'synthetic-private-value-67890'
        for kind in ('full', 'light'):
            for before, after in ((secret, other), (None, secret), (secret, None)):
                with self.subTest(kind=kind, transition=(before is None, after is None)):
                    os.environ.pop('PCAD_TEST_TOKEN', None)
                    if before is not None:
                        os.environ['PCAD_TEST_TOKEN'] = before
                    path = self.complete(kind)
                    raw = path.read_text(encoding='utf-8')
                    self.assertNotIn(secret, raw)
                    self.assertNotIn(other, raw)
                    if before is not None:
                        self.assertEqual(self.read(kind)['environmentKeys']['PCAD_TEST_TOKEN'], vr.digest(before))
                    os.environ.pop('PCAD_TEST_TOKEN', None)
                    if after is not None:
                        os.environ['PCAD_TEST_TOKEN'] = after
                    with self.assertRaisesRegex(ValueError, 'changed: environment.*PCAD_TEST_TOKEN') as caught:
                        self.action(kind, 'reuse', 'Commit')
                    for value in (secret, other, vr.digest(secret), vr.digest(other)):
                        self.assertNotIn(value, str(caught.exception))
                    self.assertFalse(path.exists())

    def test_excluded_perf_flag_one_empty_absent_does_not_change_state_or_reuse(self):
        expected = vr.capture(self.root, self.tools)
        for kind in ('full', 'light'):
            for flag in ('1', '', None):
                with self.subTest(kind=kind, flag=flag):
                    os.environ['POINTERCAD_PERF_STRICT'] = '1'
                    self.complete(kind)
                    self.assertNotIn('POINTERCAD_PERF_STRICT', self.read(kind)['environmentKeys'])
                    if flag is None:
                        os.environ.pop('POINTERCAD_PERF_STRICT')
                    else:
                        os.environ['POINTERCAD_PERF_STRICT'] = flag
                    self.assertEqual(vr.capture(self.root, self.tools), expected)
                    self.assertTrue(self.action(kind, 'reuse', 'Commit')['used'])

    def test_legacy_records_match_strictly_and_reject_mismatch(self):
        for kind in ('full', 'light'):
            for changed in (False, True):
                with self.subTest(kind=kind, changed=changed):
                    os.environ.pop('NODE_OPTIONS', None)
                    self.complete(kind)
                    legacy = self.read(kind)
                    del legacy['environmentKeys']
                    self.reseal(kind, legacy)
                    if changed:
                        os.environ['NODE_OPTIONS'] = 'synthetic-private-change'
                        with self.assertRaisesRegex(ValueError, 'changed: environment.*unavailable'):
                            self.action(kind, 'reuse', 'Commit')
                        self.assertFalse(self.receipt_path(kind).exists())
                    else:
                        self.assertTrue(self.action(kind, 'reuse', 'Commit')['used'])

    def test_tampered_metadata_fails_seal_before_capture(self):
        for kind in ('full', 'light'):
            with self.subTest(kind=kind):
                path = self.complete(kind)
                raw = json.loads(path.read_text(encoding='utf-8'))
                raw['payload']['environmentKeys']['NODE_OPTIONS'] = '0' * 64
                path.write_text(json.dumps(raw), encoding='utf-8')
                with patch.object(vr, 'capture', side_effect=AssertionError('Tampered record reached capture')):
                    with self.assertRaisesRegex(ValueError, 'Receipt was modified'):
                        self.action(kind, 'reuse', 'Commit')
                self.assertFalse(path.exists())

    def test_change_during_check_refuses_finish_with_key_name(self):
        for kind in ('full', 'light'):
            with self.subTest(kind=kind):
                os.environ.pop('VITE_PRIVATE_TEST', None)
                start = self.action(kind, 'start')
                os.environ['VITE_PRIVATE_TEST'] = 'synthetic-hidden-value'
                with self.assertRaisesRegex(ValueError, 'changed: environment.*VITE_PRIVATE_TEST') as caught:
                    self.action(kind, 'finish', token=start['token'])
                self.assertNotIn('synthetic-hidden-value', str(caught.exception))
                self.assertFalse(self.receipt_path(kind).exists())

    def test_other_environment_input_does_not_accuse_unchanged_keys(self):
        for kind in ('full', 'light'):
            with self.subTest(kind=kind):
                path = self.root / '.env.local'
                path.write_text('synthetic-before', encoding='utf-8')
                self.complete(kind)
                path.write_text('synthetic-after', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'other environment inputs changed') as caught:
                    self.action(kind, 'reuse', 'Commit')
                self.assertNotIn('synthetic-after', str(caught.exception))

    def test_strict_failure_conditions_remain_fail_closed(self):
        for kind in ('full', 'light'):
            for failure in ('expiry', 'used', 'source', 'unknown-field'):
                with self.subTest(kind=kind, failure=failure):
                    self.complete(kind)
                    record = self.read(kind)
                    if failure == 'expiry':
                        record['at'] -= 1201
                        record['monotonic'] -= 1201
                        self.reseal(kind, record)
                    elif failure == 'used':
                        self.assertTrue(self.action(kind, 'reuse', 'Commit')['used'])
                    elif failure == 'source':
                        self.source.write_text(str(time.monotonic()), encoding='utf-8')
                    else:
                        record['unknown-field'] = 'unexpected'
                        self.reseal(kind, record)
                    with self.assertRaises(ValueError):
                        self.action(kind, 'reuse', 'Commit')
                    self.assertFalse(self.receipt_path(kind).exists())
        self.complete('light')
        with self.assertRaisesRegex(ValueError, 'different range'):
            self.action('light', 'reuse', 'Push', base='f' * 40)

    def test_malformed_sealed_diagnostics_are_rejected(self):
        for kind in ('full', 'light'):
            with self.subTest(kind=kind):
                self.complete(kind)
                record = self.read(kind)
                record['environmentKeys'] = {'NODE_OPTIONS': 'synthetic-private-raw-value'}
                self.reseal(kind, record)
                with self.assertRaisesRegex(ValueError, 'Invalid environment key diagnostics') as caught:
                    self.action(kind, 'reuse', 'Commit')
                self.assertNotIn('synthetic-private-raw-value', str(caught.exception))

    def test_direct_eligibility_api_keeps_time_repeat_parent_and_unknown_field_checks(self):
        self.complete('full')
        record = self.read('full')
        state = vr.capture(self.root, self.tools)
        self.assertTrue(vr.eligible(record, state, 'Commit', '', record['at'], record['monotonic'], 1))
        for age, uptime in ((1201, 1201), (-1, -1), (10, -10)):
            self.assertFalse(vr.eligible(record, state, 'Commit', '', record['at'] + age, record['monotonic'] + uptime, 1))
        self.assertFalse(vr.eligible(record, state, 'Commit', '', record['at'], record['monotonic'], 2))
        self.assertFalse(vr.eligible(dict(record, unknown=1), state, 'Commit', '', record['at'], record['monotonic'], 1))
        changed = dict(state, head='different-head')
        self.assertFalse(vr.eligible(dict(record, phase='commit'), changed, 'Push', 'wrong-parent', record['at'], record['monotonic'], 1))

    def test_valid_record_still_captures_all_inputs_and_rejects_scan_replacement(self):
        original_capture = vr.capture
        for kind in ('full', 'light'):
            with self.subTest(kind=kind, mutation='none'):
                self.complete(kind)
                with patch.object(vr, 'capture', wraps=original_capture) as capture:
                    self.assertTrue(self.action(kind, 'reuse', 'Commit')['used'])
                    capture.assert_called_once()
                    self.assertEqual(capture.call_args.args[:2], (self.root, self.tools))
                    self.assertEqual(capture.call_args.args[2], {})
            for mutation in ('modified', 'replaced', 'removed'):
                with self.subTest(kind=kind, mutation=mutation):
                    path = self.complete(kind)
                    def capture_then_change(root, tools, environment_keys=None):
                        state = original_capture(root, tools, environment_keys)
                        if mutation == 'removed':
                            path.unlink()
                        else:
                            raw = json.loads(path.read_text(encoding='utf-8'))
                            raw['payload']['token'] = 'replacement-token'
                            if mutation == 'replaced':
                                self.reseal(kind, raw['payload'])
                            else:
                                path.write_text(json.dumps(raw), encoding='utf-8')
                        return state
                    with patch.object(vr, 'capture', side_effect=capture_then_change):
                        with self.assertRaises((OSError, ValueError)):
                            self.action(kind, 'reuse', 'Commit')
                    self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
