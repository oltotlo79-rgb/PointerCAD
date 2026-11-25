"""Build or verify the offline corresponding-source ZIP for this exact IGES kernel."""
from argparse import ArgumentParser
from hashlib import file_digest
import json
import os
from pathlib import Path
import shutil
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

RECIPE = Path(__file__).resolve().parent
MANIFEST = RECIPE / 'native-source-inputs.json'
ARCHIVE_NAME = 'pointercad-occt-source-d98f42dd4b9b6315.zip'
WASM_SHA = 'd98f42dd4b9b631516b391b551cbe390225dfeb8520d4d3c4d7552b3a5964c47'
PACKAGE = 'vendor/opencascade/opencascade.js-b5ff984-closed-' + WASM_SHA[:16]


def facts(stream, size):
    return {'bytes': size, 'sha256': file_digest(stream, 'sha256').hexdigest()}


def fail_unless(condition, message):
    if not condition:
        raise ValueError(message)


def manifest_bytes():
    checked_in = MANIFEST if MANIFEST.is_file() else RECIPE.parents[2] / 'source-manifest.json'
    raw = checked_in.read_bytes()
    manifest = json.loads(raw)
    fail_unless(manifest['format'] == 'pointercad-native-occt-source/1'
                and manifest['wasmSha256'] == WASM_SHA, 'Wrong corresponding-source manifest')
    return manifest, raw


def verify(path):
    manifest, raw = manifest_bytes()
    files = manifest['files']
    with ZipFile(path) as archive:
        expected = set(files) | {'source-manifest.json', 'README.md'}
        fail_unless(set(archive.namelist()) == expected and len(archive.namelist()) == len(expected),
                    'Missing, duplicate or unexpected archive members')
        fail_unless(archive.read('source-manifest.json') == raw, 'Archive manifest differs')
        fail_unless(archive.read('README.md') == archive.read(manifest['readme']), 'Archive README differs')
        for name, item in files.items():
            with archive.open(name) as stream:
                actual = facts(stream, archive.getinfo(name).file_size)
            fail_unless(actual == item['facts'], f'Wrong archived bytes: {name}')
    with path.open('rb') as stream:
        return {'wasmSha256': WASM_SHA, **facts(stream, path.stat().st_size)}


def checked_sources(roots, manifest):
    for name, row in manifest['files'].items():
        root = roots[row['origin']]
        path = root / row['path']
        resolved = path.resolve(strict=True)
        fail_unless(resolved.is_relative_to(root) and resolved.is_file(), f'Invalid source: {path}')
        with resolved.open('rb') as stream:
            fail_unless(facts(stream, resolved.stat().st_size) == row['facts'], f'Wrong source bytes: {path}')
        yield name, resolved


def add_member(archive, name, path):
    info = ZipInfo(name)
    info.compress_type = ZIP_STORED if name.endswith(('.zip', '.tar.gz')) else ZIP_DEFLATED
    with archive.open(info, 'w') as dest, path.open('rb') as source:
        shutil.copyfileobj(source, dest)


def build(args):
    manifest, raw = manifest_bytes()
    roots = {name: getattr(args, name).resolve(strict=True) for name in ('repo', 'native', 'upstream', 'metadata')}
    files = dict(checked_sources(roots, manifest))
    report = files['evidence/materialization.json'].read_bytes()
    installed = roots['repo'] / PACKAGE
    fail_unless((installed / 'materialization.json').read_bytes() == report, 'Package materialization differs')
    for name, expected in json.loads(report)['vendor'].items():
        path = installed / 'dist' / name
        with path.open('rb') as stream:
            fail_unless(facts(stream, path.stat().st_size) == expected, f'Adopted product differs: {name}')
    archive = args.output / ARCHIVE_NAME
    fail_unless(args.output.is_dir(), 'The destination must be an existing packaging directory')
    fail_unless(not os.path.lexists(archive), f'Release asset already exists: {archive.name}')
    return seal_archive(archive, raw, files, manifest['readme'])


def seal_archive(archive, raw, files, readme):
    with NamedTemporaryFile(dir=archive.parent, prefix='.' + archive.name + '.', suffix='.pending',
                            delete=False) as output:
        pending = Path(output.name)
    try:
        with ZipFile(pending, 'w') as writer:
            writer.writestr(ZipInfo('source-manifest.json'), raw)
            add_member(writer, 'README.md', files[readme])
            for name, source in sorted(files.items()):
                add_member(writer, name, source)
        report = verify(pending)
        if os.name == 'nt':
            os.rename(pending, archive)
        else:
            os.link(pending, archive)
        return report
    finally:
        pending.unlink(missing_ok=True)


def main():
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    create = commands.add_parser('build')
    for name in ('repo', 'native', 'upstream', 'metadata', 'output'):
        create.add_argument('--' + name, type=Path, required=True)
    commands.add_parser('verify').add_argument('archive', type=Path)
    args = parser.parse_args()
    archive = args.output / ARCHIVE_NAME if args.operation == 'build' else args.archive
    result = build(args) if args.operation == 'build' else verify(archive)
    print(json.dumps({'archive': archive.name, **result}, indent=2))


if __name__ == '__main__':
    main()
