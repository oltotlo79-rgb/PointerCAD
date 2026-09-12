"""B3: reuse a completed strict full check only for the same immediate commit/push.

This is local bookkeeping, not a trust boundary against someone who can replace hooks.
Source, installed dependencies, tools, environment and generated code are compared by
content. Missing evidence always means running the ordinary checks, never success.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import re
import secrets
import subprocess
import sys
import time

VERSION = 1
LIFETIME_SECONDS = 20 * 60
GIT_CONTEXT = ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
               'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH')
CACHE_NAMES = {'.pnpm-task-run-state-v1', '.cache', '.vite', '.vite-temp'}


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path: Path) -> str:
    before = path.stat()
    hasher = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(block)
    value = hasher.hexdigest()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError('File changed during fingerprint: ' + str(path))
    return value


def git(root: Path, *args: str) -> bytes:
    environment = {key: value for key, value in os.environ.items() if key not in GIT_CONTEXT}
    return subprocess.run(['git', '-C', str(root), *args], env=environment, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def directory_digest(roots: list[Path], workspace: Path, *, dependencies: bool) -> str:
    """Follow dependency links once; never recurse from a workspace alias back into the source tree."""
    result = hashlib.sha256()
    visited: set[Path] = set()

    def emit(value):
        result.update(canonical(value)); result.update(b'\n')

    def walk(path: Path):
        if not path.exists():
            if path.is_symlink():
                raise ValueError('Broken link: ' + str(path))
            emit([str(path), 'absent']); return
        real = path.resolve(strict=True)
        emit([str(path), str(real)])
        if path.is_file():
            emit(file_hash(path)); return
        if not path.is_dir():
            raise ValueError('Unsupported dependency/output entry: ' + str(path))
        if real in visited:
            return
        visited.add(real)
        if dependencies and real != path.absolute():
            if real.is_relative_to(workspace) and 'node_modules' not in real.relative_to(workspace).parts:
                emit('workspace-source-and-output-covered-separately'); return
            if 'node_modules' not in real.parts:
                raise ValueError('Dependency link leaves inspected modules: ' + str(path))
        names = sorted(os.listdir(path))
        for name in names:
            if dependencies and path.name == 'node_modules' and name in CACHE_NAMES:
                continue
            walk(path / name)
        if sorted(os.listdir(path)) != names:
            raise ValueError('Directory changed during fingerprint: ' + str(path))

    for path in sorted(roots):
        walk(path)
    return result.hexdigest()


def browser_roots(root: Path, node: str) -> list[Path]:
    script = "const p=require('@playwright/test');process.stdout.write(JSON.stringify([p.chromium.executablePath(),p.firefox.executablePath()]));"
    output = subprocess.run([node, '-e', script], cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    roots: set[Path] = set()
    for name in json.loads(output.stdout):
        executable = Path(name).resolve(strict=True)
        if not executable.is_file():
            raise ValueError('The checked browser executable is missing')
        folder = next((parent for parent in executable.parents if re.fullmatch(r'(?:chromium|firefox)-\d+', parent.name)), None)
        if folder is None:
            raise ValueError('An unsupported browser installation requires ordinary checks')
        roots.add(folder)
        roots.update(path for path in folder.parent.iterdir() if path.is_dir() and re.fullmatch(r'(?:chromium_headless_shell|ffmpeg)-\d+', path.name))
    return sorted(roots)


def git_tool_inputs(selected: Path) -> tuple[Path, list[Path]]:
    """Recognize the installed Git entry points that hooks prepend to PATH.

    Hash every recognized shipped entry point and its runtime. Unix packages
    can install either hard links or identical copies. Neither allows a general
    exemption for another executable with the same name or version string.
    """
    if selected.name.lower() not in {'git', 'git.exe'}:
        return selected, []
    output = subprocess.run([str(selected), '--exec-path'], check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=10)
    core = Path(output.stdout.decode().strip()).resolve(strict=True)
    if os.name != 'nt':
        # Git prepends its exec-path to PATH inside hooks. On Unix both entries
        # can be hard links or separate copies. Only the installed bin/ and
        # lib[exec]/git-core pair is eligible; hash BOTH entries in either case.
        runtime = core / 'git'
        entry = core.parent.parent / 'bin/git'
        if core.name == 'git-core' and core.parent.name in {'lib', 'libexec'} and runtime.is_file() and entry.is_file():
            runtime, entry = runtime.resolve(strict=True), entry.resolve(strict=True)
            if selected in {runtime, entry} and file_hash(entry) == file_hash(runtime):
                return runtime, [entry]
        return selected, []
    architecture = core.parent.parent
    # Determine the layout from the installed executable. ARM64 uses clangarm64,
    # so assuming the x86 mingw64 directory would disable reuse on the user's PC.
    if core.name != 'git-core' or core.parent.name != 'libexec':
        return selected, []
    runtime = core / 'git.exe'
    shipped = [architecture.parent / 'cmd/git.exe', architecture / 'bin/git.exe', runtime]
    if not runtime.is_file() or selected not in [path.resolve() for path in shipped]:
        return selected, []
    return runtime.resolve(strict=True), shipped


def capture(root: Path, tools: dict[str, str]) -> dict:
    root = root.resolve(strict=True)
    if set(tools) != {'node', 'pnpm', 'git', 'shell', 'node_runtime', 'pnpm_runtime'}:
        raise ValueError('Required runtime tool paths are missing')
    inherited_index = os.environ.get('GIT_INDEX_FILE')
    if inherited_index and Path(inherited_index).resolve() != (storage(root) / 'index').resolve():
        raise ValueError('An alternate commit index requires ordinary checks')
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    index = git(root, 'ls-files', '--stage', '-z')
    if any(not line.startswith(b'H ') for line in git(root, 'ls-files', '-v', '-z').split(b'\0') if line):
        raise ValueError('Hidden index flags cannot authorize reuse')
    if git(root, 'diff', '--name-only', '-z') or git(root, 'ls-files', '--others', '--exclude-standard', '-z'):
        raise ValueError('All changes must be staged, with no additional working edits')
    files: list[list[str]] = []
    for record in index.split(b'\0'):
        if not record:
            continue
        metadata, raw_name = record.split(b'\t', 1)
        mode, _object, stage = metadata.split(b' ')
        if stage != b'0' or mode not in {b'100644', b'100755'}:
            raise ValueError('Unmerged entries, submodules or source links require ordinary checks')
        name = raw_name.decode('utf-8', errors='strict')
        path = root / name
        if not path.resolve(strict=True).is_relative_to(root) or not path.is_file():
            raise ValueError('Source is outside the inspected tree')
        files.append([name, file_hash(path)])
    tree = git(root, 'write-tree').decode().strip()
    packages = sorted((root / 'packages').glob('*')) + sorted((root / 'apps').glob('*'))
    module_roots = [root / 'node_modules', root / 'e2e/node_modules'] + [path / 'node_modules' for path in packages if path.is_dir()]
    if not (root / 'node_modules').is_dir():
        raise ValueError('Installed dependencies are absent')
    tool_paths = {name: str(Path(value).resolve(strict=True)) for name, value in tools.items()}
    git_runtime, git_entries = git_tool_inputs(Path(tool_paths['git']))
    tool_paths['git'] = str(git_runtime)
    tool_paths['python'] = str(Path(sys.executable).resolve(strict=True))
    tool_files = {name: file_hash(Path(path)) for name, path in tool_paths.items()}
    # Corepack wrappers load code beside the executable or from their containing package.
    extra_tools: list[Path] = git_entries
    for name in ('node', 'pnpm', 'node_runtime', 'pnpm_runtime'):
        path = Path(tool_paths[name])
        for package_name in ('corepack', 'pnpm'):
            sibling = path.parent / 'node_modules' / package_name
            if sibling.exists():
                extra_tools.append(sibling)
        for parent in list(path.parents)[:4]:
            manifest = parent / 'package.json'
            if manifest.is_file() and json.loads(manifest.read_text(encoding='utf-8')).get('name') in {'corepack', 'pnpm'}:
                extra_tools.append(parent); break
    # PATH differences caused by Git's shell are represented by the actual selected tool files.
    # Only performance mode is normalized: the receipt always requires a strict full check.
    environment = {key: value for key, value in os.environ.items()
                   if re.match(r'^(NODE_|PNPM_|npm_config_|COREPACK_|PLAYWRIGHT_|ELECTRON_|VITE_|PCAD_|POINTERCAD_|CI$|TZ$|LANG$|LC_|DISPLAY$)', key, re.I)
                   and key.upper() != 'POINTERCAD_PERF_STRICT'}
    outputs = [root / 'apps/web/dist', root / 'apps/desktop/dist']
    for package in packages:
        if package.is_dir():
            outputs.extend([package / 'dist', package / 'dist-types', package / 'tsconfig.tsbuildinfo'])
    environment_files = [path for folder in [root, *packages] if folder.is_dir() for path in sorted(folder.glob('.env*')) if path.is_file()]
    user_directory = Path.home()
    configuration = {user_directory / '.npmrc', user_directory / '.pnpmrc'}
    configuration.update(Path(value) for key, value in os.environ.items()
                         if key.lower() in {'npm_config_userconfig', 'npm_config_globalconfig'} and value)
    for name in ('node', 'pnpm', 'node_runtime', 'pnpm_runtime'):
        configuration.add(Path(tool_paths[name]).parent.parent / 'etc/npmrc')
    config_base = os.environ.get('XDG_CONFIG_HOME') or os.environ.get('LOCALAPPDATA')
    configuration.add((Path(config_base) if config_base else user_directory / '.config') / 'pnpm/rc')
    if sys.platform == 'darwin':
        configuration.add(user_directory / 'Library/Preferences/pnpm/rc')
    state = {'root': str(root), 'head': head, 'tree': tree, 'index': hashlib.sha256(index).hexdigest(),
             'source': digest(files), 'dependencies': directory_digest(module_roots, root, dependencies=True),
             'outputs': directory_digest(outputs, root, dependencies=False),
             'tools': {name: digest([path, tool_files[name]]) for name, path in tool_paths.items()},
             'toolPackages': directory_digest(extra_tools, root, dependencies=False),
             'browsers': directory_digest(browser_roots(root, tool_paths['node_runtime']), root, dependencies=False),
             'environment': digest([environment, [[str(path), file_hash(path)] for path in environment_files],
                                    directory_digest(sorted(configuration), root, dependencies=False), platform.platform(), platform.machine(), sys.version])}
    if head != git(root, 'rev-parse', 'HEAD').decode().strip() or index != git(root, 'ls-files', '--stage', '-z'):
        raise ValueError('Git changed during fingerprint')
    return state


def eligible(receipt: dict, current: dict, phase: str, parent: str, now: float, monotonic: float, repeats: int) -> bool:
    if set(receipt) != {'version', 'state', 'at', 'monotonic', 'repeats', 'phase', 'token'} or receipt['version'] != VERSION:
        return False
    age = now - receipt['at']
    if not 0 <= age <= LIFETIME_SECONDS or abs(age - (monotonic - receipt['monotonic'])) > 5:
        return False
    if receipt['repeats'] < repeats or receipt['phase'] not in {'prepared', 'commit'}:
        return False
    before = receipt['state']
    if set(before) != set(current) or any(before[key] != current[key] for key in current if key != 'head'):
        return False
    if phase == 'Commit':
        return receipt['phase'] == 'prepared' and current['head'] == before['head']
    if phase == 'Push':
        return (receipt['phase'] == 'commit' and parent == before['head'] and current['head'] != before['head']) or (
            receipt['phase'] == 'prepared' and current['head'] == before['head'])
    return False


def storage(root: Path) -> Path:
    return Path(git(root, 'rev-parse', '--absolute-git-dir').decode().strip()).resolve(strict=True)


def write_record(path: Path, value: dict, key: bytes):
    content = {'payload': value, 'seal': hmac.new(key, canonical(value), hashlib.sha256).hexdigest()}
    temporary = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    with temporary.open('x', encoding='utf-8') as output:
        json.dump(content, output, ensure_ascii=True); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, path)


def read_record(path: Path, key: bytes) -> dict:
    if path.stat().st_size > 64_000:
        raise ValueError('Oversized receipt')
    record = json.loads(path.read_text(encoding='utf-8'))
    if set(record) != {'payload', 'seal'} or not hmac.compare_digest(record['seal'], hmac.new(key, canonical(record['payload']), hashlib.sha256).hexdigest()):
        raise ValueError('Receipt was modified')
    return record['payload']


def invalidate(directory: Path):
    for name in ('validation-receipt.json', 'validation-running.json'):
        (directory / name).unlink(missing_ok=True)


def operate(action: str, root: Path, tools: dict[str, str], phase: str, token: str, repeats: int) -> dict:
    directory = storage(root)
    receipt_path, running_path = directory / 'validation-receipt.json', directory / 'validation-running.json'
    if action == 'invalidate':
        invalidate(directory); return {'ok': True}
    if os.environ.get('CI', '').lower() == 'true':
        invalidate(directory); return {'ok': False, 'reason': 'CI always executes all checks'}
    if action in {'start', 'finish'} and os.environ.get('POINTERCAD_PERF_STRICT') != '1':
        invalidate(directory); return {'ok': False, 'reason': 'Only a strict full check can publish a receipt'}
    key_path = directory / 'validation-receipt.key'
    if action == 'start':
        invalidate(directory)
        if not key_path.exists():
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as output:
                output.write(secrets.token_bytes(32))
    key = key_path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid local receipt key')
    current = capture(root, tools)
    if action == 'start':
        token = secrets.token_hex(24)
        write_record(running_path, {'state': current, 'token': token, 'repeats': repeats}, key)
        return {'ok': True, 'token': token}
    if action == 'finish':
        before = read_record(running_path, key)
        changed = [name for name in current if name != 'outputs' and before['state'].get(name) != current[name]]
        if before['token'] != token or before['repeats'] != repeats or changed:
            # Categories only: never print environment values or private file contents.
            raise ValueError('The full check no longer matches its starting inputs; changed: ' + ', '.join(changed))
        write_record(receipt_path, {'version': VERSION, 'state': current, 'at': time.time(), 'monotonic': time.monotonic(),
                                   'repeats': repeats, 'phase': 'prepared', 'token': token}, key)
        running_path.unlink(); return {'ok': True}
    if action != 'reuse':
        raise ValueError('Unknown receipt operation')
    receipt = read_record(receipt_path, key)
    ancestry = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').decode().split() if phase == 'Push' else []
    parent = ancestry[1] if len(ancestry) == 2 else ''
    if phase == 'Push' and git(root, 'rev-parse', 'HEAD^{tree}').decode().strip() != current['tree']:
        raise ValueError('Push HEAD does not contain the checked index')
    if not eligible(receipt, current, phase, parent, time.time(), time.monotonic(), repeats):
        before = receipt.get('state', {})
        changed = [name for name in current if name != 'head' and before.get(name) != current[name]]
        if 'tools' in changed:
            changed += ['tool:' + name for name, value in current['tools'].items() if before.get('tools', {}).get(name) != value]
        # Report categories only. Paths, environment values and local configuration
        # may contain private information and are never dumped for diagnostics.
        raise ValueError('Receipt is stale or belongs to different inputs or an already used operation; changed: ' + ', '.join(changed))
    if phase == 'Commit':
        receipt['phase'] = 'commit'; write_record(receipt_path, receipt, key)
    else:
        receipt_path.unlink()  # Consume before returning to Git; a failed send cannot reuse this record.
    return {'ok': True, 'used': True, 'tree': current['tree'], 'phase': phase}


@contextmanager
def receipt_lock(directory: Path):
    # OS locks are released on interruption; an abandoned lock file does not block recovery.
    with (directory / 'validation-receipt.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0'); handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def run(action: str, root: Path, tools: dict[str, str], phase: str = 'Manual', token: str = '', repeats: int = 1) -> dict:
    with receipt_lock(storage(root)):
        try:
            return operate(action, root, tools, phase, token, repeats)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            invalidate(storage(root))
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'finish', 'reuse', 'invalidate'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--tools', default='e30=')
    parser.add_argument('--phase', choices=['Manual', 'Commit', 'Push', 'Disabled'], default='Manual')
    parser.add_argument('--token', default='')
    parser.add_argument('--repeats', type=int, default=1)
    args = parser.parse_args()
    try:
        result = run(args.action, args.root.resolve(strict=True), json.loads(base64.b64decode(args.tools)), args.phase, args.token, args.repeats)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        result = {'ok': False, 'reason': str(error)}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result['ok'] else 3


if __name__ == '__main__':
    raise SystemExit(main())
