"""Select local checks from complete Git changes. Unknown impact requires the full gate.

CI and release checks always run the full gate. This never certifies completion.

--light (2026-09-27 owner decision "leave every browser operation to CI"): a manual
local check keeps types, lint, the selected unit suites, both builds, the gate
self-tests and the three startup projects, and runs only the browser specs that a
changed e2e/tests file can reach through static relative imports. Anything that
cannot be traced returns to every operation or to the full gate. The success of a
light check is recorded separately from B3 (--receipt), so the ordinary commit and
push hooks can accept exactly the checked content without repeating it.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import posixpath
import re
import secrets
import subprocess
import sys
import time

PACKAGE_NAMES = {'web', 'desktop', 'drawing', 'kernel', 'model', 'io', 'ui', 'test-utils', 'help-content', 'expression'}
WORKSPACE_FOLDERS = {
    **{name: 'packages/' + name for name in PACKAGE_NAMES - {'desktop', 'web'}},
    'desktop': 'apps/desktop', 'web': 'apps/web',
}
GATE_FILES = {
    '.github/workflows/ci.yml',
    'scripts/check.ps1', 'scripts/check.selftest.ps1', 'scripts/hooks/pre-commit', 'scripts/hooks/pre-push',
    'scripts/lib/local_change_scope.py', 'scripts/local-change-scope.selftest.py',
    'scripts/lib/gitTreeGuard.ps1',
    'scripts/check-commit-batch.selftest.ps1', 'scripts/git-selftest-environment.selftest.py',
    'scripts/hooks/commit-msg', 'scripts/lib/commit_message.py', 'scripts/commit-message.selftest.py',
    'scripts/validation-receipt.integration.selftest.py',
    'scripts/lib/task_workspace.py', 'scripts/task-workspace.selftest.py',
    'scripts/lib/isolated_checkout_preflight.py', 'scripts/isolated-checkout-preflight.selftest.py',
    'scripts/lib/gitEnvironment.mjs', 'scripts/lib/gitEnvironment.d.mts',
    'scripts/vite/webBuildSources.mjs', 'scripts/vite/webBuildSources.d.mts',
}
NOTICE_BUILD_FILES = {'scripts/vite/mathNotices.mjs', 'scripts/vite/mathNotices.d.mts',
                      'scripts/vite/mathDependencyInventory.mjs', 'scripts/vite/mathDependencyInventory.d.mts'}
# Relative static imports only: from '...', import '...', import('...'), export ... from '...'.
E2E_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}/[^'"\n]+)\1""")
# Names that are safe as Playwright file filters on every shell. Others use every operation.
E2E_SOURCE = re.compile(r'e2e/tests/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.ts')
LIGHT_RECEIPT = 'local-light-receipt.json'
LIGHT_RUNNING = 'local-light-running.json'
LIGHT_KIND = 'local-light'
LIGHT_VERSION = 1
LIGHT_KEYS = {'version', 'kind', 'state', 'at', 'monotonic', 'phase', 'token', 'base'}


def full(reason):
    return {'mode': 'full', 'reason': reason, 'packages': []}


def e2e_imports(importer, text, known):
    """Resolve the relative imports of one e2e/tests file to other known e2e/tests files."""
    folder = posixpath.dirname(importer)
    targets = set()
    for match in E2E_IMPORT.finditer(text):
        target = posixpath.normpath(posixpath.join(folder, match[2].split('?', 1)[0]))
        stem, extension = posixpath.splitext(target)
        if extension in {'.js', '.ts'}:
            candidates = [stem + '.ts', target]
        elif extension == '':
            candidates = [target + '.ts', target + '/index.ts']
        else:
            candidates = [target]
        targets.update(next(([candidate] for candidate in candidates if candidate in known), []))
    return targets


