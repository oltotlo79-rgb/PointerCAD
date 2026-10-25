import { describe, expect, it } from 'vitest';
import { assertDisjointTrimCorridors, type TrimChord } from './analyticTrimCorridorsR4.js';
import { buildTrimIntervalInventory, sharedTake, nativePrimitiveForInjectivity, type B08Occurrence, type B08WireChain } from './boundary08Adapter.js';

// AUTHOR-ONLY, UNEXECUTED. Root executes. Hand-derived expectations; no production oracle.
const tick = (): void => undefined;
const budget = { take: (): void => undefined };

function directed(occurrence: number, other: number, origin: readonly [number, number], end: readonly [number, number],
  reverse: boolean, m = 0.8): TrimChord {
  return { occurrence, interval: 0, from: reverse ? other : 0, to: reverse ? 0 : other, a: reverse ? end : origin,
    b: reverse ? origin : end, secondDerivativeBound: m, parameterLength: 1 };
}

describe('corridors R4: one immutable coordinate per node id (Astra ef1ed08f)', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]] as const)(
    'refuses node 0 at (0,0) in one chord and (3,0) in the other (p reverse=%s, q reverse=%s)', (rp, rq) => {
      const p = directed(0, 1, [0, 0], [4, 0], rp);
      const q = directed(1, 2, [3, 0], [4, 4], rq);
      expect(() => assertDisjointTrimCorridors([p, q], tick, budget)).toThrow('unequal exact coordinates');
    });

  it('keeps an ordinary acute junction sharing the canonical node (radius = shorter chord / 2 = 2)', () => {
    const radius = assertDisjointTrimCorridors([directed(0, 1, [0, 0], [4, 0], false), directed(1, 2, [0, 0], [4, 4], true)], tick, budget).get(0);
    expect(radius).toBeGreaterThanOrEqual(2);
    expect(radius).toBeLessThan(3);
  });

  it('partial obligation only: an admitted acute pair may still have curves meeting again inside the endpoint disk', () => {
    // p(t)=t(2,-1)+(3/5)t(1-t)(1,2), q(t)=t(2,1)+(3/5)t(1-t)(1,-2) meet at t=1/6 in (5/12, 0); M=3 bounds |p''|,|q''|.
    const radius = assertDisjointTrimCorridors([directed(0, 1, [0, 0], [2, -1], false, 3), directed(1, 2, [0, 0], [2, 1], false, 3)], tick, budget).get(0);
    expect(radius).toBeGreaterThan(5 / 12); // the second meeting lies in the disk: endpoint-cone/coverage proof still required
  });
});

const occurrence = (segmentIndex: number, edgeIndex: number, first: number, last: number, forward = true): B08Occurrence => ({
  faceIndex: 0, wireIndex: 0, segmentIndex, edgeIndex, firstVertex: 0, lastVertex: 1, first, last, forward, faceForward: true });

