import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument, removeSolid } from '../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument } from '../part/types.js';
import { bodyAppearanceOf } from './appearanceTable.js';
import {
  appearanceOf,
  assignBodyAppearance,
  assignFaceAppearance,
  clearDocumentAppearance,
  pruneDocumentAppearance,
  removeDocumentAppearance,
  resolveAppearanceFor,
} from './documentAppearance.js';
import { appearanceFromPreset, DEFAULT_APPEARANCE } from './materialPresets.js';

/** 検査用の押し出し 1 本。20×20×20 の箱のつもりで使う(形そのものは解決しない)。 */
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

/** 面 1 枚の参照(`appearanceTable.test.ts` と同じ形の指紋)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 400,
      position: [10, 10, 20],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 箱 1 つ(押し出し 1 本)だけの文書。 */
function boxDocument(): PartDocument {
  return appendSolid(createEmptyPartDocument(), extrude('extrude-1'));
}

// P5 タスク5(§0.a-0.15)で `PartDocument.appearance` が必須の欄になったため、
// 「欄そのものが無い文書」は有効な TypeScript では作れなくなった(`part/types.ts` の
// コメント参照)。そのため、以前ここにあった「欄が無い文書でも appearanceOf が空の表を
// 返す」「欄が無い文書どうしの空の表は同じものを使い回す」の2件は前提が成り立たなくなり、
// 削除した(版5以前のファイルは `packages/io` の `SCHEMA_MIGRATIONS[5]` が読み込み時に
// 空の表を補うので、実際の運用でこの状態の文書ができることはない)。
describe('createEmptyPartDocument の外観', () => {
  it('起動時の文書の割り当ては空', () => {
    expect(appearanceOf(createEmptyPartDocument()).entries).toEqual([]);
  });

  it('同じ文書に対しては同じ表を返す(余計な作り直しをしない)', () => {
    const document = boxDocument();
    expect(appearanceOf(document)).toBe(appearanceOf(document));
  });
});

describe('assignBodyAppearance', () => {
  it('箱に鉄板を割り当てると、その立体の外観として引ける', () => {
    const steel = appearanceFromPreset('steel');
    const document = assignBodyAppearance(boxDocument(), 'extrude-1', steel);
    expect(appearanceOf(document).entries).toHaveLength(1);
    expect(appearanceOf(document).entries[0].target).toEqual({
      kind: 'body',
      bodyFeatureId: 'extrude-1',
    });
    expect(bodyAppearanceOf(appearanceOf(document), 'extrude-1')).toEqual(steel);
    // 色は #8c9199、光沢 100(§2.4.1 の鉄板の行)。
    expect(steel.color).toBe('#8c9199');
    expect(steel.gloss.value).toBe(100);
  });

  it('同じ立体へ 2 回割り当てると差し替えになる(重ねない)', () => {
    const first = assignBodyAppearance(boxDocument(), 'extrude-1', appearanceFromPreset('steel'));
    const second = assignBodyAppearance(first, 'extrude-1', appearanceFromPreset('aluminum'));
    expect(appearanceOf(second).entries).toHaveLength(1);
    expect(bodyAppearanceOf(appearanceOf(second), 'extrude-1')?.preset).toBe('aluminum');
  });

  it('元の文書は書き換えない(不変)', () => {
    const before = boxDocument();
    assignBodyAppearance(before, 'extrude-1', appearanceFromPreset('steel'));
    expect(appearanceOf(before).entries).toEqual([]);
  });
});

describe('assignFaceAppearance', () => {
  it('面 1 枚への割り当ては立体への割り当てと別に積まれる', () => {
    const withBody = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    const document = assignFaceAppearance(
      withBody,
      faceRef('extrude-1', 4),
      appearanceFromPreset('glass'),
    );
    expect(appearanceOf(document).entries).toHaveLength(2);
    expect(appearanceOf(document).entries[1].target.kind).toBe('face');
  });

  it('割り当ての id は重ならない', () => {
    const first = assignFaceAppearance(
      boxDocument(),
      faceRef('extrude-1', 0),
      appearanceFromPreset('steel'),
    );
    const second = assignFaceAppearance(
      first,
      faceRef('extrude-1', 1),
      appearanceFromPreset('glass'),
    );
    const ids = appearanceOf(second).entries.map((entry) => entry.id);
    expect(ids).toEqual(['appearance-1', 'appearance-2']);
  });
});

