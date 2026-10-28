import { isNumericLiteral } from '@pointercad/expression';
import type { SketchDocument } from '../types.js';
import type { LinearizedRow } from './solve.js';
import type { SketchConstraint } from './types.js';
import { canonicalPointKey, constraintPointKey, pointComponentKey, pointValueAt, type VariableSet } from './variables.js';

interface Edge {
  readonly a: string;
  readonly b: string;
  readonly direction: readonly [number, number];
}

// A conservative rank screen, not a relaxation of any residual tolerance. Near-parallel
// directions go through the unchanged solver instead of claiming rigidity from roundoff.
function independent(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] * b[1] - a[1] * b[0]) > Math.sqrt(Number.EPSILON);
}

/**
 * A sufficient (not necessary) certificate of only two translational freedoms. Fix one
 * point of a pair with independent constraints. Every further point needs two independent
 * directions to already fixed points. Induction fixes its two infinitesimal coordinates.
 * A flexible tree or a distance-only rotating body is deliberately not certified.
 */
function translationOnly(edges: readonly Edge[], component: ReadonlySet<string>): boolean {
  const adjacency = new Map<string, Edge[]>(), pairs = new Map<string, Edge>();
  let anchor: string | null = null;
  for (const edge of edges) {
    if (!component.has(edge.a)) continue;
    for (const key of [edge.a, edge.b]) {
      const group = adjacency.get(key) ?? []; group.push(edge); adjacency.set(key, group);
    }
    const pair = JSON.stringify([edge.a, edge.b].sort());
    const first = pairs.get(pair);
    if (first === undefined) pairs.set(pair, edge);
    else if (independent(first.direction, edge.direction)) anchor ??= edge.a;
  }
  if (anchor === null) return false;
  const fixed = new Set([anchor]), queue = [anchor], directions = new Map<string, readonly [number, number]>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const edge of adjacency.get(current) ?? []) {
      const next = edge.a === current ? edge.b : edge.a;
      if (fixed.has(next)) continue;
      const first = directions.get(next);
      if (first === undefined) directions.set(next, edge.direction);
      else if (independent(first, edge.direction)) { fixed.add(next); queue.push(next); }
    }
  }
  return fixed.size === component.size;
}

/** Internal initial-value optimization; never exported from the model package. Null means
 * use the exact old initial vector. No constraint, soft pin, solve cap or output is changed.
 * Only literal point geometry with a single pin and a translation-only nonlinear component
 * is eligible. Both the written shape and the candidate must pass the original evaluator.
 */
export function dragTranslationSeed(
  document: SketchDocument,
  variables: VariableSet,
  constraints: readonly SketchConstraint[],
  pinned: ReadonlyMap<string, readonly [number, number]>,
  evaluate: (x: readonly number[]) => readonly LinearizedRow[],
  tolerance: number,
): readonly number[] | null {
  if (pinned.size !== 1 || !(tolerance > 0) || !Number.isFinite(tolerance)
    || variables.frozen.size !== 0 || variables.followsBase.size !== 0 || variables.implicit.length !== 0
    || variables.variables.length !== document.features.length * 2
    || new Set(document.features.map(feature => feature.id)).size !== document.features.length
    || document.features.some(feature => feature.kind !== 'point' || feature.at.mode !== 'absolute'
      || ![feature.at.x, feature.at.y, feature.at.z].every(value => isNumericLiteral(value.source)))
    || !variables.initial.every(Number.isFinite)) return null;
  const pin = [...pinned][0], key = canonicalPointKey(variables, pin[0]);
  const origin = key === null ? null : pointValueAt(variables, variables.initial, key);
  if (key === null || origin === null || !pin[1].every(Number.isFinite)) return null;
  const delta = [pin[1][0] - origin[0], pin[1][1] - origin[1]] as const;
  const edges: Edge[] = [], adjacency = new Map<string, string[]>();
  let nonlinear = false;
  for (const constraint of constraints) {
    if ((constraint.kind !== 'distance' && constraint.kind !== 'horizontalDistance' && constraint.kind !== 'verticalDistance')
      || !isNumericLiteral(constraint.length.source) || !Number.isFinite(constraint.length.value)) return null;
    const a = constraintPointKey(variables, constraint.a), b = constraintPointKey(variables, constraint.b);
    if (a === null || b === null || a === b) return null;
    const p = pointValueAt(variables, variables.initial, a), q = pointValueAt(variables, variables.initial, b);
    if (p === null || q === null) return null;
    const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || (constraint.kind === 'distance' && length === 0)) return null;
    const direction: readonly [number, number] = constraint.kind === 'distance' ? [dx / length, dy / length]
      : constraint.kind === 'horizontalDistance' ? [1, 0] : [0, 1];
    edges.push({ a, b, direction });
    for (const [first, second] of [[a, b], [b, a]]) {
      const group = adjacency.get(first) ?? []; group.push(second); adjacency.set(first, group);
    }
    nonlinear ||= constraint.kind === 'distance';
  }
  // Linear-only sketches retain the existing linear-work/cancellation path.
  if (!nonlinear) return null;
  const component = new Set([key]), queue = [key];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of adjacency.get(queue[index]) ?? []) if (!component.has(next)) { component.add(next); queue.push(next); }
  }
  if (!translationOnly(edges, component)) return null;
  const initialRows = evaluate(variables.initial);
  // Each supported constraint must contribute exactly one row; a skipped equation is not evidence.
  if (initialRows.length !== constraints.length + 2
    || initialRows.slice(0, constraints.length).some(row => !Number.isFinite(row.value) || Math.abs(row.value) >= tolerance)) return null;
  const candidate = [...variables.initial];
  for (const point of component) {
    for (const [axis, shift] of [['u', delta[0]], ['v', delta[1]]] as const) {
      const column = variables.index.get(pointComponentKey(point, axis));
      if (column === undefined) return null;
      const old = candidate[column], next = old + shift;
      // Reject magnitudes whose arithmetic spacing could consume the residual budget.
      if (!Number.isFinite(next) || Math.max(Math.abs(old), Math.abs(next), Math.abs(shift)) * Number.EPSILON >= tolerance / 8
        || Math.abs((next - old) - shift) >= tolerance) return null;
      candidate[column] = next;
    }
  }
  const placed = pointValueAt(variables, candidate, key);
  if (placed === null || Math.abs(placed[0] - pin[1][0]) >= tolerance || Math.abs(placed[1] - pin[1][1]) >= tolerance) return null;
  const rows = evaluate(candidate);
  return rows.length === initialRows.length
    && rows.every(row => Number.isFinite(row.value) && Math.abs(row.value) < tolerance
      && [...row.gradient.values()].every(Number.isFinite)) ? candidate : null;
}
