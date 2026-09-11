import { describe, expect, it } from 'vitest';
import { Zip, ZipDeflate, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { zipDirectory } from './zipDirectory.js';
import { readArchive } from './readArchive.js';

function streaming(compressed: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => { if (error !== null) throw error; chunks.push(bytes); });
  const entry = compressed ? new ZipDeflate('document.json') : new ZipPassThrough('document.json');
  zip.add(entry); entry.push(strToU8('{"length":'), false); entry.push(strToU8('20}'), true); zip.end();
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

describe('中央目録とCRCの対応', () => {
  it('通常ZIPと署名付きdescriptorを圧縮あり/なしで読む', () => {
    for (const zip of [zipSync({ 'document.json': strToU8('{"length":20}') }), streaming(false), streaming(true)]) {
      const directory = zipDirectory(zip, 10);
      expect(directory.map((entry) => entry.name)).toEqual(['document.json']);
      const result = readArchive(zip, { shouldExtract: () => true });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entries.get('document.json')).toEqual(strToU8('{"length":20}'));
    }
  });
  it('内容だけ20から90へ変えた保存データをCRC不一致で断る', () => {
    for (const bytes of [zipSync({ 'document.json': [strToU8('{"length":20}'), { level: 0 }] }), streaming(false)]) {
      const entry = zipDirectory(bytes, 10)[0];
      if (entry === undefined) throw new Error('fixtureがありません');
      const value = strToU8('{"length":90}'); entry.compressed.set(value);
      expect(readArchive(bytes, { shouldExtract: () => true })).toMatchObject({ ok: false, error: { kind: 'invalidZip' } });
    }
  });
  it('中央目録の切断、localとの名前不一致、local領域の重複を断る', () => {
    const original = zipSync({ a: strToU8('first'), b: strToU8('second') });
    expect(() => zipDirectory(original.subarray(0, original.length - 1), 10)).toThrow('invalidZip');
    const wrongName = original.slice(); wrongName[30] = 99;
    expect(() => zipDirectory(wrongName, 10)).toThrow('invalidZip');
    const overlap = original.slice(), view = new DataView(overlap.buffer);
    const central = view.getUint32(overlap.length - 6, true);
    const second = central + 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
    view.setUint32(second + 42, 0, true);
    expect(() => zipDirectory(overlap, 10)).toThrow('invalidZip');
  });
  it('目録の個数が上限を超えたらentry配列を作る前に拒否する', () => {
    expect(() => zipDirectory(zipSync({ a: new Uint8Array(), b: new Uint8Array() }), 1)).toThrow('entryCount');
    expect(zipDirectory(zipSync({}), 0)).toEqual([]);
  });
});
