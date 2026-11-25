"""Coordinator entry point for the native Windows J-04 generation."""

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import shutil
import subprocess
import sys

from materials import RECIPE, new_json, overlay, reparse, require, sha


RECIPE_HASHES = {
    'build.py': '6d2fb1a60a57b1dad6160d543579341090ffc8c49b3ce588c437d06b670e1a0e',
    'package.mjs': '8a447bb95273818534d9503012afcc49c9db44f145ca386ca84985a769da584e',
    'pins.json': '4b8463a26381827ff84cf44af977d4f3f9f3e65a1dda2b10d2a657795cc26dce',
}
SDK_HASHES = {
    'bin/clang.exe': 'e74813d31fafc2aa12261b4408a03088957f07d7782235f6c0028772cadd866f',
    'bin/clang++.exe': 'e74813d31fafc2aa12261b4408a03088957f07d7782235f6c0028772cadd866f',
    'bin/wasm-ld.exe': '58d8fb137e69fb79d42141d7cd51c6ecc290202bdd4f67f5b0705d3ba2e9bf45',
    'bin/wasm-opt.exe': 'd1b939fe07f5b0805243f9216353cdd76a8ef47540c39c841d8594c3095393bc',
    'bin/wasm-emscripten-finalize.exe': 'f2ddae7de54ad081b5ad58ff4376eb9d4320c649084dbf0eabd31d4690881e37',
    'bin/llvm-nm.exe': '1cfa93a60c4e3d7f19c07ac5043ebd8b85746d634bcccc71676fb4c24c2b8386',
    'bin/llvm-link.exe': '7fd8584f5c7f130730cba07ad5060a01f643d4c4646256e3d97a6760d6b0d85d',
    'bin/llvm-ar.exe': '30bc4c1a1628c3fe5432266ee027391f858a056cfa12a0cc8fa31276a0ebed48',
    'emscripten/emcc.py': 'bdb1a33573358b683983f5601701e4f0a3d80784776d14174c851187093f740d',
    'emscripten/emscripten-revision.txt': '6c7fbdd42a519ba8ef3dc51987f6c408ad9966ee4089f78b2741a97481dab90a',
    'emscripten/emscripten-version.txt': 'dfb846391c25fdfd4691e3537fb6a0262cfe537689d56cc073c5d2cae4bc1531',
    'emscripten/LICENSE': '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
    'emscripten/tools/config.py': 'f21f93187f039718f4f3b1145b9e478b51bfba9c3bd6c2aa2f8ee7e9a6202cfc',
    'emscripten/tools/shared.py': '6271dcd6877b5099d6c78f5f3e14a7b76cdcc414dc0617dd3a56a6449f4a5616',
    'emscripten/tools/building.py': '6ded06c4a0eab94ab869f5dd03c27e6ecf84203a7376ff1f106e5ccceecf633b',
    'emscripten/tools/response_file.py': '6bf2c02e1e02b3b5ba7b59b85702612bf1c2703d2ea5646b55002d97739e8c52',
    'emscripten/tools/system_libs.py': 'dfe51906887746ed0e45b6fd02309d83360912bc448e109184642b132c883cfc',
}
SDK: Path
SDK_ZIP_SHA = '6bfec6bf6a01e483a57e91f7223340a425f6ff711cbd32a08ed78002810d7882'
INVENTORY_SHA = '7b6dd92bc772053b76370bf03791143de0133c1445e5adc1447f2aed12911a0f'
SOURCE_TAIL = 'type Standard_Boolean = boolean;\n'
RESERVE = 5 * 1024**3


def file_facts(path):
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'sha256': digest}


def open_recipe(recipe, overlay):
    for name, digest in RECIPE_HASHES.items():
        require(file_facts(recipe / name)['sha256'] == digest, f'Public recipe differs: {name}')
    module = runpy.run_path(str(recipe / 'build.py'))
    bindings = module['prepare_bindings']
    bindings.__globals__['IMAGE'] = overlay / 'opencascade.js'
    bindings.__globals__['EMSCRIPTEN'] = SDK / 'emscripten'
    return module


