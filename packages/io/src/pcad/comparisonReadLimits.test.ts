import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { unzipSync } from 'fflate';
import { IO_LIMITS } from '../limits.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';

describe('二文書の比較で使う展開前の個別上限', () => {
  it('通常は開ける同じファイルでも、小さい圧縮・単一展開・合計展開の各上限で断る', () => {
    const bytes = writePcadFile(createEmptyPartDocument()), original = [...bytes];
    const expanded = unzipSync(bytes)['document.json'].byteLength;
    expect(readPcadFile(bytes).ok).toBe(true);
    for (const limits of [{ ...IO_LIMITS, archiveCompressedBytes: bytes.length - 1 },
      { ...IO_LIMITS, archiveEntryExpandedBytes: expanded - 1 },
      { ...IO_LIMITS, archiveTotalExpandedBytes: expanded - 1 }]) {
      const result = readPcadFile(bytes, { limits });
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toContain('大きすぎる');
    }
    expect([...bytes]).toEqual(original); expect(readPcadFile(bytes).ok).toBe(true);
  });
});
