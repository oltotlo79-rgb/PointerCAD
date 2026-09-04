import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { assignBodyAppearance, clearDocumentAppearance } from '../appearance/documentAppearance.js';
import { appearanceFromPreset } from '../appearance/materialPresets.js';
import { appendSolid, createEmptyPartDocument } from './createPartDocument.js';
import { affectsShape } from './documentChange.js';
import type { ExtrudeFeature, PartDocument, ReferenceFeature } from './types.js';

/** 検査用の押し出し 1 本(20mm)。形の差を作るためだけに使う。 */
function extrude(id: string): ExtrudeFeature {
  return {
    kind: 'extrude',
    id,
    name: id,
    suppressed: false,
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: expressionValueFromNumber(20),
    reversed: false,
    symmetric: false,
  };
}

/** 検査用の作業平面 1 枚(FR-328)。 */
function referencePlane(id: string): ReferenceFeature {
  return {
    kind: 'referencePlane',
    id,
    name: id,
    visible: true,
    plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0) },
  };
}

function boxDocument(): PartDocument {
  return appendSolid(createEmptyPartDocument(), extrude('extrude-1'));
}

describe('affectsShape', () => {
  it('同じ文書(同一参照)は形に影響しない', () => {
    const document = boxDocument();
    expect(affectsShape(document, document)).toBe(false);
  });

  it('中身が同じでも作り直した文書は、履歴の配列が別物なので形に影響すると見る', () => {
    // 不変の約束(同じ中身なら同じ参照)が守られている限りこの場合は起きない。
    // 守られなくなったときに「見落とす」のではなく「余分に計算する」側へ倒れることの確認。
    const document = boxDocument();
    expect(affectsShape(document, { ...document, solids: [...document.solids] })).toBe(true);
  });

  it('外観の割り当てを足しただけなら形に影響しない(§2.3 の要)', () => {
    const before = boxDocument();
    const after = assignBodyAppearance(before, 'extrude-1', appearanceFromPreset('steel'));
    expect(after).not.toBe(before);
    expect(affectsShape(before, after)).toBe(false);
  });

  it('外観をすべて外しただけなら形に影響しない', () => {
    const assigned = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    const cleared = clearDocumentAppearance(assigned);
    expect(cleared).not.toBe(assigned);
    expect(affectsShape(assigned, cleared)).toBe(false);
  });

  it('立体を 1 つ足したら形に影響する', () => {
    const before = boxDocument();
    expect(affectsShape(before, appendSolid(before, extrude('extrude-2')))).toBe(true);
  });

  it('スケッチを差し替えたら形に影響する', () => {
    const before = boxDocument();
    const sketch = before.sketches[0];
    const after: PartDocument = {
      ...before,
      sketches: [{ ...sketch, name: 'スケッチA' }],
    };
    expect(affectsShape(before, after)).toBe(true);
  });

  it('編集中のスケッチを変えたら形に影響する(表示するスケッチが変わるため)', () => {
    const before = boxDocument();
    expect(affectsShape(before, { ...before, activeSketchId: 'sketch-2' })).toBe(true);
  });

  it('基準ジオメトリを足したら形に影響する(作業平面はスケッチの土台のため)', () => {
    const before = boxDocument();
    const after: PartDocument = { ...before, references: [referencePlane('referencePlane-1')] };
    expect(affectsShape(before, after)).toBe(true);
  });

  it('パラメータ表を差し替えたら形に影響する(式の値が変わりうるため)', () => {
    const before = boxDocument();
    const after: PartDocument = {
      ...before,
      parameters: [
        { name: '厚み', value: expressionValueFromNumber(3), unit: 'mm', description: '' },
      ],
    };
    expect(affectsShape(before, after)).toBe(true);
  });

  it('名前だけを変えても形に影響しない', () => {
    const before = boxDocument();
    expect(affectsShape(before, { ...before, name: '部品A' })).toBe(false);
  });

  it('id だけを変えても形に影響しない', () => {
    const before = boxDocument();
    expect(affectsShape(before, { ...before, id: 'part-2' })).toBe(false);
  });

  it('版だけを変えても形に影響しない', () => {
    const before = boxDocument();
    expect(affectsShape(before, { ...before, schemaVersion: 99 })).toBe(false);
  });
});
