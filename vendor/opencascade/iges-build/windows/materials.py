"""Read, inventory and selectively stage the fixed J-04 OCI layers on Windows."""

import argparse
from collections import Counter
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile


HERE = Path(__file__).resolve().parent
RECIPE = HERE.parent
PINS_SHA = '4b8463a26381827ff84cf44af977d4f3f9f3e65a1dda2b10d2a657795cc26dce'
OBSERVED_LAYERS = (9, 11, 18)
LAYERS = {
    9: (32430226, '18966790804f31de3b510c2792744d85836b605636eb25952619d5f5320d9ada'),
    11: (32832162, 'f5c03b3aae754889f5ab63cc70dbfcbce7b7aa14f39d1ece504d81f86bd919f3'),
    13: (95957779, '0c3ec531ebee70e4eaa89353f16e204796a3a70a3e11b117e07e52a681a33953'),
    15: (25219, '3dd08b889f3fd9e0fedf4686d764081cb5b590b1d9a47e6888ab1932342fd085'),
    17: (9528, '3d578cc774ae29425b7359c7870a86cb7818d291b9078c48f3ad0c541ece0610'),
    18: (817495024, '718ff4f930184ca70a0e8d199eb001dc4a95b43a52724734a280de1e1b1b6a41'),
}
ROOTS = ('opencascade.js/build/bindings', 'opencascade.js/build/sources',
         'opencascade.js/src', 'occt/src', 'freetype/include', 'rapidjson/include')
ROOT_FILES = ('occt/LICENSE_LGPL_21.txt', 'occt/OCCT_LGPL_EXCEPTION.txt',
              'freetype/LICENSE.TXT', 'freetype/docs/FTL.TXT', 'freetype/docs/GPLv2.TXT',
              'rapidjson/license.txt', 'rapidjson/LICENSE', 'rapidjson/LICENSE.txt',
              'opencascade.js/Dockerfile', 'opencascade.js/LICENSE')
CHUNK = 1024 * 1024
MAX_DECODED = 8 * 1024**3
MAX_MEMBERS = 350_000
MAX_FILE = 64 * CHUNK
RESERVED = re.compile(r'(?i)(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def new_json(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def clean_name(name):
    path = name.removeprefix('./').rstrip('/')
    require(not name.startswith('/') and path and '\\' not in path and ':' not in path
            and all(part not in ('', '.', '..') for part in path.split('/')),
            f'Unsafe tar path: {name!r}')
    return path


def windows_name(path):
    for part in path.split('/'):
        require(part == part.rstrip(' .') and not RESERVED.match(part)
                and not any(c in '<>"|?*' or ord(c) < 32 for c in part),
                f'Invalid Windows component: {path!r}')


def below(path, root):
    return path == root or path.startswith(root + '/')


def covers(path):
    return any(below(path, root) or below(root, path) for root in (*ROOTS, *ROOT_FILES))


class HashReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size):
        data = self.stream.read(size)
        self.digest.update(data)
        self.size += len(data)
        return data


class BoundedReader:
    def __init__(self, source):
        self.source = source
        self.size = 0

    def read(self, size):
        data = self.source.read(size)
        self.size += len(data)
        require(self.size <= MAX_DECODED, 'Decoded archive exceeds limit')
        return data


def recipe_data(recipe):
    raw = (recipe / 'pins.json').read_bytes()
    require(sha(raw) == PINS_SHA, 'Wrong public recipe pins')
    pins = json.loads(raw)
    base = (recipe / 'opencascade.base.yml').read_bytes()
    require({'bytes': len(base), 'sha256': sha(base)} == pins['configuration']['base'],
            'Wrong baseline binding configuration')
    symbols = {item['symbol'] for item in json.loads(base)['mainBuild']['bindings']}
    return pins, symbols | set(pins['configuration']['add'])