def verify_sdk(pins):
    require(not (SDK / 'emscripten/.git').exists(), 'Unexpected SDK git directory')
    selected = dict(SDK_HASHES)
    prefix = '/emsdk/upstream/'
    selected.update({path.removeprefix(prefix): pin['sha256']
                     for path, pin in pins['imageFiles'].items() if path.startswith(prefix)})
    facts = {}
    for name, digest in selected.items():
        path = SDK / name
        facts[name] = file_facts(path)
        require(facts[name]['sha256'] == digest, f'SDK input differs: {name}')
    return facts


def environment(root, node):
    temp = root / 'temp'
    cache = root / 'cache'
    ports = root / 'ports'
    for folder in (temp, cache, ports):
        folder.mkdir()
    config = root / 'emscripten-config.py'
    with config.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(f'LLVM_ROOT = {(SDK / "bin").as_posix()!r}\n'
                     f'BINARYEN_ROOT = {SDK.as_posix()!r}\n'
                     f'NODE_JS = [{node.as_posix()!r}]\n'
                     f'CACHE = {cache.as_posix()!r}\nPORTS = {ports.as_posix()!r}\n')
    system_root = Path(os.environ['SystemRoot'])
    environ = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT') if key in os.environ}
    environ.update({'PATH': os.pathsep.join(map(str, (Path(sys.executable).parent, node.parent,
                                                   SDK / 'bin', system_root / 'System32'))),
                    'TEMP': str(temp), 'TMP': str(temp), 'TMPDIR': str(temp),
                    'EM_CONFIG': str(config), 'EM_CACHE': str(cache), 'EM_PORTS': str(ports),
                    'EMCC_TEMP_DIR': str(temp), 'EMCC_CORES': '1', 'EM_FORCE_RESPONSE_FILES': '1',
                    'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1', 'threading': 'single-threaded'})
    return environ


def stage_port(archive, flags, module, environ):
    # The original public staging function verifies both hashes, ZIP members and port closure.
    saved = os.environ.copy()
    try:
        os.environ.clear()
        os.environ.update(environ)
        return module['stage_freetype'](archive, flags)
    finally:
        os.environ.clear()
        os.environ.update(saved)


def driver(emcc, response):
    # This fresh process runs the unchanged SDK driver. A cache miss fails before transport.
    require(emcc == SDK / 'emscripten/emcc.py' and response.startswith('@'), 'Unexpected SDK driver entry')
    sys.path.insert(0, str(emcc.parent))
    from tools import config, ports

    original_fetch = ports.Ports.fetch_project

    def offline_fetch(name, url, subdir, sha512hash=None):
        folder = Path(config.PORTS) / name
        require(name == 'freetype' and subdir == 'FreeType-version_1'
                and (folder / subdir).is_dir()
                and (folder / '.emscripten_url').read_text(encoding='utf-8').strip() == url,
                'Unexpected port dependency or offline port cache miss')
        return original_fetch(name, url, subdir, sha512hash)

    ports.Ports.fetch_project = staticmethod(offline_fetch)
    sys.argv = [str(emcc), response]
    runpy.run_path(str(emcc), run_name='__main__')


def parsed_source(path, digest):
    raw = path.read_bytes()
    require(sha(raw) == digest, f'Upstream generator source differs: {path}')
    return ast.parse(raw, filename=str(path))


