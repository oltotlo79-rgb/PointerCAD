import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOLT_CONTACT_ASSETS, FEM_ASSETS, NETGEN_ASSETS, SOLID_ASSETS, SOLID_BUCKLING_ASSETS, SOLID_MODAL_ASSETS,
  SOLID_PLASTIC_ASSETS } from './assets.js';
import { BEAM_IMPACT_ASSETS } from './beamImpactAssets.js';
import { JOINT_CONTACT_ASSETS } from './beamJointAssets.js';
import { JOINT_INITIAL_STRAIN_ASSETS } from './beamJointInitialStrainAssets.js';
import { WELD_CONTACT_ASSETS } from './beamWeldAssets.js';
import { WELD_SPAN_CONTACT_ASSETS } from './beamWeldSpanAssets.js';
import { FemClient, type FemWorkerPort } from './client.js';
import { FRICTION_CONTACT_ASSETS } from './frictionContactAssets.js';
import { qualifyInBrowser } from './offlineBrowser.js';
import { FEM_PROTOCOL, FEM_RUNTIME_VERSION, type FemIdentity, type FemRequest } from './protocol.js';
import { boundedFemResponse, FEM_RUNTIME_LIMITS, qualifyBeam, type PyodideRuntime } from './runtime.js';
import { SHELL_ASSETS } from './shellAssets.js';
import { SOLID_CONTACT_ASSETS } from './solidContactAssets.js';
import { SOLID_FINITE_ASSETS } from './solidFiniteAssets.js';

type FemResponseKind = Parameters<typeof boundedFemResponse>[1];
/** Pinned expected values: the same literals as the product constants, kept independent of them. */
const OOFEM_DISTRIBUTION_VERSION = '3.1.dev5+g214b161ed';

// EX-09 delivery: the host-side resolution, notices, limits, cancellation and ownership of the shipped FEM runtime.
// The byte pins of every runtime file against manifest.json stay in buckling.package.test.ts and are not repeated here.

interface Pin { readonly file: string; readonly bytes: number; readonly sha256: string }
interface Component { readonly name: string; readonly notices: readonly string[] }
interface Manifest { readonly files: ReadonlyMap<string, Pin>; readonly components: readonly Component[] }

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const runtimeBytes = (name: string): Buffer => readFileSync(new URL('../runtime/' + name, import.meta.url));
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text');
  return value;
}
function readManifest(): Manifest {
  const raw = record(JSON.parse(runtimeBytes('manifest.json').toString('utf8')));
  const files = new Map(Object.entries(record(raw.files)).map(([file, value]) => {
    const pin = record(value);
    if (typeof pin.bytes !== 'number') throw new Error('Expected a byte count: ' + file);
    return [file, { file, bytes: pin.bytes, sha256: text(pin.sha256) }] as const;
  }));
  if (!Array.isArray(raw.components)) throw new Error('Expected components');
  const components = raw.components.map((value: unknown) => {
    const row = record(value);
    if (!Array.isArray(row.notices)) throw new Error('Expected notices');
    return { name: text(row.name), notices: row.notices.map(text) };
  });
  return { files, components };
}
function storedBytes(name: string): Buffer {
  const parts = record(record(JSON.parse(runtimeBytes('manifest.json').toString('utf8'))).storedParts)[name];
  if (!Array.isArray(parts)) throw new Error('Expected stored parts: ' + name);
  return Buffer.concat(parts.map((part: unknown) => runtimeBytes(text(record(part).file))));
}

