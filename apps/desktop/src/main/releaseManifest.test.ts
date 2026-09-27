import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assembleDesktopDistribution, verifyDesktopDistribution } from '../../../../scripts/release/desktopDistribution.mjs';
import { verifyDesktopPackageArtifacts } from '../../../../scripts/release/desktopPackageTargets.mjs';
import { createReleaseManifest, verifyReleaseManifest } from '../../../../scripts/release/releaseManifest.mjs';
import type { ReleaseCandidateInput, ReleaseManifest, ReleaseManifestInput } from '../../../../scripts/release/releaseManifest.mjs';
import { CAPTURE_REGISTRY_PATH, PUBLICATION_LIMITS, createPublicationManifest, measurePublicationSizes, verifyPublicationManifest }
  from '../../../../scripts/release/publicationManifest.mjs';
import type { PublicationManifestInput } from '../../../../scripts/release/publicationManifest.mjs';
import { PAGES_MAX_FILE_BYTES, PAGES_MAX_FILES } from '../../../../scripts/release/releaseReadiness.mjs';
import { assembleSbomDocument } from '../../../../scripts/release/sbom.mjs';
import type { SbomComponentInput } from '../../../../scripts/release/sbom.mjs';
import { bytes, files, fixture, hash, inputs, json } from './distributionTestFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const packageFiles = { root: readFileSync(join(root, 'package.json')),
  desktop: readFileSync(join(root, 'apps/desktop/package.json')), web: readFileSync(join(root, 'apps/web/package.json')) };
const builderConfig = readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
const sourceCommit = 'a'.repeat(40);
const webInputs = { ...inputs, 'package.json': hash(packageFiles.root), 'apps/web/package.json': hash(packageFiles.web) };
const desktopInputs = { ...inputs, 'package.json': hash(packageFiles.root), 'apps/desktop/package.json': hash(packageFiles.desktop),
  'apps/desktop/electron-builder.yml': hash(builderConfig) };

