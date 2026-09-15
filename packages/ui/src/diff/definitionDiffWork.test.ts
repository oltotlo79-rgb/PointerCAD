import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createPrimitiveFeature } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { PCAD_TEMPLATE_KIND, writePcadFile } from '@pointercad/io';
import { executeDefinitionDiffWork } from './definitionDiffWork.js';

describe('実ファイルを別々に読んだ比較結果を画面へ返す', () => {
  it('保存ファイル2個の差を求め、元の圧縮バイト列を更新しない', async () => {
    const empty = createEmptyPartDocument(), original = { ...empty, solids: [createPrimitiveFeature(empty, 'box')] };
    const before = writePcadFile(original), after = writePcadFile({ ...original, solids: [{ ...original.solids[0],
      shape: { kind: 'box', sizeX: expressionValueFromNumber(30), sizeY: expressionValueFromNumber(20), sizeZ: expressionValueFromNumber(20) } }] });
    const originals = [[...before], [...after]];
    const result = await executeDefinitionDiffWork({ kind: 'compare', before, after, relationship: 'versions' });
    expect(result.kind).toBe('compared');
    if (result.kind === 'compared') { expect(result.result.geometryCompared).toBe(false); expect(result.result.changes.some(change => change.group === 'solid')).toBe(true); }
    expect([[...before], [...after]]).toEqual(originals);
  });
  it('片側の破損、不正な関係、ひな形を完成した比較に読み替えない', async () => {
    const bytes = writePcadFile(createEmptyPartDocument());
    for (const request of [{ kind: 'compare', before: bytes, after: new Uint8Array([1]), relationship: 'versions' },
      { kind: 'compare', before: bytes, after: bytes, relationship: 'guess' },
      { kind: 'inspect', bytes: 'not bytes' },
      { kind: 'inspect', bytes: writePcadFile(createEmptyPartDocument(), { kind: PCAD_TEMPLATE_KIND }) }]) expect((await executeDefinitionDiffWork(request)).kind).toBe('failed');
  });
});