def related_e2e_specs(changed, sources):
    """Specs that are changed or reach a changed e2e/tests file; None when it cannot be traced.

    sources maps every present e2e/tests/**/*.ts file to its checked text. A present
    changed helper that no spec reaches (for example, used only by another tool or via
    an unrecognised import form) cannot be bounded, so it requires every operation.
    A deleted file normally has no present importer (the complete type check also covers
    e2e); if a present spec still reaches it, that spec runs and reports the break.
    Playwright's default test names include *.test.ts, so those count as tests; only
    *.spec.ts names are passed on as filters, anything else keeps every operation.
    """
    if sources is None or any(not E2E_SOURCE.fullmatch(path) for path in changed):
        return None
    known = set(sources)
    # Deleted changed files stay resolvable so a remaining importer is still found.
    graph = {path: e2e_imports(path, text, known | set(changed)) for path, text in sources.items()}
    reach = {}
    for spec in (path for path in sources if path.endswith(('.spec.ts', '.test.ts'))):
        seen, stack = {spec}, [spec]
        while stack:
            for target in graph.get(stack.pop(), ()):
                if target not in seen:
                    seen.add(target)
                    stack.append(target)
        reach[spec] = seen
    related = set()
    for path in changed:
        users = {spec for spec, files in reach.items() if path in files}
        if not users and path in known:
            return None
        related.update(users)
    if any(not E2E_SOURCE.fullmatch(spec) or not spec.endswith('.spec.ts') for spec in related):
        return None
    return sorted(related)


def e2e_sources(root, git):
    """Read every present e2e/tests TypeScript file of the checked working tree."""
    listed = git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'e2e/tests')
    sources = {}
    for name in sorted(set(listed.decode('utf8').split('\0')) - {''}):
        path = root / name
        if name.endswith('.ts') and path.is_file() and not path.is_symlink():
            sources[name] = path.read_bytes().decode('utf-8')
    return sources


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


def classify(paths, before_attributes=b'', after_attributes=b'', runtime_graph=None,
             light=False, e2e_source_texts=None):
    if not paths:
        return full('No bounded change set was found')
    packages = set()
    areas = set()
    runtime = set()
    all_e2e = False
    changed_e2e = []
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
        elif re.fullmatch(r'packages/help-content/docs/ja/images/[^/\x00-\x1f]+\.(png|json)', path):
            packages.add('help-content')
            areas.add('help-images')
        elif re.fullmatch(r'e2e/tests/[^\x00-\x1f]+\.ts', path):
            # Run every operation, including shared helpers and all startup dependencies.
            # This narrows only unrelated unit packages, never the changed E2E coverage.
            packages.add('test-utils')
            if light:
                # The light local check runs the operations that reach this file.
                changed_e2e.append(path)
                areas.add('related-e2e')
            else:
                areas.add('all-e2e')
                all_e2e = True
        elif runtime_package(path) is not None:
            if runtime_graph is None:
                return full('Runtime dependency coverage is unavailable: ' + path)
            runtime.add(runtime_package(path))
            areas.add('runtime-and-dependents')
        else:
            match = re.fullmatch(r'(?:packages/([^/]+)|apps/(desktop|web))/src/[^\x00-\x1f]+\.test\.tsx?', path)
            package = (match[1] or match[2]) if match else None
            if package not in PACKAGE_NAMES:
                return full('Runtime, dependencies, configuration, E2E or unknown impact: ' + path)
            packages.add(package)
            areas.add('unit-tests')
    light_fields = {}
    if light:
        related = related_e2e_specs(changed_e2e, e2e_source_texts) if changed_e2e else []
        if related is None:
            # An untraceable operation change keeps every operation (never fewer).
            all_e2e = True
            related = []
            areas.add('all-e2e')
        # Startup and 50-part rendering are always part of the light local check.
        light_fields = {'light': True, 'runtimeChecks': True, 'e2eSpecs': related}
    if runtime:
        packages.update(dependent_packages(runtime, runtime_graph) & PACKAGE_NAMES)
        packages.add('test-utils')
        # Keep mathematics early, as in the complete gate. No package is run twice.
        ordered = sorted(packages, key=lambda name: (name != 'expression', name))
        return {'mode': 'targeted', 'reason': ', '.join(sorted(areas)), 'packages': ordered,
                'runtimeChecks': True, 'allE2EChecks': all_e2e, 'changedPackages': sorted(runtime),
                **light_fields}
    return {'mode': 'targeted', 'reason': ', '.join(sorted(areas)), 'packages': sorted(packages),
            'allE2EChecks': all_e2e, **light_fields}