describe('boundary-08 adapter: native occurrence + interval inventory', () => {
  it('one native use with two polygon intervals gives two trim rows with one occurrence id and its native range', () => {
    const wires: B08WireChain[] = [{ localNodes: [0, 1, 2], segments: [{ localNodes: [0, 1, 2], forward: true,
      trim: { edgeIndex: 0, parameters: [0, 0.5, 1], secondDerivativeBoundUv: 0 }, identity: occurrence(0, 5, 0, 1) }] }];
    const inventory = buildTrimIntervalInventory(0, wires, tick);
    expect(inventory.rows.map(row => row.key)).toEqual(['0:0:0:5#0', '0:0:0:5#1']);
    expect(inventory.boundary.get('0:1')).toEqual({ kind: 'trim', occurrence: 0, interval: [0, 0.5] });
    expect(inventory.boundary.get('1:2')).toEqual({ kind: 'trim', occurrence: 0, interval: [0.5, 1] });
    expect(inventory.trimRanges.get(0)).toEqual([0, 1]);
    expect(inventory.occurrenceTable.get(0)).toBe('0:0:0:5');
  });

  it('refuses an omitted interval, a missing identity and a misplaced occurrence tuple', () => {
    const base = { forward: true, trim: { edgeIndex: 0, parameters: [0, 1], secondDerivativeBoundUv: 0 } };
    expect(() => buildTrimIntervalInventory(0, [{ localNodes: [0, 1, 2], segments: [{ ...base, localNodes: [0, 1, 2], identity: occurrence(0, 5, 0, 1) }] }], tick))
      .toThrow('polygon nodes and parameters differ');
    expect(() => buildTrimIntervalInventory(0, [{ localNodes: [0, 1], segments: [{ ...base, localNodes: [0, 1] }] }], tick))
      .toThrow('without native occurrence identity');
    expect(() => buildTrimIntervalInventory(0, [{ localNodes: [0, 1], segments: [{ ...base, localNodes: [0, 1], identity: occurrence(3, 5, 0, 1) }] }], tick))
      .toThrow('differs from its actual wire position');
    expect(() => buildTrimIntervalInventory(0, [{ localNodes: [0, 1], segments: [{ ...base, localNodes: [0, 1], identity: occurrence(0, 5, 0, 2) }] }], tick))
      .toThrow('do not span the native edge use');
  });

  it('a seam edge used twice on one face gets the same canonical segment index on both lifts', () => {
    const seamUse = (segmentIndex: number, nodes: number[], forward: boolean, parameters: number[]) => ({ localNodes: nodes, forward,
      trim: { edgeIndex: segmentIndex, parameters, secondDerivativeBoundUv: 0 }, identity: occurrence(segmentIndex, 9, 0, 2, forward) });
    // Stored arrays increase on both lifts; only the second occurrence traverses them backwards.
    const wires: B08WireChain[] = [{ localNodes: [0, 1, 2, 3, 4, 5], segments: [seamUse(0, [0, 1, 2], true, [0, 1, 2]), seamUse(1, [5, 4, 3], false, [0, 1, 2])] }];
    const inventory = buildTrimIntervalInventory(0, wires, tick);
    expect(inventory.boundary.get('0:1')).toEqual({ kind: 'seam', seamEdge: 9, segment: 0 });
    expect(inventory.boundary.get('4:5')).toEqual({ kind: 'seam', seamEdge: 9, segment: 0 });
    expect(inventory.boundary.get('3:4')).toEqual({ kind: 'seam', seamEdge: 9, segment: 1 });
  });

  it('uses actual producer storage on a reversed native edge without conflating local and shape identities', () => {
    const segment = { localNodes: [10, 11, 12], forward: false,
      trim: { edgeIndex: 0, parameters: [2, 3, 8], secondDerivativeBoundUv: 0 }, identity: occurrence(0, 47, 2, 8, false) };
    const input: B08WireChain[] = [{ localNodes: [12, 11, 10], segments: [segment] }];
    const inventory = buildTrimIntervalInventory(0, input, tick);
    expect(inventory.rows.map(({ key, from, to, start, end }) => ({ key, from, to, start, end }))).toEqual([
      { key: '0:0:0:47#0', from: 11, to: 10, start: 3, end: 2 },
      { key: '0:0:0:47#1', from: 12, to: 11, start: 8, end: 3 },
    ]);
    expect(inventory.trimRanges.get(0)).toEqual([8, 2]);
    expect(inventory.boundary.get('12:11')).toEqual({ kind: 'trim', occurrence: 0, interval: [8, 3] });
    expect(segment.localNodes).toEqual([10, 11, 12]);
    expect(segment.trim.parameters).toEqual([2, 3, 8]);
    for (const parameters of [[8, 3, 2], [2, 3, 7]]) {
      expect(() => buildTrimIntervalInventory(0, [{ ...input[0], segments: [{ ...segment,
        trim: { ...segment.trim, parameters } }] }], tick)).toThrow('do not span the native edge use');
    }
    for (const parameters of [[2, 9, 8], [2, Number.NaN, 8], [2, 2, 8]]) {
      expect(() => buildTrimIntervalInventory(0, [{ ...input[0], segments: [{ ...segment,
        trim: { ...segment.trim, parameters } }] }], tick)).toThrow('invalid native polygon storage order');
    }
    expect(() => buildTrimIntervalInventory(0, [{ ...input[0], segments: [{ ...segment,
      trim: { ...segment.trim, edgeIndex: 47 } }] }], tick)).toThrow('differs from its actual wire position');
    expect(() => buildTrimIntervalInventory(0, [{ ...input[0], segments: [{ ...segment,
      identity: { ...segment.identity, forward: true } }] }], tick)).toThrow('differs from its actual wire position');
  });

  it('charges take(n) to the one shared consume() counter and refuses invalid requests', () => {
    let used = 0;
    const shared = { consume: (): void => { if (used >= 5) throw new Error('certificate-limit'); used += 1; }, used: () => used };
    sharedTake(shared).take(3);
    expect(shared.used()).toBe(3);
    expect(() => sharedTake(shared).take(3)).toThrow('certificate-limit');
    expect(() => sharedTake(shared).take(-1)).toThrow('invalid budget request');
  });

  it('uses actual primitive parameters: nonregular torus and cone without native angle are refused', () => {
    expect(() => nativePrimitiveForInjectivity({ kind: 'torus', scale: 1, majorRadius: 1, minorRadius: 1 }, null)).toThrow('nonregular torus');
    expect(() => nativePrimitiveForInjectivity({ kind: 'cone', scale: 1, referenceRadius: 1 }, null)).toThrow('without actual native angle');
    expect(nativePrimitiveForInjectivity({ kind: 'cone', scale: 1, referenceRadius: 1 }, 0.5)).toEqual({ kind: 'cone', referenceRadius: 1, semiAngle: 0.5 });
  });
});
