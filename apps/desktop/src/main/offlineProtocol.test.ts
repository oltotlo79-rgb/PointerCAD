import { describe, expect, it } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { readOfflineAssetManifest } from '../../../../scripts/vite/offlineProtocol.mjs';

const example = () => createOfflineAssetManifest([
  { path: 'index.html', bytes: new TextEncoder().encode('hello') },
  { path: 'worker.js', bytes: new TextEncoder().encode('worker') },
  { path: 'manual/巻1.pdf', bytes: new TextEncoder().encode('pdf') },
], ['index.html', 'worker.js', 'manual/巻1.pdf']);

describe('保存一覧を作る処理と読む処理が同じ版・全必須ファイルを扱う', () => {
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
