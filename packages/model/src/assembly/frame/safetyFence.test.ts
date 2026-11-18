/**
 * 平面から安全柵(E-12 第 1 段)の計画の検査: 辺ごとの等分・角の柱の共有・閉じる/開く・横の材の長さ(柱の面の間)・パネルの寸法と
 * 置き方・断る理由(区画の番号つき)・上限。期待は手で解いた値(柱・横の材とも断面 20×20〔半分 10〕、高さ 1200、横の材 100 と 1190)。
 */
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../sketch/vec3.js';
import { rotateVector } from '../placementMath.js';
import { planSafetyFence } from './safetyFence.js';

type SafetyFenceInput = Parameters<typeof planSafetyFence>[0];
/** 柱の数の上限(統括の決定 2026-11-18 15:2x の ③)。 */
const POST_LIMIT = 500;
const SECTION = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const RECTANGLE: readonly Vec3[] = [[0, 0, 0], [2000, 0, 0], [2000, 1000, 0], [0, 1000, 0]];
const INPUT: SafetyFenceInput = { points: RECTANGLE, closed: true, height: 1200, maxSpacing: 1000, post: SECTION, rail: SECTION,
  railHeights: [100, 1190], panel: { thickness: 3, gap: 0 }, foot: null };

function plan(input: Partial<SafetyFenceInput> = {}) {
  const result = planSafetyFence({ ...INPUT, ...input });
  if (!result.ok) throw new Error(`${result.reason} ${String(result.bay)}`);
  return result;
}

