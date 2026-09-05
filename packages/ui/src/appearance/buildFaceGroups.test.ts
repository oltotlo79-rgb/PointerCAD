/**
 * 面のまとまり(`buildFaceGroups.ts`)の検査(計画書
 * docs/plans/P5-高度なソリッド・外観と測定.md タスク7 の検証表、§2.5.2 の不変条件)。
 *
 * three.js にも DOM にも触れない純関数なので Node のまま検査できる。
 */

import { appearanceFromPreset, DEFAULT_APPEARANCE, type AppearanceSpec } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { SolidFaceEntry } from '../solid/subShapeSelection.js';

import {
  appearanceKeyText,
  buildFaceGroups,
  MAX_GROUPS_PER_BODY,
  MAX_MATERIALS_PER_BODY,
  type FaceGroup,
} from './buildFaceGroups.js';

/** 面 1 枚。三角形の範囲だけを指定し、ほかの欄は当たり判定用なのでここでは使わない。 */
function makeFace(index: number, triangleOffset: number, triangleCount: number): SolidFaceEntry {
  return {
    index,
    surfaceKind: 'plane',
    area: 100,
    centroid: [0, 0, 0],
    axis: [0, 0, 1],
    radius: null,
    triangleOffset,
    triangleCount,
  };
}

/** 三角形が `trianglesPerFace` 枚ずつ隙間なく並んだ面を `count` 枚作る。 */
function makeFaces(count: number, trianglesPerFace = 2): SolidFaceEntry[] {
  const faces: SolidFaceEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    faces.push(makeFace(index, index * trianglesPerFace, trianglesPerFace));
  }
  return faces;
}

/**
 * 色だけ違う外観(材質の種類を数える検査で使う)。
 * 色を指定できるのは `colorEditable` なプリセットだけなので `'custom'` を使う
 * (`packages/model/src/appearance/materialPresets.ts` の `appearanceFromPreset`)。
 */
function coloredAppearance(color: string): AppearanceSpec {
  return appearanceFromPreset('custom', color);
}

function tupleOf(group: FaceGroup): readonly [number, number, number] {
  return [group.start, group.count, group.materialIndex];
}

const NO_FACE_APPEARANCES: ReadonlyMap<number, AppearanceSpec> = new Map<number, AppearanceSpec>();

