import { describe, expect, it } from 'vitest';
import { composeSheetConnectionAliases, resolveSheetSeams } from './seamConnections.js';
import { closedSheetLoop } from './testing/closedSheetLoop.js';

describe('加工で分かれた継ぎ目の保存参照', () => {
  it('一対多・接触消失・二段の加工を合成し、座標や配列順から継ぎ目を選ばない', () => {
    const body = { ...closedSheetLoop(), connectionAliases: new Map([
      ['old-seam', ['corner-0', 'corner-1']], ['gone-seam', ['corner-2']],
    ]) };
    const before = [...body.connectionAliases];
    const mapping = composeSheetConnectionAliases(body, new Map([['corner-0', ['split-a', 'split-b']], ['corner-2', []]]));
    const base = body.bends[0];
    const current = { ...body, connectionAliases: mapping,
      bends: [body.bends[3], { ...base, id: 'split-b' }, body.bends[1], { ...base, id: 'split-a' }] };
    expect(resolveSheetSeams(current, ['old-seam'])).toEqual({ ok: true, value: ['corner-1', 'split-a', 'split-b'] });
    expect(resolveSheetSeams(current, ['gone-seam'])).toEqual({ ok: true, value: [] });
    expect(resolveSheetSeams(current, ['corner-0'])).toEqual({ ok: true, value: ['split-a', 'split-b'] });
    expect([...body.connectionAliases]).toEqual(before);
    expect(resolveSheetSeams(current, ['old-seam', 'corner-0']).ok).toBe(false);
    expect(resolveSheetSeams(current, ['absent']).ok).toBe(false);
  });
  it('現存しない接続に終わる写像と空・重複IDを断る', () => {
    const body = { ...closedSheetLoop(), connectionAliases: new Map([['old', ['absent']]]) };
    for (const references of [['old'], [''], ['  '], ['corner-0', 'corner-0']])
      expect(resolveSheetSeams(body, references).ok).toBe(false);
  });
});