def inspect(root: Path, level: str, phase: str, comparison_base: str, force: bool, light: bool = False):
    if force or os.environ.get('CI', '').lower() == 'true':
        return full('CI, release or explicitly requested full validation')
    if phase == 'Disabled':
        return full('The push does not describe one checked HEAD update')
    if light and (level != 'Push' or phase != 'Manual'):
        # Hooks never select checks by this mode; they only accept its recorded result.
        return full('The light local check is only a manual Push-level check')

    def git(*args):
        return subprocess.run(['git', '-C', str(root), '-c', 'safe.directory=' + root.as_posix(),
                               *args], capture_output=True, check=True, timeout=15).stdout

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
    sources = None
    if light and any(re.fullmatch(r'e2e/tests/[^\x00-\x1f]+\.ts', name) for name in names):
        try:
            sources = e2e_sources(root, git)
        except (OSError, ValueError, subprocess.SubprocessError):
            sources = None  # related_e2e_specs then keeps every operation
    result = classify(names, before, after, graph, light, sources)
    return {**result, 'base': base, 'head': head, 'paths': names}


def receipt_module():
    """The B3 module supplies the same content fingerprint, seal, lock and eligibility."""
    import importlib.util
    path = Path(__file__).resolve().with_name('validation_receipt.py')
    spec = importlib.util.spec_from_file_location('pointercad_validation_receipt', path)
    if spec is None or spec.loader is None:
        raise ValueError('The receipt fingerprint module is missing')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invalidate_light(directory: Path):
    for name in (LIGHT_RECEIPT, LIGHT_RUNNING):
        (directory / name).unlink(missing_ok=True)


