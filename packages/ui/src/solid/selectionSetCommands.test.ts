/**
 * 選択セット(FR-112)の画面側の純関数の検査
 * (計画書 docs/plans/P6-入出力.md §2.13 の検証表、§0.a-0.44、タスク43)。
 *
 * 期待値の導出は §2.13 の表のとおり。
 * 「面 3 枚を選んで名付ける → 3 件の参照ができる」「面が消えた → その 1 件だけ外れ、
 * 組は残る」の 2 つを、画面と文書のあいだの写し取りの側から固定する。
 */

import { createSelectionSet, type SelectionSet } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';

import {
  selectionKindForSet,
  selectionMembersOf,
  selectionSetElementIds,
  selectionSetRefusalMessageKey,
} from './selectionSetCommands.js';
import { subShapeElementId, type SubShapeBody } from './subShapeSelection.js';

/** 面 3 枚・辺 1 本・頂点 1 つを持つ立体。番号は `TopExp` の並びと同じ 0 始まり。 */
const BOX: SubShapeBody = {
  featureId: 'extrude-1',
  mesh: { edgePositions: new Float32Array([0, 0, 0, 10, 0, 0]) },
  faces: [
    {
      index: 0,
      surfaceKind: 'plane',
      area: 100,
      centroid: [5, 5, 10],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 2,
    },
    {
      index: 1,
      surfaceKind: 'plane',
      area: 100,
      centroid: [5, 5, 0],
      axis: [0, 0, -1],
      radius: null,
      triangleOffset: 2,
      triangleCount: 2,
    },
    {
      index: 2,
      surfaceKind: 'plane',
      area: 100,
      centroid: [5, 0, 5],
      axis: [0, -1, 0],
      radius: null,
      triangleOffset: 4,
      triangleCount: 2,
    },
  ],
  edges: [
    {
      index: 0,
      curveKind: 'line',
      length: 10,
      midpoint: [5, 0, 0],
      start: [0, 0, 0],
      end: [10, 0, 0],
      axis: [1, 0, 0],
      radius: null,
      segmentOffset: 0,
      segmentCount: 1,
    },
    {
      index: 1,
      curveKind: 'circle',
      length: 31.4,
      midpoint: [5, 5, 10],
      start: [10, 5, 10],
      end: [10, 5, 10],
      axis: [0, 0, 1],
      radius: 5,
      segmentOffset: 1,
      segmentCount: 16,
    },
  ],
  vertices: [
    { index: 0, position: [0, 0, 0] },
    { index: 1, position: [10, 0, 0] },
  ],
};

/** 面を 1 枚だけ持つ別の立体(立体をまたぐ組を作るのに使う)。 */
const CYLINDER: SubShapeBody = {
  featureId: 'revolve-2',
  mesh: { edgePositions: new Float32Array([]) },
  faces: [
    {
      index: 0,
      surfaceKind: 'cylinder',
      area: 62.8,
      centroid: [0, 0, 5],
      axis: [0, 0, 1],
      radius: 5,
      triangleOffset: 0,
      triangleCount: 8,
    },
  ],
  edges: [],
  vertices: [],
};

const BODIES: readonly SubShapeBody[] = [BOX, CYLINDER];

/** 検査で使う組を 1 つ作る(model の採番と同じ道を通す)。 */
function setOf(elementIds: readonly string[], name = '上面'): SelectionSet {
  const result = createSelectionSet([], name, selectionMembersOf(BODIES, elementIds));
  if (!result.ok) {
    throw new Error('検査の前提が崩れている(名前が空でない組は必ず作れる)');
  }
  return result.set;
}