describe('buildFaceGroups(FR-1106、§2.5.2)', () => {
  it('割り当てが 1 つも無い箱は、まとまりも材質も 1 つだけになる(§0.a-0.12)', () => {
    const plan = buildFaceGroups(makeFaces(6), NO_FACE_APPEARANCES, null, DEFAULT_APPEARANCE);
    expect(plan).not.toBeNull();
    expect(plan?.groups.length).toBe(1);
    expect(plan?.appearances.length).toBe(1);
    expect(plan?.appearances[0]).toBe(DEFAULT_APPEARANCE);
    expect(plan?.groups[0].start).toBe(0);
    // 面 6 枚 × 三角形 2 枚 × 索引 3 個 = 36。
    expect(plan?.groups[0].count).toBe(36);
    expect(plan?.groups[0].materialIndex).toBe(0);
  });

  it('先頭の面(上面)だけに割り当てると、まとまりが 2 つに分かれる', () => {
    const plan = buildFaceGroups(
      makeFaces(6),
      new Map([[0, coloredAppearance('#ff0000')]]),
      null,
      DEFAULT_APPEARANCE,
    );
    expect(plan?.appearances.length).toBe(2);
    expect(plan?.groups.map(tupleOf)).toEqual([
      [0, 6, 1],
      [6, 30, 0],
    ]);
  });

  it('中ほどの面だけに割り当てると、まとまりが 3 つに分かれる', () => {
    const plan = buildFaceGroups(
      makeFaces(6),
      new Map([[2, coloredAppearance('#ff0000')]]),
      null,
      DEFAULT_APPEARANCE,
    );
    expect(plan?.appearances.length).toBe(2);
    expect(plan?.groups.map(tupleOf)).toEqual([
      [0, 12, 0],
      [12, 6, 1],
      [18, 18, 0],
    ]);
  });

  it('まとまりが索引の全体をちょうど覆い、重なりも隙間もない(three の addGroup の約束)', () => {
    const faces = makeFaces(26, 4);
    const red = coloredAppearance('#ff0000');
    const assignment = new Map<number, AppearanceSpec>();
    for (let index = 0; index < 26; index += 2) {
      assignment.set(index, red);
    }
    const plan = buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE);
    expect(plan).not.toBeNull();
    const groups = plan?.groups ?? [];
    // 面 26 枚 × 三角形 4 枚 × 索引 3 個 = 312。
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(312);
    let cursor = 0;
    for (const group of groups) {
      expect(group.start).toBe(cursor);
      cursor += group.count;
    }
    expect(cursor).toBe(312);
  });

  it('隣り合う同じ材質の面は 1 つのまとまりに畳まれる(ドローコールを増やさない)', () => {
    const red = coloredAppearance('#ff0000');
    const plan = buildFaceGroups(
      makeFaces(6),
      new Map([
        [0, red],
        [1, red],
      ]),
      null,
      DEFAULT_APPEARANCE,
    );
    expect(plan?.appearances.length).toBe(2);
    expect(plan?.groups.map(tupleOf)).toEqual([
      [0, 12, 1],
      [12, 24, 0],
    ]);
  });

  it('索引が飛んでいる面どうしは、材質が同じでも畳まない(間を塗らないため)', () => {
    const faces = [makeFace(0, 0, 2), makeFace(1, 5, 2)];
    const plan = buildFaceGroups(faces, NO_FACE_APPEARANCES, null, DEFAULT_APPEARANCE);
    expect(plan?.groups.map(tupleOf)).toEqual([
      [0, 6, 0],
      [15, 6, 0],
    ]);
  });

  it('三角形が 0 枚の面はまとまりを作らず、前後の面の畳み込みも邪魔しない', () => {
    const faces = [makeFace(0, 0, 2), makeFace(1, 2, 0), makeFace(2, 2, 2)];
    const plan = buildFaceGroups(faces, NO_FACE_APPEARANCES, null, DEFAULT_APPEARANCE);
    expect(plan?.groups.map(tupleOf)).toEqual([[0, 12, 0]]);
  });

  it('三角形が 0 枚の面に外観を割り当てても、材質もまとまりも増えない', () => {
    const plan = buildFaceGroups(
      [makeFace(0, 0, 2), makeFace(1, 2, 0)],
      new Map([[1, coloredAppearance('#ff0000')]]),
      null,
      DEFAULT_APPEARANCE,
    );
    expect(plan?.appearances.length).toBe(1);
    expect(plan?.groups.map(tupleOf)).toEqual([[0, 6, 0]]);
  });

  it('立体全体の割り当てがあると 0 番の材質がそれになり、まとまりは 1 つのまま', () => {
    const body = coloredAppearance('#00ff00');
    const plan = buildFaceGroups(makeFaces(6), NO_FACE_APPEARANCES, body, DEFAULT_APPEARANCE);
    expect(plan?.appearances).toEqual([body]);
    expect(plan?.groups.length).toBe(1);
  });

  it('面の割り当てが立体の割り当てと同じ見え方なら、材質は増えない', () => {
    const body = coloredAppearance('#00ff00');
    const plan = buildFaceGroups(
      makeFaces(6),
      new Map([[0, coloredAppearance('#00ff00')]]),
      body,
      DEFAULT_APPEARANCE,
    );
    expect(plan?.appearances.length).toBe(1);
    expect(plan?.groups.length).toBe(1);
  });

  it('材質 8 種(既定 1 + 割り当て 7)までは作れる(§0.a-0.11)', () => {
    const faces = makeFaces(8);
    const assignment = new Map<number, AppearanceSpec>();
    for (let index = 0; index < MAX_MATERIALS_PER_BODY - 1; index += 1) {
      assignment.set(index, coloredAppearance(`#0000${(index + 1).toString(16)}${index + 1}`));
    }
    const plan = buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE);
    expect(plan?.appearances.length).toBe(MAX_MATERIALS_PER_BODY);
  });

  it('材質 9 種になる割り当ては断る(null を返す。例外は投げない)', () => {
    const faces = makeFaces(8);
    const assignment = new Map<number, AppearanceSpec>();
    for (let index = 0; index < MAX_MATERIALS_PER_BODY; index += 1) {
      assignment.set(index, coloredAppearance(`#0000${(index + 1).toString(16)}${index + 1}`));
    }
    expect(buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE)).toBeNull();
  });

  it('まとまり 32 個までは作れる(§2.5.2)', () => {
    const faces = makeFaces(MAX_GROUPS_PER_BODY);
    const red = coloredAppearance('#ff0000');
    const assignment = new Map<number, AppearanceSpec>();
    for (let index = 0; index < MAX_GROUPS_PER_BODY; index += 2) {
      assignment.set(index, red);
    }
    const plan = buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE);
    expect(plan?.groups.length).toBe(MAX_GROUPS_PER_BODY);
    expect(plan?.appearances.length).toBe(2);
  });

  it('まとまり 33 個になる割り当ては断る(null を返す)', () => {
    const faces = makeFaces(MAX_GROUPS_PER_BODY + 1);
    const red = coloredAppearance('#ff0000');
    const assignment = new Map<number, AppearanceSpec>();
    for (let index = 0; index < MAX_GROUPS_PER_BODY + 1; index += 2) {
      assignment.set(index, red);
    }
    expect(buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE)).toBeNull();
  });

  it('面が 1 枚も無いボディでも、既定の材質 1 つだけを返す', () => {
    const plan = buildFaceGroups([], NO_FACE_APPEARANCES, null, DEFAULT_APPEARANCE);
    expect(plan?.groups).toEqual([]);
    expect(plan?.appearances).toEqual([DEFAULT_APPEARANCE]);
  });

  it('同じ入力を 2 回渡すと同じ結果になる(決定性)', () => {
    const faces = makeFaces(6);
    const assignment = new Map([[3, coloredAppearance('#ff0000')]]);
    const first = buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE);
    const second = buildFaceGroups(faces, assignment, null, DEFAULT_APPEARANCE);
    expect(second?.groups).toEqual(first?.groups);
    expect(second?.appearances).toEqual(first?.appearances);
  });

  it('上限の値は §0.a-0.11 / §2.5.2 のとおり', () => {
    expect(MAX_MATERIALS_PER_BODY).toBe(8);
    expect(MAX_GROUPS_PER_BODY).toBe(32);
  });
});