function candidate(manual: ReturnType<typeof fixture>, platform: 'win32' | 'linux',
  runtime: ReadonlyMap<string, Uint8Array> = new Map()): ReleaseCandidateInput {
  const desktop = new Map<string, Uint8Array>([
    ['main/main.cjs', bytes("require('electron');")], ['preload/preload.cjs', bytes("require('electron');")],
    ...['renderer/index.html', 'renderer/fonts/LICENSES.txt', 'renderer/licenses/math-notices.json',
      'renderer/licenses/runtime/runtime-notices.json', 'renderer/LICENSE', 'renderer/NOTICE',
      'renderer/licenses/exact-math/manifest.json', 'renderer/exact-math/runtime/pyodide.asm.wasm',
      'renderer/assets/opencascade.full-example.wasm', 'renderer/assets/quickjs-pcad-example.wasm']
      .map(name => [name, bytes(name)] as const),
  ]);
  for (const [name, value] of runtime) desktop.set(name, value);
  desktop.set('desktop-build.json', json({ format: 'pointercad-desktop-build/1', inputs: desktopInputs,
    outputs: Object.fromEntries([...desktop].map(([name, value]) => [name, hash(value)])) }));
  const result = assembleDesktopDistribution(files(desktop), files(manual.manual), files(manual.pdf),
    new Map([['LICENSE', bytes('license')], ['NOTICE', bytes('notice')]]),
    { version: '0.0.0', sourceCommit, platform, arch: 'x64', electronVersion: '44.1.0', builderVersion: '26.15.3' });
  const packageManifestBytes = result.files.get('desktop-package.json');
  if (packageManifestBytes === undefined) throw new Error('Missing fixture package inventory');
  const application = verifyDesktopDistribution(files(result.files), packageManifestBytes);
  const names = platform === 'win32'
    ? ['PointerCAD-0.0.0-windows-x64-setup.exe', 'PointerCAD-0.0.0-windows-x64-portable.exe']
    : ['PointerCAD-0.0.0-linux-x64.AppImage'];
  const artifacts = names.map(name => ({ name, bytes: bytes(name).length, sha256: hash(name) }));
  const receipt = { format: 'pointercad-desktop-candidate/1', version: '0.0.0', sourceCommit, platform, arch: 'x64',
    signed: false, assets: artifacts, packages: verifyDesktopPackageArtifacts(platform, '0.0.0', artifacts),
    application, installed: false, releaseCertified: false };
  return { receiptBytes: json(receipt), packageManifestBytes, stagedFiles: files(result.files), artifacts };
}
interface DistributionExtras {
  readonly web?: ReadonlyMap<string, Uint8Array | null>;
  readonly desktop?: ReadonlyMap<string, Uint8Array>;
}
function releaseFixture(manualCommit = sourceCommit,
  webBuildExtra: Record<string, unknown> = { sourceCommit, dirtySources: false }, extras: DistributionExtras = {}): ReleaseManifestInput {
  const manual = fixture();
  for (const [name, value] of extras.web ?? []) {
    if (value === null) manual.web.delete(name); else manual.web.set(name, new Uint8Array(value));
  }
  const manualRecord = { ...manual.manualManifest, sourceCommit: manualCommit, dirtySources: false };
  manual.manual.set('manifest.json', json(manualRecord));
  manual.pdf.set('pdf-manifest.json', json({ ...manual.pdfManifest, manualManifestSha256: hash(json(manualRecord)) }));
  manual.web.set('web-build.json', json({ format: 'pointercad-web-build/1', ...webBuildExtra, inputs: webInputs,
    outputs: Object.fromEntries([...manual.web].filter(([name]) => name !== 'web-build.json')
      .map(([name, value]) => [name, hash(value)])) }));
  const assembled = manual.assemble();
  return { packageFiles, builderConfig, sourceCommit, sourceInputs: { web: webInputs, desktop: desktopInputs, manual: inputs },
    candidates: [candidate(manual, 'win32', extras.desktop), candidate(manual, 'linux', extras.desktop)], webFiles: files(assembled.files) };
}
function changeReceipt(input: ReleaseManifestInput, index: number, change: (value: Record<string, unknown>) => void): ReleaseManifestInput {
  const candidates = [...input.candidates];
  const original = candidates[index];
  const value = JSON.parse(new TextDecoder().decode(original.receiptBytes)) as Record<string, unknown>;
  change(value); candidates[index] = { ...original, receiptBytes: json(value) };
  return { ...input, candidates };
}
function changePackage(input: ReleaseManifestInput, index: number, change: (value: Record<string, unknown>) => void): ReleaseManifestInput {
  const candidates = [...input.candidates];
  const original = candidates[index];
  const value = JSON.parse(new TextDecoder().decode(original.packageManifestBytes)) as Record<string, unknown>;
  change(value); candidates[index] = { ...original, packageManifestBytes: json(value) };
  return { ...input, candidates };
}
function changeWebBuild(input: ReleaseManifestInput, change: (value: Record<string, unknown>) => void): ReleaseManifestInput {
  return { ...input, webFiles: input.webFiles.map(file => {
    if (file.path !== 'web-build.json') return file;
    const value = JSON.parse(new TextDecoder().decode(file.bytes)) as Record<string, unknown>;
    change(value); return { ...file, bytes: json(value) };
  }) };
}

