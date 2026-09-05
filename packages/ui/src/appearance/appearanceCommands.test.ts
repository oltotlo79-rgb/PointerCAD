/**
 * 外観のコマンド(計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク11)の検査。
 *
 * 対応要件: FR-1106、FR-1107、FR-1108、FR-1109、FR-1110、FR-505、NFR-UX-5。
 *
 * どれも純関数なので Node のまま確かめられる(three.js にも DOM にもストアにも触れない)。
 * ストア側の口(`assignAppearance` / `removeAppearance` / `clearAppearance`)と、
 * 「外観を変えても再計算が走らない」ことは `store/useAppStore.test.ts` で確かめる。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appearanceFromPreset,
  appearanceOf,
  assignFaceAppearance,
  createEmptyPartDocument,
  DEFAULT_APPEARANCE,
  type AppearanceMatchEntry,
  type AppearanceSpec,
  type AppearanceTable,
  type PartDocument,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  subShapeElementId,
  type SolidFaceEntry,
  type SubShapeBody,
} from '../solid/subShapeSelection.js';
import {
  appearanceOfSelection,
  appearanceReadiness,
  appearanceTargetsOf,
  appearanceWithColor,
  appearanceWithNumber,
  appearanceWithPattern,
  appearanceWithPreset,
  appearanceWithWoodSpecies,
  assignAppearanceToSelection,
  buildAppearanceInput,
  clearAllAppearance,
  isSameAppearanceSpec,
  missingAppearanceCount,
  missingAppearanceIds,
  removeAppearanceAt,
  type AppearanceContext,
} from './appearanceCommands.js';

/* ---------------------------------------------------------------------------
 * 見本
 * ------------------------------------------------------------------------- */

/** 面 1 枚 = 三角形 1 枚のボディ(まとまりの区切りを面の数で作れるようにする)。 */
function makeBody(featureId: string, faceCount: number): SubShapeBody {
  const faces: SolidFaceEntry[] = [];
  for (let face = 0; face < faceCount; face += 1) {
    faces.push({
      index: face,
      surfaceKind: 'plane',
      area: 1,
      centroid: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: face,
      triangleCount: 1,
    });
  }
  return {
    featureId,
    mesh: { edgePositions: new Float32Array(0) },
    faces,
    edges: [],
    vertices: [],
  };
}

/** 面の指紋つきの参照(通し番号だけが要る検査なので、指紋の中身は最小にする)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

function tableOf(entries: AppearanceTable['entries']): AppearanceTable {
  return { entries };
}

/** 色だけを変えた外観(「自分で決める」相当)。 */
function coloredAppearance(color: string): AppearanceSpec {
  return { ...DEFAULT_APPEARANCE, preset: 'custom', color };
}

const STEEL = appearanceFromPreset('steel');
const GLASS = appearanceFromPreset('glass');
const BODY = makeBody('extrude-1', 6);

/** 検査で使う入力一式。渡さなかったものは「箱 1 つ・何も選んでいない」になる。 */
function contextOf(overrides: Partial<AppearanceContext> = {}): AppearanceContext {
  return {
    document: createEmptyPartDocument(),
    bodies: [BODY],
    selection: [],
    selectionKind: 'body',
    matches: [],
    ...overrides,
  };
}

/** `extrude-1#face:<index>` の要素 id。 */
function faceId(index: number): string {
  return subShapeElementId('extrude-1', 'face', index);
}

/** 断りだったことを確かめて理由を取り出す(`ok: true` のまま読み進めない)。 */
function refusalOf(context: AppearanceContext, spec: AppearanceSpec): string {
  const outcome = assignAppearanceToSelection(context, spec);
  expect(outcome.ok).toBe(false);
  return outcome.ok ? '' : outcome.reasonKey;
}

/** 確定できたことを確かめて文書を取り出す。 */
function documentOf(context: AppearanceContext, spec: AppearanceSpec): PartDocument {
  const outcome = assignAppearanceToSelection(context, spec);
  expect(outcome.ok).toBe(true);
  return outcome.ok ? outcome.document : context.document;
}

