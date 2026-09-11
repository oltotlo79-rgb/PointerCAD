import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import fixtures from './zip64Fixtures.json';
import { zipDirectory } from './zipDirectory.js';
import { readArchive } from './readArchive.js';

function bytes(encoded: string): Uint8Array { return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)); }
function signatureAt(data: Uint8Array, signature: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index <= data.length - 4; index++) if (view.getUint32(index, true) === signature) return index;
  throw new Error('ZIP64 fixtureの署名がありません');
}

describe('独立した書き手のZIP64入力（R06/R10）', () => {
  for (const fixture of fixtures.fixtures) {
    it(fixture.name + ': 圧縮/非圧縮・descriptorの有無を正しく読む', () => {
      const data = bytes(fixture.zip), result = readArchive(data, { shouldExtract: () => true });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.reason);
      expect(result.entries.get(fixture.entry)).toEqual(strToU8(fixture.text));
    });
  }

  it('ZIP64のoffsetが安全な整数でなければ実領域を探す前に断る', () => {
    const fixture = fixtures.fixtures[0];
    if (fixture === undefined) throw new Error('ZIP64 fixture不足');
    const data = bytes(fixture.zip), view = new DataView(data.buffer);
    const locator = signatureAt(data, 0x07064b50);
    view.setUint32(locator + 12, 0x200000, true);
    expect(() => zipDirectory(data, 10)).toThrow('invalidZip');
  });

  it('ZIP64のdescriptorがCRC/実長と矛盾すれば断る', () => {
    const fixture = fixtures.fixtures.find((item) => item.name === 'python-zip64-deflated-descriptor');
    if (fixture === undefined) throw new Error('streaming ZIP64 fixture不足');
    const data = bytes(fixture.zip), view = new DataView(data.buffer);
    const descriptor = signatureAt(data, 0x08074b50);
    view.setUint32(descriptor + 16, 1, true);
    expect(() => zipDirectory(data, 10)).toThrow('invalidZip');
  });
});
