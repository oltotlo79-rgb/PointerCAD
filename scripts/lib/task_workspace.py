"""Create task output only in this project's ignored scratchpad, never outside it."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile


def _workspace_locations(repository: Path) -> tuple[Path, Path]:
    repository = repository.resolve(strict=True)
    common = subprocess.check_output(
        ['git', '--no-optional-locks', '-C', str(repository), 'rev-parse',
         '--path-format=absolute', '--git-common-dir'], text=True,
        env={key: value for key, value in os.environ.items() if not key.startswith('GIT_')}).strip()
    git_directory = Path(common).resolve(strict=True)
    # Linked worktrees share the main project's .git directory. Their output must
    # also stay under the same project folder, rather than following an OS temp path.
    project = git_directory.parent
    if git_directory.name != '.git' or not repository.is_relative_to(project):
        raise ValueError('The repository must be inside the main project folder')
    scratchpad = (project / 'scratchpad').resolve()
    if not scratchpad.is_relative_to(project) or scratchpad.is_relative_to(git_directory):
        raise ValueError('The scratchpad must not resolve outside the project or into Git metadata')
    return git_directory, scratchpad


def project_temp_directory(repository: Path) -> Path:
    git_directory, scratchpad = _workspace_locations(repository)
    path = (scratchpad / 'temp').resolve()
    if not path.is_relative_to(scratchpad) or path.is_relative_to(git_directory):
        raise ValueError('Temporary output must stay inside the project scratchpad')
    path.mkdir(parents=True, exist_ok=True)
    return path


def configure_project_temp(repository: Path) -> Path:
    path = project_temp_directory(repository)
    for name in ('TEMP', 'TMP', 'TMPDIR'):
        os.environ[name] = str(path)
    tempfile.tempdir = str(path)
    return path


def create_workspace(repository: Path, task: str, base: Path | None = None) -> Path:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', task):
        raise ValueError('Task name must contain only lowercase letters, digits and hyphens')
    git_directory, scratchpad = _workspace_locations(repository)
    base = (base if base is not None else scratchpad / 'tasks').resolve()
    # resolve() follows existing Windows junctions before creating any output.
    if not base.is_relative_to(scratchpad) or base.is_relative_to(git_directory):
        raise ValueError('Task output must stay inside the project scratchpad')
    base.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(str(git_directory).casefold().encode()).hexdigest()[:12]
    return Path(tempfile.mkdtemp(prefix=f'{key}-{task}-', dir=base))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('task', nargs='?')
    parser.add_argument('--temp-root', action='store_true')
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    if args.temp_root == (args.task is not None):
        parser.error('Specify a task name or --temp-root')
    print(project_temp_directory(args.repository) if args.temp_root else create_workspace(args.repository, args.task))
