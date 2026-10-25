import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectFemRuntimeAssets, readFemDistributionGaps } from '../../../../scripts/vite/femRuntimeAssets.mjs';
import { describe, expect, it } from 'vitest';
import {
  assembleSbomDocument, assertSbomMatchesReleaseManifest, assertSbomPublishable, buildSbom,
  collectSbomComponents, femComponentsFromDistribution, deterministicUuid, findSbomGaps, matchSbomToReleaseManifest, verifyFontAssetParity,
} from '../../../../scripts/release/sbom.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const exactMathManifest = JSON.parse(readFileSync(join(root, 'vendor/exact-math/manifest.json'), 'utf8')) as {
  components: Record<string, string[]>; files: Record<string, unknown>;
};
// 本物のpackage.jsonの版を読む(決め打ちの'0.0.0'は版を上げると落ちるため、rules/06 P5)。buildSbomも同じ経路で読む。
const rootPackageVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
type SbomComponent = ReturnType<typeof collectSbomComponents>['components'][number];
const byName = (components: readonly SbomComponent[], name: string) => components.find((item) => item.name === name);

describe('配布に含める依存・固定資産の一覧(SBOM)を作る', () => {
  it('maps every FEM component and emitted part, retains uncertain licenses and rejects altered or absent bytes', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const components = femComponentsFromDistribution(distribution);
    expect(byName(components, 'FEM: oofem')?.version).toBe('3.1.dev5+g214b161ed');
    expect(byName(components, 'FEM: Pyodide')?.version).toBe('0.29.3 / CPython 3.13.2 / Emscripten 4.0.9');
    const paths = new Map<string, string>();
    for (const component of components) for (const entry of component.properties ?? []) {
      if (entry.name === 'pointercad:distributedFile') {
        const [name, digest] = entry.value.split('|'); paths.set(name, digest);
      }
    }
    expect([...paths.keys()].sort()).toEqual([...distribution.assets.keys()].sort());
    for (const [name, digest] of paths) {
      const emitted = distribution.assets.get(name);
      if (!emitted) throw new Error('Expected emitted FEM asset absent: ' + name);
      expect(createHash('sha256').update(emitted).digest('hex'), name).toBe(digest);
    }
    const missing = new Map(distribution.assets);
    missing.delete('fem/assets/pyodide.asm.wasm');
    expect(() => femComponentsFromDistribution({ ...distribution, assets: missing })).toThrow('distributed bytes differ');
    const changed = new Map(distribution.assets);
    changed.set('fem/assets/beamAnalysis.py', Buffer.from('changed'));
    expect(() => femComponentsFromDistribution({ ...distribution, assets: changed })).toThrow('distributed bytes differ');
  });


  it('FEM の部品は oofem・numpy・Pyodide・netgen-mesher の4件で、各部品の原文一式が同梱バイト・source-index と完全に一致し、未分類を保つ', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const components = femComponentsFromDistribution(distribution);
    // The numerical drivers need only numpy; matplotlib, pytest and their 18 exclusive dependencies are not shipped.
    expect(components.filter(item => item.type === 'library').map(item => item.name)).toEqual(['FEM: oofem', 'FEM: numpy', 'FEM: Pyodide', 'FEM: netgen-mesher', 'FEM: pybind11', 'FEM: Netgen pybind11', 'FEM: Netgen zlib', 'FEM: Netgen concurrentqueue', 'FEM: Netgen gzstream']);
    for (const removed of ['atomicwrites', 'attrs', 'contourpy', 'cycler', 'exceptiongroup', 'fonttools', 'iniconfig', 'kiwisolver', 'matplotlib',
      'more-itertools', 'packaging', 'pillow', 'pluggy', 'py', 'pyparsing', 'pytest', 'python-dateutil', 'pytz', 'setuptools', 'six']) {
      expect(byName(components, 'FEM: ' + removed), removed).toBeUndefined();
    }
    // pybind11 is compiled into oofempy.so from its own upstream source, so it is listed by itself, bound to the
    // source-index record of that archive and to the notice oofem already ships. No licence is classified.
    const pybind11 = byName(components, 'FEM: pybind11');
    expect(pybind11?.version).toBe('d6ae0e163a6fb414c81c7f4a98291460e5a18bfe');
    expect(pybind11?.licenses).toBeUndefined();
    expect(pybind11?.properties).toEqual([
      { name: 'pointercad:licenseStatus', value: 'unclassified' },
      { name: 'pointercad:femEmbeddedIn', value: 'FEM: oofem' },
      { name: 'pointercad:femSourceEvidence', value: 'licenses/fem/evidence/source-index.json' },
      { name: 'pointercad:femSourceArchive', value: 'sources/026-pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe.tar.gz|e171d6cd4f855f65e7e12129d4a594999310b7549a737d80aa1ebf3adee32e9b' },
      { name: 'pointercad:distributedFile', value: 'licenses/fem/notices/83965b843b98f670d3a85bd041ed4b372c8ec50d7b4a5995a83ac697ba675dcb.txt|83965b843b98f670d3a85bd041ed4b372c8ec50d7b4a5995a83ac697ba675dcb' },
    ]);
    interface Part { file: string; bytes: number; sha256: string }
    interface Inventory { components: { name: string; version: string; notices: string[] }[]; files: Record<string, { sha256: string; bytes: number; parts: Part[] }> }
    interface NoticeEntry { source: string; member: string; sha256: string; bundlePath: string; extent?: string }
    const read = (name: string): unknown => {
      const bytes = distribution.assets.get(name);
      if (!bytes) throw new Error('FEM distribution file absent: ' + name);
      return JSON.parse(bytes.toString('utf8'));
    };
    const manifest = read('licenses/fem/manifest.json') as Inventory;
    const index = read('licenses/fem/evidence/source-index.json') as { components: { name: string; version: string }[]; noticeEntries: NoticeEntry[] };
    // Only wheels have source-index rows; Pyodide is the platform component and has none.
    expect(index.components.map(entry => entry.name).sort()).toEqual(['netgen-mesher', 'numpy', 'oofem']);
    // [notice SHA-256 (the file name), exact byte length]: the complete shipped notice set of each component.
    const expected: Record<string, [string, number][]> = {
      'netgen-mesher': [['915b533dea3bff17c3fca634928176a4d831c69ce99257809637beebc88596b6', 1478],
        ['a190dc9c8043755d90f8b0a75fa66b9e42d4af4c980bf5ddc633f0124db3cee7', 26430],
        ['b1d90f091e62f5c1e59ea6db105348b20c6404c0c5ed20d91db5235b511ac288', 51]],
      // r14: pybind11's licence, compiled into oofempy.so through the vendored header-only bindings.
      oofem: [['20c17d8b8c48a600800dfd14f95d5cb9ff47066a9641ddeab48dc54aec96e331', 26526], ['83965b843b98f670d3a85bd041ed4b372c8ec50d7b4a5995a83ac697ba675dcb', 1684], ['bf488b13430c036ae911f018798f4a49a28165ee7f2f487371406f11c3659b7f', 1912], ['dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551', 26530]],
      // numpy also links the 7 licence texts of code its 2.2.5 meson build compiles into the shipped wheel
      // (lapack_lite, pocketfft, random distributions, mt19937, pcg64, philox, sfc64).
      // r13: highway (linked into _multiarray_umath) and pythoncapi-compat (header compiled via npy_pycompat.h).
      numpy: [['01fb016849aa427edb1bbbbd55f91c26ca6cadb32a5b20e7f000655dd05b0760', 1543], ['05f3b88351988ecfad10abe92c0c50e5875c6452d5009a0084cc291551ffcca6', 1593],
        ['0e111337b25494a773106695f0e799f642b8567aaacca4f116a74a8177179156', 2926], ['103166b62b80443afb9eb3488e052ea06be0cff566b908f199e561fde49af19f', 3511],
        ['3f2c1ffa76383a55ae0aac01c9737cd70050dff63e1f026694fbe9d662573c98', 690], ['43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1', 11356],
        ['469778be8f33d54e1bcaab28c281cc472916d2d273f835e55bc487d30503face', 2745], ['6f5828a57223d4cc7f8ea505a2623e7b978b242752c1515e355f46ba2cec1800', 1509],
        ['92b12e5a8bdcd0bbf49cf7d7bb061ce3ea2d64902ea9f3c03395e5c063ed30bf', 1498], ['9d4098846018319cd68e228ee6220361787f73bccbf00237a85e4fc9621b998f', 1226],
        ['a14cc25e10d40a3aa705b7de2fb764a6535d8ee9b2db4e1724900585457dfd55', 2266], ['a85ca13fdf90160b64a0698215868c13b74d835ad0a4e2ba44713b8c5058a056', 1498],
        ['d25e82e26acd42ca3ccc9993622631163425b869b9e16284226d534cff6470f2', 1515], ['e7d4f4fb20358f314210a892ae17351e04993813646f697ec387385ca2a36918', 1154],
        ['fbc539f47d0cf83bc61378080fb873d5c14630126cacbfe754035c3926daa5ec', 1018]],
      // r13: CPython, libffi, zlib, bzip2 and the Emscripten runtime libraries compiled into pyodide.asm.wasm (core build files).
      Pyodide: [['122f2c27000472a201d337b9b31f7eb2b52d091b02857061a8880371612d9534', 1144], ['1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d', 16708],
        ['1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5', 16725], ['2c9c2acb9743e6b007b91350475308aee44691d96aa20eacef8e199988c8c388', 1132],
        ['4919cfb14a73cd64fcef67b107613970cf1659a09aa675dba31314f373bc7204', 1901], ['539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b', 16703],
        ['56f7df65203d4858dac19cafe3a84a8c49abaff56b67d32d2d463d5fef6e440b', 28933], ['620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86', 5093],
        ['62f2c9c2c75d511170eb464ad5f83b78cc1f37eb2eb49c2846c9aa6c4557ee99', 55737], ['78b12c3a81360b357002334f0e70ea0e92eebf7a9b358805c03c48484945f3bb', 13809],
        ['845efc77857d485d91fb3e0b884aaa929368c717ae8186b66fe1ed2495753243', 1002], ['899da9d991cb211a3642b84e82a9ae0b4b4e44546fd207e34d7d4ec2eb40f420', 1080],
        ['b5efebcaca80879234098e52d1725e6d9eb8fb96a19fce625d39184b705f7b6d', 16706], ['e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c', 16706],
        ['f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af', 6204]],
    };
    expect(manifest.components.map(item => item.name)).toEqual(['oofem', 'numpy', 'Pyodide', 'netgen-mesher']);
    for (const [name, notices] of Object.entries(expected)) {
      const item = manifest.components.find(entry => entry.name === name);
      expect([...(item?.notices ?? [])].sort(), name).toEqual(notices.map(([digest]) => 'notices/' + digest + '.txt'));
      const component = byName(components, 'FEM: ' + name);
      // No SPDX id or named licence is invented: the grants of these three are not classified (see FEM_LICENSES).
      expect(component?.licenses, name).toBeUndefined();
      expect(component?.properties, name).toContainEqual({ name: 'pointercad:licenseStatus', value: 'unclassified' });
      for (const [digest, length] of notices) {
        const notice = 'notices/' + digest + '.txt';
        const bytes = distribution.assets.get('licenses/fem/' + notice);
        if (!bytes) throw new Error('FEM notice is not distributed: ' + notice);
        // The whole text: exact length and SHA-256 of every byte, equal to the pin and to each recorded upstream source.
        expect(bytes.byteLength, notice).toBe(length);
        expect(createHash('sha256').update(bytes).digest('hex'), notice).toBe(digest);
        expect(manifest.files[notice], notice).toMatchObject({ bytes: length, sha256: digest });
        const entries = index.noticeEntries.filter(entry => entry.bundlePath === notice);
        expect(entries.length, notice).toBeGreaterThan(0);
        expect(entries.map(entry => entry.sha256), notice).toEqual(entries.map(() => digest));
        expect(component?.properties, notice).toContainEqual({ name: 'pointercad:distributedFile', value: 'licenses/fem/' + notice + '|' + digest });
        // A missing or changed notice is refused, never silently dropped from the SBOM.
        const missing = new Map(distribution.assets);
        missing.delete('licenses/fem/' + notice);
        expect(() => femComponentsFromDistribution({ ...distribution, assets: missing }), notice).toThrow('distributed bytes differ');
        const changed = new Map(distribution.assets);
        changed.set('licenses/fem/' + notice, Buffer.concat([bytes, Buffer.from('\n')]));
        expect(() => femComponentsFromDistribution({ ...distribution, assets: changed }), notice).toThrow('distributed bytes differ');
      }
    }
    // Each compiled-in numpy text is recorded from its exact numpy-2.2.5 sdist member.
    const compiledIn: Record<string, string> = {
      '0e111337b25494a773106695f0e799f642b8567aaacca4f116a74a8177179156': 'numpy-2.2.5/numpy/random/src/mt19937/LICENSE.md',
      '469778be8f33d54e1bcaab28c281cc472916d2d273f835e55bc487d30503face': 'numpy-2.2.5/numpy/random/src/distributions/LICENSE.md',
      '6f5828a57223d4cc7f8ea505a2623e7b978b242752c1515e355f46ba2cec1800': 'numpy-2.2.5/numpy/random/src/philox/LICENSE.md',
      '9d4098846018319cd68e228ee6220361787f73bccbf00237a85e4fc9621b998f': 'numpy-2.2.5/numpy/random/src/sfc64/LICENSE.md',
      'a14cc25e10d40a3aa705b7de2fb764a6535d8ee9b2db4e1724900585457dfd55': 'numpy-2.2.5/numpy/linalg/lapack_lite/LICENSE.txt',
      'a85ca13fdf90160b64a0698215868c13b74d835ad0a4e2ba44713b8c5058a056': 'numpy-2.2.5/numpy/fft/pocketfft/LICENSE.md',
      'e7d4f4fb20358f314210a892ae17351e04993813646f697ec387385ca2a36918': 'numpy-2.2.5/numpy/random/src/pcg64/LICENSE.md',
    };
    for (const [digest, member] of Object.entries(compiledIn)) {
      expect(index.noticeEntries.filter(entry => entry.bundlePath === 'notices/' + digest + '.txt').map(entry => entry.member), digest).toContain(member);
    }
    // Each r13 link is recorded from its exact retained upstream member.
    const linkedMembers: Record<string, string> = {
      '83965b843b98f670d3a85bd041ed4b372c8ec50d7b4a5995a83ac697ba675dcb': 'pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe/LICENSE',
      '122f2c27000472a201d337b9b31f7eb2b52d091b02857061a8880371612d9534': 'Python-3.13.2/Modules/expat/COPYING',
      '1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d': 'emscripten-4.0.9/system/lib/compiler-rt/LICENSE.TXT',
      '2c9c2acb9743e6b007b91350475308aee44691d96aa20eacef8e199988c8c388': 'libffi-f08493d249d2067c8b3207ba46693dd858f95db3/LICENSE',
      '3f2c1ffa76383a55ae0aac01c9737cd70050dff63e1f026694fbe9d662573c98': 'numpy-2.2.5/numpy/_core/src/common/pythoncapi-compat/COPYING',
      '43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1': 'numpy-2.2.5/numpy/_core/src/highway/LICENSE',
      '4919cfb14a73cd64fcef67b107613970cf1659a09aa675dba31314f373bc7204': 'bzip2-1.0.6/LICENSE',
      '539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b': 'emscripten-4.0.9/system/lib/libcxx/LICENSE.TXT',
      '56f7df65203d4858dac19cafe3a84a8c49abaff56b67d32d2d463d5fef6e440b': 'emscripten-4.0.9/AUTHORS',
      '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86': 'emscripten-4.0.9/LICENSE',
      '62f2c9c2c75d511170eb464ad5f83b78cc1f37eb2eb49c2846c9aa6c4557ee99': 'Python-3.13.2/Doc/license.rst',
      '78b12c3a81360b357002334f0e70ea0e92eebf7a9b358805c03c48484945f3bb': 'Python-3.13.2/LICENSE',
      '845efc77857d485d91fb3e0b884aaa929368c717ae8186b66fe1ed2495753243': 'zlib-1.3.1/LICENSE',
      'b5efebcaca80879234098e52d1725e6d9eb8fb96a19fce625d39184b705f7b6d': 'emscripten-4.0.9/system/lib/libunwind/LICENSE.TXT',
      'd25e82e26acd42ca3ccc9993622631163425b869b9e16284226d534cff6470f2': 'numpy-2.2.5/numpy/_core/src/highway/LICENSE-BSD3',
      'e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c': 'emscripten-4.0.9/system/lib/libcxxabi/LICENSE.TXT',
      'f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af': 'emscripten-4.0.9/system/lib/libc/musl/COPYRIGHT',
    };
    for (const [digest, member] of Object.entries(linkedMembers)) {
      expect(index.noticeEntries.filter(entry => entry.bundlePath === 'notices/' + digest + '.txt').map(entry => entry.member), digest).toContain(member);
    }
    // dragon4.c contributes only its leading licence comment; the recorded extent stays exact.
    expect(index.noticeEntries.filter(entry => entry.bundlePath === 'notices/92b12e5a8bdcd0bbf49cf7d7bb061ce3ea2d64902ea9f3c03395e5c063ed30bf.txt'))
      .toEqual([expect.objectContaining({ member: 'numpy-2.2.5/numpy/_core/src/multiarray/dragon4.c', extent: 'lines 1-31',
        sha256: '92b12e5a8bdcd0bbf49cf7d7bb061ce3ea2d64902ea9f3c03395e5c063ed30bf' })]);
    // Notices of removed components are no longer shipped (Humor Sans grant, ttconv, PDF core fonts, six MIT text).
    for (const digest of ['94aadc8f2a4dcfbe296e7dffb165c557b8a10d9b6b9e0542f06f9fe0ef79ca83', '7d42f49f29d60bc6b2877bf09f91d7e1ec7eb442cefd5d6bd6a533cfc127fac5',
      '311bfca694884d86006fb96de443b0f4359635921b95fc6c161bb94d013b7292', '4375ba20e2b9c6c4e7cad2940a628fd90e95cc3d50ee92aae755715d8ba1fbd0',
      // libpng, an Emscripten port only Pillow and matplotlib linked.
      '8684217b46550025e78e8e7a133e6b21d3415ad2fb8af189cc7a6a44e9fcef18']) {
      expect(distribution.assets.has('licenses/fem/notices/' + digest + '.txt'), digest).toBe(false);
      expect(manifest.files['notices/' + digest + '.txt'], digest).toBeUndefined();
    }
  });

  it('binds the Pyodide platform tuple to its actual metadata and all six shipped platform assets without classifying licenses', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const component = byName(femComponentsFromDistribution(distribution), 'FEM: Pyodide');
    expect(component?.version).toBe('0.29.3 / CPython 3.13.2 / Emscripten 4.0.9');
    expect(component?.properties).toEqual(expect.arrayContaining([
      { name: 'pointercad:femPlatformVersion', value: '0.29.3' },
      { name: 'pointercad:femPythonVersion', value: '3.13.2' },
      { name: 'pointercad:femEmscriptenVersion', value: '4.0.9' },
      { name: 'pointercad:femPackageIndexVersion', value: '0.28.0.dev0' },
    ]));
    for (const name of ['package.json', 'pyodide-lock.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip']) {
      const path = 'fem/assets/' + name, bytes = distribution.assets.get(path);
      if (!bytes) throw new Error('Expected real platform asset absent: ' + path);
      expect(component?.properties).toContainEqual({ name: 'pointercad:distributedFile',
        value: path + '|' + createHash('sha256').update(bytes).digest('hex') });
    }
    expect(component?.licenses).toBeUndefined();
    expect(component?.properties).toContainEqual({ name: 'pointercad:licenseStatus', value: 'unclassified' });
  });

  it.each(['runtime', 'python', 'emscripten', 'missing', 'duplicate'] as const)(
    'rejects a %s platform component identity that is not the actual shipped tuple', reason => {
      const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
      const bytes = distribution.assets.get('licenses/fem/manifest.json');
      if (!bytes) throw new Error('FEM manifest absent');
      const manifest = JSON.parse(bytes.toString()) as { components: { name: string; version: string }[] };
      const platform = manifest.components.find(item => item.name === 'Pyodide');
      if (!platform) throw new Error('Pyodide component absent');
      if (reason === 'runtime') platform.version = platform.version.replace('0.29.3', '0.29.4');
      if (reason === 'python') platform.version = platform.version.replace('3.13.2', '3.13.3');
      if (reason === 'emscripten') platform.version = platform.version.replace('4.0.9', '4.0.10');
      if (reason === 'missing') manifest.components = manifest.components.filter(item => item.name !== 'Pyodide');
      if (reason === 'duplicate') manifest.components.push({ ...platform });
      const assets = new Map(distribution.assets);
      assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(manifest)));
      expect(() => femComponentsFromDistribution({ ...distribution, assets })).toThrow(
        reason === 'missing' || reason === 'duplicate' ? 'FEM platform component mapping missing' : 'FEM platform version differs');
    },
  );

  it.each(['package.json', 'pyodide-lock.json'])(
    'rejects missing or changed platform metadata bytes at %s instead of trusting the declared version', name => {
      const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
      const path = 'fem/assets/' + name, bytes = distribution.assets.get(path);
      if (!bytes) throw new Error('Platform metadata absent');
      const assets = new Map(distribution.assets);
      assets.delete(path);
      expect(() => femComponentsFromDistribution({ ...distribution, assets })).toThrow('distributed bytes differ');
      assets.set(path, Buffer.concat([bytes, Buffer.from(' ')]));
      expect(() => femComponentsFromDistribution({ ...distribution, assets })).toThrow('distributed bytes differ');
    },
  );

  it('refuses a shipped wheel omitted from the component notice inventory', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const bytes = distribution.assets.get('licenses/fem/manifest.json');
    if (!bytes) throw new Error('FEM manifest absent');
    const manifest = JSON.parse(bytes.toString('utf8')) as { components: { name: string }[] };
    expect(byName(femComponentsFromDistribution(distribution), 'FEM: netgen-mesher')?.version).toBe('6.2.2606.post5.dev0');
    manifest.components = manifest.components.filter(item => item.name !== 'netgen-mesher');
    const assets = new Map(distribution.assets);
    assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(manifest)));
    expect(() => femComponentsFromDistribution({ ...distribution, assets })).toThrow('FEM wheel component/source mapping missing: assets/netgen_mesher-');
  });

  it('FEM の部品と source-index の対応・版の不一致は拒否し、整合した版の変更でも記録の無い分類は付けない', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    interface Part { file: string; bytes: number; sha256: string }
    interface Inventory { components: { name: string; version: string; notices: string[] }[]; files: Record<string, { sha256: string; bytes: number; parts: Part[] }> }
    const read = (name: string): unknown => {
      const bytes = distribution.assets.get(name);
      if (!bytes) throw new Error('FEM distribution file absent: ' + name);
      return JSON.parse(bytes.toString('utf8'));
    };
    const manifest = read('licenses/fem/manifest.json') as Inventory;
    const numpy = (copy: Inventory) => {
      const item = copy.components.find(entry => entry.name === 'numpy');
      if (!item) throw new Error('numpy component absent');
      return item;
    };
    const numpyWith = (change: (copy: Inventory) => void) => {
      const copy = structuredClone(manifest);
      change(copy);
      const assets = new Map(distribution.assets);
      assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(copy)));
      return byName(femComponentsFromDistribution({ ...distribution, assets }), 'FEM: numpy');
    };
    // A component version that no longer equals its source-index record is rejected by the existing mapping check.
    expect(() => numpyWith(copy => { numpy(copy).version = '2.2.6'; })).toThrow('component/source mapping missing: numpy');
    // A notice that is not a mapped, byte-verified distribution file is refused.
    expect(() => numpyWith(copy => { numpy(copy).notices = [...numpy(copy).notices, 'notices/' + '0'.repeat(64) + '.txt']; }))
      .toThrow('FEM SBOM file mapping missing');
    // The source-index mapping (component file and version) stays mandatory.
    const index = read('licenses/fem/evidence/source-index.json') as { components: { name: string; version: string }[] };
    const changedIndex = structuredClone(index);
    const numpySource = changedIndex.components.find(entry => entry.name === 'numpy');
    if (!numpySource) throw new Error('numpy source record absent');
    numpySource.version = '2.2.6';
    const assets = new Map(distribution.assets);
    assets.set('licenses/fem/evidence/source-index.json', Buffer.from(JSON.stringify(changedIndex)));
    expect(() => femComponentsFromDistribution({ ...distribution, assets })).toThrow('component/source mapping missing: numpy');
    // Changing the component version together with the source-index bytes but keeping the source-index part record
    // stale is rejected by facts() (observed in Root run 20261011-201139); the product byte check is not relaxed.
    const changedManifest = structuredClone(manifest);
    numpy(changedManifest).version = '2.2.6';
    assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(changedManifest)));
    expect(() => femComponentsFromDistribution({ ...distribution, assets })).toThrow('FEM SBOM distributed bytes differ: evidence/source-index.json');
    // A fully coherent version change also restates the single source-index part (bytes, digest) and its pin.
    const indexFile = 'licenses/fem/evidence/source-index.json';
    const indexBytes = assets.get(indexFile);
    if (!indexBytes) throw new Error('changed source-index absent');
    const indexPin = changedManifest.files['evidence/source-index.json'];
    expect(indexPin.parts.map(part => part.file)).toEqual([indexFile]);
    const indexDigest = createHash('sha256').update(indexBytes).digest('hex');
    changedManifest.files['evidence/source-index.json'] = { ...indexPin, bytes: indexBytes.byteLength, sha256: indexDigest,
      parts: [{ file: indexFile, bytes: indexBytes.byteLength, sha256: indexDigest }] };
    assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(changedManifest)));
    // That passes the mapping and every byte check, and still carries no licence: nothing is recorded for numpy.
    const coherent = byName(femComponentsFromDistribution({ ...distribution, assets }), 'FEM: numpy');
    expect(coherent?.version).toBe('2.2.6');
    expect(coherent?.licenses).toBeUndefined();
    expect(coherent?.properties).toContainEqual({ name: 'pointercad:licenseStatus', value: 'unclassified' });
  });

  it('FEM の応用ソース書庫と索引は、配布バイト・索引の書庫 SHA-256・manifest の固定値が一致し、書庫の欠け・改変を拒否する', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    interface Part { file: string; bytes: number; sha256: string }
    const manifestBytes = distribution.assets.get('licenses/fem/manifest.json');
    const appIndexBytes = distribution.assets.get('licenses/fem/evidence/application-source-index.json');
    if (!manifestBytes || !appIndexBytes) throw new Error('FEM manifest/application index absent');
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      applicationSource: { archive: string; index: string; completeRuntimeCorrespondingSourceClaim: boolean };
      files: Record<string, { sha256: string; bytes: number; parts: Part[] }>;
      correspondingSourceComplete: boolean; nativeRebuildExecuted: boolean; legalClearance: boolean };
    const appIndex = JSON.parse(appIndexBytes.toString('utf8')) as { archiveSha256: string; correspondingSourceComplete: boolean; nativeRebuildExecuted: boolean };
    expect(manifest.applicationSource).toEqual({ archive: 'sources/pointercad-beam-application-source.zip', index: 'evidence/application-source-index.json',
      completeRuntimeCorrespondingSourceClaim: false });
    const pin = manifest.files['sources/pointercad-beam-application-source.zip'];
    const joined = Buffer.concat(pin.parts.map(part => {
      const bytes = distribution.assets.get(part.file);
      if (!bytes) throw new Error('application archive part absent: ' + part.file);
      return bytes;
    }));
    expect(joined.byteLength).toBe(pin.bytes);
    expect(createHash('sha256').update(joined).digest('hex')).toBe(pin.sha256);
    expect(appIndex.archiveSha256).toBe(pin.sha256);
    // Technical native rebuild is proven; source correspondence and legal clearance remain incomplete.
    expect([manifest.correspondingSourceComplete, manifest.nativeRebuildExecuted, manifest.legalClearance]).toEqual([false, true, false]);
    expect([appIndex.correspondingSourceComplete, appIndex.nativeRebuildExecuted]).toEqual([false, false]);
    const first = pin.parts[0].file;
    const missing = new Map(distribution.assets);
    missing.delete(first);
    expect(() => femComponentsFromDistribution({ ...distribution, assets: missing })).toThrow('distributed bytes differ');
    const changed = new Map(distribution.assets);
    const original = distribution.assets.get(first);
    if (!original) throw new Error('application archive part absent: ' + first);
    const altered = Buffer.from(original);
    altered[0] = (altered[0] + 1) % 256;
    changed.set(first, altered);
    expect(() => femComponentsFromDistribution({ ...distribution, assets: changed })).toThrow('distributed bytes differ');
  });

  it('FEM の pybind11 部品は source-index の記録が欠けると黙って消えずに止まる', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const bytes = distribution.assets.get('licenses/fem/evidence/source-index.json');
    if (!bytes) throw new Error('FEM source-index absent');
    interface Index { buildEvidence: { pybind11Gitlink?: string }; noticeEntries: { source: string; bundlePath: string }[]; materials: { components: string[]; url: string | null }[] }
    const original = JSON.parse(bytes.toString('utf8')) as Index;
    const run = (change: (copy: Index) => void) => {
      const copy = structuredClone(original);
      change(copy);
      const assets = new Map(distribution.assets);
      assets.set('licenses/fem/evidence/source-index.json', Buffer.from(JSON.stringify(copy)));
      return () => femComponentsFromDistribution({ ...distribution, assets });
    };
    // A second pybind version or build recipe must not replace the exact OOFEM gitlink.
    expect(original.materials.filter(item => item.components.includes('pybind11')).length).toBeGreaterThan(1);
    expect(run(copy => {
      copy.materials = copy.materials.filter(item => !String(item.url).endsWith('/' + copy.buildEvidence.pybind11Gitlink));
    })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => {
      const matched = copy.materials.find(item => String(item.url).endsWith('/' + copy.buildEvidence.pybind11Gitlink));
      if (!matched) throw new Error('Expected exact OOFEM source material');
      copy.materials.push(structuredClone(matched));
    })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => { delete copy.buildEvidence.pybind11Gitlink; })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => { copy.buildEvidence.pybind11Gitlink = '0'.repeat(40); })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => { copy.noticeEntries = copy.noticeEntries.filter(entry => !entry.source.endsWith('/pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe.tar.gz')); }))
      .toThrow('FEM embedded component notice missing: pybind11');
  });

  it('FEM retains the four unrelated distribution blockers after technical native proof', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const manifestBytes = distribution.assets.get('licenses/fem/manifest.json');
    if (!manifestBytes) throw new Error('FEM manifest absent');
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { unresolved: string[] };
    const unresolved = [
      '歴史的なビルド環境と静的に含まれる部品の対応付けは未完了です。',
      'IML の指定ソースの出典・許諾根拠と NIST notice は保持済みです。製品全体の法的確認の完了は主張しません。',
      'ソース提供・差替えの配布条件と製品の条項について法的確認が残っています。',
      '列挙済みの OOFEM・Pyodide・Netgen の部品と保持資料は一覧へ対応付け済みですが、静的・コンパイラー実行時依存と NumPy 内包部品の完全な対応は未完了です。',
    ];
    expect(manifest.unresolved).toEqual(unresolved);
    expect(readFemDistributionGaps(join(root, 'packages/fem/runtime'))).toEqual([...unresolved.map(item => 'FEM: ' + item),
      'FEM: corresponding source closure is incomplete']);
  });

  it('直接・推移のnpm依存11件をCycloneDXのlibrary部品として集める', () => {
    const { components } = collectSbomComponents(root);
    for (const name of ['comlink', 'decimal.js', 'fflate', 'mathlive', 'opencascade.js', 'opentype.js', 'react', 'react-dom', 'scheduler', 'three', 'zustand']) {
      const component = byName(components, name);
      expect(component?.type, name).toBe('library');
      expect(component?.purl, name).toBe(`pkg:npm/${name}@${component?.version}`);
      expect(component?.properties?.some((entry) => entry.name === 'pointercad:distributedFile' && entry.value.startsWith(`licenses/runtime/`)), name).toBe(true);
    }
    expect(components.filter((item) => item.type === 'library' && item.purl?.startsWith('pkg:npm/'))).toHaveLength(11);
  });

  it('OCCTのLGPL例外条項をopencascade.js部品の配布資産として記録する(P13-6c)', () => {
    const { components } = collectSbomComponents(root);
    const occt = byName(components, 'opencascade.js');
    expect(occt?.licenses).toEqual([{ license: { id: 'LGPL-2.1-only' } }]);
    const distributed = occt?.properties?.filter((entry) => entry.name === 'pointercad:distributedFile') ?? [];
    expect(distributed).toHaveLength(2);
    expect(distributed.some((entry) => entry.value.startsWith('licenses/runtime/runtime-opencascade.js-2.0.0-beta.b5ff984-license.txt|'))).toBe(true);
    expect(distributed.some((entry) => entry.value.startsWith('licenses/runtime/runtime-opencascade.js-2.0.0-beta.b5ff984-lgpl-exception.txt|'))).toBe(true);
  });

  it('数式字体20個と数式の追加原文2件を固定資産として集め、既存のnpm部品と二重計上しない', () => {
    const { components } = collectSbomComponents(root);
    const fonts = components.filter((item) => item.type === 'file' && item.name.endsWith('.woff2'));
    expect(fonts).toHaveLength(20);
    for (const font of fonts) {
      expect(font.hashes?.[0]?.alg).toBe('SHA-256');
      expect(font.hashes?.[0]?.content).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(byName(components, 'mathlive-fonts.txt')?.licenses).toEqual([{ license: { id: 'OFL-1.1' } }]);
    expect(byName(components, 'ofl-1.1.txt')).toBeDefined();
    expect(components.filter((item) => item.name === 'decimal.js' || item.name === 'mathlive')).toHaveLength(2);
    const mathlive = byName(components, 'mathlive');
    expect(mathlive?.properties?.filter((entry) => entry.name === 'pointercad:distributedFile')).toHaveLength(2);
  });

  it('自動作図(QuickJS-ng)の原文12件と実行バイナリを集め、出典URLから発行元を機械的に判定する', () => {
    const { components } = collectSbomComponents(root);
    const scriptRuntimeNotices = components.filter((item) => item.externalReferences?.[0]?.url.startsWith('https://raw.githubusercontent.com/'));
    expect(scriptRuntimeNotices).toHaveLength(12);
    expect(scriptRuntimeNotices.some((item) => item.name.startsWith('quickjs-ng ('))).toBe(true);
    expect(scriptRuntimeNotices.some((item) => item.name.startsWith('wasi-libc ('))).toBe(true);
    expect(scriptRuntimeNotices.every((item) => item.licenses?.length === 1)).toBe(true);
    const wasm = byName(components, 'quickjs-pcad.wasm');
    expect(wasm?.hashes?.[0]?.content).toMatch(/^[a-f0-9]{64}$/u);
    // P13-6b: the wasm is compiled from the exact quickjs-ng commit pinned below, so it now
    // carries that notice's confirmed MIT license instead of being reported unclassified.
    expect(wasm?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus')).toBe(false);
    expect(wasm?.licenses).toEqual([{ license: { id: 'MIT' } }]);
  });

  it('自動作図の原文12件は、同梱原文に書かれた組合せだけをSPDX識別子/式として記録する(P13-6b)', () => {
    const { components } = collectSbomComponents(root);
    const named = (file: string) => components.find((item) => item.name.endsWith(`(${file})`));
    // 単一のSPDX識別子(原文がその1つの標準条文とだけ一致するもの)。
    expect(named('quickjs-ng.txt')?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(named('script-wasi-libc-apache.txt')?.licenses).toEqual([{ license: { id: 'Apache-2.0' } }]);
    expect(named('script-wasi-libc-mit.txt')?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(named('script-cloudlibc.txt')?.licenses).toEqual([{ license: { id: 'BSD-2-Clause' } }]);
    expect(named('script-musl.txt')?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(named('script-musl-fts.txt')?.licenses).toEqual([{ license: { id: 'BSD-3-Clause' } }]);
    expect(named('script-dlmalloc.txt')?.licenses).toEqual([{ license: { id: 'CC0-1.0' } }]);
    // SPDX式(原文自身がその組合せを明記しているもの)。
    expect(named('script-wasi-libc-license.txt')?.licenses).toEqual([{ expression: 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT' }]);
    expect(named('script-wasi-libc-apache-llvm.txt')?.licenses).toEqual([{ expression: 'Apache-2.0 WITH LLVM-exception' }]);
    expect(named('script-emmalloc.txt')?.licenses).toEqual([{ expression: 'MIT OR NCSA' }]);
    expect(named('script-compiler-rt.txt')?.licenses).toEqual([{ expression: 'NCSA OR MIT' }]);
    expect(named('script-emscripten-license.txt')?.licenses).toEqual([{ expression: 'MIT OR NCSA' }]);
    for (const file of ['quickjs-ng.txt', 'script-wasi-libc-license.txt', 'script-wasi-libc-apache.txt', 'script-wasi-libc-apache-llvm.txt',
      'script-wasi-libc-mit.txt', 'script-cloudlibc.txt', 'script-musl.txt', 'script-musl-fts.txt', 'script-dlmalloc.txt',
      'script-emmalloc.txt', 'script-compiler-rt.txt', 'script-emscripten-license.txt']) {
      expect(named(file)?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus'), file).toBe(false);
    }
  });

  it('追加計算部(Pyodide/SymPy/mpmath等)の21部品と、原文以外の実配布ファイルを集める', () => {
    const { components } = collectSbomComponents(root);
    const grouped = components.filter((item) => item.type === 'library' && Object.hasOwn(exactMathManifest.components, item.name));
    expect(grouped).toHaveLength(21);
    expect(byName(components, 'Pyodide 314.0.6')).toBeDefined();
    const notices = Object.keys(exactMathManifest.files).filter((name) => name.startsWith('notices/')).length;
    const others = Object.keys(exactMathManifest.files).length - notices;
    const ungrouped = components.filter((item) => item.properties?.some((entry) => entry.name === 'pointercad:vendorPath'));
    expect(ungrouped).toHaveLength(others);
    const bigSource = ungrouped.find((item) => item.properties?.some((entry) => entry.value.includes('Python-3.14.2.tgz')));
    expect(bigSource?.properties?.some((entry) => entry.name === 'pointercad:distributedFile')).toBe(false);
  });

  it('追加計算部21件のうち20件は同梱原文と一致するSPDX識別子/式を持ち、liblzmaは同梱原文の公有宣言を名前付き(非SPDX)の許諾として正確な本文で記録する', () => {
    const { components } = collectSbomComponents(root);
    const expectedSingle: Record<string, string> = {
      'SQLite 3.39.0': 'blessing',
      'Pyodide 314.0.6': 'MPL-2.0', 'Hiwire 6a1e67280a15d929ebeceee54a6358c9c8d5f697': 'MPL-2.0', 'CPython 3.14.2': 'PSF-2.0',
      'libffi f08493d249d2067c8b3207ba46693dd858f95db3': 'MIT', 'zlib 1.3.1': 'Zlib', 'bzip2 1.0.6': 'bzip2-1.0.6',
      'zstd 1.5.7': 'BSD-3-Clause', 'musl in Emscripten 5.0.3': 'MIT', 'MiniLZ4 in Emscripten 5.0.3': 'MIT',
      'HACL in CPython 3.14.2': 'MIT', 'libmpdec in CPython 3.14.2': 'BSD-2-Clause', 'Expat in CPython 3.14.2': 'MIT',
      'StackFrame and ErrorStackParser in Pyodide 314.0.6': 'MIT', 'mpmath 1.3.0': 'BSD-3-Clause',
    };
    for (const [name, id] of Object.entries(expectedSingle)) {
      expect(byName(components, name)?.licenses, name).toEqual([{ license: { id } }]);
      expect(byName(components, name)?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus'), name).toBe(false);
    }
    const expectedExpression: Record<string, string> = {
      'Emscripten 5.0.3': 'MIT OR NCSA', 'libc++ in Emscripten 5.0.3': 'NCSA OR MIT', 'libc++abi in Emscripten 5.0.3': 'NCSA OR MIT',
      'compiler-rt in Emscripten 5.0.3': 'NCSA OR MIT', 'sympy 1.14.0': 'BSD-3-Clause AND MIT',
    };
    for (const [name, expression] of Object.entries(expectedExpression)) {
      expect(byName(components, name)?.licenses, name).toEqual([{ expression }]);
    }
    expect(Object.keys(expectedSingle)).toHaveLength(15);
    expect(Object.keys(expectedExpression)).toHaveLength(5);
    // liblzma: XZ's own public-domain declaration, by name with the exact pinned COPYING text; never CC0-1.0 or Unlicense.
    const xzPin = exactMathManifest.files['notices/xz-5.2.2-COPYING.txt'] as { sha256: string; bytes: number };
    const xzText = readFileSync(join(root, 'vendor/exact-math/notices/xz-5.2.2-COPYING.txt'));
    expect(createHash('sha256').update(xzText).digest('hex')).toBe(xzPin.sha256);
    expect(exactMathManifest.components['liblzma from XZ 5.2.2']).toContain('xz-5.2.2-COPYING.txt');
    const liblzma = byName(components, 'liblzma from XZ 5.2.2');
    expect(liblzma?.licenses).toEqual([{ license: { name: 'XZ Utils public domain declaration (liblzma)', text: { contentType: 'text/plain', content: xzText.toString('utf8') } } }]);
    // The whole pinned COPYING text is compared above as one exact string (no partial-text checks, no SPDX id).
    expect(liblzma?.properties).toContainEqual({ name: 'pointercad:licenseStatus', value: 'named-non-spdx' });
    expect(liblzma?.properties).not.toContainEqual({ name: 'pointercad:licenseStatus', value: 'unclassified' });
    expect(liblzma?.properties).toContainEqual({ name: 'pointercad:distributedFile', value: 'licenses/exact-math/notices/xz-5.2.2-COPYING.txt|' + xzPin.sha256 });
  });

  it('画面・図面用フォント(Noto Sans JP)を集め、WebとDesktopの内容が一致することを確かめる', () => {
    const files = verifyFontAssetParity(root);
    expect(files.size).toBeGreaterThanOrEqual(2);
    const { components } = collectSbomComponents(root);
    const font = byName(components, 'NotoSansJP-Regular.otf');
    expect(font?.licenses).toEqual([{ license: { id: 'OFL-1.1' } }]);
    expect(font?.properties?.[0]?.value).toMatch(/^fonts\/LICENSES\.txt\|[a-f0-9]{64}$/u);
    // P13-6b: name/version/license/hash now come from the new font-notices.json record.
    expect(font?.version).toBe('Sans2.004');
  });

  it('説明書だけに埋め込む字体(Noto Sans・Noto Sans Math)を固定資産として集める', () => {
    const { components } = collectSbomComponents(root);
    for (const [file, version] of [['NotoSans-Regular.otf', '2.015'], ['NotoSansMath-Regular.otf', '3.000']] as const) {
      const font = byName(components, file);
      expect(font?.type, file).toBe('file');
      expect(font?.version, file).toBe(version);
      expect(font?.licenses, file).toEqual([{ license: { id: 'OFL-1.1' } }]);
      expect(font?.hashes?.[0]?.alg, file).toBe('SHA-256');
      expect(font?.hashes?.[0]?.content, file).toMatch(/^[a-f0-9]{64}$/u);
      expect(font?.properties?.some((entry) => entry.name === 'pointercad:distributionNote'), file).toBe(true);
      // 画面・図面用フォント(NotoSansJP-Regular.otf)と二重計上しない別部品であること。
      expect(font?.name).not.toBe('NotoSansJP-Regular.otf');
    }
  });

  it('CycloneDXの文書形状(bomFormat・specVersion・決定的なUUID)を組み立てる', () => {
    const sbom = buildSbom(root, { sourceCommit: '1'.repeat(40) });
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.6');
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(sbom.metadata.component).toEqual({ type: 'application', name: 'PointerCAD', version: rootPackageVersion });
    expect(deterministicUuid('same-seed')).toBe(deterministicUuid('same-seed'));
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
  });

  it('壊れた入力を拒否する: 版・commit・重複部品・不正なハッシュ', () => {
    const good = collectSbomComponents(root);
    expect(() => assembleSbomDocument(good, { rootPackageVersion: 'not-a-version' })).toThrow('root package version');
    expect(() => assembleSbomDocument(good, { rootPackageVersion: '1.0.0', sourceCommit: 'short' })).toThrow('source commit');
    expect(() => assembleSbomDocument({ components: [], unresolvedNotices: [] }, { rootPackageVersion: '1.0.0' })).toThrow('no components');
    const duplicate = { components: [good.components[0], good.components[0]], unresolvedNotices: [] };
    expect(() => assembleSbomDocument(duplicate, { rootPackageVersion: '1.0.0' })).toThrow('Duplicate SBOM component');
    const badHash = { components: [{ ...good.components[0], hashes: [{ alg: 'SHA-256', content: 'zz' }] }], unresolvedNotices: [] };
    expect(() => assembleSbomDocument(badHash, { rootPackageVersion: '1.0.0' })).toThrow('Invalid SBOM component hash');
    const badType = { components: [{ ...good.components[0], type: 'application' }], unresolvedNotices: [] };
    expect(() => assembleSbomDocument(badType, { rootPackageVersion: '1.0.0' })).toThrow('Invalid SBOM component type');
  });

  it('原文が全く無い(unresolved)場合と、SPDX識別子が未分類の場合を区別して一覧にする', () => {
    const sbom = buildSbom(root);
    const gaps = findSbomGaps(sbom);
    expect(gaps.unresolvedNotices).toEqual(readFemDistributionGaps(join(root, 'packages/fem/runtime')));
    expect(new Set(gaps.unresolvedNotices).size).toBe(gaps.unresolvedNotices.length);
    expect(gaps.unresolvedNotices).not.toContain('FEM: native rebuild and replacement remain unqualified');
    expect(gaps.unresolvedNotices).toContain('FEM: corresponding source closure is incomplete');
    // SQLiteは原文と公式blessing全文を照合済み。liblzmaは別の標準条文を推測で割り当てず、同梱原文の名前付き許諾として未分類から外す。
    const fem = JSON.parse(readFileSync(join(root, 'packages/fem/runtime/manifest.json'), 'utf8')) as { components: { name: string }[] };
    // FEM の部品は oofem・numpy・Pyodide・netgen-mesher の4件で、どれにも推測で SPDX や名前付き許諾を割り当てない(numpy の原文一式の網羅は未証明)。
    expect(fem.components.map(item => item.name)).toEqual(['oofem', 'numpy', 'Pyodide', 'netgen-mesher']);
    expect(gaps.unclassifiedLicenses).toEqual(['FEM: oofem', 'FEM: numpy', 'FEM: Pyodide', 'FEM: netgen-mesher', 'FEM: pybind11', 'FEM: Netgen pybind11', 'FEM: Netgen zlib', 'FEM: Netgen concurrentqueue', 'FEM: Netgen gzstream']);
    expect(gaps.noLicenseInformation).toEqual([]);
    expect(() => assertSbomPublishable(sbom)).toThrow('Unresolved SBOM notices');
    const withGap = { ...sbom, metadata: { ...sbom.metadata, properties: [...sbom.metadata.properties, { name: 'pointercad:unresolvedNotice', value: 'missing@1.0.0' }] } };
    expect(() => assertSbomPublishable(withGap)).toThrow('Unresolved SBOM notices');
  });

  it('release-manifest.json(P13-1)の資産一覧と原文の経路・ハッシュを照合する', () => {
    const sbom = buildSbom(root);
    const files = [];
    for (const component of sbom.components) {
      for (const entry of component.properties ?? []) {
        if (entry.name !== 'pointercad:distributedFile') continue;
        const [path, sha256] = entry.value.split('|');
        files.push({ path, bytes: 1, sha256 });
      }
    }
    expect(files.length).toBeGreaterThan(50);
    const okManifest = { web: { files } };
    expect(matchSbomToReleaseManifest(sbom, okManifest)).toEqual({ checked: files.length, missing: [], mismatched: [] });
    expect(() => assertSbomMatchesReleaseManifest(sbom, okManifest)).not.toThrow();

    const missingManifest = { web: { files: files.slice(1) } };
    const missingResult = matchSbomToReleaseManifest(sbom, missingManifest);
    expect(missingResult.missing).toHaveLength(1);
    expect(() => assertSbomMatchesReleaseManifest(sbom, missingManifest)).toThrow('missing SBOM files');

    const tamperedManifest = { web: { files: [{ ...files[0], sha256: files[0].sha256.replace(/^./u, files[0].sha256[0] === 'a' ? 'b' : 'a') }, ...files.slice(1)] } };
    const tamperedResult = matchSbomToReleaseManifest(sbom, tamperedManifest);
    expect(tamperedResult.mismatched).toHaveLength(1);
    expect(() => assertSbomMatchesReleaseManifest(sbom, tamperedManifest)).toThrow('hash differs from SBOM');
  });

  it('壊れたrelease-manifest入力を拒否する', () => {
    const sbom = buildSbom(root);
    expect(() => matchSbomToReleaseManifest(sbom, {})).toThrow('Invalid release manifest');
    expect(() => matchSbomToReleaseManifest(sbom, { web: { files: [{ path: 'x', sha256: 'not-a-hash' }] } })).toThrow('Invalid release manifest file entry');
    expect(() => matchSbomToReleaseManifest({ components: null }, { web: { files: [] } })).toThrow('Invalid SBOM document');
  });

  /**
   * CycloneDX 1.6 official schema (docs/standards/licenses/cyclonedx-*.schema.json, verified in
   * cyclonedx-schema-verification.json against the CycloneDX/specification repository at tag
   * 1.6) machine-checks every SPDX id this file records, so an id that is not on SPDX's own
   * list (like the "Expat" mistake this test replaces, P13-6b/P13-6c) fails a real schema
   * check instead of only an equality assertion against a value this file itself chose. Uses
   * the already-installed ajv 6.15.0 (draft-07 validator; no new dependency, see module doc).
   */
  it('CycloneDX 1.6公式スキーマで全85部品が合格し、SPDX一覧に無い識別子を機械的に検出する(P13-6c)', async () => {
    interface AjvValidateFunction { (data: unknown): boolean; errors?: unknown }
    interface AjvInstance {
      addSchema(schema: unknown, key: string): AjvInstance;
      compile(schema: unknown): AjvValidateFunction;
    }
    interface AjvConstructorOptions { allErrors?: boolean; schemaId?: string; unknownFormats?: string[] }
    interface AjvConstructor { new (options?: AjvConstructorOptions): AjvInstance }

    const readSchema = (name: string) => JSON.parse(readFileSync(join(root, 'docs/standards/licenses', name), 'utf8')) as unknown;
    const ajvEntry = join(root, 'node_modules/.pnpm/ajv@6.15.0/node_modules/ajv/lib/ajv.js');
    const ajvModule = await import(pathToFileURL(ajvEntry).href) as { default: AjvConstructor };
    const Ajv = ajvModule.default;
    const ajv = new Ajv({ allErrors: true, schemaId: 'auto', unknownFormats: ['iri-reference', 'idn-email'] });
    ajv.addSchema(readSchema('cyclonedx-spdx.schema.json'), 'spdx.schema.json');
    ajv.addSchema(readSchema('cyclonedx-jsf-0.82.schema.json'), 'jsf-0.82.schema.json');
    const validate = ajv.compile(readSchema('cyclonedx-bom-1.6.schema.json'));

    const sbom = buildSbom(root, { sourceCommit: '1'.repeat(40) });
    const fem = JSON.parse(readFileSync(join(root, 'packages/fem/runtime/manifest.json'), 'utf8')) as { components: unknown[]; files: Record<string, unknown> };
    // Existing inventory plus the five explicitly retained Netgen dependency/header records.
    expect(sbom.components).toHaveLength(87 + fem.components.length + Object.keys(fem.files).length + 2 + 1 + 5);
    const valid = validate(sbom);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);

    // A component whose license id is not on SPDX's own list must fail this same schema check
    // (the exact mistake 'Expat' was: readable prose, but absent from the official enum).
    const tampered = { ...sbom, components: sbom.components.map((component) =>
      component.name === 'CPython 3.14.2' ? { ...component, licenses: [{ license: { id: 'not-a-real-spdx-id' } }] } : component) };
    expect(validate(tampered)).toBe(false);
  });
});