describe('安全柵の計画', () => {
  it('2000 × 1000 の囲い・間隔の上限 1000: 区画 6・柱 6(角 4 と長い辺の中 2)・横の材 12・パネル 6', () => {
    const result = plan();
    expect([result.bays, result.posts.length, result.rails.length, result.panels.length]).toEqual([6, 6, 12, 6]);
    expect(result.posts.map((post) => post.line.start)).toEqual([[0, 0, 0], [1000, 0, 0], [2000, 0, 0], [2000, 1000, 0], [1000, 1000, 0],
      [0, 1000, 0]]);
    expect(result.posts.every((post) => post.line.end[2] === 1200)).toBe(true);
  });

  it('等分の数は柱の間隔が上限以下になる最小の数(2000 は 2 区画、2001 は 3 区画)', () => {
    expect(plan({ points: [[0, 0, 0], [2000, 0, 0]], closed: false }).bays).toBe(2);
    const odd = plan({ points: [[0, 0, 0], [2001, 0, 0]], closed: false });
    expect(odd.bays).toBe(3);
    expect(odd.posts.map((post) => post.line.start[0])).toEqual([0, 667, 1334, 2001]);
  });

  it('横の材は柱の面の間(区画 0: 10〜990 の 980)で、高さごとに 1 本。開いた線は最後の点にも柱', () => {
    const result = plan({ points: [[0, 0, 0], [2000, 0, 0]], closed: false });
    expect(result.posts).toHaveLength(3);
    expect(result.rails.slice(0, 2)).toEqual([{ start: [10, 0, 100], end: [990, 0, 100] }, { start: [10, 0, 1190], end: [990, 0, 1190] }]);
  });

  it('パネル: 幅 980・高さ 1070(上下の横の材の面の間)、中心 (500, 0, 645) を板厚の半分だけ外へずらし、局所 X が辺・Y が上を向く', () => {
    const [panel] = plan().panels;
    expect([panel?.bay, panel?.width, panel?.height]).toEqual([0, 980, 1070]);
    // 辺 (1,0,0) に直交する水平の向きは (0,-1,0)。板は局所 +Z へ押し出すので、原点は中心から -(0,-1,0) × 1.5。
    expect(panel?.placement.position).toEqual([500, 1.5, 645]);
    const rotation = panel?.placement.rotation ?? [0, 0, 0, 1];
    expect(rotateVector(rotation, [1, 0, 0]).map((value) => Math.round(value * 1e9) / 1e9 + 0)).toEqual([1, 0, 0]);
    expect(rotateVector(rotation, [0, 1, 0]).map((value) => Math.round(value * 1e9) / 1e9 + 0)).toEqual([0, 0, 1]);
  });

  it('隙間は各辺から引く。パネル無しなら横の材だけ。柱の断面の向きは辺(角は前の辺)', () => {
    expect(plan({ panel: { thickness: 3, gap: 5 } }).panels[0]).toMatchObject({ width: 970, height: 1060 });
    expect(plan({ panel: null }).panels).toEqual([]);
    expect(plan().posts.map((post) => post.up)).toEqual([[0, -1, 0], [1, 0, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [-1, 0, 0]]);
  });

  it('足(第 2 段): 柱の下端を足の高さ 30 に上げ(長さ 1170)、柱の下の床の点に足を置く。横の材とパネルの高さは床から測るので変わらない', () => {
    const base = plan();
    const footed = plan({ foot: { height: 30 } });
    expect(footed.posts.map((post) => [post.line.start[2], post.line.end[2]])).toEqual(base.posts.map(() => [30, 1200]));
    expect(footed.feet).toEqual(base.posts.map((post) => post.line.start));
    expect(footed.rails).toEqual(base.rails);
    expect(footed.panels).toEqual(base.panels);
    expect(base.feet).toEqual([]);
    // 足の上端より下に出る横の材と、柱の高さ以上の足は断る。
    expect(planSafetyFence({ ...INPUT, foot: { height: 100 } })).toMatchObject({ reason: 'railOutOfRange' });
    expect(planSafetyFence({ ...INPUT, foot: { height: 1200 } })).toMatchObject({ reason: 'invalidNumber' });
  });

  it('第 3 段: 板の上限 900 × 2000 だと、長辺 2000 の区画は 980 幅が収まらないので 3 区画(幅 646.667)に分ける。高さが収まらない上限は分けない', () => {
    const base = plan();
    const split = plan({ panel: { thickness: 3, gap: 0, max: [900, 2000] } });
    // 長辺 2 本が 2 → 3 区画、短辺 2 本も 980 が 900 を超えるので 1 → 2 区画(幅 480)になり、区画は 6 → 10。
    expect([base.bays, split.bays]).toEqual([6, 10]);
    expect(split.panels.every((panel) => panel.width <= 900 || panel.height <= 900)).toBe(true);
    expect(plan({ panel: { thickness: 3, gap: 0, max: [500, 500] } }).bays).toBe(6);
  });

  it('第 3 段: 出入口の区画には横の材もパネルも置かない(柱は置く)', () => {
    const result = plan({ openBays: [1] });
    expect([result.posts.length, result.rails.length, result.panels.length]).toEqual([6, 10, 5]);
    expect(result.panels.map((panel) => panel.bay)).toEqual([0, 2, 3, 4, 5]);
  });

  it('断る: 点が足りない・数が正でない・長さ 0 の辺・柱の面の間が無い・横の材が柱の外・パネルの高さが無い・上限', () => {
    expect(planSafetyFence({ ...INPUT, points: [[0, 0, 0]] })).toEqual({ ok: false, reason: 'tooFewPoints', bay: null });
    expect(planSafetyFence({ ...INPUT, points: [[0, 0, 0], [10, 0, 0]], closed: true })).toMatchObject({ reason: 'tooFewPoints' });
    expect(planSafetyFence({ ...INPUT, height: 0 })).toMatchObject({ reason: 'invalidNumber' });
    expect(planSafetyFence({ ...INPUT, points: [[0, 0, 0], [0, 0, 5], [100, 0, 0]], closed: false })).toMatchObject({ reason: 'degenerateEdge' });
    expect(planSafetyFence({ ...INPUT, points: [[0, 0, 0], [15, 0, 0]], closed: false })).toEqual({ ok: false, reason: 'noRoom', bay: 0 });
    expect(planSafetyFence({ ...INPUT, railHeights: [5, 1190] })).toMatchObject({ reason: 'railOutOfRange' });
    expect(planSafetyFence({ ...INPUT, railHeights: [100, 120] })).toEqual({ ok: false, reason: 'noPanelRoom', bay: 0 });
    expect(planSafetyFence({ ...INPUT, points: [[0, 0, 0], [POST_LIMIT * 1000, 0, 0]], closed: false }))
      .toMatchObject({ reason: 'tooMany' });
  });
});
