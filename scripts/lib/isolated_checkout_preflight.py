"""Reject incomplete independent delivery copies before starting their long checks."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def git_environment():
    return {name: value for name, value in os.environ.items()
            if name.upper() not in ('GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX',
                                   'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
                                   'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH')}


def checked_root(project: Path, checkout: Path) -> Path:
    project = project.resolve(strict=True)
    if any(part.casefold() == '.git' for part in checkout.parts):
        raise ValueError('The independent checkout must not use Git metadata')
    checkout = checkout.resolve(strict=True)
    if not checkout.is_relative_to(project / 'scratchpad') or any(part.casefold() == '.git' for part in checkout.parts):
        raise ValueError('The independent checkout must stay in the project scratchpad')
    return checkout


def check_fixture_path(checkout: Path) -> int:
    nested = checkout / 'scratchpad/temp' / ('pointercad-receipt-hooks-' + 'x'*8) / 'working/.git/worktrees' / (
        'pointercad-commitcheck-' + 'x'*32) / 'refs'
    length = len(str(nested))
    if os.name == 'nt' and length >= 240:
        raise ValueError('Nested check path is too long: ' + str(length))
    return length


def check_dependency_links(checkout: Path) -> int:
    roots = [checkout / 'node_modules', checkout / 'e2e/node_modules']
    for group in ('apps', 'packages'):
        parent = checkout / group
        if parent.is_dir():
            roots.extend(folder / 'node_modules' for folder in parent.iterdir() if folder.is_dir())
    links = 0
    pending = [folder for folder in roots if os.path.lexists(folder)]
    while pending:
        folder = pending.pop()
        # Check the root as well: a whole node_modules junction can also escape.
        if folder.is_symlink() or folder.is_junction():
            if not folder.resolve(strict=True).is_relative_to(checkout):
                raise ValueError('Dependency link leaves the independent checkout: ' + str(folder))
            links += 1
            continue
        for child in folder.iterdir():
            if child.is_symlink() or child.is_junction():
                if not child.resolve(strict=True).is_relative_to(checkout):
                    raise ValueError('Dependency link leaves the independent checkout: ' + str(child))
                links += 1
            elif child.is_dir():
                pending.append(child)
    return links


def inspect(project: Path, checkout: Path, expected_commit: str):
    checkout = checked_root(project, checkout)
    environment = git_environment()

    def git(*args):
        return subprocess.check_output(['git', '--no-optional-locks', '-C', str(checkout), *args], env=environment).decode().strip()

    metadata = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir')).resolve(strict=True)
    if metadata != checkout / '.git' or not metadata.is_dir():
        raise ValueError('An independent checkout must have its own Git metadata')
    if git('rev-parse', 'HEAD') != expected_commit:
        raise ValueError('The checkout is not the approved commit')
    if git('status', '--porcelain=v1', '-z') or git('write-tree') != git('rev-parse', 'HEAD^{tree}'):
        raise ValueError('The independent checkout has unexpected source or index changes')
    if git('config', '--get', 'core.hooksPath') != 'scripts/hooks':
        raise ValueError('The ordinary repository hooks must remain enabled')
    maximum_path = check_fixture_path(checkout)
    links = check_dependency_links(checkout)
    # Resolve the real production graph with the exact same code as the license
    # build. A symlink count alone cannot prove that required packages exist.
    script = """import { installedRuntimeDependencies } from './scripts/vite/runtimeDependencyInventory.mjs';
const items = installedRuntimeDependencies(process.cwd());
console.log(JSON.stringify(items.map(({name, version}) => ({name, version}))));"""
    inventory = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script],
                                                  cwd=checkout, env=environment))
    return {'commit': expected_commit, 'tree': git('rev-parse', 'HEAD^{tree}'),
            'maximumFixturePathLength': maximum_path, 'dependencyLinks': links, 'runtimePackages': inventory}


def push_checked(project: Path, checkout: Path, expected_commit: str, remote: str, target: str):
    result = inspect(project, checkout, expected_commit)
    if not target.startswith('refs/heads/'):
        raise ValueError('The destination must be an explicit branch reference')
    environment = git_environment()
    subprocess.run(['git', 'check-ref-format', target], check=True, env=environment, capture_output=True)
    # Ordinary hooks remain mandatory; never force a branch or bypass checks.
    subprocess.run(['git', '-C', str(checkout), 'push', '--', remote, expected_commit + ':' + target],
                   check=True, env=environment)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--checkout', required=True, type=Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--push-ref', help='After preflight, push this explicit refs/heads/ branch through ordinary hooks')
    parser.add_argument('--remote', default='origin')
    arguments = parser.parse_args()
    try:
        result = (inspect(arguments.project, arguments.checkout, arguments.commit) if arguments.push_ref is None else
                  push_checked(arguments.project, arguments.checkout, arguments.commit, arguments.remote, arguments.push_ref))
        print(json.dumps({'ok': True, **result}))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({'ok': False, 'reason': str(error)}))
        raise SystemExit(1)