describe('selectionMembersOf(画面 → 文書)', () => {
  it('面 3 枚を選ぶと 3 件の面の参照になる(§2.13「面 3 枚を選んで「上面」と名付ける」)', () => {
    const members = selectionMembersOf(BODIES, [
      'extrude-1#face:0',
      'extrude-1#face:1',
      'extrude-1#face:2',
    ]);
    expect(members).toHaveLength(3);
    expect(members.every((member) => member.kind === 'face')).toBe(true);
  });

  it('参照には手がかり(向き・広さ・位置)が入り、再計算のあとに選び直せる', () => {
    const [member] = selectionMembersOf(BODIES, ['extrude-1#face:0']);
    if (member === undefined || member.kind !== 'face') {
      throw new Error('面の参照が作られていない');
    }
    expect(member.ref.bodyFeatureId).toBe('extrude-1');
    expect(member.ref.index).toBe(0);
    expect(member.ref.fingerprint).toEqual({
      kind: 'face',
      surfaceKind: 'plane',
      area: 100,
      position: [5, 5, 10],
      axis: [0, 0, 1],
      radius: null,
    });
  });

  it('立体そのものも覚えられ、面と混ざっていても選んだ順のまま並ぶ', () => {
    expect(selectionMembersOf(BODIES, ['extrude-1#face:2', 'revolve-2'])).toEqual([
      {
        kind: 'face',
        ref: {
          bodyFeatureId: 'extrude-1',
          index: 2,
          fingerprint: {
            kind: 'face',
            surfaceKind: 'plane',
            area: 100,
            position: [5, 0, 5],
            axis: [0, -1, 0],
            radius: null,
          },
        },
      },
      { kind: 'body', bodyFeatureId: 'revolve-2' },
    ]);
  });

  it('辺・頂点も覚える(利用者の決定 2026-09-06。選択フィルタの 4 種と対になる)', () => {
    const members = selectionMembersOf(BODIES, [
      'extrude-1#edge:0',
      'extrude-1#vertex:0',
      'extrude-1#face:0',
      'extrude-1',
    ]);
    // 選んだ順のまま 4 件。落ちるものは 1 つも無い。
    expect(members.map((member) => member.kind)).toEqual(['edge', 'vertex', 'face', 'body']);
  });

  it('辺の参照には辺の指紋(長さ・中点・向き・半径)が入る', () => {
    const [member] = selectionMembersOf(BODIES, ['extrude-1#edge:1']);
    if (member === undefined || member.kind !== 'edge') {
      throw new Error('辺の参照が作られていない');
    }
    expect(member.ref.index).toBe(1);
    expect(member.ref.fingerprint).toEqual({
      kind: 'edge',
      curveKind: 'circle',
      length: 31.4,
      position: [5, 5, 10],
      axis: [0, 0, 1],
      radius: 5,
    });
  });

  it('頂点の参照には頂点の指紋(位置だけ)が入る', () => {
    const [member] = selectionMembersOf(BODIES, ['extrude-1#vertex:1']);
    if (member === undefined || member.kind !== 'vertex') {
      throw new Error('頂点の参照が作られていない');
    }
    expect(member.ref.index).toBe(1);
    expect(member.ref.fingerprint).toEqual({ kind: 'vertex', position: [10, 0, 0] });
  });

  it('判別子は指紋の種類とそろう(io が食い違いを断る前提。4 種類とも)', () => {
    const members = selectionMembersOf(BODIES, [
      'extrude-1#face:0',
      'extrude-1#edge:0',
      'extrude-1#vertex:0',
    ]);
    for (const member of members) {
      if (member.kind === 'body') {
        throw new Error('この選択に立体は入れていない');
      }
      expect(member.ref.fingerprint.kind).toBe(member.kind);
    }
  });

  it('無い番号の辺・頂点は入れない(引けない組を作らない)', () => {
    expect(selectionMembersOf(BODIES, ['extrude-1#edge:9', 'revolve-2#vertex:0'])).toEqual([]);
  });

  it('いま画面に無い立体の id は入れない(引けない組を作らない)', () => {
    expect(selectionMembersOf(BODIES, ['消えた立体', 'line-1'])).toEqual([]);
  });

  it('空の選択からは空の組ができる(§2.13「空のセットは作れる」)', () => {
    const members = selectionMembersOf(BODIES, []);
    expect(members).toEqual([]);
    expect(createSelectionSet([], '空の組', members).ok).toBe(true);
  });
});

