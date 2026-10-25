/**
 * boundary-08 -> R2 cover/corridor adapter (AUTHOR-ONLY, UNEXECUTED; Astra REVIEW e502eaee sections 2-4).
 * Structural mirrors of the boundary-08 declarations are restated locally (no peer import); Root wires the real types.
 * Required order inside bindAnalyticNativeChain, on the SAME meshed copy before owner release:
 *   1. existing readAnalyticSurfaceGeometry (keeps majorRadius > minorRadius > 0) and readAnalyticFaceChart/WireChains;
 *   2. existing validateAnalyticUvComplex(chart.uvNodes, chart.localTriangles, wires.localNodes) - MANDATORY, unchanged;
 *   3. buildTrimIntervalInventory below (expected inventory derived from the actual wires, never from a caller Map);
 *   4. assertLiftedChartCoverR2 / assertDisjointTrimCorridorsR2 with sharedTake(budget) (one counter per attempt).
 * Output is a partial obligation result only; it never sets geometricallyClosed/material/topology/certificate flags.
 */

export interface B08Occurrence {
  readonly faceIndex: number; readonly wireIndex: number; readonly segmentIndex: number; readonly edgeIndex: number;
  readonly firstVertex: number; readonly lastVertex: number; readonly first: number; readonly last: number;
  readonly forward: boolean; readonly faceForward: boolean;
}
export interface B08WireChain {
  readonly localNodes: readonly number[];
  readonly segments: readonly {
    /** Native increasing-parameter storage order, regardless of traversal orientation. */
    readonly localNodes: readonly number[];
    readonly forward: boolean;
    /** edgeIndex here is the wire-local segment ordinal; identity.edgeIndex is the native shape identity. */
    readonly trim: { readonly edgeIndex: number; readonly parameters: readonly number[]; readonly secondDerivativeBoundUv: number };
    readonly identity?: B08Occurrence;
  }[];
}
export interface B08CellBudget { consume(): void; used(): number }

/** One row per actual native polygon interval: native occurrence tuple PLUS interval index (Astra section 2). */
export interface TrimIntervalRow {
  readonly key: string;
  readonly occurrence: B08Occurrence;
  readonly interval: number;
  readonly from: number;
  readonly to: number;
  readonly start: number;
  readonly end: number;
  readonly seam: boolean;
}

export interface TrimIntervalInventory {
  readonly rows: readonly TrimIntervalRow[];
  /** Opaque integer -> native tuple key, bijective (retained for audit). */
  readonly occurrenceTable: ReadonlyMap<number, string>;
  /** Directed chart edge "from:to" -> class for assertLiftedChartCoverR2. Pole edges are NOT produced here. */
  readonly boundary: ReadonlyMap<string, { kind: 'trim'; occurrence: number; interval: readonly [number, number] }
    | { kind: 'seam'; seamEdge: number; segment: number }>;
  readonly trimRanges: ReadonlyMap<number, readonly [number, number]>;
}

