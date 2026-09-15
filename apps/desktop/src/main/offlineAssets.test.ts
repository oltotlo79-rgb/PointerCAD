import { describe, expect, it } from 'vitest';
import {
  createOfflineAssetManifest, offlineAssetUrl, OFFLINE_MAX_FILE_BYTES,
} from '../../../../scripts/vite/offlineAssets.mjs';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text = 'hello') => ({ path, bytes: bytes(text) });
const example = [file('index.html'), file('assets/worker.js', 'worker'), file('manual/巻1.pdf', 'pdf')];
const required = ['index.html', 'assets/worker.js', 'manual/巻1.pdf'];

describe('通信なしの利用に必要な同じ版の全ファイルを列挙する', () => {
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