describe('公開manifestは既存の候補・Web・説明書の記録を束ねて照合する', () => {
  it('Windowsの2形式、Linux AppImage、Pagesと全HTML/PDF巻を同じ版へ束ねる', async () => {
    const input = releaseFixture(), manifest = await createReleaseManifest(input);
    expect(manifest.targets).toEqual(['windows-x64-nsis', 'windows-x64-portable', 'linux-x64-AppImage', 'cloudflare-pages']);
    expect(manifest.sourceCommit).toBe(sourceCommit);
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.manual.pdfVolumes).toBe(2);
    expect(manifest.manual.volumes.map(volume => volume.pdf)).toEqual(['manual/pdf/first.pdf', 'manual/pdf/second.pdf']);
    expect(manifest.web.files.some(file => file.path === 'service-worker.js')).toBe(true);
    expect(manifest.releaseCertified).toBe(false);
    await expect(verifyReleaseManifest(manifest, input)).resolves.toEqual(manifest);
  });
  it('渡された版と一致するtagを記録する', async () => {
    expect((await createReleaseManifest({ ...releaseFixture(), tag: 'v0.0.0' })).tag).toBe('v0.0.0');
  });
  it.each(['root', 'desktop', 'web'] as const)('%s packageの版違いを拒否する', async name => {
    const input = releaseFixture(), value = JSON.parse(new TextDecoder().decode(input.packageFiles[name])) as Record<string, unknown>;
    value.version = '1.0.0';
    await expect(createReleaseManifest({ ...input, packageFiles: { ...input.packageFiles, [name]: json(value) } }))
      .rejects.toThrow(/version differs|source fingerprint differs/u);
  });
  it('desktop配布設定の版違いを拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, builderConfig: 'version: 9.9.9\n' + input.builderConfig }))
      .rejects.toThrow('builder version differs');
  });
  it('tagの版違いを拒否する', async () => {
    await expect(createReleaseManifest({ ...releaseFixture(), tag: 'v9.9.9' })).rejects.toThrow('tag version differs');
  });
  it('別commitのdesktop候補を拒否する', async () => {
    const input = changeReceipt(releaseFixture(), 1, value => { value.sourceCommit = 'b'.repeat(40); });
    await expect(createReleaseManifest(input)).rejects.toThrow('commit differs');
  });
  it('別commitの説明書を拒否する', async () => {
    await expect(createReleaseManifest(releaseFixture('b'.repeat(40)))).rejects.toThrow('Manual source commit differs');
  });
  it('別の入力指紋で作ったWebを拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, sourceInputs: { ...input.sourceInputs,
      web: { ...input.sourceInputs.web, 'packages/ui/src/example.ts': hash('later commit') } } }))
      .rejects.toThrow('input fingerprints differ');
  });
  it('desktop-packageの入力指紋の差を拒否する', async () => {
    const input = changePackage(releaseFixture(), 0, value => {
      value.inputs = { ...desktopInputs, 'packages/ui/src/example.ts': hash('other commit') };
    });
    await expect(createReleaseManifest(input)).rejects.toThrow('input fingerprints differ');
  });
  it('記録に無いdesktop artifactを拒否する', async () => {
    const input = releaseFixture(), first = input.candidates[0];
    await expect(createReleaseManifest({ ...input, candidates: [{ ...first,
      artifacts: [...first.artifacts, { name: 'extra.exe', bytes: 1, sha256: hash('x') }] }, input.candidates[1]] }))
      .rejects.toThrow('Unrecorded desktop artifact');
  });
  it('内容が違うdesktop artifactを拒否する', async () => {
    const input = releaseFixture(), first = input.candidates[0];
    await expect(createReleaseManifest({ ...input, candidates: [{ ...first,
      artifacts: [{ ...first.artifacts[0], sha256: hash('different') }, ...first.artifacts.slice(1)] }, input.candidates[1]] }))
      .rejects.toThrow('Desktop artifact differs');
  });
  it('記録に無いWebファイルを拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, webFiles: [...input.webFiles, { path: 'surprise.txt', bytes: bytes('x') }] }))
      .rejects.toThrow('Unrecorded Web file');
  });
  it('Webファイルの内容違いを拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, webFiles: input.webFiles.map(file => file.path === 'index.html'
      ? { ...file, bytes: bytes('tampered') } : file) })).rejects.toThrow(/Web build output differs|Offline asset differs/u);
  });
  it('別commitのWebビルドを拒否する', async () => {
    const input = changeWebBuild(releaseFixture(), value => { value.sourceCommit = 'c'.repeat(40); });
    await expect(createReleaseManifest(input)).rejects.toThrow('Web build source commit differs');
  });
  it('汚れた作業ツリーで生成したWebビルドを拒否する', async () => {
    const input = changeWebBuild(releaseFixture(), value => { value.dirtySources = true; });
    await expect(createReleaseManifest(input)).rejects.toThrow('Web build was generated from dirty sources');
  });
  it('commit欄の無い旧形式のWebビルド記録を許容する', async () => {
    // P13-1当時のweb-build.json（commit欄なし）を、offline-assets.jsonとの指紋整合を保ったまま再現する。
    const input = releaseFixture(sourceCommit, { dirtySources: false });
    await expect(createReleaseManifest(input)).resolves.toMatchObject({ sourceCommit });
  });
  it('dirtySources欄の無い旧形式のWebビルド記録を許容する', async () => {
    const input = releaseFixture(sourceCommit, { sourceCommit });
    await expect(createReleaseManifest(input)).resolves.toMatchObject({ sourceCommit });
  });
  it('保存済みmanifestの再照合でもWebビルドのcommit食い違いを拒否する', async () => {
    const input = releaseFixture(), manifest = await createReleaseManifest(input);
    const tampered = changeWebBuild(input, value => { value.sourceCommit = 'd'.repeat(40); });
    await expect(verifyReleaseManifest(manifest, tampered)).rejects.toThrow('Web build source commit differs');
  });
  it('macOS候補を拒否する', async () => {
    const input = changeReceipt(releaseFixture(), 1, value => { value.platform = 'darwin'; });
    await expect(createReleaseManifest(input)).rejects.toThrow('candidate target');
  });
  it('ARM64候補を拒否する', async () => {
    const input = changeReceipt(releaseFixture(), 0, value => { value.arch = 'arm64'; });
    await expect(createReleaseManifest(input)).rejects.toThrow('candidate target');
  });
  it('Web候補の欠落を拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, webFiles: [] })).rejects.toThrow('Missing Web distribution files');
  });
  it('desktop候補の欠落を拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, candidates: input.candidates.slice(0, 1) }))
      .rejects.toThrow('Both desktop candidates');
  });
  it('壊れたWeb記録を拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, webFiles: input.webFiles.map(file => file.path === 'web-build.json'
      ? { ...file, bytes: bytes('{bad') } : file) })).rejects.toThrow('Invalid web-build.json');
  });
  it('説明書の1巻欠落を拒否する', async () => {
    const input = releaseFixture();
    await expect(createReleaseManifest({ ...input, webFiles: input.webFiles.filter(file => file.path !== 'manual/pdf/second.pdf') }))
      .rejects.toThrow(/Offline asset differs|Missing Web file/u);
  });
  it('保存済みmanifestの書き換えを拒否する', async () => {
    const input = releaseFixture(), manifest = await createReleaseManifest(input);
    await expect(verifyReleaseManifest({ ...manifest, version: '9.9.9' }, input)).rejects.toThrow('Release manifest differs');
  });
});

