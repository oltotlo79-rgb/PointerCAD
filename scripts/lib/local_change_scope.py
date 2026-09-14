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
WORKSPACE_FOLDERS = {
    **{name: 'packages/' + name for name in PACKAGE_NAMES - {'desktop'}},
    'desktop': 'apps/desktop', 'web': 'apps/web',
}
GATE_FILES = {
    'scripts/check.ps1', 'scripts/check.selftest.ps1', 'scripts/hooks/pre-commit', 'scripts/hooks/pre-push',
    'scripts/lib/local_change_scope.py', 'scripts/local-change-scope.selftest.py',
    'scripts/lib/gitTreeGuard.ps1',
    'scripts/check-commit-batch.selftest.ps1', 'scripts/git-selftest-environment.selftest.py',
    'scripts/hooks/commit-msg', 'scripts/lib/commit_message.py', 'scripts/commit-message.selftest.py',
    'scripts/validation-receipt.integration.selftest.py',
    'scripts/lib/task_workspace.py', 'scripts/task-workspace.selftest.py',
}
NOTICE_BUILD_FILES = {'scripts/vite/mathNotices.mjs', 'scripts/vite/mathNotices.d.mts',
                      'scripts/vite/mathDependencyInventory.mjs', 'scripts/vite/mathDependencyInventory.d.mts'}


def full(reason):
    return {'mode': 'full', 'reason': reason, 'packages': []}


def attribute_rules(content):
    return [line.strip() for line in content.decode('utf-8-sig').splitlines()
            if line.strip() and not line.lstrip().startswith('#')]


def runtime_package(path):
    match = re.fullmatch(r'(packages|apps)/([^/]+)/src/[^\x00-\x1f]+\.(ts|tsx|css|json|svg)', path)
    if match and not re.search(r'\.test\.tsx?$', path) and WORKSPACE_FOLDERS.get(match[2]) == match[1] + '/' + match[2]:
        return match[2]
    return None


def workspace_dependencies(git):
    """Read the actual checked index, never a partly edited dependency table."""
    expected = {folder + '/package.json': name for name, folder in WORKSPACE_FOLDERS.items()}
    entries = git('ls-files', '--stage', '-z', '--', 'packages/*/package.json', 'apps/*/package.json')
    actual = {}
    for line in entries.decode('utf8').split('\0'):
        if not line:
            continue
        metadata, path = line.split('\t', 1)
        mode, _, stage = metadata.split()
        if mode not in {'100644', '100755'} or stage != '0' or path in actual:
            raise ValueError('Workspace manifest is not one regular checked file')
        actual[path] = mode
    if set(actual) != set(expected):
        raise ValueError('The complete known workspace could not be established')
    graph = {}
    for path, name in expected.items():
        document = json.loads(git('show', ':' + path))
        if not isinstance(document, dict) or document.get('name') != '@pointercad/' + name:
            raise ValueError('Unexpected workspace identity')
        scripts = document.get('scripts', {})
        if not isinstance(scripts, dict):
            raise ValueError('Invalid workspace scripts')
        if name in PACKAGE_NAMES and (not isinstance(scripts.get('test'), str) or not scripts['test'].strip()):
            raise ValueError('A required whole-package test command is missing')
        if name == 'web' and scripts.get('test'):
            raise ValueError('A new Web test command needs an explicit gate mapping')
        dependencies = set()
        for field in ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']:
            mapping = document.get(field, {})
            if not isinstance(mapping, dict):
                raise ValueError('Invalid dependency table')
            for dependency, version in mapping.items():
                if not isinstance(version, str):
                    raise ValueError('Invalid dependency version')
                if dependency.startswith('@pointercad/'):
                    target = dependency.removeprefix('@pointercad/')
                    if target not in WORKSPACE_FOLDERS or version != 'workspace:*':
                        raise ValueError('Unresolved internal dependency')
                    dependencies.add(target)
                elif version.startswith(('workspace:', 'file:', 'link:')):
                    raise ValueError('An unmodelled local dependency can affect other packages')
        graph[name] = dependencies
    return graph


