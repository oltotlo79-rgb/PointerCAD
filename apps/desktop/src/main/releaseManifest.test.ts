import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assembleDesktopDistribution, verifyDesktopDistribution } from '../../../../scripts/release/desktopDistribution.mjs';
import { verifyDesktopPackageArtifacts } from '../../../../scripts/release/desktopPackageTargets.mjs';
import { createReleaseManifest, verifyReleaseManifest } from '../../../../scripts/release/releaseManifest.mjs';
import type { ReleaseCandidateInput, ReleaseManifestInput } from '../../../../scripts/release/releaseManifest.mjs';
import { bytes, files, fixture, hash, inputs, json } from './distributionTestFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const packageFiles = { root: readFileSync(join(root, 'package.json')),
  desktop: readFileSync(join(root, 'apps/desktop/package.json')), web: readFileSync(join(root, 'apps/web/package.json')) };
const builderConfig = readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
const sourceCommit = 'a'.repeat(40);
const webInputs = { ...inputs, 'package.json': hash(packageFiles.root), 'apps/web/package.json': hash(packageFiles.web) };
const desktopInputs = { ...inputs, 'package.json': hash(packageFiles.root), 'apps/desktop/package.json': hash(packageFiles.desktop),
  'apps/desktop/electron-builder.yml': hash(builderConfig) };

function candidate(manual: ReturnType<typeof fixture>, platform: 'win32' | 'linux'): ReleaseCandidateInput {
  const desktop = new Map<string, Uint8Array>([
    ['main/main.cjs', bytes("require('electron');")], ['preload/preload.cjs', bytes("require('electron');")],
    ...['renderer/index.html', 'renderer/fonts/LICENSES.txt', 'renderer/licenses/math-notices.json',
      'renderer/licenses/runtime/runtime-notices.json', 'renderer/LICENSE', 'renderer/NOTICE',
      'renderer/licenses/exact-math/manifest.json', 'renderer/exact-math/runtime/pyodide.asm.wasm',
      'renderer/assets/opencascade.full-example.wasm', 'renderer/assets/quickjs-pcad-example.wasm']
      .map(name => [name, bytes(name)] as const),
  ]);
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
function releaseFixture(manualCommit = sourceCommit,
  webBuildExtra: Record<string, unknown> = { sourceCommit, dirtySources: false }): ReleaseManifestInput {
  const manual = fixture();
  const manualRecord = { ...manual.manualManifest, sourceCommit: manualCommit, dirtySources: false };
  manual.manual.set('manifest.json', json(manualRecord));
  manual.pdf.set('pdf-manifest.json', json({ ...manual.pdfManifest, manualManifestSha256: hash(json(manualRecord)) }));
  manual.web.set('web-build.json', json({ format: 'pointercad-web-build/1', ...webBuildExtra, inputs: webInputs,
    outputs: Object.fromEntries([...manual.web].filter(([name]) => name !== 'web-build.json')
      .map(([name, value]) => [name, hash(value)])) }));
  const assembled = manual.assemble();
  return { packageFiles, builderConfig, sourceCommit, sourceInputs: { web: webInputs, desktop: desktopInputs, manual: inputs },
    candidates: [candidate(manual, 'win32'), candidate(manual, 'linux')], webFiles: files(assembled.files) };
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