const wasm = (label: string) => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...bytes(label)]);
const occtWasm = wasm('occt kernel'), pyodideWasm = wasm('pyodide runtime'), quickjsWasm = wasm('quickjs runtime');
const occtPart = 'occt/opencascade.full-test.bin';
const kernelHeaders = '/*\n  X-Content-Type-Options: nosniff\n\n/occt/*\n  Content-Type: application/octet-stream\n'
  + '  Cache-Control: public, max-age=31536000, immutable\n\n/occt/manifest.json\n  Content-Type: application/json\n';
const noticePath = 'licenses/runtime/example-license.txt', noticeBytes = bytes('license text');
interface PublicationOptions {
  readonly part?: Uint8Array;
  readonly occtRecord?: Record<string, unknown>;
  readonly headers?: string;
  readonly web?: ReadonlyMap<string, Uint8Array | null>;
  readonly desktopOcct?: Uint8Array;
  readonly sbom?: (components: SbomComponentInput[]) => SbomComponentInput[];
  readonly sbomVersion?: string;
  readonly sbomCommit?: string;
}
function runtimeComponents(): SbomComponentInput[] {
  const mit = [{ license: { id: 'MIT' } }];
  return [
    { type: 'library', name: 'opencascade.js', version: '2.0.0-beta.b5ff984', licenses: [{ license: { id: 'LGPL-2.1-only' } }],
      properties: [{ name: 'pointercad:distributedFile', value: noticePath + '|' + hash(noticeBytes) }] },
    { type: 'library', name: 'Pyodide 314.0.6', licenses: [{ license: { id: 'MPL-2.0' } }] },
    { type: 'library', name: 'sympy 1.14.0', licenses: [{ license: { id: 'BSD-3-Clause' } }] },
    { type: 'library', name: 'mpmath 1.3.0', licenses: [{ license: { id: 'BSD-3-Clause' } }] },
    { type: 'file', name: 'quickjs-pcad.wasm', version: '65641a0c1e85cc266d7613d6673a22ec834bb941', licenses: mit },
    { type: 'library', name: 'mathlive', version: '0.110.0', licenses: mit },
  ];
}
async function publicationFixture(options: PublicationOptions = {}): Promise<PublicationManifestInput> {
  const part = options.part ?? gzipSync(occtWasm);
  const occtManifest = { byteLength: occtWasm.length, sha256: hash(occtWasm), compression: 'gzip',
    parts: [{ order: 0, file: occtPart.slice('occt/'.length), byteLength: part.length }], ...options.occtRecord };
  const web = new Map<string, Uint8Array | null>([
    ['_headers', bytes(options.headers ?? kernelHeaders)], ['occt/manifest.json', json(occtManifest)], [occtPart, part],
    ['exact-math/runtime/pyodide.asm.wasm', pyodideWasm], ['assets/quickjs-pcad-test.wasm', quickjsWasm],
    ['fonts/NotoSansJP-Regular.otf', bytes('font')], [noticePath, noticeBytes],
  ]);
  for (const [name, value] of options.web ?? []) web.set(name, value);
  const desktop = new Map<string, Uint8Array>([
    ['renderer/assets/opencascade.full-example.wasm', options.desktopOcct ?? occtWasm],
    ['renderer/exact-math/runtime/pyodide.asm.wasm', pyodideWasm], ['renderer/assets/quickjs-pcad-example.wasm', quickjsWasm],
  ]);
  const release = releaseFixture(sourceCommit, { sourceCommit, dirtySources: false }, { web, desktop });
  const releaseManifestBytes = bytes(JSON.stringify(await createReleaseManifest(release), null, 2) + '\n');
  const components = options.sbom === undefined ? runtimeComponents() : options.sbom(runtimeComponents());
  const sbom = assembleSbomDocument({ components }, { rootPackageVersion: options.sbomVersion ?? '0.0.0',
    sourceCommit: options.sbomCommit ?? sourceCommit, generatedAt: '2026-09-27T00:00:00.000Z' });
  return { release, releaseManifestBytes, sbomBytes: json(sbom),
    captureRegistryBytes: json({ format: 'pointercad-capture-registry/1', images: {} }) };
}

