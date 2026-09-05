/**
 * 面をつなぐ(罫線面)・ロフトのコマンドの検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27、§2.9、§2.15)。
 *
 * 対応要件: FR-430、FR-410、FR-201/202、FR-502、FR-504、NFR-UX-1、NFR-UX-4、NFR-UX-5。
 * ストアにも DOM にも触れない純関数だけを呼ぶ(`primitiveCommands.test.ts` と同じ流儀)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createPrimitiveFeature,
  DEFAULT_FACE_COLOR,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  liveBodyIds,
  replaceSketch,
  replaceSolid,
  type LoftFeature,
  type PartDocument,
  type PrimitiveFeature,
  type RuledFeature,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';

import {
  commitLoft,
  commitRuled,
  commitRuledInput,
  DEFAULT_RULED_TWIST_VALUE,
  loftSectionsRejection,
  loftToolReadiness,
  ruledSectionsOf,
  ruledSectionsRejection,
  ruledSelectionHasSphere,
  ruledToolOf,
  ruledToolReadiness,
  ruledTwistNoteKey,
  ruledTwistRejection,
  type RuledContext,
} from './ruledCommands.js';
import { solidToolReadiness } from './solidCommands.js';
import { subShapeElementId, type SolidFaceEntry, type SubShapeBody } from './subShapeSelection.js';

/* ------------------------------------------------------------------ *
 * ひな型
 * ------------------------------------------------------------------ */

/** 面フィーチャーを 1 枚足す。座標の妥当性はこの層の対象外(`solidCommands.test.ts` と同じ)。 */
function addFace(sketch: SketchDocument, id: string): SketchDocument {
  return appendFeature(sketch, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'face',
    boundary: [],
    color: DEFAULT_FACE_COLOR,
  });
}

/** 面を何枚か持つ部品文書。ソリッドの履歴は空。 */
function documentWithFaces(faceIds: readonly string[]): PartDocument {
  const base = createEmptyPartDocument();
  let sketch = base.sketches[0];
  for (const id of faceIds) {
    sketch = addFace(sketch, id);
  }
  return replaceSketch(base, sketch);
}

/** 立体の面 1 枚ぶんの素性(指紋の材料)。 */
function faceEntry(index: number): SolidFaceEntry {
  return {
    index,
    surfaceKind: 'plane',
    area: 100 + index,
    centroid: [index, 0, 0],
    axis: [0, 0, 1],
    radius: null,
    triangleOffset: index * 2,
    triangleCount: 2,
  };
}

/** 面を 2 枚持つカーネルのボディ(立体の面を輪郭にするときの相手)。 */
function bodyWithFaces(featureId: string): SubShapeBody {
  return {
    featureId,
    mesh: { edgePositions: new Float32Array(0) },
    faces: [faceEntry(0), faceEntry(1)],
    edges: [],
    vertices: [{ index: 0, position: [0, 0, 0] }],
  };
}

function contextOf(fields: Partial<RuledContext> = {}): RuledContext {
  return {
    document: fields.document ?? createEmptyPartDocument(),
    bodies: fields.bodies ?? [],
    selection: fields.selection ?? [],
  };
}

/** 球の基本形状を 1 つ積んだ文書(FR-429)。id は `sphere-1`。 */
function withSphere(document: PartDocument): PartDocument {
  return appendSolid(document, createPrimitiveFeature(document, 'sphere'));
}

/** 押し出しの代わりに使う、面を持つ立体としての箱(輪郭に立体の面を使う検査で id を借りる)。 */
function withBox(document: PartDocument): PartDocument {
  return appendSolid(document, createPrimitiveFeature(document, 'box'));
}