/** Minimal readers for the shipped wheels/zip (stored or deflate) and tar.gz sources; no dependency is added. */
function zipMember(data: Buffer, wanted: string): Buffer {
  const names = zipNames(data), entry = names.get(wanted);
  if (entry === undefined) throw new Error('Missing zip member: ' + wanted);
  const nameLength = data.readUInt16LE(entry.local + 26), extraLength = data.readUInt16LE(entry.local + 28);
  if (data.readUInt32LE(entry.local) !== 0x04034b50) throw new Error('Invalid local zip header: ' + wanted);
  const start = entry.local + 30 + nameLength + extraLength, raw = data.subarray(start, start + entry.compressed);
  const body = entry.method === 0 ? raw : entry.method === 8 ? inflateRawSync(raw) : undefined;
  if (body?.byteLength !== entry.size) throw new Error('Unsupported or changed zip member: ' + wanted);
  return body;
}
function zipNames(data: Buffer): Map<string, { method: number; compressed: number; size: number; local: number }> {
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65_535) && end < 0; at -= 1) {
    if (data.readUInt32LE(at) === 0x06054b50) end = at;
  }
  if (end < 0) throw new Error('Missing zip directory');
  const names = new Map<string, { method: number; compressed: number; size: number; local: number }>();
  let at = data.readUInt32LE(end + 16);
  for (let index = 0; index < data.readUInt16LE(end + 10); index += 1) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid zip directory');
    const nameLength = data.readUInt16LE(at + 28);
    names.set(data.toString('utf8', at + 46, at + 46 + nameLength), { method: data.readUInt16LE(at + 10),
      compressed: data.readUInt32LE(at + 20), size: data.readUInt32LE(at + 24), local: data.readUInt32LE(at + 42) });
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  return names;
}
function tarFiles(gzip: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gzip), files = new Map<string, Buffer>();
  let offset = 0, nextName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const raw = header.subarray(start, start + length), stop = raw.indexOf(0);
      return raw.toString('utf8', 0, stop < 0 ? length : stop);
    };
    const size = Number.parseInt(field(124, 12).trim() || '0', 8), type = header[156];
    const body = tar.subarray(offset + 512, offset + 512 + size), prefix = field(345, 155);
    const name = nextName ?? (prefix === '' ? field(0, 100) : prefix + '/' + field(0, 100));
    nextName = undefined;
    if (type === 0x4c) nextName = body.toString('utf8').split('\0')[0];
    else if (type === 0x78) nextName = body.toString('utf8').split('\n').find(line => line.includes(' path='))?.split(' path=')[1];
    else if (type === 0x30 || type === 0) files.set(name, body);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const PIN_LISTS = { FEM_ASSETS, NETGEN_ASSETS, SOLID_ASSETS, SOLID_PLASTIC_ASSETS, BOLT_CONTACT_ASSETS, SOLID_MODAL_ASSETS,
  SOLID_BUCKLING_ASSETS, BEAM_IMPACT_ASSETS, JOINT_CONTACT_ASSETS, JOINT_INITIAL_STRAIN_ASSETS, WELD_CONTACT_ASSETS,
  WELD_SPAN_CONTACT_ASSETS, FRICTION_CONTACT_ASSETS, SHELL_ASSETS, SOLID_CONTACT_ASSETS, SOLID_FINITE_ASSETS };
const WEB_ORIGIN_WORKER = 'https://pointercad.invalid/fem/worker.js';
const DESKTOP_ORIGIN_WORKER = 'app://pointercad/fem/worker.js';

/** Compares every Worker pin list with every manifest asset; the counts are the delivery inventory result. */
function pinInventory(manifest: Manifest, lists: Readonly<Record<string, readonly Pin[]>>) {
  const pins = new Map<string, Pin>(), conflicting: string[] = [];
  for (const list of Object.values(lists)) {
    for (const pin of list) {
      const known = pins.get(pin.file);
      if (known !== undefined && (known.bytes !== pin.bytes || known.sha256 !== pin.sha256)) conflicting.push(pin.file);
      pins.set(pin.file, pin);
    }
  }
  const assets = [...manifest.files.values()].filter(row => row.file.startsWith('assets/'));
  const missing = assets.filter(row => !pins.has(row.file.slice('assets/'.length))).map(row => row.file);
  const mismatched = assets.filter(row => {
    const pin = pins.get(row.file.slice('assets/'.length));
    return pin !== undefined && (pin.bytes !== row.bytes || pin.sha256 !== row.sha256);
  }).map(row => row.file);
  const extra = [...pins.keys()].filter(file => !manifest.files.has('assets/' + file));
  return { assets: assets.length, pins: pins.size, missing, mismatched, extra, conflicting };
}