def operate_light(vr, action: str, root: Path, tools: dict, phase: str, token: str, base: str) -> dict:
    """Record or accept the success of one light local check (never a B3 full-check receipt).

    The same inputs as B3 are compared by content; the push must also send exactly the
    range the check selected from (its comparison base). Missing, stale, changed or
    already used evidence always means the ordinary hook checks run instead.
    """
    directory = vr.storage(root)
    receipt_path, running_path = directory / LIGHT_RECEIPT, directory / LIGHT_RUNNING
    if action == 'invalidate':
        invalidate_light(directory)
        return {'ok': True}
    if os.environ.get('CI', '').lower() == 'true':
        invalidate_light(directory)
        return {'ok': False, 'reason': 'CI always executes all checks'}
    if action in {'start', 'finish'} and os.environ.get('POINTERCAD_PERF_STRICT') != '1':
        invalidate_light(directory)
        return {'ok': False, 'reason': 'Only a Push-level light check can publish its record'}
    key_path = directory / 'validation-receipt.key'
    if action == 'start':
        invalidate_light(directory)
        if not re.fullmatch(r'[0-9a-f]{40}', base) or base == '0' * 40:
            raise ValueError('The light check record requires its actual comparison base')
        if not key_path.exists():
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as output:
                output.write(secrets.token_bytes(32))
    key = key_path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid local receipt key')
    reuse_receipt = vr.read_record(receipt_path, key) if action == 'reuse' else None
    current = vr.capture(root, tools)
    if action == 'start':
        token = secrets.token_hex(24)
        vr.write_record(running_path, {'kind': LIGHT_KIND, 'state': current, 'token': token, 'base': base}, key)
        return {'ok': True, 'token': token}
    if action == 'finish':
        before = vr.read_record(running_path, key)
        changed = [name for name in current if name != 'outputs' and before['state'].get(name) != current[name]]
        if before.get('kind') != LIGHT_KIND or before['token'] != token or changed:
            raise ValueError('The light check no longer matches its starting inputs; changed: ' + ', '.join(changed))
        vr.write_record(receipt_path, {'version': LIGHT_VERSION, 'kind': LIGHT_KIND, 'state': current,
                                       'at': time.time(), 'monotonic': time.monotonic(), 'phase': 'prepared',
                                       'token': token, 'base': before['base']}, key)
        running_path.unlink()
        return {'ok': True}
    if action != 'reuse':
        raise ValueError('Unknown light receipt operation')
    receipt = vr.read_record(receipt_path, key)
    if receipt != reuse_receipt:
        raise ValueError('Light receipt changed during input scan')
    if set(receipt) != LIGHT_KEYS or receipt['version'] != LIGHT_VERSION or receipt['kind'] != LIGHT_KIND:
        raise ValueError('Unsupported light receipt')
    ancestry = vr.git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').decode().split() if phase == 'Push' else []
    parent = ancestry[1] if len(ancestry) >= 2 else ''
    if phase == 'Push':
        if base != receipt['base']:
            raise ValueError('The push sends a different range than the light check selected')
        if vr.git(root, 'rev-parse', 'HEAD^{tree}').decode().strip() != current['tree']:
            raise ValueError('Push HEAD does not contain the checked index')
        if receipt['phase'] == 'commit':
            before = receipt['state']
            if current['mergeHeads'] or ancestry[1:] != [before['head'], *before.get('mergeHeads', [])]:
                raise ValueError('Push commit parents differ from the checked light check')
            current['mergeHeads'] = before.get('mergeHeads', [])
    # Same time window, input comparison and one-commit/one-push sequence as B3.
    shaped = {'version': vr.VERSION, 'state': receipt['state'], 'at': receipt['at'],
              'monotonic': receipt['monotonic'], 'repeats': 1, 'phase': receipt['phase'], 'token': receipt['token']}
    if not vr.eligible(shaped, current, phase, parent, time.time(), time.monotonic(), 1):
        before = receipt.get('state', {})
        changed = [name for name in current if name != 'head' and before.get(name) != current[name]]
        raise ValueError('Light receipt is stale or belongs to different inputs or an already used operation; changed: '
                         + ', '.join(changed))
    if phase == 'Commit':
        receipt['phase'] = 'commit'
        vr.write_record(receipt_path, receipt, key)
    else:
        receipt_path.unlink()  # Consume before returning to Git; a failed send cannot reuse it.
    return {'ok': True, 'used': True, 'tree': current['tree'], 'phase': phase, 'base': receipt['base']}


def run_light_receipt(action: str, root: Path, tools: dict, phase: str = 'Manual', token: str = '', base: str = '') -> dict:
    vr = receipt_module()
    with vr.receipt_lock(vr.storage(root)):
        try:
            return operate_light(vr, action, root, tools, phase, token, base)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            invalidate_light(vr.storage(root))
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--level', choices=['Commit', 'Push'])
    parser.add_argument('--phase', choices=['Manual', 'Commit', 'Push', 'Disabled'], required=True)
    parser.add_argument('--base', default='')
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--light', action='store_true')
    parser.add_argument('--receipt', choices=['start', 'finish', 'reuse', 'invalidate'])
    parser.add_argument('--tools', default='e30=')
    parser.add_argument('--token', default='')
    args = parser.parse_args()
    if args.receipt:
        try:
            result = run_light_receipt(args.receipt, args.root.resolve(strict=True),
                                       json.loads(base64.b64decode(args.tools)), args.phase, args.token, args.base)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            result = {'ok': False, 'reason': str(error)}
        print(json.dumps(result, ensure_ascii=True))
        return 0 if result['ok'] else 3
    if args.level is None:
        parser.error('--level is required unless --receipt is given')
    try:
        result = inspect(args.root.resolve(), args.level, args.phase, args.base, args.full, args.light)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result = full('Cannot establish a safe local scope: ' + type(error).__name__)
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