/** その場入力の確定結果のひな型。 */
function commitOf(
  tool: string,
  extra: Partial<SolidInputCommit> = {},
): SolidInputCommit {
  return {
    kind: 'solid',
    // 道具 id の絞り込みそのものを検査したいので、型の穴を開けずに既存の道具から作る。
    tool: tool === 'loft' ? 'loft' : tool === 'ruled' ? 'ruled' : 'extrude',
    step: tool === 'loft' ? 'loftTwist' : 'ruledTwist',
    values: {},
    flags: {},
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * 選択 → 断面
 * ------------------------------------------------------------------ */

describe('選択から断面の並びを作る(FR-430、FR-410)', () => {
  it('スケッチの面は選んだ順に `sketchFace` になる', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    const sections = ruledSectionsOf(contextOf({ document, selection: ['face-2', 'face-1'] }));
    expect(sections.map((section) => section.kind)).toEqual(['sketchFace', 'sketchFace']);
    expect(sections[0]).toEqual({
      kind: 'sketchFace',
      ref: { sketchId: document.sketches[0].id, faceFeatureId: 'face-2' },
    });
  });

  it('立体の面は指紋つきの `solidFace` になる(§0.a-0.73、タスク24b)', () => {
    const document = withBox(documentWithFaces(['face-1']));
    const sections = ruledSectionsOf(
      contextOf({
        document,
        bodies: [bodyWithFaces('box-1')],
        selection: [subShapeElementId('box-1', 'face', 1), 'face-1'],
      }),
    );
    expect(sections.map((section) => section.kind)).toEqual(['solidFace', 'sketchFace']);
    expect(sections[0]).toEqual({
      kind: 'solidFace',
      ref: {
        bodyFeatureId: 'box-1',
        index: 1,
        fingerprint: {
          kind: 'face',
          surfaceKind: 'plane',
          area: 101,
          position: [1, 0, 0],
          axis: [0, 0, 1],
          radius: null,
        },
      },
    });
  });

  it('球はボディを選んでも面を選んでも同じ `sphere` になる(NFR-UX-1、タスク27 手順3)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    const bodies = [bodyWithFaces('sphere-1')];
    const fromBody = ruledSectionsOf(contextOf({ document, bodies, selection: ['sphere-1'] }));
    const fromFace = ruledSectionsOf(
      contextOf({ document, bodies, selection: [subShapeElementId('sphere-1', 'face', 0)] }),
    );
    expect(fromBody).toEqual([{ kind: 'sphere', sphereFeatureId: 'sphere-1' }]);
    expect(fromFace).toEqual(fromBody);
  });

  it('球でない立体そのもの・辺・頂点・線分は断面にならない(読み飛ばす)', () => {
    const document = withBox(documentWithFaces(['face-1']));
    const bodies = [bodyWithFaces('box-1')];
    const sections = ruledSectionsOf(
      contextOf({
        document,
        bodies,
        selection: [
          'box-1',
          subShapeElementId('box-1', 'edge', 0),
          subShapeElementId('box-1', 'vertex', 0),
          'face-1',
        ],
      }),
    );
    expect(sections.map((section) => section.kind)).toEqual(['sketchFace']);
  });

  it('球を含むかどうかを見込める(なめらかさの欄の出し分け、§0.a-0.87)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    expect(
      ruledSelectionHasSphere(contextOf({ document, selection: ['face-1', 'sphere-1'] })),
    ).toBe(true);
    expect(ruledSelectionHasSphere(contextOf({ document, selection: ['face-1'] }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 押せる条件(NFR-UX-5)
 * ------------------------------------------------------------------ */

describe('面をつなぐが押せる条件(FR-430、NFR-UX-5)', () => {
  it('スケッチの面 2 つで押せる', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(ruledToolReadiness(contextOf({ document, selection: ['face-1', 'face-2'] }))).toEqual({
      ready: true,
      reasonKey: null,
    });
  });

  it('スケッチの面 1 つ + 球で押せる(§2.9.3)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    expect(ruledToolReadiness(contextOf({ document, selection: ['face-1', 'sphere-1'] })).ready).toBe(
      true,
    );
  });

  it('立体の面 + スケッチの面、立体の面 2 つでも押せる(§0.a-0.73)', () => {
    const document = withBox(documentWithFaces(['face-1']));
    const bodies = [bodyWithFaces('box-1')];
    expect(
      ruledToolReadiness(
        contextOf({ document, bodies, selection: [subShapeElementId('box-1', 'face', 0), 'face-1'] }),
      ).ready,
    ).toBe(true);
    expect(
      ruledToolReadiness(
        contextOf({
          document,
          bodies,
          selection: [
            subShapeElementId('box-1', 'face', 0),
            subShapeElementId('box-1', 'face', 1),
          ],
        }),
      ).ready,
    ).toBe(true);
  });

  it('面が 1 つだけ・0 個・3 つ以上なら押せず、理由は「2 つ選んで」', () => {
    const document = documentWithFaces(['face-1', 'face-2', 'face-3']);
    for (const selection of [[], ['face-1'], ['face-1', 'face-2', 'face-3']]) {
      expect(ruledToolReadiness(contextOf({ document, selection }))).toEqual({
        ready: false,
        reasonKey: 'ruledError.needTwoSections',
      });
    }
  });

  it('球どうしは押せない(直線で結ぶ相手の輪郭が無い、§2.9.3)', () => {
    const base = withSphere(createEmptyPartDocument());
    const document = appendSolid(base, createPrimitiveFeature(base, 'sphere'));
    expect(ruledToolReadiness(contextOf({ document, selection: ['sphere-1', 'sphere-2'] }))).toEqual(
      { ready: false, reasonKey: 'ruledError.twoSpheres' },
    );
  });

  it('中心を立体の頂点で決めた球は押せない(model の解決と同じ理由、NFR-UX-5)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    const sphere = document.solids.find((solid) => solid.id === 'sphere-1');
    expect(sphere?.kind).toBe('primitive');
    if (sphere === undefined || sphere.kind !== 'primitive') {
      return;
    }
    const moved: PrimitiveFeature = {
      ...sphere,
      origin: {
        kind: 'vertex',
        ref: {
          bodyFeatureId: 'extrude-1',
          index: 0,
          fingerprint: { kind: 'vertex', position: [0, 0, 0] },
        },
      },
    };
    expect(
      ruledToolReadiness(
        contextOf({
          document: replaceSolid(document, 'sphere-1', moved),
          selection: ['face-1', 'sphere-1'],
        }),
      ),
    ).toEqual({ ready: false, reasonKey: 'ruledError.sphereOrigin' });
  });
});

describe('ロフトが押せる条件(FR-410、NFR-UX-5)', () => {
  it('スケッチの面 2 つ・3 つで押せる', () => {
    const document = documentWithFaces(['face-1', 'face-2', 'face-3']);
    expect(loftToolReadiness(contextOf({ document, selection: ['face-1', 'face-2'] })).ready).toBe(
      true,
    );
    expect(
      loftToolReadiness(contextOf({ document, selection: ['face-1', 'face-2', 'face-3'] })).ready,
    ).toBe(true);
  });

  it('面が 1 つ以下なら押せない', () => {
    const document = documentWithFaces(['face-1']);
    expect(loftToolReadiness(contextOf({ document, selection: ['face-1'] }))).toEqual({
      ready: false,
      reasonKey: 'loftError.needTwoSections',
    });
    expect(loftToolReadiness(contextOf({ document })).reasonKey).toBe('loftError.needTwoSections');
  });

  it('球が混ざっていると押せない(ロフトに球は置けない、§2.9.3)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    expect(loftToolReadiness(contextOf({ document, selection: ['face-1', 'sphere-1'] }))).toEqual({
      ready: false,
      reasonKey: 'loftError.sphere',
    });
  });

  it('断りの理由はすべて ja.json に実在する(NFR-MA-5)', () => {
    const keys = [
      'ruledError.needTwoSections',
      'ruledError.twoSpheres',
      'ruledError.sphereOrigin',
      'ruledError.twistNotInteger',
      'ruledError.notRuledTool',
      'loftError.needTwoSections',
      'loftError.sphere',
    ];
    for (const key of keys) {
      expect(MESSAGE_KEYS, key).toContain(key);
    }
  });
});

