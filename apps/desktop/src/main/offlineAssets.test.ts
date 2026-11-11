import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  createOfflineAssetManifest, offlineAssetUrl, OFFLINE_MAX_FILE_BYTES,
} from '../../../../scripts/vite/offlineAssets.mjs';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text = 'hello') => ({ path, bytes: bytes(text) });
const example = [file('index.html'), file('assets/worker.js', 'worker'), file('manual/巻1.pdf', 'pdf')];
const required = ['index.html', 'assets/worker.js', 'manual/巻1.pdf'];
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function isDesktopAssetBuilder(value: unknown): value is { desktopOcctAssets: (input: Uint8Array) => unknown } {
  return typeof value === 'object' && value !== null &&
    'desktopOcctAssets' in value && typeof value.desktopOcctAssets === 'function';
}
function streamFixture(decoded = bytes('small wasm')) {
  const compressed = new Uint8Array(gzipSync(decoded)), decodedSha = hash(decoded), transportSha = hash(compressed);
  const streamPath = `occt/stream/opencascade.full-${decodedSha}.wasm`;
  const legacyPath = `occt/opencascade.full-${decodedSha.slice(0, 16)}.bin`;
  const occt = { byteLength: decoded.byteLength, sha256: decodedSha, compression: 'gzip',
    parts: [{ order: 0, file: legacyPath.slice('occt/'.length), byteLength: compressed.byteLength }],
    stream: { file: streamPath.slice('occt/'.length), compression: 'gzip',
      transportByteLength: compressed.byteLength, transportSha256: transportSha,
      decodedByteLength: decoded.byteLength, decodedSha256: decodedSha } };
  const files = [file('index.html'), { path: legacyPath, bytes: compressed },
    { path: streamPath, bytes: compressed }, { path: 'occt/manifest.json', bytes: bytes(JSON.stringify(occt)) }];
  return { files, occt, decoded, compressed, streamPath, legacyPath };
}