describe('host resolution of every shipped FEM asset (Web and Electron share the Worker pins)', () => {
  it('pins all manifest assets exactly once with the same bytes and SHA-256, and both origins resolve to fem/assets', () => {
    const manifest = readManifest(), inventory = pinInventory(manifest, PIN_LISTS);
    expect(inventory).toEqual({ assets: 36, pins: 36, missing: [], mismatched: [], extra: [], conflicting: [] });
    for (const list of Object.values(PIN_LISTS)) {
      for (const pin of list) {
        for (const worker of [WEB_ORIGIN_WORKER, DESKTOP_ORIGIN_WORKER]) {
          const url = new URL(pin.file, new URL('./assets/', worker));
          // Electron decodes the path before joining the renderer root; the Web host serves the same emitted name.
          expect(decodeURIComponent(url.pathname), worker).toBe('/fem/assets/' + pin.file);
          expect(url.search + url.hash).toBe('');
        }
      }
    }
  });
  it('detects a one-byte tampered pin, a missing pin and an extra pin in the inventory comparison', () => {
    const manifest = readManifest();
    const [first, ...rest] = FEM_ASSETS;
    const flipped = first.sha256.slice(0, -1) + (first.sha256.endsWith('0') ? '1' : '0');
    expect(pinInventory(manifest, { ...PIN_LISTS, FEM_ASSETS: [{ ...first, sha256: flipped }, ...rest] }).mismatched)
      .toEqual(['assets/' + first.file]);
    expect(pinInventory(manifest, { ...PIN_LISTS, FEM_ASSETS: rest }).missing).toEqual(['assets/' + first.file]);
    expect(pinInventory(manifest, { ...PIN_LISTS, EXTRA: [{ file: 'extra.whl', bytes: 1, sha256: 'a'.repeat(64) }] }).extra)
      .toEqual(['extra.whl']);
  });
});

describe('the Worker verifies the real shipped bytes before an interpreter starts', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const served = (change: (files: Map<string, Uint8Array>) => void = () => undefined) => {
    const files = new Map<string, Uint8Array>(FEM_ASSETS.map(pin => ['/fem/assets/' + pin.file, runtimeBytes('assets/' + pin.file)]));
    change(files);
    const requested: string[] = [];
    const worker = { location: new URL(WEB_ORIGIN_WORKER),
      fetch: (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requested.push(url.pathname);
        const bytes = files.get(url.pathname);
        return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice(0)));
      },
      importScripts: () => { throw new Error('No interpreter may start in this unit test'); } };
    vi.stubGlobal('self', worker);
    return { worker, requested };
  };
  const stop = new Error('stop after verified assets');
  const qualify = (phases: string[]): Promise<unknown> => qualifyInBrowser(phase => {
    phases.push(phase);
    if (phase === 'loading-runtime') throw stop;
  }).catch((error: unknown) => error);

  it('accepts the 13 runtime files byte-identical to their pins and refuses an unpinned extra request afterwards', async () => {
    const { worker, requested } = served(files => { files.set('/fem/assets/extra.py', Uint8Array.of(1)); });
    const phases: string[] = [];
    expect(await qualify(phases)).toBe(stop);
    expect(phases).toEqual(['loading-assets', 'loading-runtime']);
    expect([...requested].sort()).toEqual(FEM_ASSETS.map(pin => '/fem/assets/' + pin.file).sort());
    await expect(worker.fetch('https://pointercad.invalid/fem/assets/extra.py')).rejects.toThrow('offline-request-denied');
    const wasm = await worker.fetch('https://pointercad.invalid/fem/assets/pyodide.asm.wasm');
    expect(sha(new Uint8Array(await wasm.arrayBuffer()))).toBe(FEM_ASSETS.find(pin => pin.file === 'pyodide.asm.wasm')?.sha256);
  });
  it.each([
    ['a one-byte tampered copy of pyodide.asm.wasm', (files: Map<string, Uint8Array>) => {
      const copy = Uint8Array.from(files.get('/fem/assets/pyodide.asm.wasm') ?? []);
      copy[copy.length >> 1] ^= 1;
      files.set('/fem/assets/pyodide.asm.wasm', copy);
    }, 'asset-corrupt: pyodide.asm.wasm (SHA-256)'],
    ['a missing OOFEM wheel', (files: Map<string, Uint8Array>) => {
      files.delete('/fem/assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl');
    }, 'asset-missing: oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl (HTTP 404)'],
  ] as const)('refuses %s before the runtime phase', async (_name, change, message) => {
    served(change);
    const phases: string[] = [];
    const error = await qualify(phases);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').toBe(message);
    expect(phases).toEqual(['loading-assets']);
  });
});