/* ---------------------------------------------------------------------------
 * 割り当て先の決め方
 * ------------------------------------------------------------------------- */

describe('appearanceTargetsOf(選択 → 割り当て先)', () => {
  it('何も選んでいなければ空', () => {
    expect(appearanceTargetsOf(contextOf())).toEqual([]);
  });

  it('立体を選んでいれば立体の割り当て先になる', () => {
    const targets = appearanceTargetsOf(contextOf({ selection: ['extrude-1'] }));
    expect(targets).toEqual([{ kind: 'body', bodyFeatureId: 'extrude-1' }]);
  });

  it('選ぶ種類が面なら、選んでいる面が割り当て先になる', () => {
    const targets = appearanceTargetsOf(
      contextOf({ selection: [faceId(2)], selectionKind: 'face' }),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe('face');
  });

  it('選ぶ種類が立体なら、面と立体の両方が選択にあっても立体を選ぶ', () => {
    const targets = appearanceTargetsOf(
      contextOf({ selection: [faceId(2), 'extrude-1'], selectionKind: 'body' }),
    );
    expect(targets).toEqual([{ kind: 'body', bodyFeatureId: 'extrude-1' }]);
  });

  it('立体が 1 つも選ばれていなければ、選ぶ種類が立体でも面へ落ちる', () => {
    const targets = appearanceTargetsOf(
      contextOf({ selection: [faceId(1)], selectionKind: 'body' }),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe('face');
  });

  it('画面に無いボディの id は割り当て先にしない', () => {
    expect(appearanceTargetsOf(contextOf({ selection: ['extrude-9'] }))).toEqual([]);
  });
});

describe('appearanceReadiness(ボタンの押せる条件)', () => {
  it('何も選んでいなければ断りの理由を返す', () => {
    expect(appearanceReadiness(contextOf())).toEqual({
      ok: false,
      reasonKey: 'appearanceError.noTarget',
    });
  });

  it('立体を選んでいれば押せる', () => {
    expect(appearanceReadiness(contextOf({ selection: ['extrude-1'] }))).toEqual({
      ok: true,
      reasonKey: null,
    });
  });
});

/* ---------------------------------------------------------------------------
 * 割り当て(FR-1106)
 * ------------------------------------------------------------------------- */

describe('assignAppearanceToSelection(割り当てる)', () => {
  it('立体を選んで割り当てると、立体への割り当てが 1 件できる', () => {
    const next = documentOf(contextOf({ selection: ['extrude-1'] }), STEEL);
    const entries = appearanceOf(next).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].target).toEqual({ kind: 'body', bodyFeatureId: 'extrude-1' });
    expect(entries[0].appearance).toBe(STEEL);
  });

  it('面を 1 枚選んで割り当てると、その面への割り当てが 1 件できる', () => {
    const next = documentOf(
      contextOf({ selection: [faceId(3)], selectionKind: 'face' }),
      GLASS,
    );
    const entries = appearanceOf(next).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].target.kind).toBe('face');
    expect(entries[0].target.kind === 'face' ? entries[0].target.ref.index : -1).toBe(3);
  });

  it('面を 2 枚選ぶと 2 件できる', () => {
    const next = documentOf(
      contextOf({ selection: [faceId(0), faceId(4)], selectionKind: 'face' }),
      GLASS,
    );
    expect(appearanceOf(next).entries).toHaveLength(2);
  });

  it('同じ面へ違う外観をもう一度割り当てると差し替わる(2 件に増えない)', () => {
    const context = contextOf({ selection: [faceId(3)], selectionKind: 'face' });
    const first = documentOf(context, STEEL);
    const second = documentOf({ ...context, document: first }, GLASS);
    const entries = appearanceOf(second).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].appearance).toBe(GLASS);
    // 差し替えでは id を変えない(「1 つずつ外す」の相手が入れ替わらない)。
    expect(entries[0].id).toBe(appearanceOf(first).entries[0].id);
  });

  it('すでに同じ外観なら文書を作り直さない(Undo の段を増やさない)', () => {
    const context = contextOf({ selection: ['extrude-1'] });
    const first = documentOf(context, STEEL);
    const again = assignAppearanceToSelection({ ...context, document: first }, STEEL);
    expect(again.ok).toBe(true);
    expect(again.ok ? again.document : null).toBe(first);
  });

  it('同じ値でも式の文字が違えば割り当て直す(打ち直した式が残る)', () => {
    const context = contextOf({ selection: ['extrude-1'] });
    const first = documentOf(context, STEEL);
    const retyped: AppearanceSpec = {
      ...STEEL,
      roughness: { source: '21*2', value: STEEL.roughness.value, display: STEEL.roughness.display },
    };
    const second = documentOf({ ...context, document: first }, retyped);
    expect(second).not.toBe(first);
    expect(appearanceOf(second).entries[0].appearance.roughness.source).toBe('21*2');
  });

  it('何も選んでいなければ断り、文書は 1 バイトも変わらない', () => {
    const context = contextOf();
    expect(refusalOf(context, STEEL)).toBe('appearanceError.noTarget');
    expect(appearanceOf(context.document).entries).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * 値の範囲(FR-1109)
 * ------------------------------------------------------------------------- */

describe('assignAppearanceToSelection(値の範囲)', () => {
  const context = contextOf({ selection: ['extrude-1'] });

  it('透過率 120 は断る', () => {
    const spec: AppearanceSpec = { ...STEEL, transmission: expressionValueFromNumber(120) };
    expect(refusalOf(context, spec)).toBe('appearanceError.outOfRange');
  });

  it('光沢 -1 は断る', () => {
    const spec: AppearanceSpec = { ...STEEL, gloss: expressionValueFromNumber(-1) };
    expect(refusalOf(context, spec)).toBe('appearanceError.outOfRange');
  });

  it('粗さが数でない(NaN)ときも断る', () => {
    const spec: AppearanceSpec = {
      ...STEEL,
      roughness: { source: '0/0', value: Number.NaN, display: 'NaN' },
    };
    expect(refusalOf(context, spec)).toBe('appearanceError.outOfRange');
  });

  it('0 と 100 は境目として通す', () => {
    const spec: AppearanceSpec = {
      ...STEEL,
      transmission: expressionValueFromNumber(0),
      gloss: expressionValueFromNumber(100),
      roughness: expressionValueFromNumber(100),
    };
    expect(appearanceOf(documentOf(context, spec)).entries).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------
 * 上限の先出し検査(§0.a-0.11)
 * ------------------------------------------------------------------------- */

/** 面 0〜count-1 へ、色だけが違う外観を 1 枚ずつ割り当てた文書を作る。 */
function documentWithDistinctFaceColors(count: number): PartDocument {
  let document = createEmptyPartDocument();
  for (let index = 0; index < count; index += 1) {
    document = assignFaceAppearance(
      document,
      faceRef('extrude-1', index),
      coloredAppearance(`#ff00${String(index).padStart(2, '0')}`),
    );
  }
  return document;
}

describe('assignAppearanceToSelection(上限の先出し検査)', () => {
  const wideBody = makeBody('extrude-1', 12);

  it('材質 8 種類目までは通す(既定 1 + 割り当て 7)', () => {
    // 既定 + 6 色 = 7 種。ここへ 7 色目を足すと 8 種でちょうど上限。
    const context = contextOf({
      document: documentWithDistinctFaceColors(6),
      bodies: [wideBody],
      selection: [faceId(6)],
      selectionKind: 'face',
    });
    const next = documentOf(context, coloredAppearance('#00ff00'));
    expect(appearanceOf(next).entries).toHaveLength(7);
  });

  it('材質 9 種類目は「作る前に」断る', () => {
    // 既定 + 7 色 = 8 種。ここへ 8 色目を足すと 9 種で上限を超える。
    const context = contextOf({
      document: documentWithDistinctFaceColors(7),
      bodies: [wideBody],
      selection: [faceId(7)],
      selectionKind: 'face',
    });
    expect(refusalOf(context, coloredAppearance('#00ff00'))).toBe(
      'appearanceError.tooManyMaterials',
    );
    // 断ったので割り当ては 7 件のまま(作らせない、NFR-UX-5)。
    expect(appearanceOf(context.document).entries).toHaveLength(7);
  });

  it('まとまりが 33 個以上になるときは、まとめてほしいと断る', () => {
    // 40 枚の面へ 1 枚おきに同じ色を割り当てると、色と既定が交互になって
    // まとまりが 40 個になる(上限 32)。材質は既定 + 1 色の 2 種なので、
    // 断りの理由は「材質が多すぎる」ではなく「まとまりが多すぎる」になる。
    const striped = makeBody('extrude-1', 40);
    let document = createEmptyPartDocument();
    for (let index = 0; index < 40; index += 2) {
      document = assignFaceAppearance(document, faceRef('extrude-1', index), coloredAppearance('#123456'));
    }
    const context = contextOf({
      document,
      bodies: [striped],
      selection: [faceId(1)],
      selectionKind: 'face',
    });
    expect(refusalOf(context, coloredAppearance('#123456'))).toBe('appearanceError.tooManyGroups');
  });

  it('画面にまだ出ていないボディへの割り当ては上限を見ずに通す(面の一覧が無いため)', () => {
    const context = contextOf({
      bodies: [],
      selection: ['extrude-1'],
    });
    // ボディが 1 つも無いので割り当て先も作れない(= noTarget)。上限で落ちないことの確認。
    expect(refusalOf(context, STEEL)).toBe('appearanceError.noTarget');
  });
});

/* ---------------------------------------------------------------------------
 * 外す・すべて戻す(FR-1110)
 * ------------------------------------------------------------------------- */

describe('removeAppearanceAt / clearAllAppearance', () => {
  it('割り当てを 1 つ外す', () => {
    const context = contextOf({ selection: [faceId(0), faceId(1)], selectionKind: 'face' });
    const assigned = documentOf(context, STEEL);
    const removed = removeAppearanceAt(assigned, appearanceOf(assigned).entries[0].id);
    expect(appearanceOf(removed).entries).toHaveLength(1);
  });

  it('無い id を外そうとしても文書はそのまま(同一参照)', () => {
    const document = createEmptyPartDocument();
    expect(removeAppearanceAt(document, 'appearance-9')).toBe(document);
  });

  it('すべて既定に戻すと割り当てが 0 件になる', () => {
    const context = contextOf({ selection: [faceId(0), faceId(1)], selectionKind: 'face' });
    const assigned = documentOf(context, STEEL);
    expect(appearanceOf(clearAllAppearance(assigned)).entries).toHaveLength(0);
  });

  it('割り当てが無い文書へ「すべて戻す」を呼んでも文書はそのまま(同一参照)', () => {
    const document = createEmptyPartDocument();
    expect(clearAllAppearance(document)).toBe(document);
  });
});

/* ---------------------------------------------------------------------------
 * いま効いている外観(§2.2.2 の 3 段)
 * ------------------------------------------------------------------------- */

describe('appearanceOfSelection(プロパティの欄の初期値)', () => {
  it('何も選んでいなければ既定の外観', () => {
    expect(appearanceOfSelection(contextOf())).toBe(DEFAULT_APPEARANCE);
  });

  it('割り当てが 1 つも無ければ既定の外観', () => {
    expect(appearanceOfSelection(contextOf({ selection: ['extrude-1'] }))).toBe(DEFAULT_APPEARANCE);
  });

  it('その面の割り当てがあればそれを返す(優先順位 1)', () => {
    const context = contextOf({ selection: [faceId(2)], selectionKind: 'face' });
    const document = documentOf(context, GLASS);
    expect(appearanceOfSelection({ ...context, document })).toBe(GLASS);
  });

  it('面の割り当てが無ければ立体の割り当てを返す(優先順位 2)', () => {
    const assigned = documentOf(contextOf({ selection: ['extrude-1'] }), STEEL);
    const context = contextOf({
      document: assigned,
      selection: [faceId(2)],
      selectionKind: 'face',
    });
    expect(appearanceOfSelection(context)).toBe(STEEL);
  });
});

/* ---------------------------------------------------------------------------
 * 見つからない割り当て(FR-1106 の警告)
 * ------------------------------------------------------------------------- */

describe('missingAppearanceCount / missingAppearanceIds', () => {
  // 面 2 枚へ割り当てた文書。コマンドを通さず model で組み立てるのは、
  // `describe` の本体で `expect` を呼ばないため(検査の外での判定にしない)。
  const assigned = assignFaceAppearance(
    assignFaceAppearance(createEmptyPartDocument(), faceRef('extrude-1', 0), STEEL),
    faceRef('extrude-1', 1),
    STEEL,
  );
  const ids = appearanceOf(assigned).entries.map((entry) => entry.id);

  it('照合の結果が届いていなければ 0 件(色を付けた直後)', () => {
    expect(missingAppearanceCount(assigned, [])).toBe(0);
  });

  it('選び直せた割り当ては数えない', () => {
    const matches: AppearanceMatchEntry[] = ids.map((id, index) => ({
      id,
      bodyFeatureId: 'extrude-1',
      faceIndex: index,
    }));
    expect(missingAppearanceCount(assigned, matches)).toBe(0);
  });

  it('選び直せなかった(faceIndex が null)割り当ての数を返す', () => {
    const matches: AppearanceMatchEntry[] = [
      { id: ids[0], bodyFeatureId: 'extrude-1', faceIndex: null },
      { id: ids[1], bodyFeatureId: 'extrude-1', faceIndex: 3 },
    ];
    expect(missingAppearanceCount(assigned, matches)).toBe(1);
    expect(missingAppearanceIds(assigned, matches)).toEqual([ids[0]]);
  });

  it('文書に無くなった id の照合は数えない(前の文書の残り)', () => {
    const matches: AppearanceMatchEntry[] = [
      { id: 'appearance-99', bodyFeatureId: 'extrude-1', faceIndex: null },
    ];
    expect(missingAppearanceCount(assigned, matches)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * 面の通し番号 → 外観(タスク10 から移設)
 * ------------------------------------------------------------------------- */

describe('buildAppearanceInput(文書の割り当て → 組み立てへ渡す一式)', () => {
  it('割り当てが 1 つも無ければ、ボディの表は空で既定の外観だけになる', () => {
    const input = buildAppearanceInput(tableOf([]), []);
    expect(input.byBody.size).toBe(0);
    expect(input.defaultAppearance).toBe(DEFAULT_APPEARANCE);
  });

  it('立体への割り当ては bodyAppearance に入る', () => {
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'body', bodyFeatureId: 'extrude-1' }, appearance: STEEL },
      ]),
      [],
    );
    expect(input.byBody.get('extrude-1')?.bodyAppearance).toBe(STEEL);
    expect(input.byBody.get('extrude-1')?.faceAppearances.size).toBe(0);
  });

  it('面への割り当ては、カーネルが選び直した面の通し番号に入る', () => {
    const matches: AppearanceMatchEntry[] = [
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 4 },
    ];
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 2) }, appearance: GLASS },
      ]),
      matches,
    );
    // 保存されている通し番号(2)ではなく、選び直した番号(4)を使う。
    expect(input.byBody.get('extrude-1')?.faceAppearances.get(4)).toBe(GLASS);
    expect(input.byBody.get('extrude-1')?.faceAppearances.has(2)).toBe(false);
  });

  it('選び直せなかった(faceIndex が null)割り当ては描かない', () => {
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 2) }, appearance: STEEL },
      ]),
      [{ id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: null }],
    );
    // 描くものが 1 つも無いので、そのボディの入れ物そのものを作らない。
    expect(input.byBody.has('extrude-1')).toBe(false);
  });

  it('照合の結果がまだ無い割り当ては、割り当てたときの通し番号を使う(色を付けた直後)', () => {
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 3) }, appearance: STEEL },
      ]),
      [],
    );
    expect(input.byBody.get('extrude-1')?.faceAppearances.get(3)).toBe(STEEL);
  });

  it('立体と面の両方の割り当てが 1 つの入れ物にまとまる', () => {
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 1) }, appearance: GLASS },
        { id: 'appearance-2', target: { kind: 'body', bodyFeatureId: 'extrude-1' }, appearance: STEEL },
      ]),
      [],
    );
    const assignment = input.byBody.get('extrude-1');
    expect(assignment?.bodyAppearance).toBe(STEEL);
    expect(assignment?.faceAppearances.get(1)).toBe(GLASS);
  });
});

