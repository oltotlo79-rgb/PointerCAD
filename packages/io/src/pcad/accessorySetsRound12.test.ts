/**
 * 12 回目の形の付属の組の記録(端のキャップの組。指定は ends・endReference・itemKey の 3 欄だけ)を持つ組立の文書を、固定の文字
 * (accessorySetsRound12.fixture.json。2026-11-19 に 12 回目の形の書き手の道で作り、以後は取り直さない)で持ち、
 * 今の読み手で読めて、開いて保存し直すと同じバイトになる事を確かめる(統括の決定 2026-11-19 16:0x。記録の形を足しても今の形のファイルが読める事を守る)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';

const TEXT = readFileSync(new URL('./accessorySetsRound12.fixture.json', import.meta.url), 'utf8');
const SAVED_AT = '2026-11-19T00:00:00.000Z';

describe('12 回目の形の付属の組の記録', () => {
  it('読めて、記録は端のキャップの組 1 つ(両端・全長・行 s6-20x20)で、部品は本体とキャップ 2 個', () => {
    const read = readAssemblyDocument(TEXT);
    if (!read.ok) throw new Error('read failed');
    expect(read.document.schemaVersion).toBe(23);
    expect(read.document.accessorySets).toEqual([{ id: 'accessory-1', setId: 'frame-end-caps', hostComponentId: 'component-1',
      accessories: [{ componentId: 'component-2', role: 'startCap' }, { componentId: 'component-3', role: 'endCap' }],
      choices: { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' } }]);
    expect(read.document.components.map((component) => component.id)).toEqual(['component-1', 'component-2', 'component-3']);
  });

  it('開いて保存し直すと、固定の文字と同じバイトになる', () => {
    const read = readAssemblyDocument(TEXT);
    if (!read.ok) throw new Error('read failed');
    expect(writeAssemblyDocument(read.document, { savedAt: SAVED_AT })).toBe(TEXT);
  });
});