export function buildTrimIntervalInventory(faceIndex: number, wires: readonly B08WireChain[], checkpoint: () => void): TrimIntervalInventory {
  const rows: TrimIntervalRow[] = [];
  const edgeUses = new Map<number, number>();
  for (const wire of wires) for (const segment of wire.segments) {
    const id = segment.identity;
    if (id === undefined) throw new Error('b08-adapter: segment without native occurrence identity');
    edgeUses.set(id.edgeIndex, (edgeUses.get(id.edgeIndex) ?? 0) + 1);
  }
  wires.forEach((wire, wireIndex) => {
    wire.segments.forEach((segment, segmentIndex) => {
      checkpoint();
      const id = segment.identity;
      if (id === undefined) throw new Error('b08-adapter: segment without native occurrence identity');
      if (id.faceIndex !== faceIndex || id.wireIndex !== wireIndex || id.segmentIndex !== segmentIndex || segment.trim.edgeIndex !== segmentIndex
        || !Number.isSafeInteger(id.edgeIndex) || id.edgeIndex < 0 || typeof segment.forward !== 'boolean'
        || id.forward !== segment.forward) throw new Error('b08-adapter: occurrence tuple differs from its actual wire position');
      const nodes = segment.localNodes, params = segment.trim.parameters;
      if (nodes.length < 2 || nodes.length !== params.length) throw new Error('b08-adapter: polygon nodes and parameters differ');
      if (!Number.isFinite(id.first) || !Number.isFinite(id.last) || !(id.first < id.last)
        || params[0] !== id.first || params[params.length - 1] !== id.last) {
        throw new Error('b08-adapter: polygon parameters do not span the native edge use');
      }
      for (let k = 0; k < params.length; k += 1) {
        if (!Object.hasOwn(params, k) || !Object.hasOwn(nodes, k) || !Number.isFinite(params[k])
          || !Number.isSafeInteger(nodes[k]) || nodes[k] < 0 || (k > 0 && !(params[k - 1] < params[k]))) {
          throw new Error('b08-adapter: invalid native polygon storage order');
        }
      }
      const uses = edgeUses.get(id.edgeIndex) ?? 0;
      if (uses !== 1 && uses !== 2) throw new Error('b08-adapter: edge used more than twice on one face');
      for (let k = 0; k + 1 < nodes.length; k += 1) {
        const tuple = `${id.faceIndex}:${id.wireIndex}:${id.segmentIndex}:${id.edgeIndex}`;
        // Match boundAnalyticWireRibbons: keep native interval identity, orient only the emitted traversal.
        const from = segment.forward ? k : k + 1, to = segment.forward ? k + 1 : k;
        rows.push({ key: `${tuple}#${k}`, occurrence: id, interval: k, from: nodes[from], to: nodes[to], start: params[from], end: params[to], seam: uses === 2 });
      }
    });
  });
  if (new Set(rows.map(row => row.key)).size !== rows.length) throw new Error('b08-adapter: duplicate interval key');
  const occurrenceIds = new Map<string, number>(), occurrenceTable = new Map<number, string>();
  const boundary = new Map<string, { kind: 'trim'; occurrence: number; interval: readonly [number, number] } | { kind: 'seam'; seamEdge: number; segment: number }>();
  const trimRanges = new Map<number, readonly [number, number]>();
  // Seam segment index: canonical increasing-parameter interval order of the native edge (identical for both lifts).
  const seamIntervals = new Map<number, number[][]>();
  for (const row of rows.filter(r => r.seam)) {
    const lo = Math.min(row.start, row.end), hi = Math.max(row.start, row.end);
    const list = seamIntervals.get(row.occurrence.edgeIndex) ?? [];
    if (!list.some(([a, b]) => a === lo && b === hi)) list.push([lo, hi]);
    seamIntervals.set(row.occurrence.edgeIndex, list);
  }
  for (const list of seamIntervals.values()) list.sort((a, b) => a[0] - b[0]);
  for (const row of rows) {
    const directed = `${row.from}:${row.to}`;
    if (boundary.has(directed)) throw new Error('b08-adapter: two native intervals claim one directed chart edge');
    if (row.seam) {
      const list = seamIntervals.get(row.occurrence.edgeIndex) ?? [];
      const lo = Math.min(row.start, row.end), hi = Math.max(row.start, row.end);
      const segment = list.findIndex(([a, b]) => a === lo && b === hi);
      if (segment < 0) throw new Error('b08-adapter: seam interval missing from canonical list');
      boundary.set(directed, { kind: 'seam', seamEdge: row.occurrence.edgeIndex, segment });
      continue;
    }
    const tuple = row.key.slice(0, row.key.indexOf('#'));
    let id = occurrenceIds.get(tuple);
    if (id === undefined) {
      id = occurrenceIds.size;
      occurrenceIds.set(tuple, id);
      occurrenceTable.set(id, tuple);
      const o = row.occurrence;
      trimRanges.set(id, o.forward ? [o.first, o.last] : [o.last, o.first]);
    }
    boundary.set(directed, { kind: 'trim', occurrence: id, interval: [row.start, row.end] });
  }
  return { rows, occurrenceTable, boundary, trimRanges };
}

/** Bridge take(n) onto the ONE existing 32-per-triangle counter (Astra section 4.3); never a fresh per-face budget. */
export function sharedTake(budget: B08CellBudget): { take(cells: number): void } {
  return {
    take(cells: number): void {
      if (!Number.isSafeInteger(cells) || cells < 0) throw new Error('b08-adapter: invalid budget request');
      for (let unit = 0; unit < cells; unit += 1) budget.consume();
    },
  };
}

/** Actual native primitive parameters for the cone apex / torus checks (never the kind string alone). */
export function nativePrimitiveForInjectivity(surface: { kind: string; scale: number; referenceRadius?: number; majorRadius?: number; minorRadius?: number },
  coneSemiAngle: number | null): { kind: 'plane' | 'cylinder' | 'sphere' | 'torus' } | { kind: 'cone'; referenceRadius: number; semiAngle: number } {
  if (surface.scale !== 1) throw new Error('b08-adapter: scaled primitive');
  switch (surface.kind) {
    case 'plane': case 'cylinder': case 'sphere': return { kind: surface.kind };
    case 'torus': {
      const major = surface.majorRadius, minor = surface.minorRadius;
      if (major === undefined || minor === undefined || !(minor > 0) || !(major > minor) || !Number.isFinite(major)) {
        throw new Error('b08-adapter: nonregular torus');
      }
      return { kind: 'torus' };
    }
    case 'cone': {
      if (coneSemiAngle === null || surface.referenceRadius === undefined || !Number.isFinite(surface.referenceRadius)) {
        throw new Error('b08-adapter: cone without actual native angle/radius');
      }
      return { kind: 'cone', referenceRadius: surface.referenceRadius, semiAngle: coneSemiAngle };
    }
    default: throw new Error('b08-adapter: unsupported primitive ' + surface.kind);
  }
}
