import { describe, expect, it } from 'vitest';
import { serializeCsvReport } from './csvReport.js';

describe('shared output CSV encoding', () => {
  it('preserves the existing BOM/CRLF, boundaries and spreadsheet-safe text without rounding numbers', () => {
    const bytes = serializeCsvReport([['plain', '=1+2', 'text:literal', 'a,"b"\nnext', -1.2345678901234567, '−1', '\t@x']]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]);
    expect(new TextDecoder().decode(bytes)).toBe('plain,text:=1+2,text:text:literal,"a,""b""\nnext",-1.2345678901234567,text:−1,text:\t@x\r\n');
    expect(serializeCsvReport([['x', 1]])).toEqual(serializeCsvReport([['x', 1]]));
  });
});
