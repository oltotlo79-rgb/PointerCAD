import { expressionValueFromNumber } from '@pointercad/expression';
import type { SheetMetalRecognizedRim } from '@pointercad/kernel';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import type { Vec3 } from '../sketch/vec3.js';
import { sheetFlatReferenceIssue } from './flatSheetReference.js';
import { resolveSheetConvert } from './resolveSheetConvert.js';
import { setSheetUnfoldDefinition } from './sheetUnfoldDefinition.js';
import type { SheetConvertFeature } from './types.js';

// 50×30×2 の平板 1 枚を基準の面 z=0 から読んだ答え(実の箱を読んだ時と同じ形。sheetConvertRecompute.test.ts)。
const corners: readonly Vec3[] = [[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]];
const rims: SheetMetalRecognizedRim[] = corners.map((from, i) => ({ edgeIndex: i, curve: { kind: 'segment', from, to: corners[(i + 1) % 4] } }));
const convert: SheetConvertFeature = { kind: 'sheetConvert', id: 'convert-1', name: '板金へ変換', suppressed: false, sourceFeatureId: 'box-1',
  referenceFace: { bodyFeatureId: 'box-1', index: 4, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1500, position: [25, 15, 0],
    axis: [0, 0, -1], radius: null } }, rule: { innerRadius: expressionValueFromNumber(1), kFactor: expressionValueFromNumber(0.4) } };

describe('M-08 変換した板金を展開の条件と図面の参照の元にできる', () => {
  it('展開の固定面を保存でき、図面の展開の参照も変換の行を元として受け付ける', () => {
    const empty = createEmptyPartDocument();
    const document = appendSolid(appendSolid(empty, { ...createPrimitiveFeature(empty, 'box'), id: 'box-1' }), convert);
    const result = resolveSheetConvert(convert, { ok: true, thickness: 2, bends: [],
      panels: [{ faceIndex: 4, oppositeFaceIndex: 5, inward: [0, 0, 1], outer: rims, holes: [] }] }, { face: () => null, edge: () => null });
    if (!result.ok) throw new Error(result.reason);
    const fixedPanelId = result.body.panels[0].id;
    expect(sheetFlatReferenceIssue(document, { partId: document.id, sourceFeatureId: 'convert-1', fixedPanelId, seamConnectionIds: [] })).toBeNull();
    const saved = setSheetUnfoldDefinition(document, result.body, { sourceFeatureId: 'convert-1', fixedPanelId, seamConnectionIds: [] });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value.sheetUnfolds).toEqual([{ sourceFeatureId: 'convert-1', fixedPanelId, seamConnectionIds: [] }]);
    expect(sheetFlatReferenceIssue(document, { partId: document.id, sourceFeatureId: 'box-1', fixedPanelId, seamConnectionIds: [] }))
      .toBe('展開図の元になる板金フィーチャーが見つかりません。');
  });
});