def classify(path, symbols, pins):
    name = path.rpartition('/')[2]
    if path in ROOT_FILES:
        return 'notice-or-recipe'
    if path.startswith('opencascade.js/build/sources/') and name.endswith('.o'):
        return 'excluded-occt-object' if name == 'XBRepMesh.o' else 'occt-object'
    if path.startswith('opencascade.js/build/bindings/'):
        changed = {'opencascade.js/build/bindings/' + item['imagePath'] for item in pins['bindings']}
        if path in changed:
            return 'original-binding'
        for suffix, kind in (('.cpp.o', 'binding-object'), ('.d.ts.json', 'binding-declaration')):
            if name.endswith(suffix) and name.removesuffix(suffix) in symbols:
                return kind
    if path.startswith('opencascade.js/src/') and name.endswith(('.py', '.patch', '.sh', '.json', '.yml')):
        return 'upstream-script'
    if path.startswith('occt/src/') and name.endswith(('.h', '.hxx', '.hpp', '.gxx', '.lxx', '.ixx', '.inl', '.pXX')):
        return 'occt-header'
    if path.startswith(('freetype/include/', 'rapidjson/include/')):
        return 'dependency-header'
    return None


def regular_bytes(source, output):
    digest = hashlib.sha256()
    count = 0
    magic = b''
    while data := source.read(CHUNK):
        if count == 0:
            magic = data[:8]
        digest.update(data)
        count += len(data)
        if output is not None:
            output.write(data)
    return count, digest.hexdigest(), magic.hex()


def layer_path(root, layer):
    _, digest = LAYERS[layer]
    return root / f'layer-{layer}-{digest}.tar.gz'