describe('resolveAppearanceFor(優先順位、§2.2.2)', () => {
  it('面の割り当てが立体の割り当てより優先される', () => {
    const withBody = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    const document = assignFaceAppearance(
      withBody,
      faceRef('extrude-1', 4),
      appearanceFromPreset('glass'),
    );
    const table = appearanceOf(document);
    expect(resolveAppearanceFor(table, { kind: 'face', ref: faceRef('extrude-1', 4) }).preset).toBe(
      'glass',
    );
  });

  it('面の割り当てが無い面は、その立体の割り当てになる', () => {
    const table = appearanceOf(
      assignBodyAppearance(boxDocument(), 'extrude-1', appearanceFromPreset('steel')),
    );
    expect(resolveAppearanceFor(table, { kind: 'face', ref: faceRef('extrude-1', 2) }).preset).toBe(
      'steel',
    );
  });

  it('どちらも無ければ既定の外観', () => {
    const table = appearanceOf(boxDocument());
    expect(resolveAppearanceFor(table, { kind: 'body', bodyFeatureId: 'extrude-1' })).toEqual(
      DEFAULT_APPEARANCE,
    );
    expect(resolveAppearanceFor(table, { kind: 'face', ref: faceRef('extrude-1', 0) })).toEqual(
      DEFAULT_APPEARANCE,
    );
  });

  it('別の立体の割り当ては効かない', () => {
    const table = appearanceOf(
      assignBodyAppearance(boxDocument(), 'extrude-1', appearanceFromPreset('steel')),
    );
    expect(resolveAppearanceFor(table, { kind: 'body', bodyFeatureId: 'extrude-2' })).toEqual(
      DEFAULT_APPEARANCE,
    );
  });
});

describe('removeDocumentAppearance / clearDocumentAppearance', () => {
  it('1 つずつ外せる(FR-1110)', () => {
    const document = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    const removed = removeDocumentAppearance(document, 'appearance-1');
    expect(appearanceOf(removed).entries).toEqual([]);
  });

  it('存在しない id を外しても文書は作り直さない', () => {
    const document = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    expect(removeDocumentAppearance(document, 'appearance-99')).toBe(document);
  });

  it('すべて外すと空になる(FR-1110)', () => {
    const document = assignFaceAppearance(
      assignBodyAppearance(boxDocument(), 'extrude-1', appearanceFromPreset('steel')),
      faceRef('extrude-1', 4),
      appearanceFromPreset('glass'),
    );
    expect(appearanceOf(clearDocumentAppearance(document)).entries).toEqual([]);
  });

  it('割り当てが無い文書をすべて外しても文書は作り直さない', () => {
    const document = boxDocument();
    expect(clearDocumentAppearance(document)).toBe(document);
  });
});

describe('pruneDocumentAppearance', () => {
  it('上流の押し出しを消すと、その面への割り当ても掃除される', () => {
    const assigned = assignFaceAppearance(
      boxDocument(),
      faceRef('extrude-1', 4),
      appearanceFromPreset('glass'),
    );
    const removed = removeSolid(assigned, 'extrude-1');
    expect(appearanceOf(removed).entries).toHaveLength(1);
    const pruned = pruneDocumentAppearance(removed);
    expect(appearanceOf(pruned).entries).toEqual([]);
  });

  it('生きている立体の割り当ては残り、文書も作り直さない', () => {
    const document = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    expect(pruneDocumentAppearance(document)).toBe(document);
  });

  it('抑制した立体の割り当ても掃除される(画面に出ないため)', () => {
    const document = assignBodyAppearance(
      boxDocument(),
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    const suppressed: PartDocument = {
      ...document,
      solids: [{ ...extrude('extrude-1'), suppressed: true }],
    };
    expect(appearanceOf(pruneDocumentAppearance(suppressed)).entries).toEqual([]);
  });
});