describe('appearanceKeyText(§2.5.3)', () => {
  it('色が違えば別の鍵になる', () => {
    expect(appearanceKeyText(coloredAppearance('#ff0000'))).not.toBe(
      appearanceKeyText(coloredAppearance('#00ff00')),
    );
  });

  it('式の書き方(source)が違っても、評価値が同じなら同じ鍵になる', () => {
    const base = coloredAppearance('#ff0000');
    const rewritten: AppearanceSpec = {
      ...base,
      gloss: { source: '2+3', value: base.gloss.value, display: base.gloss.display },
    };
    expect(appearanceKeyText(rewritten)).toBe(appearanceKeyText(base));
  });

  it('柄の樹種が違えば別の鍵になる', () => {
    const wood = appearanceFromPreset('wood');
    const spacing = { source: '6', value: 6, display: '6' };
    const oak: AppearanceSpec = { ...wood, pattern: { kind: 'woodGrain', spacing, species: 'oak' } };
    const walnut: AppearanceSpec = {
      ...wood,
      pattern: { kind: 'woodGrain', spacing, species: 'walnut' },
    };
    expect(appearanceKeyText(walnut)).not.toBe(appearanceKeyText(oak));
  });

  it('柄の繰り返しの間隔が違えば別の鍵になる(FR-1108)', () => {
    const plate = appearanceFromPreset('checkerPlate');
    const wide: AppearanceSpec = {
      ...plate,
      pattern: { kind: 'checkerPlate', spacing: { source: '60', value: 60, display: '60' } },
    };
    expect(appearanceKeyText(wide)).not.toBe(appearanceKeyText(plate));
  });

  it('プリセットの id が違っても、見え方が同じなら同じ鍵になる(材質を 2 つ作らない)', () => {
    const steel = appearanceFromPreset('steel');
    const sameLook: AppearanceSpec = { ...steel, preset: 'custom' };
    expect(appearanceKeyText(sameLook)).toBe(appearanceKeyText(steel));
  });
});
