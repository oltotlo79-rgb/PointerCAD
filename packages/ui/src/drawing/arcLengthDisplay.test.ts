import type { ResolvedDimensionTarget } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { arcLengthSweep } from './arcLengthDisplay.js';

type ArcTarget = Extract<ResolvedDimensionTarget, { readonly kind: 'circle' | 'arc' }>;
const arc: ArcTarget = { kind: 'arc', center: [0, 0, 0], axis: [0, 0, 1], radius: 10, length: Math.PI * 5,
  from: [10, 0, 0], to: [0, 10, 0], paperCenter: [0, 0], paperFrom: [10, 0], paperTo: [0, 10] };
describe('実形状から弧長寸法の向きを決める', () => {
  it('同じ両端の小弧と大弧を実寸の長さから区別する', () => {
    expect(arcLengthSweep(arc)?.sweep).toBeCloseTo(Math.PI / 2);
    expect(arcLengthSweep({ ...arc, length: Math.PI * 15 })?.sweep).toBeCloseTo(-Math.PI * 1.5);
  });
  it('半円は線の重心から上下を区別し、資料のない向きを推測しない', () => {
    const semicircle: ArcTarget = { ...arc, length: Math.PI * 10, to: [-10, 0, 0] };
    expect(arcLengthSweep({ ...semicircle, centroid: [0, 20 / Math.PI, 0] })?.sweep).toBeCloseTo(Math.PI);
    expect(arcLengthSweep({ ...semicircle, centroid: [0, -20 / Math.PI, 0] })?.sweep).toBeCloseTo(-Math.PI);
    expect(arcLengthSweep(semicircle)).toBeNull();
  });
  it('全円を0長さとせず、不整合な両端を拒む', () => {
    expect(arcLengthSweep({ ...arc, kind: 'circle', to: arc.from, length: 20 * Math.PI })?.sweep).toBeCloseTo(2 * Math.PI);
    expect(arcLengthSweep({ ...arc, to: [-10, 0, 0] })).toBeNull();
  });
});