describe('通信なしの利用に必要な同じ版の全ファイルを列挙する', () => {
  it('Desktop build gzip uses the existing manifest and release asset decoded/transport identities', async () => {
    const decoded = bytes('desktop native wasm fixture');
    // Keep the build configuration outside the application's TypeScript rootDir.
    const configUrl = new URL('../../vite.renderer.config.ts', import.meta.url).href;
    const config: unknown = await import(/* @vite-ignore */ configUrl);
    if (!isDesktopAssetBuilder(config)) throw new Error('Desktop gzip build helper missing');
    const built: unknown = config.desktopOcctAssets(decoded);
    if (typeof built !== 'object' || built === null || !('compressed' in built) ||
        !(built.compressed instanceof Uint8Array) || !('partFile' in built) || typeof built.partFile !== 'string' ||
        !('streamFile' in built) || typeof built.streamFile !== 'string' || !('manifest' in built)) {
      throw new Error('Desktop gzip build output malformed');
    }
    const streamFile = built.streamFile;
    const manifest: unknown = built.manifest;
    if (typeof manifest !== 'object' || manifest === null || !('sha256' in manifest) ||
        !('byteLength' in manifest) || !('stream' in manifest) || typeof manifest.stream !== 'object' ||
        manifest.stream === null || !('decodedSha256' in manifest.stream)) throw new Error('Desktop manifest malformed');
    const files = [file('index.html'),
      { path: `occt/${built.partFile}`, bytes: built.compressed },
      { path: `occt/${built.streamFile}`, bytes: built.compressed },
      { path: 'occt/manifest.json', bytes: bytes(JSON.stringify(built.manifest)) }];
    const release = createOfflineAssetManifest(files, files.map(item => item.path));
    expect(manifest.sha256).toBe(hash(decoded));
    expect(manifest.byteLength).toBe(decoded.byteLength);
    expect(manifest.stream.decodedSha256).toBe(hash(decoded));
    expect(release.assets.find(asset => asset.url === `occt/${streamFile}`)).toEqual({
      url: `occt/${built.streamFile}`, byteLength: decoded.byteLength, sha256: hash(decoded),
      transport: { encoding: 'gzip', byteLength: built.compressed.byteLength, sha256: hash(built.compressed) },
    });
  });
  it('A1のgzip実体を限定付きで展開し、v2に輸送と復号の両指紋を記録する', () => {
    const input = streamFixture();
    const result = createOfflineAssetManifest(input.files, input.files.map(item => item.path));
    expect(result.format).toBe('pointercad-offline-assets/2');
    expect(result.assets.find(asset => asset.url === input.streamPath)).toEqual({
      url: input.streamPath, byteLength: input.decoded.byteLength, sha256: hash(input.decoded),
      transport: { encoding: 'gzip', byteLength: input.compressed.byteLength, sha256: hash(input.compressed) },
    });
    expect(result.totalBytes).toBe(input.files.reduce((sum, item) => sum + item.bytes.byteLength, 0)
      - input.compressed.byteLength + input.decoded.byteLength);
  });
  it('物理gzipの改変、復号本文の改変、gzip bombを一覧発行前に拒否する', () => {
    const input = streamFixture();
    const requiredPaths = input.files.map(item => item.path);
    const altered = input.files.map(item => item.path === input.streamPath
      ? { ...item, bytes: new Uint8Array(gzipSync(bytes('other wasm'))) } : item);
    expect(() => createOfflineAssetManifest(altered, requiredPaths)).toThrow('transport');
    const wrongDecoded = { ...input.occt, sha256: 'a'.repeat(64),
      stream: { ...input.occt.stream, decodedSha256: 'a'.repeat(64),
        file: `stream/opencascade.full-${'a'.repeat(64)}.wasm` } };
    const changed = input.files.map(item => item.path === 'occt/manifest.json'
      ? { ...item, bytes: bytes(JSON.stringify(wrongDecoded)) } : item);
    expect(() => createOfflineAssetManifest(changed, requiredPaths)).toThrow();
    const bomb = streamFixture(new Uint8Array(1024 * 1024));
    const declared = { ...bomb.occt, byteLength: 100,
      stream: { ...bomb.occt.stream, decodedByteLength: 100 } };
    const bombFiles = bomb.files.map(item => item.path === 'occt/manifest.json'
      ? { ...item, bytes: bytes(JSON.stringify(declared)) } : item);
    expect(() => createOfflineAssetManifest(bombFiles, bombFiles.map(item => item.path))).toThrow('gzip');
  });
  it('実バイト数と既知の内容指紋を記録し、並べる順番で版を変えない', () => {
    const first = createOfflineAssetManifest(example, required);
    const reverse = createOfflineAssetManifest([...example].reverse(), [...required].reverse());
    expect(first).toEqual(reverse);
    expect(first.totalBytes).toBe(14);
    expect(first.assets.find(asset => asset.url === 'index.html')).toEqual({ url: 'index.html', byteLength: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
    expect(first.required).toContain('manual/%E5%B7%BB1.pdf');
    expect(first.buildId).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('長さが同じ内容変更も、必須ファイルの条件変更も別の版として扱う', () => {
    const original = createOfflineAssetManifest(example, required);
    const changed = createOfflineAssetManifest([file('index.html', 'HELLO'), ...example.slice(1)], required);
    const differentRequirement = createOfflineAssetManifest(example, ['index.html']);
    expect(changed.totalBytes).toBe(original.totalBytes);
    expect(changed.buildId).not.toBe(original.buildId);
    expect(differentRequirement.buildId).not.toBe(original.buildId);
  });
  it('子処理や説明書の欠落を、他のファイルで同じ件数にしても受け入れない', () => {
    for (const path of required) {
      const missing = example.filter(item => item.path !== path);
      expect(() => createOfflineAssetManifest([...missing, file('replacement.txt')], required)).toThrow('Missing required');
    }
    expect(() => createOfflineAssetManifest(example, ['assets/worker.js'])).toThrow('entry HTML');
    expect(() => createOfflineAssetManifest([], required)).toThrow('count');
    expect(() => createOfflineAssetManifest(example, [])).toThrow('required');
  });
  it('同じURLとOSで意味の変わる大文字小文字の衝突を拒否する', () => {
    expect(() => createOfflineAssetManifest([...example, example[0]], required)).toThrow('Duplicate');
    expect(() => createOfflineAssetManifest([...example, file('INDEX.HTML')], required)).toThrow('Duplicate');
    expect(() => createOfflineAssetManifest(example, [...required, required[0]])).toThrow('Duplicate required');
  });
  it('異なるファイル名が同じ公開先になる場合、取得前に衝突を拒否する', () => {
    expect(() => createOfflineAssetManifest([...example, file('manual/overview.html'), file('manual/overview')], required))
      .toThrow('Duplicate offline asset or public route');
  });
  it.each(['../escape', '/index.html', 'C:/index.html', 'a\\b.js', 'a//b.js', 'a/./b', 'a/../b',
    'file?secret=1', 'file#section', 'a\0b', '%2e%2e/file', 'a.', 'a '])('範囲外と曖昧な参照%sを拒否する', path => {
    expect(() => offlineAssetUrl(path)).toThrow();
  });
  it('版の指紋へ自身を含む循環や配信設定の混入を拒否する', () => {
    for (const path of ['offline-assets.json', 'service-worker.js', '_headers', '_redirects', 'OFFLINE-ASSETS.JSON', 'SERVICE-WORKER.JS']) {
      expect(() => createOfflineAssetManifest([...example, file(path)], required)).toThrow('Control or deployment');
    }
  });
  it('空ファイルと配信できない大きさを、取得完了に数えない', () => {
    expect(() => createOfflineAssetManifest([file('index.html', '')], ['index.html'])).toThrow('size');
    const oversized = { path: 'index.html', bytes: new Uint8Array(OFFLINE_MAX_FILE_BYTES + 1) };
    expect(() => createOfflineAssetManifest([oversized], ['index.html'])).toThrow('size');
  });
  it('入力配列と生成済みの対応を後から書き換えさせない', () => {
    const input = [...example];
    const original = input.map(item => item.path);
    const manifest = createOfflineAssetManifest(input, required);
    expect(input.map(item => item.path)).toEqual(original);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.assets)).toBe(true);
    expect(manifest.assets.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(manifest.required)).toBe(true);
  });
});
