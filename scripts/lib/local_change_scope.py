"""Select local checks from complete Git changes. Unknown impact requires the full gate.

CI and release checks always run the full gate. This never certifies completion.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

PACKAGE_NAMES = {'desktop', 'drawing', 'kernel', 'model', 'io', 'ui', 'test-utils', 'help-content', 'expression'}
GATE_FILES = {
    'scripts/check.ps1', 'scripts/check.selftest.ps1', 'scripts/hooks/pre-commit', 'scripts/hooks/pre-push',
    'scripts/lib/local_change_scope.py', 'scripts/local-change-scope.selftest.py',
    'scripts/lib/gitTreeGuard.ps1',
    'scripts/validation-receipt.integration.selftest.py',
}
NOTICE_BUILD_FILES = {'scripts/vite/mathNotices.mjs', 'scripts/vite/mathNotices.d.mts',
                      'scripts/vite/mathDependencyInventory.mjs', 'scripts/vite/mathDependencyInventory.d.mts'}


def full(reason):
    return {'mode': 'full', 'reason': reason, 'packages': []}


def attribute_rules(content):
    return [line.strip() for line in content.decode('utf-8-sig').splitlines()
            if line.strip() and not line.lstrip().startswith('#')]


def classify(paths, before_attributes=b'', after_attributes=b''):
    if not paths:
        return full('No bounded change set was found')
    packages = set()
    areas = set()
    for path in paths:
        if path == '.gitattributes':
            permitted = 'docs/standards/licenses/*.txt -text'
            before = attribute_rules(before_attributes)
            after = attribute_rules(after_attributes)
            if [line for line in before if line != permitted] != [line for line in after if line != permitted]:
                return full('Attributes outside the notice originals changed')
            packages.add('desktop')
            areas.add('notices')
        elif path in GATE_FILES:
            packages.update(['desktop', 'test-utils'])
            areas.add('quality-gate')
        elif path in NOTICE_BUILD_FILES or re.fullmatch(r'docs/standards/licenses/[a-z0-9.-]+\.(txt|json)', path):
            packages.add('desktop')
            areas.add('notices')
        elif path in {'README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/progress.json'} or re.fullmatch(r'(docs|rules)/[^\x00-\x1f]+\.md', path):
            packages.update(['help-content', 'test-utils'])
            areas.add('documentation')
        elif re.fullmatch(r'packages/help-content/docs/[^\x00-\x1f]+\.md', path):
            packages.add('help-content')
            areas.add('help-content')
        else:
            match = re.fullmatch(r'(?:packages/([^/]+)|apps/(desktop))/src/[^\x00-\x1f]+\.test\.tsx?', path)
            package = (match[1] or match[2]) if match else None
            if package not in PACKAGE_NAMES:
                return full('Runtime, dependencies, configuration, E2E or unknown impact: ' + path)
            packages.add(package)
            areas.add('unit-tests')
    return {'mode': 'targeted', 'reason': ', '.join(sorted(areas)), 'packages': sorted(packages)}


def inspect(root: Path, level: str, phase: str, comparison_base: str, force: bool):
    if force or os.environ.get('CI', '').lower() == 'true':
        return full('CI, release or explicitly requested full validation')
    if phase == 'Disabled':
        return full('The push does not describe one checked HEAD update')

    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=True, timeout=15).stdout

    head = git('rev-parse', '--verify', 'HEAD').decode().strip()
    if level == 'Commit':
        base = head
        paths = git('diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, '--')
    else:
        if phase == 'Push' and git('status', '--porcelain', '-z'):
            return full('A targeted push requires a clean checked HEAD')
        if comparison_base:
            if not re.fullmatch(r'[a-f0-9]{40}', comparison_base) or comparison_base == '0' * 40:
                return full('The actual push comparison base is unavailable')
            base = comparison_base
        elif phase == 'Push':
            return full('The pre-push hook did not supply its actual remote base')
        else:
            base = git('rev-parse', '--verify', 'refs/remotes/origin/main').decode().strip()
        git('merge-base', '--is-ancestor', base, head)
        # Include both index and worktree. Restoring a working file must not hide its staged change.
        paths = git('diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, '--')
        paths += git('diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, '--')
        paths += git('ls-files', '--others', '--exclude-standard', '-z')
    names = sorted(set(paths.decode('utf8').split('\0')) - {''})
    # Links and submodules can point outside the inspected contents.
    for line in git('ls-files', '--stage', '-z').decode('utf8').split('\0'):
        if not line:
            continue
        metadata, name = line.split('\t', 1)
        if name in names and metadata.split()[0] not in {'100644', '100755'}:
            return full('Changed links or submodules require full validation')
    if any((root / name).is_symlink() for name in names):
        return full('Changed filesystem links require full validation')
    before = after = b''
    if '.gitattributes' in names:
        before = git('show', base + ':.gitattributes')
        after = git('show', ':.gitattributes') if level == 'Commit' else (root / '.gitattributes').read_bytes()
    result = classify(names, before, after)
    return {**result, 'base': base, 'head': head, 'paths': names}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--level', choices=['Commit', 'Push'], required=True)
    parser.add_argument('--phase', choices=['Manual', 'Commit', 'Push', 'Disabled'], required=True)
    parser.add_argument('--base', default='')
    parser.add_argument('--full', action='store_true')
    args = parser.parse_args()
    try:
        result = inspect(args.root.resolve(), args.level, args.phase, args.base, args.full)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result = full('Cannot establish a safe local scope: ' + type(error).__name__)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