def dependent_packages(changed, graph):
    selected = set(changed)
    while True:
        consumers = {name for name, dependencies in graph.items() if dependencies & selected}
        added = consumers - selected
        if not added:
            return selected
        selected.update(added)


def has_linked_parent(root, name):
    current = root / name
    while current != root:
        if current.parent == current:
            return True
        try:
            info = current.lstat()
        except FileNotFoundError:
            current = current.parent
            continue
        if current.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            return True
        current = current.parent
    return False


def classify(paths, before_attributes=b'', after_attributes=b'', runtime_graph=None):
    if not paths:
        return full('No bounded change set was found')
    packages = set()
    areas = set()
    runtime = set()
    for path in paths:
        if path == '.gitattributes':
            permitted = {'docs/standards/licenses/*.txt -text', 'scripts/hooks/commit-msg text eol=lf'}
            before = attribute_rules(before_attributes)
            after = attribute_rules(after_attributes)
            if [line for line in before if line not in permitted] != [line for line in after if line not in permitted]:
                return full('Attributes outside the notice originals or commit-message hook changed')
            packages.add('desktop')
            areas.add('notices')
        elif path in GATE_FILES:
            packages.update(['desktop', 'test-utils'])
            areas.add('quality-gate')
        elif path == 'packages/expression/vitest.config.ts':
            packages.update(['expression', 'test-utils'])
            areas.add('expression-test-configuration')
        elif path in NOTICE_BUILD_FILES or re.fullmatch(r'docs/standards/licenses/[a-z0-9.-]+\.(txt|json)', path):
            packages.add('desktop')
            areas.add('notices')
        elif path in {'README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/progress.json'} or re.fullmatch(r'(docs|rules)/[^\x00-\x1f]+\.md', path):
            packages.update(['help-content', 'test-utils'])
            areas.add('documentation')
        elif re.fullmatch(r'packages/help-content/docs/[^\x00-\x1f]+\.md', path):
            packages.add('help-content')
            areas.add('help-content')
        elif runtime_package(path) is not None:
            if runtime_graph is None:
                return full('Runtime dependency coverage is unavailable: ' + path)
            runtime.add(runtime_package(path))
            areas.add('runtime-and-dependents')
        else:
            match = re.fullmatch(r'(?:packages/([^/]+)|apps/(desktop))/src/[^\x00-\x1f]+\.test\.tsx?', path)
            package = (match[1] or match[2]) if match else None
            if package not in PACKAGE_NAMES:
                return full('Runtime, dependencies, configuration, E2E or unknown impact: ' + path)
            packages.add(package)
            areas.add('unit-tests')
    if runtime:
        packages.update(dependent_packages(runtime, runtime_graph) & PACKAGE_NAMES)
        packages.add('test-utils')
        # Keep mathematics early, as in the complete gate. No package is run twice.
        ordered = sorted(packages, key=lambda name: (name != 'expression', name))
        return {'mode': 'targeted', 'reason': ', '.join(sorted(areas)), 'packages': ordered,
                'runtimeChecks': True, 'changedPackages': sorted(runtime)}
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
    for line in git('--literal-pathspecs', 'ls-tree', '-r', '-z', base, '--', *names).decode('utf8').split('\0'):
        if not line:
            continue
        metadata, name = line.split('\t', 1)
        if name in names and metadata.split()[0] not in {'100644', '100755'}:
            return full('Removing or replacing a link or submodule requires full validation')
    if any(has_linked_parent(root, name) for name in names):
        return full('Changed filesystem links require full validation')
    before = after = b''
    if '.gitattributes' in names:
        before = git('show', base + ':.gitattributes')
        after = git('show', ':.gitattributes') if level == 'Commit' else (root / '.gitattributes').read_bytes()
    graph = None
    if any(runtime_package(name) is not None for name in names):
        try:
            graph = workspace_dependencies(git)
        except (OSError, ValueError, subprocess.SubprocessError):
            return full('The checked workspace dependency coverage could not be established')
    result = classify(names, before, after, graph)
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