// Explicit third-party attribution of shipped assets. Application wrappers are first-party only when their exact bytes
// are in the shipped PointerCAD application source index, whose own LICENSE row is the notice.
const THIRD_PARTY = new Map([
  ['pyodide.mjs', 'Pyodide'], ['pyodide.asm.js', 'Pyodide'], ['pyodide.asm.wasm', 'Pyodide'], ['python_stdlib.zip', 'Pyodide'],
  ['package.json', 'Pyodide'], ['pyodide-lock.json', 'Pyodide'], ['numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', 'numpy'],
  ['oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl', 'oofem'], ['test_2.py', 'oofem'],
  ['netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl', 'netgen-mesher'],
]);
function applicationIndex(): { readonly hashes: ReadonlySet<string>; readonly license: Pin | undefined } {
  const files = record(record(JSON.parse(runtimeBytes('evidence/application-source-index.json').toString('utf8'))).files);
  const rows = Object.entries(files).map(([file, value]) => {
    const row = record(value);
    return { file, bytes: typeof row.bytes === 'number' ? row.bytes : -1, sha256: text(row.sha256) };
  });
  return { hashes: new Set(rows.map(row => row.sha256)), license: rows.find(row => row.file === 'LICENSE') };
}
/** Every shipped asset needs a component with present, non-empty notices, or first-party application source. */
function noticeGaps(manifest: Manifest, application = applicationIndex()): string[] {
  const gaps: string[] = [];
  for (const row of manifest.files.values()) {
    if (!row.file.startsWith('assets/')) continue;
    const name = THIRD_PARTY.get(row.file.slice('assets/'.length));
    if (name === undefined) {
      const license = application.license;
      if (!application.hashes.has(row.sha256) || license === undefined || license.bytes <= 0) gaps.push(row.file + ': no notice');
      continue;
    }
    const component = manifest.components.find(item => item.name === name);
    if (component === undefined || component.notices.length === 0) { gaps.push(row.file + ': no ' + name + ' notice'); continue; }
    for (const notice of component.notices) {
      const pin = manifest.files.get(notice);
      if (pin === undefined || pin.bytes <= 0 || runtimeBytes(notice).byteLength !== pin.bytes) gaps.push(row.file + ': ' + notice);
    }
  }
  return gaps;
}
function noticeFor(manifest: Manifest, component: string, data: Uint8Array): string | undefined {
  const name = 'notices/' + sha(data) + '.txt';
  const owner = manifest.components.find(item => item.name === component);
  return owner?.notices.includes(name) === true && runtimeBytes(name).equals(data) ? name : undefined;
}

