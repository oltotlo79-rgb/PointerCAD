import { describe, expect, it } from 'vitest';

import { isSameAppearanceTarget } from '../appearance/appearanceTable.js';
import type { AppearanceTarget } from '../appearance/types.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';

import { createEmptyPartDocument } from './createPartDocument.js';
import { affectsShape } from './documentChange.js';
import {
  addSelectionSetMembers,
  createSelectionSet,
  findSelectionSet,
  isSameSelectionMember,
  nextSelectionSetId,
  pruneSelectionSets,
  removeSelectionSet,
  removeSelectionSetMembers,
  renameSelectionSet,
} from './selectionSets.js';
import type { SelectionMember, SelectionSet } from './types.js';

/** 面 1 枚の参照(P3 §2.2.2 の指紋の形。`appearanceTable.test.ts` と同じ見本)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 辺 1 本の参照。選択セットは面だけでなく辺・頂点も持てる(FR-112)。 */
function edgeRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 40,
      position: [0, 0, 0],
      axis: [1, 0, 0],
      radius: null,
    },
  };
}

/** 頂点 1 つの参照。指紋は位置だけ(`geometry/subShapeRef.ts`)。 */
function vertexRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: { kind: 'vertex', position: [10, 20, 30] },
  };
}

function bodyMember(bodyFeatureId: string): SelectionMember {
  return { kind: 'body', bodyFeatureId };
}

function faceMember(bodyFeatureId: string, index: number): SelectionMember {
  return { kind: 'face', ref: faceRef(bodyFeatureId, index) };
}

function edgeMember(bodyFeatureId: string, index: number): SelectionMember {
  return { kind: 'edge', ref: edgeRef(bodyFeatureId, index) };
}

function vertexMember(bodyFeatureId: string, index: number): SelectionMember {
  return { kind: 'vertex', ref: vertexRef(bodyFeatureId, index) };
}

/** 「面 3 枚を選んで名前を付けた」セット(§2.13 の表)。 */
function threeFaces(): readonly SelectionMember[] {
  return [faceMember('extrude-1', 1), faceMember('extrude-1', 2), faceMember('extrude-1', 3)];
}

/** 断られないことを確かめて、できたセットの一覧を取り出す。 */
function expectCreated(
  sets: readonly SelectionSet[],
  name: string,
  members: readonly SelectionMember[] = [],
): { readonly sets: readonly SelectionSet[]; readonly set: SelectionSet } {
  const result = createSelectionSet(sets, name, members);
  if (!result.ok) {
    throw new Error(`セットを作れるはず: ${result.reason}`);
  }
  return { sets: result.sets, set: result.set };
}