describe('selectionSetElementIds(文書 → 画面)', () => {
  it('覚えた 3 枚の面をそのまま選び直せる', () => {
    const set = setOf(['extrude-1#face:0', 'extrude-1#face:1', 'extrude-1#face:2']);
    expect(selectionSetElementIds(BODIES, set)).toEqual({
      elementIds: ['extrude-1#face:0', 'extrude-1#face:1', 'extrude-1#face:2'],
      missingCount: 0,
    });
  });

  it('要素 id の書式は subShapeElementId が作るものと同じ(書式を 2 か所に書かない)', () => {
    const set = setOf(['extrude-1#face:2']);
    expect(selectionSetElementIds(BODIES, set).elementIds).toEqual([
      subShapeElementId('extrude-1', 'face', 2),
    ]);
  });

  it('面が消えたときはその 1 件だけが引けず、組は残る(§2.13、FR-504)', () => {
    const set = setOf(['extrude-1#face:0', 'extrude-1#face:2']);
    // 面が 1 枚だけになった立体(番号 2 の面がもう無い)。
    const shrunk: SubShapeBody = { ...BOX, faces: [BOX.faces[0]] };
    const outcome = selectionSetElementIds([shrunk, CYLINDER], set);
    expect(outcome.elementIds).toEqual(['extrude-1#face:0']);
    expect(outcome.missingCount).toBe(1);
    // 組そのものは 2 件を覚えたままで、選び直して足せる。
    expect(set.members).toHaveLength(2);
  });

  it('立体ごと消えたときも、残りは選び直せる', () => {
    const set = setOf(['extrude-1#face:0', 'revolve-2']);
    const outcome = selectionSetElementIds([CYLINDER], set);
    expect(outcome.elementIds).toEqual(['revolve-2']);
    expect(outcome.missingCount).toBe(1);
  });

  it('覚えた辺・頂点も元の要素 id へ戻る(種類ごとの番号で引き直す)', () => {
    const set = setOf(['extrude-1#edge:1', 'extrude-1#vertex:1', 'extrude-1#face:2']);
    expect(selectionSetElementIds(BODIES, set)).toEqual({
      elementIds: ['extrude-1#edge:1', 'extrude-1#vertex:1', 'extrude-1#face:2'],
      missingCount: 0,
    });
  });

  it('辺が減ったときはその 1 件だけが引けず、組は残る(§2.13、FR-504)', () => {
    const set = setOf(['extrude-1#edge:0', 'extrude-1#edge:1']);
    // 円の辺(番号 1)が消えた立体。
    const shrunk: SubShapeBody = { ...BOX, edges: [BOX.edges[0]] };
    const outcome = selectionSetElementIds([shrunk, CYLINDER], set);
    expect(outcome.elementIds).toEqual(['extrude-1#edge:0']);
    expect(outcome.missingCount).toBe(1);
    expect(set.members).toHaveLength(2);
  });

  it('種類ごとに別の一覧を見る(面が減っても同じ番号の辺は引ける)', () => {
    const set = setOf(['extrude-1#face:1', 'extrude-1#edge:1', 'extrude-1#vertex:1']);
    // 面だけ 1 枚に減らす。番号 1 の面は無いが、番号 1 の辺と頂点は残っている。
    const shrunk: SubShapeBody = { ...BOX, faces: [BOX.faces[0]] };
    const outcome = selectionSetElementIds([shrunk, CYLINDER], set);
    expect(outcome.elementIds).toEqual(['extrude-1#edge:1', 'extrude-1#vertex:1']);
    expect(outcome.missingCount).toBe(1);
  });

  it('空の組を選んでも何も選ばれない(断らない)', () => {
    expect(selectionSetElementIds(BODIES, setOf([]))).toEqual({ elementIds: [], missingCount: 0 });
  });
});

describe('selectionKindForSet', () => {
  it('面が 1 つでも入っていれば「面」へ切り替える(選ばれたのに光らないのを防ぐ)', () => {
    expect(selectionKindForSet(setOf(['revolve-2', 'extrude-1#face:0']))).toBe('face');
  });

  it('立体だけの組は「立体」', () => {
    expect(selectionKindForSet(setOf(['revolve-2']))).toBe('body');
  });

  it('空の組は「立体」(既定)', () => {
    expect(selectionKindForSet(setOf([]))).toBe('body');
  });

  it('辺だけの組は「辺」、頂点だけの組は「頂点」(4 種類とも戻せる)', () => {
    expect(selectionKindForSet(setOf(['extrude-1#edge:0', 'extrude-1#edge:1']))).toBe('edge');
    expect(selectionKindForSet(setOf(['extrude-1#vertex:0']))).toBe('vertex');
  });

  it('種類が混ざった組は、最初に選んだ部分形状の種類に合わせる', () => {
    expect(selectionKindForSet(setOf(['extrude-1#edge:0', 'extrude-1#face:0']))).toBe('edge');
    expect(selectionKindForSet(setOf(['extrude-1#face:0', 'extrude-1#edge:0']))).toBe('face');
    // 立体は数に入れない(立体だけの組でないかぎり、部分形状の種類が勝つ)。
    expect(selectionKindForSet(setOf(['revolve-2', 'extrude-1#vertex:0']))).toBe('vertex');
  });
});

describe('selectionSetRefusalMessageKey', () => {
  it('名前が空のときは「名前を入れてください。」を引く(§2.13、NFR-UX-5)', () => {
    expect(t(selectionSetRefusalMessageKey('emptyName'))).toBe('名前を入れてください。');
  });

  it('名前が空白だけの組は作れず、その理由が引ける', () => {
    const result = createSelectionSet([], '   ', []);
    if (result.ok) {
      throw new Error('空白だけの名前は断られるはず');
    }
    expect(t(selectionSetRefusalMessageKey(result.reason))).toBe('名前を入れてください。');
  });

  it('同じ名前は 2 つ作れる(id で区別する。§2.13)', () => {
    const first = createSelectionSet([], '上面', []);
    if (!first.ok) {
      throw new Error('1 つ目が作れていない');
    }
    const second = createSelectionSet(first.sets, '上面', []);
    if (!second.ok) {
      throw new Error('同じ名前は許されるはず');
    }
    expect(second.sets).toHaveLength(2);
    expect(second.sets[0]?.id).not.toBe(second.sets[1]?.id);
  });
});
