"""Create task output only in this project's ignored scratchpad, never outside it."""
import hashlib
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import tempfile
from typing import NamedTuple


class Capacity(NamedTuple):
    required: int
    free: int


def absolute_path(path: Path, *, git_metadata: bool = False) -> Path:
    """Validate the spelling without resolving or opening the requested path."""
    path = Path(path).absolute()
    if not path.is_absolute() or (os.name == 'nt' and not re.fullmatch(r'[a-zA-Z]:\\', path.anchor)):
        raise ValueError(f'Use a local absolute path: {path}')
    for part in path.parts[1:]:
        if (part == '..' or (not git_metadata and part.casefold() == '.git')
                or (os.name == 'nt' and (part.endswith(('.', ' ')) or PureWindowsPath(part).is_reserved()
                                         or re.search(r'[\x00-\x1f<>:"|?*]', part)))):
            raise ValueError(f'Unsafe path component: {path}')
    return path


def is_reparse(info: os.stat_result) -> bool:
    return (stat.S_ISLNK(info.st_mode) or
            bool(getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT))


def entry_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def direct_path(path: Path, *, directory: bool = True, allow_missing: bool = False,
                git_metadata: bool = False) -> Path:
    """Inspect parents first, without following directory links or junctions."""
    path = absolute_path(path, git_metadata=git_metadata)
    last = None
    for item in (*reversed(path.parents), path):
        try:
            info = item.lstat()
        except FileNotFoundError:
            if allow_missing:
                break
            raise
        expected = stat.S_ISREG if item == path and not directory else stat.S_ISDIR
        if is_reparse(info) or not expected(info.st_mode):
            raise ValueError(f'Indirect or unexpected path: {item}')
        last = item
    if os.name == 'nt' and last is not None and last.resolve(strict=True) != last:
        raise ValueError(f'Noncanonical Windows path: {last}')
    return path


def scratch_path(project: Path, path: Path, *, directory: bool = True,
                 allow_missing: bool = False, allow_scratch: bool = False,
                 isolated: bool = True) -> Path:
    """Accept only direct locations below this project's scratchpad."""
    project, path = absolute_path(project), absolute_path(path)
    scratch = project / 'scratchpad'
    if not path.is_relative_to(scratch) or (path == scratch and not allow_scratch):
        raise ValueError(f'Path must be below {scratch}: {path}')
    direct_path(path, directory=directory, allow_missing=allow_missing)
    if isolated:
        for parent in reversed(path.parents):
            if parent.is_relative_to(scratch) and entry_exists(parent / '.git'):
                raise ValueError(f'Path is inside another Git worktree: {parent}')
    return path


def separate_paths(first: Path, *others: Path) -> None:
    for other in others:
        if first.is_relative_to(other) or other.is_relative_to(first):
            raise ValueError(f'Workspace paths overlap: {first} and {other}')


def new_scratch_path(project: Path, path: Path) -> Path:
    """Require a direct, existing parent and a name that has never been opened."""
    path = scratch_path(project, path, allow_missing=True)
    direct_path(path.parent)
    if entry_exists(path):
        raise FileExistsError(f'Workspace destination already exists: {path}')
    return path


def allocation_block(path: Path) -> int:
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        sectors, size = wintypes.DWORD(), wintypes.DWORD()
        ok = ctypes.windll.kernel32.GetDiskFreeSpaceW(
            path.anchor, ctypes.byref(sectors), ctypes.byref(size), None, None)
        if not ok or not sectors.value or not size.value:
            raise OSError(f'Cannot read allocation unit: {path}')
        return sectors.value * size.value
    return os.statvfs(path).f_frsize