/* ---------------------------------------------------------------------------
 * 外観 1 つの作り替え(FR-1107〜1109)
 * ------------------------------------------------------------------------- */

describe('isSameAppearanceSpec', () => {
  it('同じ外観は同じと判定する', () => {
    expect(isSameAppearanceSpec(STEEL, appearanceFromPreset('steel'))).toBe(true);
  });

  it('プリセットの id が違えば違うと判定する(見え方が同じでも)', () => {
    expect(isSameAppearanceSpec(STEEL, { ...STEEL, preset: 'custom' })).toBe(false);
  });

  it('柄の間隔が違えば違うと判定する', () => {
    const woodA = appearanceFromPreset('wood');
    const woodB = appearanceWithPattern(woodA, {
      kind: 'woodGrain',
      spacing: expressionValueFromNumber(12),
      species: 'hinoki',
    });
    expect(isSameAppearanceSpec(woodA, woodB)).toBe(false);
  });
});

describe('外観の値を個別に変える(FR-1109)', () => {
  it('色を変えると「自分で決める」へ移る(色を選べないプリセット)', () => {
    const next = appearanceWithColor(STEEL, '#123456');
    expect(next.color).toBe('#123456');
    expect(next.preset).toBe('custom');
  });

  it('色を選べるプリセット(プラスチック)は色を変えてもプリセットのまま', () => {
    const plastic = appearanceFromPreset('plastic');
    const next = appearanceWithColor(plastic, '#123456');
    expect(next.preset).toBe('plastic');
    expect(next.color).toBe('#123456');
  });

  it('同じ色を入れ直しても作り直さない(同一参照)', () => {
    expect(appearanceWithColor(STEEL, STEEL.color)).toBe(STEEL);
  });

  it('粗さを変えると「自分で決める」へ移る', () => {
    const next = appearanceWithNumber(STEEL, 'roughness', expressionValueFromNumber(12));
    expect(next.roughness.value).toBe(12);
    expect(next.preset).toBe('custom');
  });

  it('同じ値を入れ直しても作り直さない(同一参照)', () => {
    expect(appearanceWithNumber(STEEL, 'gloss', STEEL.gloss)).toBe(STEEL);
  });

  it('プリセットを選び直すと 5 つの値がまとめて変わる', () => {
    const next = appearanceWithPreset(coloredAppearance('#123456'), 'glass');
    expect(next.preset).toBe('glass');
    expect(next).toEqual(appearanceFromPreset('glass', '#123456'));
  });

  it('柄を変えると「自分で決める」へ移る', () => {
    const next = appearanceWithPattern(STEEL, {
      kind: 'checkerPlate',
      spacing: expressionValueFromNumber(30),
    });
    expect(next.pattern.kind).toBe('checkerPlate');
    expect(next.preset).toBe('custom');
  });

  it('樹種を選び直すと、地の色と木目の樹種が同時に変わる', () => {
    const wood = appearanceFromPreset('wood');
    const walnut = appearanceWithWoodSpecies(wood, 'walnut');
    expect(walnut.color).toBe('#6b4a33');
    expect(walnut.pattern.kind === 'woodGrain' ? walnut.pattern.species : null).toBe('walnut');
  });

  it('柄が木目でなければ樹種を変えても何も起きない(同一参照)', () => {
    expect(appearanceWithWoodSpecies(STEEL, 'walnut')).toBe(STEEL);
  });
});
