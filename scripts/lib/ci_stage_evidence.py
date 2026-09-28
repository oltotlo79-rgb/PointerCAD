"""CI の段の記録と照合(2026-09-28、レビュー docs/review-2026-09-28-codex.md §6.3)。

CI は1つの OS の検査を、前段(自己試験・型・lint・単体の残り・ビルド)、単体の先行分、画面検査の3組へ
分けて別々の実行機で同時に流す。各段は成功したときだけ、この処理で「同じ版・同じ依存・同じ道具で
どの手順を通したか」を記録する。集約(ci.yml の checks)はこの処理の verify で、両 OS の全段の記録が
そろい、全てが同じ版(HEAD と木)・同じ lock・OS ごとに同じ node/pnpm で成功したことを確かめる。

検査の命令そのものは scripts/check.ps1 だけが実行する(rules/03 §7.2 の単一正本)。ここは記録と照合と、
ルートの package.json の test を先行分と残りへ分ける読み取り(unit-split)だけを行う。分け方は test の
「A && B」をそのまま2つにするだけで、2つをつなぐと元の test と文字列で一致することを確かめる。

使い方:
  ci_stage_evidence.py unit-split --root <根>
  ci_stage_evidence.py write --root <根> --dir <記録先> --stage Front|UnitLead|E2E [--shard k/3]
                             --node <node --version> --pnpm <pnpm --version> --step <手順> ...
  ci_stage_evidence.py verify --root <根> --dir <記録先>
  ci_stage_evidence.py selftest
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Mapping

SCHEMA = 'pointercad-ci-stage/1'
# 要件 §1.5: デスクトップ版の対応 OS。どちらかの記録が欠けたら合格にしない。
OPERATING_SYSTEMS = ('Windows', 'Linux')
SHARD_TOTAL = 3
STAGES = ('Front', 'UnitLead', 'E2E')
RECORD_KEYS = {'schema', 'stage', 'shard', 'os', 'head', 'tree', 'lockfileSha256', 'node', 'pnpm',
               'steps', 'unitCommand', 'run', 'image', 'result'}
TOKEN = re.compile(r'[A-Za-z0-9@/!=._-]+')
PACKAGE = re.compile(r'@pointercad/[a-z][a-z0-9-]*')
NODE_VERSION = re.compile(r'v\d+\.\d+\.\d+')
PNPM_VERSION = re.compile(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?')
FULL_SHA = re.compile(r'[0-9a-f]{40}')
DIGITS = re.compile(r'[1-9][0-9]*')


class EvidenceError(Exception):
    """記録を書かない・合格にしない理由。"""


def unit_split(root: Path) -> dict:
    """ルートの test「pnpm --filter X run test && pnpm --recursive --filter !X ... run test」を2つに分ける。"""
    try:
        package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
        script = package['scripts']['test']
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise EvidenceError(f'ルートの package.json の test を読めません: {error}') from error
    if not isinstance(script, str):
        raise EvidenceError('ルートの test が文字列ではありません')
    parts = script.split(' && ')
    if len(parts) != 2:
        raise EvidenceError('ルートの test が「先行分 && 残り」の2つの形ではないため、分けずに止めます')
    lead, rest = (part.split(' ') for part in parts)
    for token in lead + rest:
        if not TOKEN.fullmatch(token):
            raise EvidenceError(f'ルートの test に分けられない文字があります: {token!r}')
    if len(lead) != 5 or lead[0] != 'pnpm' or lead[1] != '--filter' or lead[3:] != ['run', 'test'] \
            or not PACKAGE.fullmatch(lead[2]):
        raise EvidenceError('ルートの test の先行分が「pnpm --filter <1つの包> run test」ではありません')
    package_name = lead[2]
    if rest[0] != 'pnpm' or rest[-2:] != ['run', 'test'] or '--recursive' not in rest:
        raise EvidenceError('ルートの test の残りが「pnpm --recursive ... run test」ではありません')
    filters = [index for index, token in enumerate(rest) if token == '--filter' or token.startswith('--filter=')]
    # 残りは先行分の包だけを除いた全部でなければならない(別の絞込みがあれば検査が欠ける)。
    if len(filters) != 1 or rest[filters[0]] != '--filter' or filters[0] + 1 >= len(rest) \
            or rest[filters[0] + 1] != '!' + package_name:
        raise EvidenceError('ルートの test の残りが、先行分の包だけを除く1つの絞込みになっていません')
    if 'run' in rest[:-2] or 'test' in rest[:-2]:
        raise EvidenceError('ルートの test の残りに余分な命令があります')
    if ' '.join(lead) + ' && ' + ' '.join(rest) != script:
        raise EvidenceError('分けた2つをつないでもルートの test と一致しません')
    return {'package': package_name, 'lead': lead[1:], 'rest': rest[1:],
            'leadCommand': ' '.join(lead), 'restCommand': ' '.join(rest)}


def expected_steps(stage: str, root: Path) -> list[str]:
    if stage == 'Front':
        return ['selftest', 'typecheck', 'lint', 'unit-rest', 'build']
    if stage == 'UnitLead':
        return ['unit-lead']
    if stage == 'E2E':
        steps = ['browsers']
        if (root / 'apps/desktop/package.json').is_file():
            steps.append('electron')
        return steps + ['e2e']
    raise EvidenceError(f'未知の段です: {stage}')


def record_name(os_name: str, stage: str, shard: str | None) -> str:
    if stage == 'Front':
        key = 'front'
    elif stage == 'UnitLead':
        key = 'unit-lead'
    else:
        key = 'e2e-' + str(shard).replace('/', 'of')
    return f'{os_name.lower()}-{key}.json'


def expected_record_names() -> dict[str, tuple[str, str, str | None]]:
    names = {}
    for os_name in OPERATING_SYSTEMS:
        for stage in STAGES:
            shards = [f'{index}/{SHARD_TOTAL}' for index in range(1, SHARD_TOTAL + 1)] if stage == 'E2E' else [None]
            for shard in shards:
                names[record_name(os_name, stage, shard)] = (os_name, stage, shard)
    return names


def _git(root: Path, *args: str) -> str:
    # 呼出元(フック等)の GIT_* を持ち込まず、この根だけを読む。
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
    result = subprocess.run(['git', '--no-optional-locks', '-C', str(root), *args], env=environment,
                            capture_output=True, check=False)
    if result.returncode != 0:
        raise EvidenceError(f'git {" ".join(args)} に失敗しました: {result.stderr.decode("utf-8", "replace").strip()}')
    return result.stdout.decode('utf-8', 'replace')


def current_content(root: Path) -> dict:
    head = _git(root, 'rev-parse', '--verify', 'HEAD').strip()
    tree = _git(root, 'rev-parse', '--verify', 'HEAD^{tree}').strip()
    lockfile = root / 'pnpm-lock.yaml'
    if not lockfile.is_file():
        raise EvidenceError('pnpm-lock.yaml がありません')
    return {'head': head, 'tree': tree, 'lockfileSha256': hashlib.sha256(lockfile.read_bytes()).hexdigest()}


def _platform_os() -> str | None:
    if os.name == 'nt':
        return 'Windows'
    if sys.platform.startswith('linux'):
        return 'Linux'
    return None


def _run_identity(env: Mapping[str, str]) -> dict:
    run = {'id': env.get('GITHUB_RUN_ID', ''), 'attempt': env.get('GITHUB_RUN_ATTEMPT', ''),
           'sha': env.get('GITHUB_SHA', '')}
    if not DIGITS.fullmatch(run['id']) or not DIGITS.fullmatch(run['attempt']) or not FULL_SHA.fullmatch(run['sha']):
        raise EvidenceError('GitHub Actions の実行番号・試行番号・版(GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT/GITHUB_SHA)がありません')
    return run


def write(root: Path, directory: Path, stage: str, shard: str | None, node: str, pnpm: str,
          steps: list[str], env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    if env.get('CI') != 'true':
        raise EvidenceError('段の記録は CI でだけ書きます')
    os_name = env.get('RUNNER_OS', '')
    if os_name not in OPERATING_SYSTEMS or os_name != _platform_os():
        raise EvidenceError(f'実行機の OS({os_name!r})が対象の OS と一致しません')
    if stage not in STAGES:
        raise EvidenceError(f'未知の段です: {stage}')
    valid_shards = {f'{index}/{SHARD_TOTAL}' for index in range(1, SHARD_TOTAL + 1)}
    if (stage == 'E2E') != (shard is not None) or (shard is not None and shard not in valid_shards):
        raise EvidenceError(f'段 {stage} の組の指定が正しくありません: {shard!r}')
    if steps != expected_steps(stage, root):
        raise EvidenceError(f'段 {stage} で通した手順 {steps} が必要な手順 {expected_steps(stage, root)} と一致しません')
    if not NODE_VERSION.fullmatch(node) or not PNPM_VERSION.fullmatch(pnpm):
        raise EvidenceError(f'node({node!r})または pnpm({pnpm!r})の版を読めません')
    run = _run_identity(env)
    content = current_content(root)
    if content['head'] != run['sha']:
        raise EvidenceError('検査した HEAD が GitHub の対象の版(GITHUB_SHA)と一致しません')
    if _git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=no') != '':
        raise EvidenceError('追跡中のファイルが HEAD と違うため、この版の記録として書きません')
    split = unit_split(root) if stage != 'E2E' else None
    record = {
        'schema': SCHEMA, 'stage': stage, 'shard': shard, 'os': os_name, **content, 'node': node, 'pnpm': pnpm,
        'steps': steps,
        'unitCommand': None if split is None else split['restCommand' if stage == 'Front' else 'leadCommand'],
        'run': run, 'image': {'os': env.get('ImageOS', ''), 'version': env.get('ImageVersion', '')},
        'result': 'success',
    }
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / record_name(os_name, stage, shard)
    try:
        with target.open('x', encoding='utf-8', newline='\n') as output:
            json.dump(record, output, ensure_ascii=False, indent=1, sort_keys=True)
            output.write('\n')
    except FileExistsError as error:
        raise EvidenceError(f'同じ段の記録が既にあります: {target.name}') from error
    return target


def verify(root: Path, directory: Path, env: Mapping[str, str] | None = None) -> dict:
    env = os.environ if env is None else env
    if env.get('CI') != 'true':
        raise EvidenceError('段の記録の照合は CI の集約でだけ行います')
    run_id, run_sha = env.get('GITHUB_RUN_ID', ''), env.get('GITHUB_SHA', '')
    if not DIGITS.fullmatch(run_id) or not FULL_SHA.fullmatch(run_sha):
        raise EvidenceError('GitHub Actions の実行番号と版(GITHUB_RUN_ID/GITHUB_SHA)がありません')
    content = current_content(root)
    if content['head'] != run_sha:
        raise EvidenceError('照合する版(HEAD)が GitHub の対象の版と一致しません')
    split = unit_split(root)
    if not directory.is_dir():
        raise EvidenceError(f'段の記録のフォルダーがありません: {directory}')
    expected = expected_record_names()
    present = {}
    for entry in directory.iterdir():
        if entry.is_symlink() or not entry.is_file() or entry.name not in expected:
            raise EvidenceError(f'段の記録ではないものがあります: {entry.name}')
        present[entry.name] = entry
    missing = sorted(set(expected) - set(present))
    if missing:
        raise EvidenceError('段の記録が足りません(その段は成功していないか、実行されていません): ' + ', '.join(missing))
    tools: dict[str, set[tuple[str, str]]] = {os_name: set() for os_name in OPERATING_SYSTEMS}
    for name, (os_name, stage, shard) in sorted(expected.items()):
        try:
            record = json.loads(present[name].read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            raise EvidenceError(f'{name} を読めません: {error}') from error
        if not isinstance(record, dict) or set(record) != RECORD_KEYS or record.get('schema') != SCHEMA:
            raise EvidenceError(f'{name} の形が段の記録と違います')
        if (record['os'], record['stage'], record['shard']) != (os_name, stage, shard):
            raise EvidenceError(f'{name} の OS・段・組が名前と一致しません')
        if record['result'] != 'success':
            raise EvidenceError(f'{name} が成功の記録ではありません')
        for key in ('head', 'tree', 'lockfileSha256'):
            if record[key] != content[key]:
                raise EvidenceError(f'{name} の {key} が照合する版と一致しません(別の内容を検査した記録です)')
        run = record['run']
        if not isinstance(run, dict) or set(run) != {'id', 'attempt', 'sha'} or run['id'] != run_id \
                or run['sha'] != run_sha or not DIGITS.fullmatch(str(run['attempt'])):
            raise EvidenceError(f'{name} が同じ CI の実行の記録ではありません')
        if record['steps'] != expected_steps(stage, root):
            raise EvidenceError(f'{name} で通した手順が足りないか違います: {record["steps"]}')
        wanted_unit = {'Front': split['restCommand'], 'UnitLead': split['leadCommand'], 'E2E': None}[stage]
        if record['unitCommand'] != wanted_unit:
            raise EvidenceError(f'{name} の単体の命令が、今のルートの test から分けたものと一致しません')
        if not isinstance(record['node'], str) or not NODE_VERSION.fullmatch(record['node']) \
                or not isinstance(record['pnpm'], str) or not PNPM_VERSION.fullmatch(record['pnpm']):
            raise EvidenceError(f'{name} の node・pnpm の版を読めません')
        tools[os_name].add((record['node'], record['pnpm']))
    for os_name, seen in tools.items():
        if len(seen) != 1:
            raise EvidenceError(f'{os_name} の段の間で node・pnpm の版が違います: {sorted(seen)}')
    return {'ok': True, 'head': content['head'], 'tree': content['tree'],
            'records': len(expected), 'tools': {os_name: sorted(seen)[0] for os_name, seen in tools.items()}}


# ---- 自己試験(check.selftest.ps1 から実行する。scratchpad の既存の中身は使わない) ----

def _selftest() -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from task_workspace import configure_project_temp
    configure_project_temp(Path(__file__).resolve().parents[2])
    failures: list[str] = []
    folder_numbers = itertools.count(1)

    def expect_error(label: str, action, fragment: str) -> None:
        try:
            action()
        except EvidenceError as error:
            if fragment not in str(error):
                failures.append(f'{label}: 理由が違います: {error}')
            else:
                print(f'[OK] {label}')
            return
        failures.append(f'{label}: 拒否されませんでした')

    def expect_ok(label: str, action):
        try:
            value = action()
        except EvidenceError as error:
            failures.append(f'{label}: {error}')
            return None
        print(f'[OK] {label}')
        return value

    test_script = ('pnpm --filter @pointercad/expression run test && pnpm --recursive --filter '
                   '!@pointercad/expression --reverse --workspace-concurrency=1 --if-present run test')
    with tempfile.TemporaryDirectory(prefix='pointercad-ci-stage-') as temporary:
        base = Path(temporary)
        root = base / 'repository'
        (root / 'apps/desktop').mkdir(parents=True)
        (root / 'package.json').write_text(json.dumps({'scripts': {'test': test_script}}), encoding='utf-8')
        (root / 'pnpm-lock.yaml').write_text('lockfileVersion: fixture\n', encoding='utf-8')
        (root / 'apps/desktop/package.json').write_text('{"name":"@pointercad/desktop"}', encoding='utf-8')
        _git(root, 'init', '--quiet')
        _git(root, 'config', 'user.name', 'CI stage self-test')
        _git(root, 'config', 'user.email', 'ci-stage@example.invalid')
        _git(root, 'config', 'core.autocrlf', 'false')
        _git(root, 'add', '.')
        _git(root, 'commit', '--quiet', '-m', 'fixture')
        head = _git(root, 'rev-parse', 'HEAD').strip()
        this_os = _platform_os()
        if this_os is None:
            print('[NG] 対象外の OS では自己試験できません')
            return 1
        other_os = 'Linux' if this_os == 'Windows' else 'Windows'
        env = {'CI': 'true', 'RUNNER_OS': this_os, 'GITHUB_RUN_ID': '4242', 'GITHUB_RUN_ATTEMPT': '1',
               'GITHUB_SHA': head, 'ImageOS': 'fixture', 'ImageVersion': '1'}

        split = expect_ok('ルートの test を先行分と残りへ分け、つなぐと元と一致する', lambda: unit_split(root))
        if split is not None and (split['leadCommand'] + ' && ' + split['restCommand'] != test_script
                                  or split['lead'] != ['--filter', '@pointercad/expression', 'run', 'test']):
            failures.append('分けた結果が元の test と一致しません')
        for label, script in [
            ('3つ以上に分かれる test', test_script + ' && pnpm run extra'),
            ('残りに別の絞込みがある test', test_script.replace('--reverse', '--filter !@pointercad/kernel --reverse')),
            ('残りが先行分と違う包を除く test', test_script.replace('!@pointercad/expression', '!@pointercad/kernel')),
            ('引用符を含む test', test_script.replace('--reverse', '"--reverse"')),
            ('先行分が複数の包を選ぶ test', test_script.replace('run test &&', '--filter @pointercad/kernel run test &&', 1)),
            ('残りが再帰でない test', test_script.replace('--recursive ', '')),
        ]:
            broken = base / f'split-{next(folder_numbers)}'
            broken.mkdir()
            (broken / 'package.json').write_text(json.dumps({'scripts': {'test': script}}), encoding='utf-8')
            expect_error(f'分けられない形を拒否する: {label}', lambda folder=broken: unit_split(folder), 'ルートの test')

        evidence = base / 'evidence'
        full_steps = {'Front': expected_steps('Front', root), 'UnitLead': ['unit-lead'],
                      'E2E': ['browsers', 'electron', 'e2e']}
        for stage, shard in [('Front', None), ('UnitLead', None), ('E2E', '1/3'), ('E2E', '2/3'), ('E2E', '3/3')]:
            expect_ok(f'{this_os} の {stage} {shard or ""} の記録を書く',
                      lambda s=stage, h=shard: write(root, evidence, s, h, 'v22.0.0', '10.0.0', full_steps[s], env))
        expect_error('同じ段の記録を二重に書かない',
                     lambda: write(root, evidence, 'Front', None, 'v22.0.0', '10.0.0', full_steps['Front'], env), '既にあります')
        for name in list(p.name for p in evidence.iterdir()):
            record = json.loads((evidence / name).read_text(encoding='utf-8'))
            record['os'] = other_os
            (evidence / name.replace(this_os.lower(), other_os.lower(), 1)).write_text(
                json.dumps(record, ensure_ascii=False), encoding='utf-8')
        summary = expect_ok('両 OS の全10段の記録がそろい、同じ版・lock・道具なら合格', lambda: verify(root, evidence, env))
        if summary is not None and summary['records'] != 10:
            failures.append('照合した記録の数が10ではありません')

        def tampered(label: str, change, fragment: str) -> None:
            folder = base / f'tamper-{next(folder_numbers)}'
            shutil.copytree(evidence, folder)
            change(folder)
            expect_error(label, lambda: verify(root, folder, env), fragment)

        def edit(name: str, mutate):
            def apply(folder: Path) -> None:
                path = folder / name
                record = json.loads(path.read_text(encoding='utf-8'))
                mutate(record)
                path.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
            return apply

        mine = this_os.lower()
        tampered('画面検査の1組の記録が無ければ不合格', lambda f: (f / f'{mine}-e2e-2of3.json').unlink(), '足りません')
        tampered('単体の先行分の記録が無ければ不合格', lambda f: (f / f'{other_os.lower()}-unit-lead.json').unlink(), '足りません')
        tampered('記録でないファイルが混ざれば不合格', lambda f: (f / 'extra.json').write_text('{}', encoding='utf-8'), '段の記録ではない')
        tampered('別の木を検査した記録は不合格', edit(f'{mine}-e2e-1of3.json', lambda r: r.update(tree='0' * 40)), 'tree')
        tampered('別の lock で検査した記録は不合格', edit(f'{mine}-front.json', lambda r: r.update(lockfileSha256='1' * 64)), 'lockfileSha256')
        tampered('別の版の記録は不合格', edit(f'{mine}-unit-lead.json', lambda r: r.update(head='2' * 40)), 'head')
        tampered('別の CI 実行の記録は不合格', edit(f'{mine}-front.json', lambda r: r['run'].update(id='4243')), '同じ CI の実行')
        tampered('同じ OS で node の版が違えば不合格', edit(f'{mine}-e2e-3of3.json', lambda r: r.update(node='v22.0.1')), 'node・pnpm の版が違います')
        tampered('前段の手順が欠ければ不合格', edit(f'{mine}-front.json', lambda r: r['steps'].remove('lint')), '手順')
        tampered('画面検査の起動準備が欠ければ不合格', edit(f'{mine}-e2e-1of3.json', lambda r: r['steps'].remove('electron')), '手順')
        tampered('単体の残りの命令が今の test と違えば不合格',
                 edit(f'{mine}-front.json', lambda r: r.update(unitCommand='pnpm --recursive run test')), '単体の命令')
        tampered('成功以外の記録は不合格', edit(f'{mine}-front.json', lambda r: r.update(result='failure')), '成功の記録ではありません')
        tampered('名前と中身の組が違えば不合格', edit(f'{mine}-e2e-1of3.json', lambda r: r.update(shard='2/3')), '名前と一致しません')
        tampered('余分な項目がある記録は不合格', edit(f'{mine}-front.json', lambda r: r.update(extra=True)), '形が段の記録と違います')
        expect_error('CI でない照合は拒否する', lambda: verify(root, evidence, {**env, 'CI': ''}), 'CI の集約')
        expect_error('対象の版と違う HEAD の照合は拒否する', lambda: verify(root, evidence, {**env, 'GITHUB_SHA': '3' * 40}), '一致しません')

        other = base / 'other-evidence'
        expect_error('OS の名前が実行機と違えば書かない',
                     lambda: write(root, other, 'Front', None, 'v22.0.0', '10.0.0', full_steps['Front'], {**env, 'RUNNER_OS': other_os}), 'OS')
        expect_error('CI でなければ書かない',
                     lambda: write(root, other, 'Front', None, 'v22.0.0', '10.0.0', full_steps['Front'], {**env, 'CI': ''}), 'CI')
        expect_error('手順が足りなければ書かない',
                     lambda: write(root, other, 'Front', None, 'v22.0.0', '10.0.0', ['selftest', 'typecheck'], env), '手順')
        expect_error('画面検査の組の指定が無ければ書かない',
                     lambda: write(root, other, 'E2E', None, 'v22.0.0', '10.0.0', full_steps['E2E'], env), '組の指定')
        expect_error('4組目は書かない',
                     lambda: write(root, other, 'E2E', '4/3', 'v22.0.0', '10.0.0', full_steps['E2E'], env), '組の指定')
        expect_error('前段に組を付けたら書かない',
                     lambda: write(root, other, 'Front', '1/3', 'v22.0.0', '10.0.0', full_steps['Front'], env), '組の指定')
        expect_error('対象の版と違う HEAD では書かない',
                     lambda: write(root, other, 'Front', None, 'v22.0.0', '10.0.0', full_steps['Front'], {**env, 'GITHUB_SHA': '4' * 40}), 'GITHUB_SHA')
        (root / 'pnpm-lock.yaml').write_text('lockfileVersion: changed\n', encoding='utf-8')
        expect_error('追跡中のファイルが HEAD と違えば書かない',
                     lambda: write(root, other, 'Front', None, 'v22.0.0', '10.0.0', full_steps['Front'], env), 'HEAD と違う')
        expect_error('lock が変わった後の照合は不合格', lambda: verify(root, evidence, env), 'lockfileSha256')
        if other.exists() and any(other.iterdir()):
            failures.append('拒否した場合でも記録が作られました')
        else:
            print('[OK] 拒否した場合は記録を作らない')

    for failure in failures:
        print(f'[NG] {failure}')
    if failures:
        print(f'[NG] CI の段の記録の自己試験に {len(failures)} 件の失敗があります')
        return 1
    print('[OK] CI の段の記録・照合・単体の分け方の自己試験に全て合格しました')
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='CI の段の記録と照合')
    commands = parser.add_subparsers(dest='command', required=True)
    split_parser = commands.add_parser('unit-split')
    split_parser.add_argument('--root', required=True)
    write_parser = commands.add_parser('write')
    write_parser.add_argument('--root', required=True)
    write_parser.add_argument('--dir', required=True)
    write_parser.add_argument('--stage', required=True, choices=STAGES)
    write_parser.add_argument('--shard')
    write_parser.add_argument('--node', required=True)
    write_parser.add_argument('--pnpm', required=True)
    write_parser.add_argument('--step', action='append', default=[])
    verify_parser = commands.add_parser('verify')
    verify_parser.add_argument('--root', required=True)
    verify_parser.add_argument('--dir', required=True)
    commands.add_parser('selftest')
    arguments = parser.parse_args(argv)
    if arguments.command == 'selftest':
        return _selftest()
    try:
        root = Path(arguments.root).resolve()
        if arguments.command == 'unit-split':
            print(json.dumps(unit_split(root), ensure_ascii=False))
        elif arguments.command == 'write':
            target = write(root, Path(arguments.dir), arguments.stage, arguments.shard, arguments.node.strip(),
                           arguments.pnpm.strip(), arguments.step)
            print(f'[OK] CI の段の記録を書きました: {target.name}')
        else:
            summary = verify(root, Path(arguments.dir))
            print('[OK] 両 OS の全段の記録を照合しました: ' + json.dumps(summary, ensure_ascii=False))
    except EvidenceError as error:
        print(f'[NG] {error}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
