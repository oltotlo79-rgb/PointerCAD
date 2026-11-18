import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber as value } from '@pointercad/expression';
import { arrangeBoltedJointSetPicks } from './pairBoltedJointHoles.js';
import { commitBoltedJointSet, previewBoltedJointSet } from './boltedJointSetCommand.js';
import { entryFixture } from './entryFastening.testSupport.js';
import type { FasteningGeometryContext, FasteningHolePick } from './bindHoleSelection.js';
import type { BoltedJointSetPicks } from './boltedJointSetTypes.js';

/*
 * まとめて締結する穴の組の自動の対応付け(J-02 第 3 の版)。4 穴の板 2 枚(穴の x は 0・25・50・75)。相手の板は x へ 100
 * ずらして置き、1 組目の整列で動く(整列を当てずに比べると、どの穴も組めない)。
 */
const MOVED = entryFixture(undefined, false, 100);

function picks(second: readonly FasteningHolePick[], first: readonly FasteningHolePick[] = MOVED.firstPicks): BoltedJointSetPicks {
  return { first, second, choices: MOVED.request };
}

function holeIndices(list: readonly FasteningHolePick[]): (number | undefined)[] {
  return list.map((pick) => pick.holeFace?.index);
}

/** 固定する部品を ids だけにする(組立の最初の部品は既定で固定なので、ids に無い部品の固定は外す)。 */
function fixed(context: FasteningGeometryContext, ids: readonly string[]): FasteningGeometryContext {
  return { ...context, document: { ...context.document, components: context.document.components.map((component) =>
    ({ ...component, fixed: ids.includes(component.id) })) } };
}

const [s0, s1, s2, s3] = MOVED.secondPicks;
if (s0 === undefined || s1 === undefined || s2 === undefined || s3 === undefined) throw new Error('fixture picks');

describe('相手側の穴を、1 組目で整列した後の同じ軸で組み合わせる', () => {
  it('相手側を逆の順で押しても、同じ軸の穴へ並べ替え、確定の記録も同じ軸の組になる', () => {
    const arranged = arrangeBoltedJointSetPicks(MOVED.context, picks([s0, s3, s2, s1]));
    if (!arranged.ok) throw new Error(JSON.stringify(arranged));
    expect(arranged.order).toEqual([0, 3, 2, 1]);
    expect(holeIndices(arranged.picks.second)).toEqual([0, 1, 2, 3]);
    const preview = previewBoltedJointSet(MOVED.context, arranged.picks);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const committed = commitBoltedJointSet(MOVED.context, arranged.picks, preview.plan);
    if (!committed.ok) throw new Error(JSON.stringify(committed));
    expect(committed.document.boltedJoints?.map((record) => [record.first.holeFace.index, record.second.holeFace.index]))
      .toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
  });

  it('1 組目の後の 3 穴の 6 通りの順が、どれも同じ組み合わせになる', () => {
    const orders = [[s1, s2, s3], [s1, s3, s2], [s2, s1, s3], [s2, s3, s1], [s3, s1, s2], [s3, s2, s1]];
    for (const rest of orders) {
      const arranged = arrangeBoltedJointSetPicks(MOVED.context, picks([s0, ...rest]));
      expect(arranged.ok && holeIndices(arranged.picks.second), JSON.stringify(holeIndices(rest))).toEqual([0, 1, 2, 3]);
    }
  });

  it('同じ軸の相手が無い頭側の穴は、その番号で断り、余った相手は重ねて出さない', () => {
    const arranged = arrangeBoltedJointSetPicks(MOVED.context, picks([s0, s1, s2, MOVED.unpairedSecondPick]));
    expect(arranged).toEqual({ ok: false, holes: [{ index: 3, rejections: [],
      entryRejections: [{ code: 'holePairMissing', detail: { side: 'first', index: 3 } }] }] });
  });

  it('同じ軸の相手が 2 つ(同じ穴を 2 回)・取り合い(頭側の同じ穴を 2 回)は、近さで選ばずに断る', () => {
    const twice = arrangeBoltedJointSetPicks(MOVED.context, picks([s0, s1, s1, s2]));
    expect(twice.ok ? null : twice.holes.map((hole) => [hole.index, hole.entryRejections[0]?.detail])).toEqual([
      [1, { side: 'first', index: 1, reason: 'ambiguous' }], [3, { side: 'first', index: 3 }]]);
    const [f0, f1, f2] = MOVED.firstPicks;
    if (f0 === undefined || f1 === undefined || f2 === undefined) throw new Error('fixture picks');
    const shared = arrangeBoltedJointSetPicks(MOVED.context, picks([s0, s1, s2, s3], [f0, f1, f1, f2]));
    expect(shared.ok ? null : shared.holes.map((hole) => [hole.index, hole.entryRejections[0]?.detail])).toEqual([
      [2, { side: 'first', index: 2, reason: 'shared' }]]);
  });

  it('数が違う・1 組目が断られる時は並べ替えず、一括の口が今の理由(組の数・1 組目の断り)を出す', () => {
    const uneven = picks([s0, s1, s2]);
    expect(arrangeBoltedJointSetPicks(MOVED.context, uneven)).toEqual({ ok: true, picks: uneven, order: [0, 1, 2] });
    expect(previewBoltedJointSet(MOVED.context, uneven)).toMatchObject({ ok: false, rejections: [{ code: 'holeCountMismatch' }] });
    const blocked = fixed(MOVED.context, ['component-1', 'component-2']), reversed = picks([s0, s3, s2, s1]);
    const kept = arrangeBoltedJointSetPicks(blocked, reversed);
    expect(kept.ok && kept.picks).toBe(reversed);
    const refused = previewBoltedJointSet(blocked, reversed);
    expect(refused.ok ? null : refused.holes[0]?.index).toBe(0);
  });

  it('固定の板が逆(頭側の板が動く)でも、同じ組み合わせになる', () => {
    const arranged = arrangeBoltedJointSetPicks(fixed(MOVED.context, ['component-2']), picks([s0, s3, s2, s1]));
    expect(arranged.ok && holeIndices(arranged.picks.second)).toEqual([0, 1, 2, 3]);
  });

  it('ざぐりの入口のある穴でも、軸の比べ方は同じ', () => {
    const bored = entryFixture({ kind: 'counterbore', diameter: value(14), depth: value(8) }, false, 100);
    const [b0, b1, b2, b3] = bored.secondPicks;
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) throw new Error('fixture picks');
    const arranged = arrangeBoltedJointSetPicks(bored.context, { first: bored.firstPicks, second: [b0, b2, b3, b1],
      choices: bored.request });
    expect(arranged.ok && holeIndices(arranged.picks.second)).toEqual([0, 1, 2, 3]);
  });
});