describe('licenses and notices of every shipped FEM asset', () => {
  it('attributes all 36 assets to present non-empty notices and refuses a fake asset or a dropped notice', () => {
    const manifest = readManifest();
    expect(noticeGaps(manifest)).toEqual([]);
    const fake = new Map(manifest.files);
    fake.set('assets/unlisted-native.whl', { file: 'assets/unlisted-native.whl', bytes: 1, sha256: 'b'.repeat(64) });
    expect(noticeGaps({ ...manifest, files: fake })).toEqual(['assets/unlisted-native.whl: no notice']);
    const dropped = new Map(manifest.files);
    const numpy = manifest.components.find(item => item.name === 'numpy')?.notices[0] ?? '';
    dropped.delete(numpy);
    expect(noticeGaps({ ...manifest, files: dropped })).toEqual(['assets/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl: ' + numpy]);
  });

  it('matches every license file inside the three shipped wheels byte for byte with a notice of its component', () => {
    const manifest = readManifest();
    const wheels = [['numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', 'numpy', 1],
      ['oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl', 'oofem', 2],
      ['netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl', 'netgen-mesher', 2]] as const;
    for (const [file, component, count] of wheels) {
      const wheel = runtimeBytes('assets/' + file);
      const licenses = [...zipNames(wheel).keys()].filter(name => /^[^/]+\.dist-info\/(?:licenses\/.+|LICEN[CS]E[^/]*|COPYING[^/]*|AUTHORS[^/]*)$/u.test(name));
      expect(licenses, file).toHaveLength(count);
      for (const member of licenses) expect(noticeFor(manifest, component, zipMember(wheel, member)), member).toBeDefined();
      const changed = Buffer.from(zipMember(wheel, licenses[0] ?? ''));
      changed[0] ^= 1;
      expect(noticeFor(manifest, component, changed)).toBeUndefined();
    }
  });

  it('matches the Pyodide and CPython licenses and the OOFEM test program with the shipped source archives', () => {
    const manifest = readManifest();
    const pyodidePackage = record(JSON.parse(runtimeBytes('assets/package.json').toString('utf8')));
    expect([pyodidePackage.name, pyodidePackage.version, pyodidePackage.license]).toEqual(['pyodide', FEM_RUNTIME_VERSION, 'MPL-2.0']);
    const upstream = storedBytes('sources/upstream-source-materials.zip');
    const pyodide = tarFiles(zipMember(upstream, 'sources/049-pyodide-72e3c78d53a32a76e0aca7443ad24e5cae1042d3.tar.gz'));
    const mpl = pyodide.get('pyodide-pyodide-72e3c78/LICENSE') ?? Buffer.alloc(0);
    expect(noticeFor(manifest, 'Pyodide', mpl)).toBeDefined();
    expect(mpl.toString('utf8')).toMatch(/^Mozilla Public License Version 2\.0/u);
    const python = tarFiles(zipMember(upstream, 'sources/001-Python-3.13.2.tgz'));
    expect(noticeFor(manifest, 'Pyodide', python.get('Python-3.13.2/LICENSE') ?? Buffer.alloc(0))).toBeDefined();
    const oofem = tarFiles(runtimeBytes('sources/051-oofem-214b161ed3acb471f2d0104b004c37fd73bafaa2.tar.gz'));
    expect(oofem.get('oofem-oofem-214b161/bindings/python/tests/test_2.py')?.equals(runtimeBytes('assets/test_2.py'))).toBe(true);
    expect(noticeFor(manifest, 'oofem', oofem.get('oofem-oofem-214b161/LICENSE') ?? Buffer.alloc(0))).toBeDefined();
    expect(applicationIndex().license?.sha256).toBe(sha(readFileSync(new URL('../../../LICENSE', import.meta.url))));
  });
});