def declarations(builder, config, old_metadata, added_metadata, historical, raw):
    old = historical.decode('utf-8')
    prefix, separator, _ = old.partition(SOURCE_TAIL)
    require(separator, 'Missing fixed TS suffix in historical d.ts')
    instance = old.split('export type OpenCascadeInstance = {FS: typeof FS} & {\n  ', 1)[1]
    instance = instance.split(';\n};', 1)[0].split(';\n  ')

    def rendered_exports(item):
        return [name + (': typeof ' if item['kind'] == 'class' else ': ') + name for name in item['exports']]

    pending = [(item, item['.d.ts'], rendered_exports(item)) for item in old_metadata
               if item['.d.ts'] or item['exports']]
    ordered = []
    text_at = export_at = 0
    while pending:
        matches = [index for index, (_, text, exports) in enumerate(pending)
                   if prefix.startswith(text, text_at) and instance[export_at:export_at + len(exports)] == exports]
        require(len(matches) == 1, f'Historical declaration order is missing or ambiguous at {text_at}/{export_at}')
        item, text, exports = pending.pop(matches[0])
        ordered.append(item)
        text_at += len(text)
        export_at += len(exports)
    require(text_at == len(prefix) and export_at == len(instance),
            'Historical declaration ordering cannot be recovered from the actual fragments')
    generator = builder.body[-1]
    require(isinstance(generator, ast.If) and isinstance(generator.test, ast.Subscript)
            and isinstance(generator.test.slice, ast.Constant)
            and generator.test.slice.value == 'generateTypescriptDefinitions', 'Unknown declaration generator')

    def writer(path, mode):
        require(Path(path).resolve() == (raw / 'opencascade.closed.d.ts').resolve() and mode == 'w',
                'Unexpected declaration output')
        return Path(path).open('x', encoding='utf-8', newline='\n')

    document = ast.Module(body=generator.body, type_ignores=[])
    scope = {'typescriptDefinitions': ordered + added_metadata, 'buildConfig': config,
             'os': type('OutputDirectory', (), {'getcwd': lambda: raw.as_posix(), 'path': os.path}), 'open': writer}
    exec(compile(document, '<fixed OCJS declaration writer>', 'exec'), scope)
    scope['typescriptDefinitionsFile'].close()


def check_root(root):
    require(os.name == 'nt' and root.is_absolute() and root.parent == Path('D:/')
            and re.fullmatch(r'PointerCAD-IGES-[A-Za-z0-9-]+', root.name)
            and not reparse(root) and not reparse(root.parent),
            'Expected extracted materials in a dedicated D root')


def materialize(args):
    root = args.materials
    work = root / 'native'
    raw = work / 'raw'
    require(not any(reparse(path) for path in (work, raw, work / 'temp')),
            'Unexpected redirect in generation output')
    outputs = json.loads((raw / 'build-outputs.json').read_bytes())
    require(set(outputs) == {f'opencascade.closed.{extension}' for extension in ('js', 'wasm', 'd.ts')}
            and all(file_facts(raw / name) == pin for name, pin in outputs.items()), 'Missing build output proof')
    for name, digest in RECIPE_HASHES.items():
        require(file_facts(args.recipe / name)['sha256'] == digest, f'Public recipe differs: {name}')
    pins = json.loads((args.recipe / 'pins.json').read_bytes())
    baseline = pins['baseline']
    staging = work / 'packaging'
    staging.mkdir()
    recipe_relative = Path('vendor/opencascade/iges-build')

    def copy(source, dest, digest):
        require(file_facts(source)['sha256'] == digest, f'Materializer input differs: {source}')
        dest.parent.mkdir(parents=True, exist_ok=True)
        with source.open('rb') as incoming, dest.open('xb') as output:
            shutil.copyfileobj(incoming, output)

    for name in ('package.mjs', 'pins.json'):
        copy(args.recipe / name, staging / recipe_relative / name, RECIPE_HASHES[name])
    for item in pins['bindings']:
        if item['input'].endswith('.d.ts.json'):
            relative = Path('bindings') / item['input']
            copy(args.recipe / relative, staging / recipe_relative / relative, item['source']['sha256'])
    package_base = Path(baseline['vendor'])
    for name, pin in {**baseline['files'], 'package.json': baseline['package']}.items():
        relative = package_base / name
        copy(args.repository / relative, staging / relative, pin['sha256'])
    patch = Path('vendor/opencascade/patches/opencascade.js@2.0.0-beta.b5ff984.patch')
    copy(args.repository / patch, staging / patch, baseline['patch'])
    node = args.node.resolve(strict=True)
    build_input = json.loads((raw / 'build-inputs.json').read_bytes())
    require(file_facts(node) == build_input['node'], 'Materializer Node differs from the recorded tool')
    temp = str(work / 'temp')
    environ = {'SYSTEMROOT': os.environ['SystemRoot'], 'TEMP': temp, 'TMP': temp, 'TMPDIR': temp}
    command = [str(node), str(staging / recipe_relative / 'package.mjs'), str(raw), str(work / 'vendor')]
    with (work / 'package.log').open('xb') as log:
        subprocess.run(command, check=True, cwd=work, env=environ, stdout=log, stderr=subprocess.STDOUT)