def reparse(path):
    return bool(path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def check_output_root(root):
    require(os.name == 'nt' and root.is_absolute() and root.drive.upper() == 'D:'
            and root.parent == Path('D:/') and re.fullmatch(r'PointerCAD-IGES-[A-Za-z0-9-]+', root.name),
            'Output must be a new dedicated D:/PointerCAD-IGES-<id> folder')
    require(not os.path.lexists(root) and not reparse(root.parent), 'Output exists or parent is a reparse point')


def stage_file(stage, name):
    cursor = stage
    for part in PurePosixPath(name).parts[:-1]:
        cursor = cursor / part
        cursor.mkdir(exist_ok=True)
        require(cursor.is_dir() and not reparse(cursor), f'Unsafe staging ancestor: {cursor}')
    return cursor / PurePosixPath(name).name


def read_layer(root, layer, symbols, pins, wanted=None, stage=None):
    path = layer_path(root, layer)
    expected_size, expected_sha = LAYERS[layer]
    require(path.is_file() and not reparse(path) and path.stat().st_size == expected_size,
            f'Missing layer or incorrect compressed size: {path}')
    rows, whiteouts, directory_order = [], [], []
    counts = Counter()
    with path.open('rb') as compressed:
        raw = HashReader(compressed)
        with gzip.GzipFile(fileobj=raw) as decoded:
            bounded = BoundedReader(decoded)
            with tarfile.open(fileobj=bounded, mode='r|', bufsize=CHUNK) as archive:
                for ordinal, member in enumerate(archive, 1):
                    require(ordinal <= MAX_MEMBERS, f'Too many members in layer {layer}')
                    archive.members.clear()
                    if member.isdir() and member.name in ('.', './'):
                        continue
                    name = clean_name(member.name)
                    parent, _, leaf = name.rpartition('/')
                    if leaf.startswith('.wh.'):
                        opaque = leaf == '.wh..wh..opq'
                        target = parent if opaque else '/'.join(filter(None, (parent, leaf[4:])))
                        require(member.isfile() and member.size == 0 and (opaque or leaf[4:]),
                                f'Invalid OCI whiteout: {name}')
                        if not target or covers(target):
                            whiteouts.append({'ordinal': ordinal, 'target': target, 'opaque': opaque})
                        continue
                    if not covers(name):
                        continue
                    if member.isdir():
                        directory_order.append([ordinal, name])
                        continue
                    require(not any(prefix.startswith(name + '/') for prefix in (*ROOTS, *ROOT_FILES)),
                            f'Non-directory ancestor in selected tree: {name}')
                    if name.startswith('opencascade.js/build/bindings/'):
                        for suffix in ('.cpp.o', '.d.ts.json', '.cpp'):
                            if name.endswith(suffix):
                                counts[suffix] += 1
                                break
                    kind = classify(name, symbols, pins)
                    if kind is None:
                        require(member.isfile() or not name.startswith(('occt/src/', 'freetype/include/',
                                                                         'rapidjson/include/')),
                                f'Link or special file in selected include tree: {name}')
                        continue
                    windows_name(name)
                    require(member.isfile() and not member.issparse() and 0 <= member.size <= MAX_FILE,
                            f'Unsupported selected file: {name}')
                    if wanted is not None and ordinal not in wanted:
                        continue
                    row = {'path': name, 'layer': layer, 'ordinal': ordinal, 'kind': kind, 'bytes': member.size}
                    dest = None
                    if wanted is not None:
                        expected = wanted[ordinal]
                        require(all(expected[key] == value for key, value in row.items()),
                                f'Pinned member differs: {name}')
                        dest = stage_file(stage, name)
                    with archive.extractfile(member) as source:
                        if dest is None:
                            count, digest, magic = regular_bytes(source, None)
                        else:
                            with dest.open('xb') as output:
                                count, digest, magic = regular_bytes(source, output)
                    require(count == member.size, f'Truncated member: {name}')
                    row.update(sha256=digest, magic=magic)
                    if wanted is not None:
                        require(row == expected, f'Extracted bytes differ: {name}')
                    rows.append(row)
            while bounded.read(CHUNK):
                pass
        require(raw.size == expected_size and raw.digest.hexdigest() == expected_sha,
                f'Compressed bytes do not match layer pin: {path}')
    return {'layer': layer, 'bytes': raw.size, 'sha256': expected_sha, 'decodedBytes': bounded.size,
            'memberCount': ordinal, 'bindingCounts': dict(counts), 'whiteouts': whiteouts,
            'directoryOrder': directory_order, 'files': rows}


def overlay(layers):
    final = {}
    for layer in layers:
        for whiteout in layer['whiteouts']:
            root = whiteout['target']
            for path in list(final):
                if not root or (below(path, root) and (path != root or not whiteout['opaque'])):
                    del final[path]
        current = set()
        for row in layer['files']:
            path = row['path']
            require(path not in current, f'Duplicate member in one layer: {path}')
            current.add(path)
            final[path] = row
    folded = {}
    for path in final:
        parts = PurePosixPath(path).parts
        for index in range(1, len(parts) + 1):
            part = '/'.join(parts[:index])
            require(folded.setdefault(part.casefold(), part) == part, f'Windows case collision: {part}')
            require(index == len(parts) or part not in final, f'File used as directory: {part}')
    return list(final.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('inventory', 'extract'))
    parser.add_argument('--recipe', type=Path, default=RECIPE)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--inventory-sha256')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    pins, symbols = recipe_data(args.recipe)
    if args.mode == 'inventory':
        require(args.output is None and args.inventory.resolve().parent == HERE,
                'Inventory must be written in the assigned folder')
        layers = []
        for layer in LAYERS:
            if not layer_path(args.inputs, layer).exists():
                continue
            receipt = read_layer(args.inputs, layer, symbols, pins)
            layers.append(receipt)
            print(f"Layer {layer}: {receipt['memberCount']} members, {len(receipt['files'])} selected", flush=True)
        final = overlay(layers)
        new_json(args.inventory, {'layers': layers, 'selectedFiles': len(final),
                                  'selectedBytes': sum(row['bytes'] for row in final)})
        return
    raw = args.inventory.read_bytes()
    require(sha(raw) == args.inventory_sha256, 'Inventory SHA-256 differs')
    layers = json.loads(raw)['layers']
    numbers = [row['layer'] for row in layers]
    require(numbers == [number for number in LAYERS if number in numbers]
            and all(number in numbers for number in OBSERVED_LAYERS), 'Incorrect pinned layer inventory')
    final = overlay(layers)
    require(args.output is not None, '--output is required for extraction')
    check_output_root(args.output)
    require(shutil.disk_usage(args.output.anchor).free >= sum(row['bytes'] for row in final) + 5 * 1024**3,
            'Selected materials plus 5 GiB reserve do not fit')
    stage = args.output
    stage.mkdir()
    for layer in layers:
        number = layer['layer']
        wanted = {row['ordinal']: row for row in final
                  if row['layer'] == number and row['kind'] != 'excluded-occt-object'}
        actual = read_layer(args.inputs, number, symbols, pins, wanted, stage)
        require(actual['files'] == [wanted[index] for index in sorted(wanted)] and actual['whiteouts'] == layer['whiteouts']
                and actual['directoryOrder'] == layer['directoryOrder'], f'Layer {number} inventory differs')
    new_json(stage / 'materials-receipt.json', {'inventorySha256': sha(raw),
             'bytes': sum(row['bytes'] for row in final if row['kind'] != 'excluded-occt-object'),
             'files': [row for row in final if row['kind'] != 'excluded-occt-object']})


if __name__ == '__main__':
    main()