// The shipped rebuild list and recipe ask a recipient for these venv tools. Each must be at or above the first patched
// version of every open Dependabot alert on venv-requirements.txt (read 2026-11-12); pinned here, not read from the alerts.
const REBUILD_VENV_SECURITY_MINIMUMS = new Map([
  ['certifi', '2026.10.18'], ['filelock', '4.2.1'], ['pip', '26.2.0'], ['virtualenv', '21.14.9'],
]);
const PORTABLE_REBUILD = 'sources/native-rebuild/portable/';
const projectKey = (name: string): string => name.toLowerCase().replace(/[_.]/gu, '-');
function versionNumbers(version: string): number[] {
  if (!/^\d+(?:\.\d+)*$/u.test(version)) throw new Error('Expected a plain dotted version: ' + version);
  return version.split('.').map(Number);
}
function atLeast(version: string, minimum: string): boolean {
  const have = versionNumbers(version), need = versionNumbers(minimum);
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
function projectPins(rows: readonly (readonly [string, string])[]): Map<string, string[]> {
  const pins = new Map<string, string[]>();
  for (const [name, version] of rows) pins.set(projectKey(name), [...(pins.get(projectKey(name)) ?? []), version]);
  return pins;
}
function listedVenvPins(list: string): Map<string, string[]> {
  return projectPins(list.split('\n').flatMap(line => {
    const match = /^([A-Za-z0-9_.-]+)==(\S+)$/u.exec(line);
    return match ? [[match[1], match[2]] as const] : [];
  }));
}
function recipeVenvPins(recipe: string): Map<string, string[]> {
  const table = /^s_venv\(\) \{\n[\s\S]*?^want = \{([\s\S]*?)\}\n/mu.exec(recipe)?.[1];
  if (table === undefined) throw new Error('Expected the s_venv want table');
  return projectPins([...table.matchAll(/'([A-Za-z0-9_.-]+)': '([^']+)'/gu)].map(match => [match[1], match[2]] as const));
}

describe('the shipped rebuild environment asks for security-fixed venv tools', () => {
  it('pins certifi, filelock, pip and virtualenv once in the list and once in the recipe, at or above every fix', () => {
    const listed = listedVenvPins(runtimeBytes(PORTABLE_REBUILD + 'venv-requirements.txt').toString('utf8'));
    const recipe = recipeVenvPins(runtimeBytes(PORTABLE_REBUILD + 'rebuild-oofem-pyodide.sh').toString('utf8'));
    const unfixed = [...REBUILD_VENV_SECURITY_MINIMUMS].flatMap(([name, minimum]) => {
      const pins = { listed: listed.get(name) ?? [], recipe: recipe.get(name) ?? [] };
      const fixed = pins.listed.length === 1 && pins.recipe.length === 1
        && [...pins.listed, ...pins.recipe].every(version => atLeast(version, minimum));
      return fixed ? [] : [{ name, minimum, ...pins }];
    });
    expect(unfixed).toEqual([]);
    // The recipe refuses any venv that differs from its table, so the shipped list must state the same 42 pins.
    expect(listed.size).toBe(42);
    expect(Object.fromEntries(recipe)).toEqual(Object.fromEntries(listed));
  });

  it('compares dotted versions as numbers and refuses a version form it cannot order', () => {
    expect([atLeast('2026.10.18', '2026.10.18'), atLeast('26.2', '26.2.0'), atLeast('21.14.10', '21.14.9')]).toEqual([true, true, true]);
    expect([atLeast('2026.7.22', '2026.10.18'), atLeast('24.3.1', '25.3'), atLeast('4.2.0', '4.2.1')]).toEqual([false, false, false]);
    expect(() => atLeast('1.2.2.post1', '1.2.2')).toThrow('Expected a plain dotted version');
    expect(listedVenvPins('# note\npip==24.3.1\npip==26.2.0\n').get('pip')).toEqual(['24.3.1', '26.2.0']);
    expect(() => recipeVenvPins('s_other() {\n}\n')).toThrow('Expected the s_venv want table');
  });
});

// A protocol-valid qualification reply; the upstream displacement oracle is the fixed one in isBeamProof.
const proof = { kind: 'oofem-upstream-test-2', purpose: 'runtime-qualification-only', pyodideVersion: FEM_RUNTIME_VERSION,
  pythonVersion: '3.13.2', oofemVersion: OOFEM_DISTRIBUTION_VERSION, pythonAbi: 'cp313-cp313', u1: -8.64e-4, u4: 9.47333333e-4,
  upstreamAssertionsPassed: true, maximumAbsoluteError: 0 };
interface FakeWorker { readonly port: FemWorkerPort; readonly sent: FemRequest[]; terminated: number }
function rig() {
  const workers: FakeWorker[] = [], events: string[] = [];
  let live = 0, maxLive = 0;
  const client = new FemClient(() => {
    const worker: FakeWorker = { sent: [], terminated: 0, port: { onmessage: null, onerror: null, onmessageerror: null,
      postMessage: message => { worker.sent.push(message); },
      terminate: () => { worker.terminated += 1; if (worker.terminated === 1) { live -= 1; events.push('terminate'); } } } };
    workers.push(worker); live += 1; maxLive = Math.max(maxLive, live); events.push('create');
    return worker.port;
  });
  const send = (worker: FakeWorker | undefined, data: unknown): void => {
    worker?.port.onmessage?.(new MessageEvent<unknown>('message', { data }));
  };
  const identity = (worker: FakeWorker | undefined): FemIdentity => {
    const request = worker?.sent[0];
    if (request === undefined) throw new Error('No request was posted');
    return request.identity;
  };
  return { client, workers, events, send, identity, live: () => live, maxLive: () => maxLive };
}
const phase = (identity: FemIdentity, value: 'solving') => ({ protocol: FEM_PROTOCOL, kind: 'phase', identity, phase: value });
const result = (identity: FemIdentity) => ({ protocol: FEM_PROTOCOL, kind: 'result', identity, result: proof });

describe('FEM host limits live in one constant and refuse excess with a reason', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('keeps the existing values in FEM_RUNTIME_LIMITS', () => {
    expect(FEM_RUNTIME_LIMITS).toEqual({ workersPerClient: 1, totalDeadlineMs: 180_000, solveDeadlineMs: 60_000,
      responseCharacters: { solidPlastic: 16_000_000, solid: 24_000_000, solidModal: 2_000_000, solidBuckling: 10_000_000,
        tetraMesh: 4_000_000, beamProof: 8192, beam: 2_000_000, beamModal: 2_000_000, beamBuckling: 2_000_000,
        beamTransient: 12_000_000, plasticBar: 2_000_000, beamContact: 2_000_000 } });
    expect(Object.isFrozen(FEM_RUNTIME_LIMITS) && Object.isFrozen(FEM_RUNTIME_LIMITS.responseCharacters)).toBe(true);
  });

  it('memory: accepts a reply at the response bound and refuses one character more before JSON.parse', async () => {
    const limits = FEM_RUNTIME_LIMITS.responseCharacters;
    const longest = ' '.repeat(Math.max(...Object.values(limits)) + 1);
    for (const [kind, limit] of Object.entries(limits) as [FemResponseKind, number][]) {
      expect(boundedFemResponse(longest.slice(0, limit), kind, 'bounded')).toHaveLength(limit);
      expect(() => boundedFemResponse(longest.slice(0, limit + 1), kind, 'bounded'))
        .toThrow(`bounded: ${String(limit + 1)} characters exceed the ${String(limit)}-character ${kind} limit`);
    }
    const fakeRuntime = (reply: unknown): PyodideRuntime => ({ version: FEM_RUNTIME_VERSION, runPython: () => reply,
      FS: { mkdirTree: () => undefined, writeFile: () => undefined }, loadPackage: () => Promise.resolve(undefined) });
    const programs = { upstream: Uint8Array.of(1), wrapper: Uint8Array.of(1), wheelLocation: 'https://pointercad.invalid/w.whl' };
    // Trailing spaces keep valid JSON, so only the bound (checked before JSON.parse) can refuse the longer reply.
    const exact = JSON.stringify(proof).padEnd(limits.beamProof, ' ');
    await expect(qualifyBeam(fakeRuntime(exact), programs, () => undefined)).resolves.toEqual(proof);
    await expect(qualifyBeam(fakeRuntime(exact + ' '), programs, () => undefined)).rejects
      .toThrow('Invalid FEM numerical response: 8193 characters exceed the 8192-character beamProof limit');
    await expect(qualifyBeam(fakeRuntime(undefined), programs, () => undefined)).rejects
      .toThrow('Invalid FEM numerical response: the native reply is not text');
  });

  it('Worker count: one request owns one Worker; a second request terminates it before creating its own', async () => {
    const { client, workers, events, send, identity, live, maxLive } = rig();
    const first = client.qualify('doc', 1);
    expect([workers.length, live()]).toEqual([1, 1]);
    const second = client.qualify('doc', 2);
    await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    expect(events).toEqual(['create', 'terminate', 'create']);
    expect(maxLive()).toBe(FEM_RUNTIME_LIMITS.workersPerClient);
    send(workers[1], result(identity(workers[1])));
    await expect(second).resolves.toMatchObject({ kind: 'result', result: proof });
    expect(live()).toBe(0);
  });

  it.each([['total', 'totalDeadlineMs', 'FEM initialization/analysis exceeded 180000 ms'],
    ['solve', 'solveDeadlineMs', 'FEM solve exceeded 60000 ms']] as const)(
    'time: the %s deadline accepts a reply 1 ms before it and terminates with the bound as the reason at it',
    async (mode, key, message) => {
      vi.useFakeTimers();
      for (const late of [false, true]) {
        const { client, workers, send, identity, live } = rig();
        const pending = client.qualify('doc', 1), worker = workers[0];
        if (mode === 'solve') send(worker, phase(identity(worker), 'solving'));
        await vi.advanceTimersByTimeAsync(FEM_RUNTIME_LIMITS[key] - 1);
        expect(worker?.terminated).toBe(0);
        if (late) {
          await vi.advanceTimersByTimeAsync(1);
          await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'deadline', message } });
        } else {
          send(worker, result(identity(worker)));
          await expect(pending).resolves.toMatchObject({ kind: 'result' });
        }
        expect([worker?.terminated, live()]).toEqual([1, 0]);
        client.dispose();
      }
    });
});

