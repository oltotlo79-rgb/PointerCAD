import { describe, expect, it } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { readOfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';
import { createHash } from 'node:crypto';
import { offlineManifestBody } from '../../../../scripts/vite/offlineProtocol.mjs';

// 固定値の出どころ: 採用した closed 版 OCCT の wasm の実寸。
// `vendor/opencascade/opencascade.js-b5ff984-closed-0839d9bcc8ac4677/pcad-closed-build.json` の
// `build.wasmBytes`(復号後 19,082,393 バイト)と `build.wasmGzipBytes`(gzip 後 5,897,246 バイト。
// 配布資産を作る `apps/web/vite.config.ts` の `gzipSync(source, { level: 9 })` と同じ方法)。
// この検査は一覧の照合を確かめるもので実物の wasm は読まない。SHA-256 は仮の値を使う。
const OCCT_WASM_BYTES = 19_082_393;
const OCCT_WASM_GZIP_BYTES = 5_897_246;
const streamSha = 'a'.repeat(64);
const v2 = (streamBytes = OCCT_WASM_BYTES) => {
  const assets = [
    { url: 'index.html', byteLength: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
    { url: `occt/stream/opencascade.full-${streamSha}.wasm`, byteLength: streamBytes, sha256: streamSha,
      transport: { encoding: 'gzip' as const, byteLength: OCCT_WASM_GZIP_BYTES, sha256: 'b'.repeat(64) } },
  ] as const;
  const body = { format: 'pointercad-offline-assets/2' as const, entry: 'index.html' as const,
    totalBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0),
    required: assets.map(asset => asset.url), assets };
  return { ...body, buildId: createHash('sha256').update(JSON.stringify(offlineManifestBody(body))).digest('hex') };
};

const example = () => createOfflineAssetManifest([
  { path: 'index.html', bytes: new TextEncoder().encode('hello') },
  { path: 'worker.js', bytes: new TextEncoder().encode('worker') },
  { path: 'manual/巻1.pdf', bytes: new TextEncoder().encode('pdf') },
], ['index.html', 'worker.js', 'manual/巻1.pdf']);

describe('保存一覧を作る処理と読む処理が同じ版・全必須ファイルを扱う', () => {
  it('v2は復号後と物理輸送の長さ・SHAを別に保持し、輸送変更で版を変える', async () => {
    const source = v2();
    await expect(readOfflineAssetManifest(source)).resolves.toEqual(source);
    await expect(readOfflineAssetManifest({ ...source, assets: [source.assets[0],
      { ...source.assets[1], transport: { ...source.assets[1]?.transport, sha256: 'c'.repeat(64) } }] }))
      .rejects.toThrow('content does not match');
  });
  it('v2の一般25MiB・stream復号64MiB・輸送25MiB・1000件・合計1GiBを個別に守る', async () => {
    const source = v2();
    const stream = source.assets[1];
    if (stream === undefined) throw new Error('Missing stream fixture');
    const change = (asset: object) => ({ ...source, assets: [source.assets[0], { ...stream, ...asset }] });
    await expect(readOfflineAssetManifest({ ...source, assets: [
      { ...source.assets[0], byteLength: 26_214_401 }, stream] })).rejects.toThrow('record');
    await expect(readOfflineAssetManifest(change({ byteLength: 67_108_865 }))).rejects.toThrow('record');
    // closed 版の wasm(19,082,393)は一般の上限(25MiB)を超えないので、streamだけが一般の上限を超えて
    // 64MiBまで受理されること(上限を別々に守ること)は境界の値で確かめる。64MiB+1は直前の行で拒否している。
    for (const accepted of [26_214_401, 67_108_864]) {
      const wide = v2(accepted);
      await expect(readOfflineAssetManifest(wide)).resolves.toEqual(wide);
    }
    await expect(readOfflineAssetManifest(change({ transport: { ...stream.transport, byteLength: 26_214_401 } })))
      .rejects.toThrow('record');
    await expect(readOfflineAssetManifest({ ...source, assets: Array.from({ length: 1001 }, () => source.assets[0]) }))
      .rejects.toThrow('inventory');
    await expect(readOfflineAssetManifest({ ...source, totalBytes: 1_073_741_825 }))
      .rejects.toThrow('inventory');
    const general = Array.from({ length: 998 }, (_, index) => ({
      url: `a${String(index).padStart(4, '0')}.bin`, byteLength: 1_050_000, sha256: 'c'.repeat(64),
    }));
    const physicalOver = [...general, { url: 'index.html', byteLength: 1_050_000, sha256: 'c'.repeat(64) },
      { ...stream, byteLength: 1, transport: { ...stream.transport, byteLength: 26_214_400 } }];
    await expect(readOfflineAssetManifest({ ...source, assets: physicalOver, required: ['index.html'],
      totalBytes: 1_048_950_001 })).rejects.toThrow('transport is too large');
    const decodedOver = [...general.map(asset => ({ ...asset, byteLength: 1_073_742 })),
      { url: 'index.html', byteLength: 1_073_742, sha256: 'c'.repeat(64) },
      { ...stream, byteLength: 1_073_742 }];
    await expect(readOfflineAssetManifest({ ...source, assets: decodedOver, required: ['index.html'],
      totalBytes: 1_073_741_824 })).rejects.toThrow('too large');
  });
  it('v2の偽stream名・不正URL・欠損/二重encoding・輸送hashを拒否する', async () => {
    const source = v2(), stream = source.assets[1];
    if (stream === undefined) throw new Error('Missing stream fixture');
    for (const url of ['occt/stream/../bad.wasm', 'occt/stream/bad%2Ewasm',
      'https://other.test/stream.wasm', `occt/stream/opencascade.full-${'c'.repeat(64)}.wasm`]) {
      await expect(readOfflineAssetManifest({ ...source, assets: [source.assets[0], { ...stream, url }] })).rejects.toThrow();
    }
    for (const transport of [undefined, { ...stream.transport, encoding: 'gzip, gzip' },
      { ...stream.transport, encoding: '' }, { ...stream.transport, sha256: 'invalid' },
      { ...stream.transport, anotherEncoding: 'br' }]) {
      await expect(readOfflineAssetManifest({ ...source, assets: [source.assets[0], { ...stream, transport }] }))
        .rejects.toThrow();
    }
  });
  it('Nodeで作った実バイト一覧をWeb Cryptoで独立に照合する', async () => {
    const source = example();
    const result = await readOfflineAssetManifest(JSON.parse(JSON.stringify(source)) as unknown);
    expect(result).toEqual(source);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.required)).toBe(true);
    expect(Object.isFrozen(result.assets)).toBe(true);
    expect(result.assets.every(Object.isFrozen)).toBe(true);
  });
  it('JSONの項目順の違いは内容の変更と取り違えない', async () => {
    const value = example();
    const reordered = { buildId: value.buildId, assets: value.assets.map(asset => ({ sha256: asset.sha256,
      byteLength: asset.byteLength, url: asset.url })), required: value.required,
      totalBytes: value.totalBytes, entry: value.entry, format: value.format };
    await expect(readOfflineAssetManifest(reordered)).resolves.toEqual(value);
  });
  it('同じ件数・合計量でも内容や必須ファイルの変更を見逃さない', async () => {
    const value = example();
    const changed = value.assets.map((asset, index) => index === 0 ? { ...asset, sha256: '0'.repeat(64) } : asset);
    await expect(readOfflineAssetManifest({ ...value, assets: changed })).rejects.toThrow('content does not match');
    await expect(readOfflineAssetManifest({ ...value, required: ['index.html'] })).rejects.toThrow('content does not match');
    await expect(readOfflineAssetManifest({ ...value, buildId: '0'.repeat(64) })).rejects.toThrow('content does not match');
  });
  it('必須の子処理・説明書の欠落をダウンロード開始前に拒否する', async () => {
    const value = example();
    for (const missing of ['worker.js', 'manual/%E5%B7%BB1.pdf']) {
      const assets = value.assets.filter(asset => asset.url !== missing);
      await expect(readOfflineAssetManifest({ ...value, assets,
        totalBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0) })).rejects.toThrow('required offline asset');
    }
  });
  it('異なるOSで意味が変わる参照やURLの別表記を拒否する', async () => {
    const value = example();
    for (const url of ['../outside', '%2e%2e/outside', '/index.html', 'https://other.test/a', 'index.html?next=1',
      'index.html#fragment', 'index%2Ehtml', '%69ndex.html', 'a%2fb.js', 'a%5Cb.js', '%', '%ED%A0%80',
      ...Array.from({ length: 32 }, (_, code) => `a${encodeURIComponent(String.fromCharCode(code))}.js`), 'a%7F.js']) {
      await expect(readOfflineAssetManifest({ ...value, assets: [{ ...value.assets[0], url }, ...value.assets.slice(1)] })).rejects.toThrow();
    }
  });
  it('重複・逆順・必須の二重計上で不足を隠せない', async () => {
    const value = example();
    const duplicate = [value.assets[0], value.assets[0], ...value.assets.slice(1)];
    await expect(readOfflineAssetManifest({ ...value, assets: duplicate })).rejects.toThrow('Duplicate or unordered');
    await expect(readOfflineAssetManifest({ ...value, assets: [...value.assets].reverse() })).rejects.toThrow('Duplicate or unordered');
    await expect(readOfflineAssetManifest({ ...value, required: ['index.html', 'index.html'] })).rejects.toThrow('required offline asset');
    await expect(readOfflineAssetManifest({ ...value, totalBytes: value.totalBytes + 1 })).rejects.toThrow('total');
  });
  it('ファイル名が別でも、同じ公開URLへ変わる一覧を採用しない', async () => {
    const value = example();
    const sample = value.assets[0];
    const assets = [...value.assets, { ...sample, url: 'manual/overview' }, { ...sample, url: 'manual/overview.html' }]
      .sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
    await expect(readOfflineAssetManifest({ ...value, assets,
      totalBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0) })).rejects.toThrow('Duplicate or unordered');
  });
  it.each([null, [], {}, { format: 'pointercad-offline-assets/2' }])('破損した形式%jを受け入れない', async value => {
    await expect(readOfflineAssetManifest(value)).rejects.toThrow('Invalid offline edition');
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 26_214_401, '5'])('不正なバイト数%sを受け入れない', async byteLength => {
    const value = example();
    await expect(readOfflineAssetManifest({ ...value,
      assets: [{ ...value.assets[0], byteLength }, ...value.assets.slice(1)] })).rejects.toThrow('Invalid offline asset');
  });
});