def allocated_bytes(sizes, block: int) -> int:
    if block <= 0:
        raise ValueError('Positive allocation unit required')
    return sum(((size + block - 1) // block + 1) * block for size in sizes)


def require_capacity(parent: Path, required: int) -> Capacity:
    if required < 0:
        raise ValueError('Nonnegative capacity estimate required')
    free = shutil.disk_usage(parent).free
    if free < required:
        raise ValueError(f'Insufficient workspace capacity at {parent}: need {required} B, free {free} B')
    return Capacity(required, free)


def _metadata_location(raw: bytes, base: Path) -> Path:
    name = os.fsdecode(raw).strip()
    location = Path(name)
    if not name or any(char in name for char in ('\0', '\r', '\n')) or (location.anchor and not location.is_absolute()):
        raise ValueError('Invalid linked worktree metadata path')
    # Git's own pointers can be relative. Normalize lexically before inspecting anything.
    return absolute_path(Path(os.path.abspath(base / location)), git_metadata=True)


def _requested_git_directory(repository: Path, owner_directory: Path | None = None) -> Path:
    marker = repository / '.git'
    metadata = marker.lstat()
    if is_reparse(metadata):
        raise ValueError(f'Indirect or unexpected path: {marker}')
    if stat.S_ISDIR(metadata.st_mode):
        # The controller can check an independent repository stored in its scratchpad.
        directory = direct_path(marker, git_metadata=True)
        direct_path(directory / 'HEAD', directory=False, git_metadata=True)
        return directory
    marker = direct_path(repository / '.git', directory=False, git_metadata=True)
    prefix, separator, value = marker.read_bytes().partition(b':')
    if prefix != b'gitdir' or not separator:
        raise ValueError('The requested scratchpad repository is not a registered worktree')
    administrative = _metadata_location(value, repository)
    common = administrative.parent.parent
    if (common.name != '.git' or administrative.parent != common / 'worktrees'
            or not repository.is_relative_to(common.parent / 'scratchpad')
            or (owner_directory is not None and common != owner_directory
                and not common.parent.is_relative_to(owner_directory.parent / 'scratchpad'))):
        raise ValueError('The worktree registration must be in this project')
    direct_path(administrative, git_metadata=True)
    common_pointer = direct_path(administrative / 'commondir', directory=False, git_metadata=True)
    backlink = direct_path(administrative / 'gitdir', directory=False, git_metadata=True)
    if (_metadata_location(common_pointer.read_bytes(), administrative) != common
            or _metadata_location(backlink.read_bytes(), administrative) != marker):
        raise ValueError('Linked worktree metadata does not register this repository')
    return common


def _owned_git_directory(owner: Path) -> Path:
    if entry_exists(owner / '.git'):
        return _requested_git_directory(owner)
    # The tool is also run from a plain scripts copy kept under an owning scratchpad.
    for parent in owner.parents:
        if parent.name.casefold() == 'scratchpad' and entry_exists(parent.parent / '.git'):
            return _requested_git_directory(parent.parent)
    raise ValueError('Cannot establish the installed tool project')


def _workspace_locations(repository: Path) -> tuple[Path, Path]:
    repository = absolute_path(repository)
    # Use the installed tool's own checkout to establish the project, before inspecting the argument.
    owner = direct_path(Path(__file__).absolute().parents[2])
    git_directory = _owned_git_directory(owner)
    # Linked worktrees share the main project's .git directory. Their output must
    # also stay under the same project folder, rather than following an OS temp path.
    project = git_directory.parent
    scratchpad = project / 'scratchpad'
    if git_directory.name != '.git' or (owner != project and not owner.is_relative_to(scratchpad)):
        raise ValueError('The tool must be installed in its project or below its scratchpad')
    if repository != project and not repository.is_relative_to(scratchpad):
        raise ValueError('The repository must be the tool project or its scratchpad worktree')
    direct_path(git_directory, git_metadata=True)
    if repository != owner:
        direct_path(repository)
        if repository != project:
            git_directory = _requested_git_directory(repository, git_directory)
            project = git_directory.parent
            scratchpad = project / 'scratchpad'
    scratch_path(project, scratchpad, allow_scratch=True, allow_missing=True)
    return git_directory, scratchpad


def project_temp_directory(repository: Path) -> Path:
    git_directory, scratchpad = _workspace_locations(repository)
    path = scratch_path(git_directory.parent, scratchpad / 'temp', allow_missing=True)
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
    requested_base = base if base is not None else scratchpad / 'tasks'
    base = scratch_path(git_directory.parent, requested_base, allow_scratch=True, allow_missing=True)
    base.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(str(git_directory).casefold().encode()).hexdigest()[:12]
    return Path(tempfile.mkdtemp(prefix=f'{key}-{task}-', dir=base))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('task', nargs='?')
    parser.add_argument('--temp-root', action='store_true')
    parser.add_argument('--repository', type=Path, default=Path(__file__).absolute().parents[2])
    args = parser.parse_args()
    if args.temp_root == (args.task is not None):
        parser.error('Specify a task name or --temp-root')
    print(project_temp_directory(args.repository) if args.temp_root else create_workspace(args.repository, args.task))