describe('cancellation and document ownership leave no Worker and never accept an old result', () => {
  it('positive: an abort during the native solve terminates the Worker and detaches it', async () => {
    const { client, workers, send, identity, live } = rig(), abort = new AbortController();
    const pending = client.qualify('doc', 3, { signal: abort.signal });
    send(workers[0], phase(identity(workers[0]), 'solving'));
    abort.abort();
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect([workers[0]?.terminated, live(), workers[0]?.port.onmessage]).toEqual([1, 0, null]);
  });
  it('positive: the reply for the current document revision and request is accepted, then the Worker ends', async () => {
    const { client, workers, send, identity, live } = rig();
    const pending = client.qualify('doc', 4);
    send(workers[0], result(identity(workers[0])));
    await expect(pending).resolves.toMatchObject({ kind: 'result', identity: { documentId: 'doc', revision: 4 }, result: proof });
    expect(live()).toBe(0);
    client.dispose();
  });
  it('negative: a reply bound to an older revision of the same document is refused, not shown', async () => {
    const { client, workers, send, identity, live } = rig();
    const pending = client.qualify('doc', 5), current = identity(workers[0]);
    send(workers[0], result({ ...current, revision: current.revision - 1 }));
    await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(live()).toBe(0);
  });
  it('negative: a late reply on the superseded Worker is ignored and the new owner keeps only its own result', async () => {
    const { client, workers, send, identity, live } = rig();
    const old = client.qualify('doc', 6), stale = workers[0]?.port.onmessage, oldIdentity = identity(workers[0]);
    const current = client.qualify('doc', 7);
    await expect(old).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    stale?.(new MessageEvent<unknown>('message', { data: result(oldIdentity) }));
    expect(workers[0]?.port.onmessage).toBeNull();
    send(workers[1], result(identity(workers[1])));
    await expect(current).resolves.toMatchObject({ kind: 'result', identity: { revision: 7 } });
    client.dispose();
    expect(live()).toBe(0);
  });
});