def build(args):
    root = args.materials
    receipt_path = root / 'materials-receipt.json'
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    raw_inventory = args.inventory.read_bytes()
    require(receipt['inventorySha256'] == sha(raw_inventory) == INVENTORY_SHA, 'Unexpected materials inventory')
    inventory = json.loads(raw_inventory)
    require(receipt['files'] == [row for row in overlay(inventory['layers'])
                                 if row['kind'] != 'excluded-occt-object'], 'Incomplete material extraction receipt')
    require(shutil.disk_usage(root).free >= RESERVE, 'At least 5 GiB free is required before generation')
    # Verify the saved inputs again before any compiler action.
    for row in receipt['files']:
        path = root / row['path']
        require(path.resolve().is_relative_to(root) and not reparse(path)
                and file_facts(path) == {key: row[key] for key in ('bytes', 'sha256')},
                f'Extracted material differs: {path}')
    module = open_recipe(args.recipe, root)
    pins = module['PINS']
    versions = verify_sdk(pins)
    config_bytes = module['config_bytes']()
    config = json.loads(config_bytes)
    main = config['mainBuild']
    changed, custom = module['prepare_bindings']()
    installed = (args.repository / pins['baseline']['vendor'] / 'dist/opencascade.full.d.ts').read_bytes()
    require(file_facts(args.repository / pins['baseline']['vendor'] / 'dist/opencascade.full.d.ts')
            == pins['baseline']['files']['dist/opencascade.full.d.ts'], 'Wrong legacy declaration')
    aliases = rb'^// [^\n]*OCCT typedef aliases[^\n]*\ntype Graphic3d_ZLayerId = Standard_Integer;\ntype IntTools_CArray1OfReal = TColStd_Array1OfReal;\ntype Poly_MeshPurpose = number;\ntype XCAFDoc_PartId = TCollection_AsciiString;\n\n'
    historical, removed = re.subn(aliases, b'', installed, flags=re.M)
    require(removed == 1, 'Legacy type aliases are missing or ambiguous')
    require(sha(historical) == pins['baseline']['rawDeclarationSha256'], 'Historical declarations differ')
    source = root / 'opencascade.js/src'
    builder = parsed_source(source / 'buildFromYaml.py', pins['imageFiles']['/opencascade.js/src/buildFromYaml.py']['sha256'])
    compiler = parsed_source(source / 'compileBindings.py', pins['imageFiles']['/opencascade.js/src/compileBindings.py']['sha256'])
    build_one = next(node for node in compiler.body if isinstance(node, ast.FunctionDef) and node.name == 'buildOneFile')
    header = root / 'occt/src/Standard/Standard_Version.hxx'
    for macro, number in zip(('MAJOR', 'MINOR', 'MAINTENANCE'), pins['versions']['occtRelease'].split('.')):
        require(re.search(rb'^\s*#\s*define\s+OCC_VERSION_' + macro.encode() + rb'\s+' + number.encode() + rb'\b',
                          header.read_bytes(), re.MULTILINE), f'Unexpected OCCT header version macro: {macro}')
    node = args.node.resolve(strict=True)
    require(node.is_file() and node.suffix.lower() == '.exe', 'Use an existing Windows Node executable')
    args.work = root / 'native'
    args.work.mkdir()
    raw = args.work / 'raw'
    raw.mkdir()
    environ = environment(args.work, node)
    port = stage_port(args.freetype, main['emccFlags'], module, environ)
    includes = sorted({(Path(row['path']).parent).as_posix() for row in receipt['files']
                       if row['kind'] == 'occt-header'} | {'occt/src'})
    extras = ['rapidjson/include', 'freetype/include/freetype', 'freetype/include']
    rapidjson = module['archive_rapidjson']([root / path for path in includes + extras], raw)
    (raw / 'opencascade.closed.yml').write_bytes(config_bytes)
    commands = []
    emcc = SDK / 'emscripten/emcc.py'

    def run_tool(command):
        result = subprocess.run(command, cwd=root, env=environ, check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
        return result.stdout.strip()

    def run_emcc(command):
        require(command[0] == 'emcc', 'Unexpected upstream subprocess entry')
        arguments = [arg for arg in command[1:] if arg]
        text = shlex.join(arguments)
        require(shlex.split(text) == arguments, 'Driver response argument round trip failed')
        response = args.work / f'emcc-{len(commands):02}.rsp.utf-8'
        with response.open('x', encoding='utf-8', newline='\n') as stream:
            stream.write(text + '\n')
        commands.append({'file': response.name, **file_facts(response), 'arguments': arguments})
        entry = [sys.executable, '-B', '-X', 'utf8', str(Path(__file__).resolve()), '--driver', str(SDK), str(emcc), '@' + str(response)]
        with (args.work / f'emcc-{len(commands) - 1:02}.log').open('xb') as log:
            subprocess.run(entry, check=True, cwd=root, env=environ, stdout=log, stderr=subprocess.STDOUT)

    old_metadata = [json.loads((root / row['path']).read_bytes()) for row in receipt['files']
                    if row['kind'] == 'binding-declaration']
    added_metadata = [json.loads(data) for path, data in changed if path.name.endswith('.d.ts.json')]
    declarations(builder, config, old_metadata, added_metadata, historical, raw)

    probes = {'emcc': run_tool([sys.executable, '-B', '-X', 'utf8', str(emcc), '--version'])}
    version = pins['versions']
    require(f'{version["emscriptenRelease"]}-git ({version["emscripten"]})' in probes['emcc'],
            'Wrong Windows Emscripten driver')
    for tool in ('clang', 'wasm-ld', 'wasm-opt', 'llvm-nm'):
        probes[tool] = run_tool([str(SDK / f'bin/{tool}.exe'), '--version'])
    probes['node'] = run_tool([str(node), '--version'])
    probes['compilerTarget'] = run_tool([str(SDK / 'bin/clang.exe'), '--target=wasm32-unknown-emscripten', '-dumpmachine'])
    require(probes['compilerTarget'] == 'wasm32-unknown-emscripten', 'Unexpected compiler target')
    sources = [row['path'] for row in receipt['files'] if row['kind'] == 'occt-object']
    require(len(sources) == 5387 and all(row['magic'].startswith('4243c0de') for row in receipt['files']
                                         if row['kind'] in ('occt-object', 'binding-object')), 'Unexpected OCCT link objects')
    llvm_ir = args.work / 'target-check.ll'
    run_tool([str(SDK / 'bin/llvm-link.exe'), '-S', sources[0], '-o', str(llvm_ir)])
    probes['imageObjectTarget'] = next(line for line in llvm_ir.read_text(encoding='utf-8').splitlines()
                                       if line.startswith('target triple = '))
    require(probes['imageObjectTarget'] == 'target triple = "wasm32-unknown-emscripten"', 'Non-Emscripten image bitcode')

    generated = args.work / 'generated'
    generated.mkdir()
    cpp = [(target.name, data) for target, data in changed if target.suffix == '.cpp']
    cpp.extend((name, data) for name, data in custom.items() if name.endswith('.cpp'))
    cpp.append((main['name'] + '.cpp', main['additionalBindCode'].encode('utf-8')))
    actual_replacements = {name.removesuffix('.cpp') for name, _ in cpp[:4]}
    require(actual_replacements == set(pins['configuration']['add']), 'Unexpected changed binding sources')
    # The upstream compiler's existence check uses the same root as its child process.
    os.chdir(root)
    compile_scope = {'os': os, 'ocIncludePaths': includes, 'additionalIncludePaths': extras,
                     'subprocess': type('Driver', (), {'check_call': staticmethod(run_emcc)})}
    exec(compile(ast.Module(body=[build_one], type_ignores=[]), '<fixed OCJS compile recipe>', 'exec'), compile_scope)
    object_paths = {}
    for name, data in cpp:
        target = generated / name
        with target.open('xb') as stream:
            stream.write(data)
        rel = target.relative_to(root).as_posix()
        compile_scope['buildOneFile']({'threading': 'single-threaded'}, rel)
        require((root / (rel + '.o')).stat().st_size > 0, f'Missing compiled object: {rel}')
        object_paths[name.removesuffix('.cpp')] = rel + '.o'
    bindings = {Path(row['path']).name.removesuffix('.cpp.o'): row['path'] for row in receipt['files']
                if row['kind'] == 'binding-object'}
    require(len(bindings) == len([row for row in receipt['files'] if row['kind'] == 'binding-object']),
            'Ambiguous binding objects')
    bindings.update({key: object_paths[key] for key in actual_replacements})
    expected = [item['symbol'] for item in main['bindings']]
    require(len(expected) == len(set(expected)) == 248 and set(expected) == set(bindings), 'Wrong binding selection')
    ordered = list(bindings.values())
    require(shutil.disk_usage(root).free >= RESERVE, 'At least 5 GiB free is required before LTO link')
    link = ['emcc', '-lembind', object_paths[main['name']], *ordered, *sources,
            '-o', (raw / main['name']).relative_to(root).as_posix(), *main['emccFlags'], '--output_eol', 'linux']
    build_input = {'schema': 'pointercad-occt-iges-native-input/1', 'image': pins['image'],
                   'sdkRelease': 'ade9d780ff17c88d81aa13860361743e3c1e1396', 'sdkZipSha256': SDK_ZIP_SHA,
                   'sdkFiles': versions, 'node': file_facts(node), 'toolReports': probes,
                   'configuration': module['facts'](config_bytes), 'materialsReceiptSha256': sha(receipt_bytes),
                   'occtVersionHeader': file_facts(header), 'rapidjson': rapidjson, 'freetype': port,
                   'includeOrder': includes + extras, 'bindings': ordered, 'occtObjects': sources,
                   'orderBasis': 'OCI archive ordinal within binding and OCCT groups; r246 did not capture per-object walk order',
                   'compile': commands.copy(), 'link': link[1:], 'threading': 'single-threaded', 'emccCores': 1}
    new_json(raw / 'build-inputs.json', build_input)
    run_emcc(link)
    new_json(raw / 'emcc-commands.json', commands)
    lto = args.work / 'cache/sysroot/lib/wasm32-emscripten/lto'
    new_json(raw / 'sysroot-lto.json', {p.name: file_facts(p) for p in sorted(lto.glob('*.a'))})
    outputs = {f'opencascade.closed.{suffix}': file_facts(raw / f'opencascade.closed.{suffix}')
               for suffix in ('js', 'wasm', 'd.ts')}
    require(all(item['bytes'] for item in outputs.values()), 'Empty raw build output')
    new_json(raw / 'build-outputs.json', outputs)


def main():
    global SDK
    if len(sys.argv) == 5 and sys.argv[1] == '--driver':
        SDK = Path(sys.argv[2])
        driver(Path(sys.argv[3]), sys.argv[4])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--materials', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--recipe', type=Path, default=RECIPE)
    parser.add_argument('--freetype', type=Path, required=True)
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--materialize', action='store_true')
    args = parser.parse_args()
    SDK = args.sdk.resolve(strict=True)
    check_root(args.materials)
    if args.materialize:
        materialize(args)
    else:
        build(args)


if __name__ == '__main__':
    main()
