"""Build the pinned P11 runtime in a NEW directory. Never replace the shipped binary.

python scripts/build-script-runtime.py --output-dir scratchpad/script-runtime-rebuild
Requires clang 22.1.8 with wasm-ld and Python 3.12+. Downloads verified WASI/source
inputs; no global installation, package changes or optional native extensions.
"""
from pathlib import Path
import argparse, hashlib, json, re, shutil, subprocess, tarfile, urllib.request

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'packages/model/src/vendor/script-runtime'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def apply_patch(source, patch):
    """Apply exact unified hunks without fuzzy matching or executing git."""
    original = source.splitlines(keepends=True)
    result, position = [], 0
    lines = patch.splitlines(keepends=True)
    index = 0
    while index < len(lines):
        match = re.match(r'@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@', lines[index])
        if not match:
            index += 1
            continue
        start = int(match.group(1)) - 1
        if start < position: raise ValueError('Overlapping patch hunks')
        result.extend(original[position:start]); position = start; index += 1
        while index < len(lines) and not lines[index].startswith('@@'):
            line = lines[index]; index += 1
            if not line or line[0] not in ' +-': raise ValueError('Unsupported patch line')
            if line[0] in ' -':
                if position >= len(original) or original[position] != line[1:]: raise ValueError('Patch context mismatch')
                position += 1
            if line[0] in ' +': result.append(line[1:])
    result.extend(original[position:])
    return ''.join(result)

def download(item, cache):
    target = cache / item['name']
    if not target.exists():
        with urllib.request.urlopen(item['url'], timeout=60) as response, target.open('xb') as output:
            while chunk := response.read(1024 * 1024): output.write(chunk)
    if target.stat().st_size != item['bytes'] or digest(target) != item['sha256']:
        raise ValueError('Build input checksum mismatch: ' + item['name'])
    return target

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--clang', default=shutil.which('clang'))
    parser.add_argument('--input-cache', default=str(ROOT / 'scratchpad/script-runtime-inputs'))
    args = parser.parse_args()
    if not args.clang: raise ValueError('clang is required')
    build = Path(args.output_dir).resolve()
    if build.exists(): raise ValueError('Output directory must not exist')
    config = json.loads((VENDOR / 'build-config.json').read_text(encoding='utf-8'))
    manifest = json.loads((VENDOR / 'manifest.json').read_text(encoding='utf-8'))
    version = subprocess.check_output([args.clang, '--version'], text=True)
    if not re.search(r'clang version ' + re.escape(config['clangVersion']) + r'\b', version):
        raise ValueError('Compiler version differs from build-config.json')
    cache = Path(args.input_cache).resolve(); cache.mkdir(parents=True, exist_ok=True)
    inputs = {item['name']: download(item, cache) for item in config['inputs']}
    build.mkdir(parents=True)
    extracted = build / 'inputs'; extracted.mkdir()
    for name, archive_path in inputs.items():
        if name.endswith('.tar.gz'):
            with tarfile.open(archive_path, 'r:gz') as archive: archive.extractall(extracted, filter='data')
    qjs = next(extracted.glob('quickjs-*'))
    if digest(qjs / 'quickjs.c') != config['sourceSha256']: raise ValueError('QuickJS source mismatch')
    # Normalize line endings in the patch, including checkouts made on Windows.
    patch = (VENDOR / 'resource-limits.patch').read_text(encoding='utf-8')
    if hashlib.sha256(patch.encode()).hexdigest() != config['patchSha256']: raise ValueError('Patch mismatch')
    shutil.copytree(qjs, build / 'quickjs-ng')
    source = (qjs / 'quickjs.c').read_text(encoding='utf-8')
    (build / 'quickjs-ng/quickjs.c').write_text(apply_patch(source, patch), encoding='utf-8', newline='\n')
    (build / 'c').mkdir(); shutil.copy2(inputs['interface.c'], build / 'c/interface.c')
    resource = build / 'clang-resource'; (resource / 'lib').mkdir(parents=True)
    clang_resource = Path(subprocess.check_output([args.clang, '-print-resource-dir'], text=True).strip())
    shutil.copytree(clang_resource / 'include', resource / 'include')
    shutil.copytree(extracted / 'libclang_rt-32.0/wasm32-unknown-wasip1', resource / 'lib/wasm32-unknown-wasip1')
    flags = [flag.format(sysroot=extracted / 'wasi-sysroot-32.0', resource=resource) for flag in config['flags']]
    command = [str(Path(args.clang).resolve()), *flags]
    (build / 'command.json').write_text(json.dumps(command, indent=2), encoding='utf-8')
    with (build / 'compile.log').open('x', encoding='utf-8') as log:
        subprocess.run(command, cwd=build, stdout=log, stderr=subprocess.STDOUT, check=True)
    output = build / 'quickjs-pcad.wasm'
    actual = {'sha256': digest(output), 'bytes': output.stat().st_size}
    (build / 'result.json').write_text(json.dumps(actual, indent=2), encoding='utf-8')
    if actual['sha256'] != manifest['sha256'] or actual['bytes'] != manifest['bytes']:
        raise ValueError('Rebuilt binary differs; inspect result.json and compile.log')
    print(json.dumps(actual)); print('Rebuild matches the shipped binary. No repository files were replaced.')

if __name__ == '__main__': main()