describe('公開manifest(publication)は公開一覧・SBOM・撮影の登録簿を束ね、大きさと核の復元を照合する', () => {
  it('既存の記録を指紋で束ね、OCCTを復元して両OSの核と同じと確かめ、大きさを区分ごとに記録する', async () => {
    const input = await publicationFixture(), manifest = await createPublicationManifest(input);
    expect(manifest.format).toBe('pointercad-publication/1');
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.sourceCommit).toBe(sourceCommit);
    expect(manifest.releaseCertified).toBe(false);
    expect(manifest.records.releaseManifest).toEqual({ format: 'pointercad-release/1', sha256: hash(input.releaseManifestBytes) });
    expect(manifest.records.sbom.sha256).toBe(hash(input.sbomBytes));
    expect(manifest.records.sbom.distributedFilesChecked).toBe(1);
    expect(manifest.records.captureRegistry).toEqual({ path: CAPTURE_REGISTRY_PATH, sha256: hash(input.captureRegistryBytes) });
    expect(manifest.records.manual.pdfVolumes).toBe(2);
    expect(manifest.versions).toEqual({ 'opencascade.js': '2.0.0-beta.b5ff984', Pyodide: '314.0.6', sympy: '1.14.0',
      mpmath: '1.3.0', 'quickjs-pcad.wasm': '65641a0c1e85cc266d7613d6673a22ec834bb941', mathlive: '0.110.0' });
    expect(manifest.runtimes.occt.restored).toEqual({ bytes: occtWasm.length, sha256: hash(occtWasm) });
    expect(manifest.runtimes.occt.parts).toEqual([{ path: occtPart, bytes: gzipSync(occtWasm).length, sha256: hash(gzipSync(occtWasm)) }]);
    expect(manifest.runtimes.exactMath.sha256).toBe(hash(pyodideWasm));
    expect(manifest.runtimes.scriptVm.path).toBe('assets/quickjs-pcad-test.wasm');
    expect(manifest.runtimes.fonts.map(font => font.path)).toEqual(['fonts/NotoSansJP-Regular.otf']);
    expect(Object.keys(manifest.sizes.web.categories)).toEqual(
      ['application', 'control', 'exact-math', 'fonts', 'licenses', 'manual', 'manual-pdf', 'occt', 'script-vm']);
    expect(manifest.sizes.web.categories['manual-pdf'].files).toBe(2);
    const saved = JSON.parse(new TextDecoder().decode(input.releaseManifestBytes)) as ReleaseManifest;
    expect(manifest.sizes.web.files).toBe(saved.web.files.length);
    expect(manifest.sizes.web.totalBytes).toBe(saved.web.totalBytes);
    expect(manifest.sizes.web.headroomBytes).toBe(26_214_400 - (manifest.sizes.web.largest?.bytes ?? 0));
    expect(manifest.sizes.desktop.windows.files).toBe(2);
    expect(manifest.sizes.desktop.linux.files).toBe(1);
    await expect(verifyPublicationManifest(manifest, input)).resolves.toEqual(manifest);
  });
  it.each([
    ['releaseManifestBytes', 'Invalid release-manifest.json'],
    ['sbomBytes', 'Invalid sbom.json'],
    ['captureRegistryBytes', 'Invalid capture-manifest.json'],
  ] as const)('壊れた%sを拒否する', async (key, message) => {
    const input = await publicationFixture();
    await expect(createPublicationManifest({ ...input, [key]: bytes('{bad') })).rejects.toThrow(message);
  });
  it('形式の違う撮影の登録簿を拒否する', async () => {
    const input = await publicationFixture();
    await expect(createPublicationManifest({ ...input, captureRegistryBytes: json({ format: 'other/1' }) }))
      .rejects.toThrow('Invalid capture-manifest.json');
  });
  it('配布物と合わない保存済みrelease-manifest.jsonを拒否する', async () => {
    const input = await publicationFixture();
    const saved = JSON.parse(new TextDecoder().decode(input.releaseManifestBytes)) as Record<string, unknown>;
    await expect(createPublicationManifest({ ...input, releaseManifestBytes: json({ ...saved, version: '9.9.9' }) }))
      .rejects.toThrow('Release manifest differs');
  });
  it('SBOMの版の不一致を拒否する', async () => {
    await expect(createPublicationManifest(await publicationFixture({ sbomVersion: '9.9.9' }))).rejects.toThrow('SBOM version differs');
  });
  it('別commitのSBOMを拒否する', async () => {
    await expect(createPublicationManifest(await publicationFixture({ sbomCommit: 'e'.repeat(40) }))).rejects.toThrow('SBOM commit differs');
  });
  it('commitの記録が無いSBOMを拒否する', async () => {
    const input = await publicationFixture();
    const sbom = JSON.parse(new TextDecoder().decode(input.sbomBytes)) as { metadata: { properties: { name: string }[] } };
    sbom.metadata.properties = sbom.metadata.properties.filter(property => property.name !== 'pointercad:sourceCommit');
    await expect(createPublicationManifest({ ...input, sbomBytes: json(sbom) })).rejects.toThrow('SBOM commit differs');
  });
  it('SBOMが記録した原文がWebに無いと拒否する', async () => {
    const input = await publicationFixture({ web: new Map([[noticePath, null]]) });
    await expect(createPublicationManifest(input)).rejects.toThrow('Release manifest is missing SBOM files');
  });
  it('SBOMから計算部の版を読めないと拒否する', async () => {
    const input = await publicationFixture({ sbom: components => components.filter(component => !component.name.startsWith('mpmath')) });
    await expect(createPublicationManifest(input)).rejects.toThrow('Missing SBOM runtime version: mpmath');
  });
  it.each([
    ['occt/manifest.json', 'Missing Web kernel asset: occt/manifest.json'],
    [occtPart, 'Missing Web kernel asset: ' + occtPart],
    ['exact-math/runtime/pyodide.asm.wasm', 'Missing Web exact-math runtime'],
    ['assets/quickjs-pcad-test.wasm', 'Missing Web script runtime'],
    ['fonts/NotoSansJP-Regular.otf', 'Missing Web font files'],
  ])('欠けた資産 %s を拒否する', async (path, message) => {
    await expect(createPublicationManifest(await publicationFixture({ web: new Map([[path, null]]) }))).rejects.toThrow(message);
  });
  it('途中で切れたOCCTの圧縮片を拒否する', async () => {
    const whole = gzipSync(occtWasm);
    await expect(createPublicationManifest(await publicationFixture({ part: whole.subarray(0, whole.length - 8) })))
      .rejects.toThrow('OCCT part cannot be restored');
  });
  it('解凍済みのまま置かれたOCCTを拒否する(配信側の二重解凍の結果)', async () => {
    await expect(createPublicationManifest(await publicationFixture({ part: occtWasm }))).rejects.toThrow('OCCT part is not gzip');
  });
  it('2回圧縮したOCCTを拒否する', async () => {
    const inner = gzipSync(occtWasm);
    const input = await publicationFixture({ part: gzipSync(inner), occtRecord: { byteLength: inner.length, sha256: hash(inner) } });
    await expect(createPublicationManifest(input)).rejects.toThrow('OCCT kernel was compressed twice');
  });
  it('復元したOCCTのhashが記録と違うと拒否する', async () => {
    const input = await publicationFixture({ occtRecord: { sha256: hash('another kernel') } });
    await expect(createPublicationManifest(input)).rejects.toThrow('Restored OCCT kernel hash differs');
  });
  it('復元したOCCTの大きさが記録と違うと拒否する', async () => {
    const input = await publicationFixture({ occtRecord: { byteLength: occtWasm.length + 5 } });
    await expect(createPublicationManifest(input)).rejects.toThrow('Restored OCCT kernel size differs');
  });
  it('記録より大きく展開されるOCCTを拒否する', async () => {
    const input = await publicationFixture({ occtRecord: { byteLength: occtWasm.length - 5 } });
    await expect(createPublicationManifest(input)).rejects.toThrow('larger than recorded');
  });
  it('Webで復元した核とdesktopの核が違うと拒否する', async () => {
    await expect(createPublicationManifest(await publicationFixture({ desktopOcct: wasm('other kernel') })))
      .rejects.toThrow('Restored Web OCCT kernel differs from the win32 desktop kernel');
  });
  it('OCCTにContent-Encodingを付ける配信設定を拒否する', async () => {
    const input = await publicationFixture({ headers: kernelHeaders.replace('/occt/*\n', '/occt/*\n  Content-Encoding: gzip\n') });
    await expect(createPublicationManifest(input)).rejects.toThrow('Deployment headers set Content-Encoding');
  });
  it('OCCTをoctet-streamで配信しない設定を拒否する', async () => {
    const input = await publicationFixture({ headers: '/*\n  X-Content-Type-Options: nosniff\n' });
    await expect(createPublicationManifest(input)).rejects.toThrow('as application/octet-stream');
  });
  it('保存済みpublication manifestの書き換えを拒否する', async () => {
    const input = await publicationFixture(), manifest = await createPublicationManifest(input);
    await expect(verifyPublicationManifest({ ...manifest, sizes: { ...manifest.sizes, web: { ...manifest.sizes.web, files: 1 } } }, input))
      .rejects.toThrow('Publication manifest differs');
  });
  it('Pagesの1ファイル上限はちょうどまで通し、1バイト超えを拒否する', () => {
    const desktop = { windows: [{ name: 'setup.exe', bytes: 1 }], linux: [{ name: 'app.AppImage', bytes: 1 }] };
    expect(measurePublicationSizes([{ path: 'occt/a.bin', bytes: 26_214_400 }], desktop).web.headroomBytes).toBe(0);
    expect(() => measurePublicationSizes([{ path: 'occt/a.bin', bytes: 26_214_401 }], desktop)).toThrow('Web file exceeds 26214400 bytes');
  });
  it('Pagesのファイル数は1,000まで通し、1,001を拒否する', () => {
    const desktop = { windows: [{ name: 'setup.exe', bytes: 1 }], linux: [{ name: 'app.AppImage', bytes: 1 }] };
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ path: 'assets/' + index + '.js', bytes: 1 }));
    expect(measurePublicationSizes(many(1_000), desktop).web.fileHeadroom).toBe(0);
    expect(() => measurePublicationSizes(many(1_001), desktop)).toThrow('Web distribution has 1001 files');
  });
  it('GitHub Releasesの1ファイル2GiB未満を守り、2GiBちょうどの配布物を拒否する', () => {
    const web = [{ path: 'index.html', bytes: 1 }];
    expect(measurePublicationSizes(web, { windows: [{ name: 'setup.exe', bytes: 2_147_483_647 }], linux: [{ name: 'a.AppImage', bytes: 1 }] })
      .desktop.windows.largest).toEqual({ path: 'setup.exe', bytes: 2_147_483_647 });
    expect(() => measurePublicationSizes(web, { windows: [{ name: 'setup.exe', bytes: 1 }], linux: [{ name: 'a.AppImage', bytes: 2_147_483_648 }] }))
      .toThrow('Desktop download exceeds');
  });
  it('大きさの記録が無い・壊れていると拒否する', () => {
    const desktop = { windows: [{ name: 'setup.exe', bytes: 1 }], linux: [{ name: 'app.AppImage', bytes: 1 }] };
    expect(() => measurePublicationSizes([], desktop)).toThrow('Missing Web size records');
    expect(() => measurePublicationSizes([{ path: 'index.html', bytes: 0 }], desktop)).toThrow('Invalid Web size record');
    expect(() => measurePublicationSizes([{ path: 'index.html', bytes: 1 }], { ...desktop, linux: [] })).toThrow('Missing linux desktop size records');
  });
  it('上限は公開前検査(releaseReadiness)と同じ値を使う', () => {
    expect(PUBLICATION_LIMITS.pagesFileBytes).toBe(PAGES_MAX_FILE_BYTES);
    expect(PUBLICATION_LIMITS.pagesFiles).toBe(PAGES_MAX_FILES);
  });
});