describe('選択セット(FR-112、P6 §0.a-0.44・§2.13、タスク37)', () => {
  it('面 3 枚を選んで「上面」と名付けると、3 件の部分形状を持つセットができる', () => {
    const { sets, set } = expectCreated([], '上面', threeFaces());
    expect(sets).toHaveLength(1);
    expect(set.name).toBe('上面');
    expect(set.members).toHaveLength(3);
    expect(set.members.every((member) => member.kind === 'face')).toBe(true);
  });

  it('空のセットを作れる(後から足せる。§2.13 の表)', () => {
    const { set } = expectCreated([], '後で足す');
    expect(set.members).toEqual([]);
  });

  it('名前が空(空白だけを含む)なら emptyName で断る(NFR-UX-5)', () => {
    for (const name of ['', ' ', '　\t']) {
      const result = createSelectionSet([], name);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('断るはず');
      }
      expect(result.reason).toBe('emptyName');
    }
  });

  it('名前の前後の空白は落として持つ(見た目が同じ名前を一覧に並べないため)', () => {
    const { set } = expectCreated([], '  上面  ');
    expect(set.name).toBe('上面');
  });

  it('同じ名前のセットを 2 つ作れる(§2.13。区別は id が付ける)', () => {
    const first = expectCreated([], '上面', threeFaces());
    const second = expectCreated(first.sets, '上面', [bodyMember('extrude-2')]);
    expect(second.sets).toHaveLength(2);
    expect(second.sets[0].name).toBe(second.sets[1].name);
    expect(second.sets[0].id).not.toBe(second.sets[1].id);
  });

  it('id は selectionSet-<n> の連番で、1 つ消しても残りの最大の次を採る', () => {
    expect(nextSelectionSetId([])).toBe('selectionSet-1');
    const first = expectCreated([], 'A');
    const second = expectCreated(first.sets, 'B');
    expect(second.set.id).toBe('selectionSet-2');
    const removed = removeSelectionSet(second.sets, 'selectionSet-1');
    expect(nextSelectionSetId(removed)).toBe('selectionSet-3');
  });

  it('同じものを 2 回入れても 1 件になる(作るときも足すときも)', () => {
    const { sets, set } = expectCreated([], '上面', [
      faceMember('extrude-1', 2),
      faceMember('extrude-1', 2),
    ]);
    expect(set.members).toHaveLength(1);
    const again = addSelectionSetMembers(sets, set.id, [faceMember('extrude-1', 2)]);
    // 何も増えないときは元の配列を同一参照のまま返す(無駄な再計算を起こさない)。
    expect(again).toBe(sets);
  });

  it('後から要素を足せる(FR-112)。知らない id には何もしない', () => {
    const { sets, set } = expectCreated([], '上面');
    const added = addSelectionSetMembers(sets, set.id, [
      bodyMember('extrude-1'),
      edgeMember('extrude-1', 5),
    ]);
    expect(findSelectionSet(added, set.id)?.members).toHaveLength(2);
    expect(addSelectionSetMembers(added, 'selectionSet-9', [bodyMember('extrude-2')])).toBe(added);
  });

  it('要素を 1 つ外してもセットは残る(0 件になっても消さない)', () => {
    const { sets, set } = expectCreated([], '上面', threeFaces());
    const removed = removeSelectionSetMembers(sets, set.id, threeFaces());
    expect(removed).toHaveLength(1);
    expect(findSelectionSet(removed, set.id)?.members).toEqual([]);
    // 入っていないものを外そうとしたときは同一参照のまま。
    expect(removeSelectionSetMembers(removed, set.id, threeFaces())).toBe(removed);
  });

  it('セットを消せる。知らない id なら元の配列を同一参照のまま返す', () => {
    const { sets, set } = expectCreated([], '上面', threeFaces());
    expect(removeSelectionSet(sets, set.id)).toEqual([]);
    expect(removeSelectionSet(sets, 'selectionSet-9')).toBe(sets);
  });

  it('名前を変えられる。空の名前は断り、知らない id は何もしない', () => {
    const { sets, set } = expectCreated([], '上面', threeFaces());
    const renamed = renameSelectionSet(sets, set.id, ' 底面 ');
    if (!renamed.ok) {
      throw new Error('名前を変えられるはず');
    }
    expect(findSelectionSet(renamed.sets, set.id)?.name).toBe('底面');
    const refused = renameSelectionSet(sets, set.id, '   ');
    expect(refused.ok).toBe(false);
    const unknown = renameSelectionSet(sets, 'selectionSet-9', '別名');
    expect(unknown.ok && unknown.sets).toBe(sets);
  });

  it('消えたボディを指す要素は外れ、セットそのものは残る(§2.13、FR-504)', () => {
    const { sets } = expectCreated([], '上面', [
      faceMember('extrude-1', 2),
      bodyMember('extrude-1'),
      faceMember('消えた立体', 1),
    ]);
    const pruned = pruneSelectionSets(sets, ['extrude-1']);
    expect(pruned.removedCount).toBe(1);
    expect(pruned.sets).toHaveLength(1);
    expect(pruned.sets[0].members).toHaveLength(2);
  });

  it('外すものが無ければ掃除は元の配列を同一参照のまま返す', () => {
    const { sets } = expectCreated([], '上面', threeFaces());
    const pruned = pruneSelectionSets(sets, ['extrude-1']);
    expect(pruned.removedCount).toBe(0);
    expect(pruned.sets).toBe(sets);
  });

  it('要素の同一判定は外観の判定とは別物(利用者の決定 2026-09-06 で型を分けた)', () => {
    // 借り物ではなく `selectionSets.ts` が持つ判定。外観の判定は辺・頂点を知らない。
    expect(isSameSelectionMember).not.toBe(isSameAppearanceTarget);
    expect(isSameSelectionMember(faceMember('extrude-1', 2), faceMember('extrude-1', 2))).toBe(true);
    expect(isSameSelectionMember(faceMember('extrude-1', 2), bodyMember('extrude-1'))).toBe(false);
  });

  it('辺・頂点も立体・面と同じく同一判定できる(FR-112。外観の判定では偽になる)', () => {
    expect(isSameSelectionMember(edgeMember('extrude-1', 5), edgeMember('extrude-1', 5))).toBe(true);
    expect(isSameSelectionMember(edgeMember('extrude-1', 5), edgeMember('extrude-1', 6))).toBe(
      false,
    );
    expect(isSameSelectionMember(vertexMember('extrude-1', 0), vertexMember('extrude-1', 0))).toBe(
      true,
    );
    // 種類が違えば別物(同じボディ・同じ通し番号でも面と辺は別)。
    expect(isSameSelectionMember(faceMember('extrude-1', 5), edgeMember('extrude-1', 5))).toBe(
      false,
    );
    expect(isSameSelectionMember(edgeMember('extrude-1', 0), vertexMember('extrude-1', 0))).toBe(
      false,
    );
    // 外観の判定を借りていたら、辺どうしが同じでも偽になっていた(型を分けた理由)。
    const asAppearanceTargets: readonly AppearanceTarget[] = [
      { kind: 'face', ref: faceRef('extrude-1', 5) },
      { kind: 'face', ref: faceRef('extrude-1', 5) },
    ];
    expect(isSameAppearanceTarget(asAppearanceTargets[0], asAppearanceTargets[1])).toBe(true);
  });

  it('辺 3 本を選んで名前を付けられる(選択フィルタの 4 種と対になる。§0.a-0.43)', () => {
    const { set } = expectCreated([], '上の縁', [
      edgeMember('extrude-1', 0),
      edgeMember('extrude-1', 1),
      edgeMember('extrude-1', 2),
    ]);
    expect(set.members).toHaveLength(3);
    expect(set.members.every((member) => member.kind === 'edge')).toBe(true);
  });

  it('4 種類(立体・面・辺・頂点)を 1 つのセットに混ぜられる', () => {
    const { set } = expectCreated([], '混ぜた組', [
      bodyMember('extrude-1'),
      faceMember('extrude-1', 2),
      edgeMember('extrude-1', 5),
      vertexMember('extrude-1', 7),
    ]);
    expect(set.members.map((member) => member.kind)).toEqual(['body', 'face', 'edge', 'vertex']);
  });

  it('同じ辺・同じ頂点を 2 回入れても 1 件になる(重複除去が 4 種類に効く)', () => {
    const { set } = expectCreated([], '縁', [
      edgeMember('extrude-1', 5),
      edgeMember('extrude-1', 5),
      vertexMember('extrude-1', 7),
      vertexMember('extrude-1', 7),
    ]);
    expect(set.members).toHaveLength(2);
  });

  it('辺・頂点も後から足せて、外せる(種類を問わない純関数)', () => {
    const { sets, set } = expectCreated([], '縁', [faceMember('extrude-1', 2)]);
    const added = addSelectionSetMembers(sets, set.id, [
      edgeMember('extrude-1', 5),
      vertexMember('extrude-1', 7),
    ]);
    expect(findSelectionSet(added, set.id)?.members).toHaveLength(3);
    const removed = removeSelectionSetMembers(added, set.id, [vertexMember('extrude-1', 7)]);
    expect(findSelectionSet(removed, set.id)?.members.map((member) => member.kind)).toEqual([
      'face',
      'edge',
    ]);
  });

  it('消えたボディを指す辺・頂点も外れ、セットは残る(§2.13、FR-504)', () => {
    const { sets } = expectCreated([], '混ぜた組', [
      edgeMember('extrude-1', 5),
      vertexMember('extrude-1', 7),
      edgeMember('消えた立体', 0),
      vertexMember('消えた立体', 1),
      bodyMember('消えた立体'),
    ]);
    const pruned = pruneSelectionSets(sets, ['extrude-1']);
    expect(pruned.removedCount).toBe(3);
    expect(pruned.sets).toHaveLength(1);
    expect(pruned.sets[0].members.map((member) => member.kind)).toEqual(['edge', 'vertex']);
  });

  it('部分形状の員は判別子と指紋の種類がそろう(io がこの前提で読み書きする)', () => {
    const { set } = expectCreated([], '混ぜた組', [
      faceMember('extrude-1', 2),
      edgeMember('extrude-1', 5),
      vertexMember('extrude-1', 7),
    ]);
    for (const member of set.members) {
      if (member.kind === 'body') {
        throw new Error('この組に立体は入れていない');
      }
      expect(member.ref.fingerprint.kind).toBe(member.kind);
    }
  });

  it('辺・頂点だけのセットを変えても形に影響しない(affectsShape が偽)', () => {
    const document = createEmptyPartDocument();
    const { sets } = expectCreated(document.selectionSets, '縁と角', [
      edgeMember('extrude-1', 5),
      vertexMember('extrude-1', 7),
    ]);
    expect(affectsShape(document, { ...document, selectionSets: sets })).toBe(false);
  });

  it('起動時の部品は選択セットを 1 つも持たない', () => {
    expect(createEmptyPartDocument().selectionSets).toEqual([]);
  });

  it('選択セットだけを変えても形に影響しない(affectsShape が偽。§0.a-0.44)', () => {
    const document = createEmptyPartDocument();
    const { sets } = expectCreated(document.selectionSets, '上面', threeFaces());
    const next = { ...document, selectionSets: sets };
    expect(affectsShape(document, next)).toBe(false);
    // 名前を変えても、要素を足しても、消しても同じ(再計算を起こさない)。
    const renamed = renameSelectionSet(sets, sets[0].id, '底面');
    expect(renamed.ok).toBe(true);
    expect(
      affectsShape(next, { ...next, selectionSets: renamed.ok ? renamed.sets : sets }),
    ).toBe(false);
    expect(affectsShape(next, { ...next, selectionSets: removeSelectionSet(sets, sets[0].id) })).toBe(
      false,
    );
  });
});