/* ------------------------------------------------------------------ *
 * ねじれの先出し検査(§0.a-0.28)
 * ------------------------------------------------------------------ */

describe('ねじれは整数だけ(§0.a-0.28、NFR-UX-5)', () => {
  it('整数(0・正・負)は通り、小数は断る', () => {
    expect(ruledTwistRejection(expressionValueFromNumber(0))).toBeNull();
    expect(ruledTwistRejection(expressionValueFromNumber(3))).toBeNull();
    // 負は「逆向きに回す」意味で正しい(カーネルが頂点数で割った余りを使う)。
    expect(ruledTwistRejection(expressionValueFromNumber(-2))).toBeNull();
    expect(ruledTwistRejection(expressionValueFromNumber(1.5))).toBe('ruledError.twistNotInteger');
    expect(ruledTwistRejection(expressionValueFromNumber(Number.NaN))).toBe(
      'ruledError.twistNotInteger',
    );
  });

  it('既定のねじれは 0(model の定数と同じ。NFR-UX-4)', () => {
    expect(DEFAULT_RULED_TWIST_VALUE.value).toBe(0);
    expect(ruledTwistRejection(DEFAULT_RULED_TWIST_VALUE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 確定
 * ------------------------------------------------------------------ */

describe('面をつなぐを作る(FR-430)', () => {
  it('履歴 1 段の `ruled` ができ、元の球は消費されない(§0.a-0.27)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    const outcome = commitRuled(contextOf({ document, selection: ['face-1', 'sphere-1'] }), {
      twist: expressionValueFromNumber(1),
      sphereSegments: 48,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.solids).toHaveLength(document.solids.length + 1);
    const created = outcome.document.solids.find((solid) => solid.id === outcome.featureId);
    expect(created?.kind).toBe('ruled');
    if (created === undefined || created.kind !== 'ruled') {
      return;
    }
    const feature: RuledFeature = created;
    expect(feature.first.kind).toBe('sketchFace');
    expect(feature.second).toEqual({ kind: 'sphere', sphereFeatureId: 'sphere-1' });
    expect(feature.twist.value).toBe(1);
    expect(feature.sphereSegments).toBe(48);
    // 輪郭を貸した球はそのまま画面に残る(要るなら和でまとめられる)。
    expect(liveBodyIds(outcome.document)).toContain('sphere-1');
  });

  it('選んだ順が 1 つ目・2 つ目になる', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    const outcome = commitRuled(contextOf({ document, selection: ['face-2', 'face-1'] }), {
      twist: DEFAULT_RULED_TWIST_VALUE,
      sphereSegments: DEFAULT_RULED_SPHERE_SEGMENTS,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = outcome.document.solids[0];
    expect(created?.kind).toBe('ruled');
    if (created === undefined || created.kind !== 'ruled') {
      return;
    }
    expect(created.first).toEqual({
      kind: 'sketchFace',
      ref: { sketchId: document.sketches[0].id, faceFeatureId: 'face-2' },
    });
    expect(created.second).toEqual({
      kind: 'sketchFace',
      ref: { sketchId: document.sketches[0].id, faceFeatureId: 'face-1' },
    });
  });

  it('断面が揃わない・ねじれが小数なら履歴を変えずに断る(FR-504、NFR-UX-5)', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    expect(
      commitRuled(contextOf({ document, selection: ['face-1'] }), {
        twist: DEFAULT_RULED_TWIST_VALUE,
        sphereSegments: DEFAULT_RULED_SPHERE_SEGMENTS,
      }),
    ).toEqual({ ok: false, reasonKey: 'ruledError.needTwoSections' });
    expect(
      commitRuled(contextOf({ document, selection: ['face-1', 'face-2'] }), {
        twist: expressionValueFromNumber(1.5),
        sphereSegments: DEFAULT_RULED_SPHERE_SEGMENTS,
      }),
    ).toEqual({ ok: false, reasonKey: 'ruledError.twistNotInteger' });
  });
});

describe('ロフトを作る(FR-410)', () => {
  it('断面 3 つが選んだ順のまま入る', () => {
    const document = documentWithFaces(['face-1', 'face-2', 'face-3']);
    const outcome = commitLoft(
      contextOf({ document, selection: ['face-3', 'face-1', 'face-2'] }),
      { twist: DEFAULT_RULED_TWIST_VALUE },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = outcome.document.solids[0];
    expect(created?.kind).toBe('loft');
    if (created === undefined || created.kind !== 'loft') {
      return;
    }
    const feature: LoftFeature = created;
    expect(feature.sections).toHaveLength(3);
    expect(
      feature.sections.map((section) =>
        section.kind === 'sketchFace' ? section.ref.faceFeatureId : section.kind,
      ),
    ).toEqual(['face-3', 'face-1', 'face-2']);
  });

  it('球が混ざっていれば履歴を変えずに断る', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    expect(
      commitLoft(contextOf({ document, selection: ['face-1', 'sphere-1'] }), {
        twist: DEFAULT_RULED_TWIST_VALUE,
      }),
    ).toEqual({ ok: false, reasonKey: 'loftError.sphere' });
  });
});

describe('その場入力の確定を受ける(NFR-UX-4)', () => {
  it('道具 id の絞り込みは `ruled` / `loft` だけを受け付ける', () => {
    expect(ruledToolOf('ruled')).toBe('ruled');
    expect(ruledToolOf('loft')).toBe('loft');
    expect(ruledToolOf('extrude')).toBeNull();
    expect(ruledToolOf('')).toBeNull();
  });

  it('欄が空なら既定(ねじれ 0・なめらかさ ふつう)で作る', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    const outcome = commitRuledInput(
      contextOf({ document, selection: ['face-1', 'sphere-1'] }),
      commitOf('ruled'),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = outcome.document.solids.find((solid) => solid.id === outcome.featureId);
    if (created === undefined || created.kind !== 'ruled') {
      throw new Error('罫線面ができていない');
    }
    expect(created.twist.value).toBe(0);
    expect(created.sphereSegments).toBe(DEFAULT_RULED_SPHERE_SEGMENTS);
  });

  it('なめらかさの選択肢が渡ればその点数で作る(§0.a-0.74)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    const outcome = commitRuledInput(
      contextOf({ document, selection: ['face-1', 'sphere-1'] }),
      commitOf('ruled', { ruledSphereSegments: 72 }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = outcome.document.solids.find((solid) => solid.id === outcome.featureId);
    expect(created?.kind === 'ruled' ? created.sphereSegments : null).toBe(72);
  });

  it('面をつなぐ・ロフト以外の道具が回ってきたら履歴を変えずに断る', () => {
    expect(commitRuledInput(contextOf(), commitOf('extrude'))).toEqual({
      ok: false,
      reasonKey: 'ruledError.notRuledTool',
    });
  });
});

/* ------------------------------------------------------------------ *
 * `solidToolReadiness` からの委譲(判断を 2 か所に書かない)
 * ------------------------------------------------------------------ */

describe('ツールバーからの押せる条件は同じ関数へ委譲する', () => {
  it('`solidToolReadiness` の `ruled` / `loft` は `ruledCommands` と同じ結果を返す', () => {
    const document = documentWithFaces(['face-1', 'face-2']);
    const selection = ['face-1', 'face-2'];
    expect(solidToolReadiness(document, selection, 'ruled')).toEqual(
      ruledToolReadiness(contextOf({ document, selection })),
    );
    expect(solidToolReadiness(document, ['face-1'], 'loft')).toEqual(
      loftToolReadiness(contextOf({ document, selection: ['face-1'] })),
    );
  });
});

/* ------------------------------------------------------------------ *
 * プロパティの注記(§0.a-0.87)
 * ------------------------------------------------------------------ */

describe('ねじれが効かない旨の注記(§0.a-0.87、タスク24b)', () => {
  const SKETCH_SECTION = {
    kind: 'sketchFace',
    ref: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
  } as const;
  const SOLID_SECTION = {
    kind: 'solidFace',
    ref: {
      bodyFeatureId: 'box-1',
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 100,
        position: [0, 0, 0],
        axis: [0, 0, 1],
        radius: null,
      },
    },
  } as const;

  function ruledWith(second: RuledFeature['second']): RuledFeature {
    return {
      id: 'ruled-1',
      name: '面をつなぐ1',
      suppressed: false,
      kind: 'ruled',
      first: SKETCH_SECTION,
      second,
      twist: expressionValueFromNumber(0),
      sphereSegments: DEFAULT_RULED_SPHERE_SEGMENTS,
    };
  }

  it('断面に立体の面が 1 つでもあれば注記を出す', () => {
    expect(ruledTwistNoteKey(ruledWith(SOLID_SECTION))).toBe(
      'propertyPanel.ruledTwistSolidFaceNote',
    );
  });

  it('スケッチの面・球だけなら注記は出さない(ねじれがそのまま効く)', () => {
    expect(ruledTwistNoteKey(ruledWith(SKETCH_SECTION))).toBeNull();
    expect(ruledTwistNoteKey(ruledWith({ kind: 'sphere', sphereFeatureId: 'sphere-1' }))).toBeNull();
  });

  it('ロフトでも同じ判定になる', () => {
    const loft: LoftFeature = {
      id: 'loft-1',
      name: 'ロフト1',
      suppressed: false,
      kind: 'loft',
      sections: [SKETCH_SECTION, SOLID_SECTION],
      twist: expressionValueFromNumber(0),
    };
    expect(ruledTwistNoteKey(loft)).toBe('propertyPanel.ruledTwistSolidFaceNote');
  });

  it('注記の文言は ja.json に実在する(NFR-MA-5)', () => {
    expect(MESSAGE_KEYS).toContain('propertyPanel.ruledTwistSolidFaceNote');
  });
});

/* ------------------------------------------------------------------ *
 * 断りの並び(model の解決と同じ順)
 * ------------------------------------------------------------------ */

describe('断りを見る順は model の解決と同じ(同じ入力から同じ理由)', () => {
  it('数 → 球どうし → 球の中心 の順に見る', () => {
    const base = withSphere(createEmptyPartDocument());
    const document = appendSolid(base, createPrimitiveFeature(base, 'sphere'));
    // 球 1 つだけ = 数が足りない。球どうしの判定より先に「2 つ選んで」が出る。
    expect(ruledSectionsRejection(document, ruledSectionsOf(contextOf({ document, selection: ['sphere-1'] })))).toBe(
      'ruledError.needTwoSections',
    );
  });

  it('ロフトも数 → 球の混入の順に見る(model の `planLoft` と同じ)', () => {
    const document = withSphere(documentWithFaces(['face-1']));
    // 球 1 つだけ = 数が足りない。球の理由より先に「2 つ以上選んで」が出る。
    expect(
      loftSectionsRejection(ruledSectionsOf(contextOf({ document, selection: ['sphere-1'] }))),
    ).toBe('loftError.needTwoSections');
    // 数が足りていれば球の混入を断る。
    expect(
      loftSectionsRejection(
        ruledSectionsOf(contextOf({ document, selection: ['face-1', 'sphere-1'] })),
      ),
    ).toBe('loftError.sphere');
  });
});
