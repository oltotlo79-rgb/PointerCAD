import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, type FemRequest } from './protocol.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256, tetraMeshResultMatches,
  TETRA_MESH_SCHEMA, PLANAR_TETRA_MESH_SCHEMA, type PlanarTetraMeshInput, type TetraMeshInput } from './tetraMesh.js';

const source = { documentId: 'part', revision: 4, featureId: 'solid', bodyKey: 'solid:4' };
const tetra = (): TetraMeshInput => ({ schema: TETRA_MESH_SCHEMA, source, units: 'mm',
  coordinates: [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4],
  triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3], tags: [0, 1, 2, 3], tagCount: 4 });
const wedge = (): TetraMeshInput => ({ schema: TETRA_MESH_SCHEMA, source, units: 'mm',
  coordinates: [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4, 0, 3, 4],
  triangles: [0, 2, 1, 3, 4, 5, 0, 1, 3, 1, 4, 3, 0, 3, 2, 2, 3, 5, 1, 2, 4, 2, 5, 4],
  tags: [0, 1, 2, 2, 3, 3, 4, 4], tagCount: 5 });
const box = (): TetraMeshInput => ({ schema: TETRA_MESH_SCHEMA, source, units: 'mm',
  coordinates: [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4, 2, 3, 4, 0, 3, 4],
  triangles: [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], tagCount: 6 });
function raw(input: TetraMeshInput, elements: readonly number[]) {
  return { coordinates: input.coordinates, tetrahedra: elements, boundaryTriangles: input.triangles, boundaryTags: input.tags };
}
const hash = 'a'.repeat(64);

describe('owned bounded native meshing controls', () => {
  const controls = () => ({ targetSizeMm: 0.75, grading: 0.2, maximumOptimizationPasses: 2,
    quality: { minimumMeanRatio: 0.2, maximumEdgeRatio: 10 } });
  it('preserves the absent-control input and owns both levels of explicit controls', async () => {
    const legacy = tetra();
    expect(readTetraMeshInput(legacy)).toEqual(legacy);
    expect(Object.hasOwn(readTetraMeshInput(legacy), 'meshing')).toBe(false);
    const meshing = controls(), input = readTetraMeshInput({ ...legacy, meshing });
    const inputHash = await tetraMeshInputSha256(input);
    meshing.targetSizeMm = 3; meshing.quality.minimumMeanRatio = 1;
    expect(input.meshing).toEqual(controls());
    expect(await tetraMeshInputSha256(input)).toBe(inputHash);
    expect(inputHash).not.toBe(await tetraMeshInputSha256(legacy));
    for (const changed of [{ ...controls(), targetSizeMm: 1 }, { ...controls(), grading: 0.3 },
      { ...controls(), maximumOptimizationPasses: 1 },
      { ...controls(), quality: { minimumMeanRatio: 0.3, maximumEdgeRatio: 10 } },
      { ...controls(), quality: { minimumMeanRatio: 0.2, maximumEdgeRatio: 9 } }]) {
      expect(await tetraMeshInputSha256({ ...legacy, meshing: changed })).not.toBe(inputHash);
    }
  });
  it('rejects unbounded, malformed and executable native settings at the strict input boundary', () => {
    const invalid: unknown[] = [undefined, null, {}, { ...controls(), targetSizeMm: 0 },
      { ...controls(), targetSizeMm: Infinity }, { ...controls(), grading: NaN },
      { ...controls(), grading: 0 }, { ...controls(), grading: 1.01 },
      { ...controls(), maximumOptimizationPasses: -1 }, { ...controls(), maximumOptimizationPasses: 4 },
      { ...controls(), maximumOptimizationPasses: 0.5 }, { ...controls(), optimize3d: 'cmdDmustm' },
      { ...controls(), quality: { minimumMeanRatio: -0.1, maximumEdgeRatio: 10 } },
      { ...controls(), quality: { minimumMeanRatio: 0.1, maximumEdgeRatio: Infinity } },
      { ...controls(), quality: { minimumMeanRatio: 0.1, maximumEdgeRatio: 10, accept: true } }];
    for (const meshing of invalid) expect(() => readTetraMeshInput({ ...tetra(), meshing })).toThrow('tetra-mesh:');
  });
  it('binds an otherwise identical valid mesh reply to the exact controls', async () => {
    const input = readTetraMeshInput({ ...tetra(), meshing: controls() });
    const expected = await tetraMeshInputSha256(input);
    const result = decodeTetraMesh(raw(input, [0, 1, 2, 3]), input, expected);
    expect(tetraMeshResultMatches(result, input, expected)).toBe(true);
    const different = readTetraMeshInput({ ...input, meshing: { ...controls(), maximumOptimizationPasses: 0 } });
    expect(tetraMeshResultMatches(result, different, await tetraMeshInputSha256(different))).toBe(false);
  });
});

/** Independent unit-cell geometry, not an output of the production mesher or
 * topology validator. Six explicit positive simplex pieces partition each cell.
 * Boundary quads come from absent neighboring cells, not from tetra face counts. */
function cellFixture(shape: 'L' | 'frame' | 'cavity') {
  const height = shape === 'cavity' ? 4 : 2;
  const occupied = (x: number, y: number, z: number): boolean => x >= 0 && x < 4 && y >= 0 && y < 4 && z >= 0 && z < height
    && (shape === 'L' ? x === 0 || y === 0
      : shape === 'frame' ? x === 0 || x === 3 || y === 0 || y === 3
        : x === 0 || x === 3 || y === 0 || y === 3 || z === 0 || z === 3);
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const sides = [
    { step: [-1, 0, 0], quad: [0, 4, 6, 2] }, { step: [1, 0, 0], quad: [1, 3, 7, 5] },
    { step: [0, -1, 0], quad: [0, 1, 5, 4] }, { step: [0, 1, 0], quad: [2, 6, 7, 3] },
    { step: [0, 0, -1], quad: [0, 2, 3, 1] }, { step: [0, 0, 1], quad: [4, 5, 7, 6] },
  ];
  const cells: number[][] = [];
  for (let x = 0; x < 4; x += 1) for (let y = 0; y < 4; y += 1) for (let z = 0; z < height; z += 1) {
    if (occupied(x, y, z)) cells.push([x, y, z]);
  }
  const coordinates: number[] = [], triangles: number[] = [], tags: number[] = [];
  const outer: number[] = [], cavity: number[] = [], nodes = new Map<string, number>();
  const node = (p: readonly number[]): number => {
    const key = p.join(','), existing = nodes.get(key);
    if (existing !== undefined) return existing;
    const index = coordinates.length / 3; nodes.set(key, index); coordinates.push(...p); return index;
  };
  let tag = 0;
  for (const [x, y, z] of cells) for (const { step, quad } of sides) {
    const neighbor = [x + step[0], y + step[1], z + step[2]];
    if (occupied(neighbor[0], neighbor[1], neighbor[2])) continue;
    const points = quad.map(i => node([x + corners[i][0], y + corners[i][1], z + corners[i][2]]));
    const members = shape === 'cavity' && neighbor.every(n => n >= 1 && n <= 2) ? cavity : outer;
    members.push(triangles.length / 3, triangles.length / 3 + 1);
    triangles.push(points[0], points[1], points[2], points[0], points[2], points[3]);
    tags.push(tag, tag); tag += 1;
  }
  const input: PlanarTetraMeshInput = { schema: PLANAR_TETRA_MESH_SCHEMA, source, units: 'mm',
    coordinates: coordinates.slice(), triangles, tags, tagCount: tag,
    shells: [{ role: 'outer', triangles: outer }, ...(cavity.length === 0 ? [] : [{ role: 'cavity' as const, triangles: cavity }])] };
  const tetrahedra: number[] = [];
  for (const [x, y, z] of cells) {
    const points = corners.map(c => node([x + c[0], y + c[1], z + c[2]]));
    for (const piece of [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]]) {
      tetrahedra.push(...piece.map(i => points[i]));
    }
  }
  return { input, output: { coordinates, tetrahedra, boundaryTriangles: triangles, boundaryTags: tags } };
}

describe('embedded planar PLC2 and positive tetrahedral material chain', () => {
  it.each([['L', 14], ['frame', 24], ['cavity', 56]] as const)(
    'qualifies %s against its independent analytic volume %i without using a convex hull', (shape, volume) => {
      const { input, output } = cellFixture(shape);
      const canonical = readTetraMeshInput(input);
      expect(canonical).toEqual(input);
      const result = decodeTetraMesh(output, canonical, hash);
      expect(result.kind).toBe('netgen-tetra-mesh');
      expect(result.volumeMm3).toBe(volume);
      expect(result.minTetVolumeMm3).toBe(1 / 6);
      expect(result.boundaryTriangles).toEqual(input.triangles);
      expect(result.boundaryTags).toEqual(input.tags);
      expect(result.tetrahedra.length / 4).toBe(6 * volume);
      const legacy = { schema: TETRA_MESH_SCHEMA, source, units: 'mm', coordinates: input.coordinates,
        triangles: input.triangles, tags: input.tags, tagCount: input.tagCount };
      expect(() => readTetraMeshInput(legacy)).toThrow(/nonconvex|inward/u);
    });
  it('rejects reversed cavity orientation even though the incorrect net volume would still be positive 72', () => {
    const { input } = cellFixture('cavity');
    const triangles = input.triangles.slice();
    for (const index of input.shells[1].triangles) [triangles[3 * index + 1], triangles[3 * index + 2]] =
      [triangles[3 * index + 2], triangles[3 * index + 1]];
    expect(() => readTetraMeshInput({ ...input, triangles })).toThrow(/orientation/u);
    expect(() => readTetraMeshInput({ ...input, shells: input.shells.map(shell => ({ ...shell, role: 'outer' })) })).toThrow(/outer/u);
  });
  it('rejects mismatched, sparse or forged shell partitions rather than trusting supplied roles', () => {
    const { input } = cellFixture('cavity');
    expect(() => readTetraMeshInput({ ...input, shells: input.shells.slice(0, 1) })).toThrow();
    expect(() => readTetraMeshInput({ ...input, shells: [...input.shells].reverse() })).toThrow(/membership/u);
    expect(() => readTetraMeshInput({ ...input, shells: [{ role: 'outer', triangles: input.shells[0].triangles,
      inferredVolume: 56 }, input.shells[1]] })).toThrow(/schema/u);
    const sparse = new Array<unknown>(input.shells.length);
    expect(() => readTetraMeshInput({ ...input, shells: sparse })).toThrow(/schema/u);
  });
  it('rejects a cavity translated outside or touching the outer surface at unchanged positive volumes', () => {
    const { input } = cellFixture('cavity');
    const innerNodes = new Set(input.shells[1].triangles.flatMap(i => input.triangles.slice(3 * i, 3 * i + 3)));
    for (const shift of [1, 1.5, 5]) {
      const coordinates = input.coordinates.map((n, i) => i % 3 === 0 && innerNodes.has(Math.floor(i / 3)) ? n + shift : n);
      expect(() => readTetraMeshInput({ ...input, coordinates })).toThrow(/intersect|nesting/u);
    }
  });
  it('retains the analytic L volume under an exact determinant-one shear and a large placement', () => {
    const { input, output } = cellFixture('L');
    const transform = (xyz: readonly number[]): number[] => xyz.flatMap((_, i) => i % 3 === 0
      ? [100000 + xyz[i] + xyz[i + 1] / 4, -200000 + xyz[i + 1] + xyz[i + 2] / 8, 300000 + xyz[i + 2]] : []);
    const placed = { ...input, coordinates: transform(input.coordinates) };
    const result = decodeTetraMesh({ ...output, coordinates: transform(output.coordinates) }, placed, hash);
    expect(result.volumeMm3).toBe(14);
    expect(result.minTetVolumeMm3).toBe(1 / 6);
  });
  it('rejects a pinched vertex even when every edge has two opposite uses', () => {
    const first = tetra();
    const secondNodes = [0, 4, 5, 6];
    const input: PlanarTetraMeshInput = { schema: PLANAR_TETRA_MESH_SCHEMA, source, units: 'mm',
      coordinates: [...first.coordinates, -2, 0, 0, 0, -3, 0, 0, 0, -4],
      triangles: [...first.triangles, ...first.triangles.map(i => secondNodes[i])],
      tags: [0, 1, 2, 3, 4, 5, 6, 7], tagCount: 8,
      shells: [{ role: 'outer', triangles: [0, 1, 2, 3] }, { role: 'cavity', triangles: [4, 5, 6, 7] }] };
    expect(() => readTetraMeshInput(input)).toThrow(/vertex link/u);
  });
  it('preserves exact degree by refusing duplicate, missing and inverted native elements for a holed body', () => {
    const { input, output } = cellFixture('frame');
    expect(() => decodeTetraMesh({ ...output, tetrahedra: output.tetrahedra.slice(4) }, input, hash)).toThrow();
    expect(() => decodeTetraMesh({ ...output, tetrahedra: [...output.tetrahedra, ...output.tetrahedra.slice(0, 4)] }, input, hash)).toThrow();
    const inverted = output.tetrahedra.slice(); [inverted[0], inverted[1]] = [inverted[1], inverted[0]];
    expect(() => decodeTetraMesh({ ...output, tetrahedra: inverted }, input, hash)).toThrow(/nonpositive/u);
  });
  it('binds new result kind to PLC2, old kind to v1 and hashes the full shell table', async () => {
    const { input, output } = cellFixture('L');
    const digest = await tetraMeshInputSha256(input), result = decodeTetraMesh(output, input, digest);
    expect(tetraMeshResultMatches(result, input, digest)).toBe(true);
    expect(tetraMeshResultMatches({ ...result, kind: 'netgen-convex-tetra-mesh' }, input, digest)).toBe(false);
    const old = tetra(), oldResult = decodeTetraMesh(raw(old, [0, 1, 2, 3]), old, hash);
    expect(tetraMeshResultMatches({ ...oldResult, kind: 'netgen-tetra-mesh' }, old, hash)).toBe(false);
    expect(tetraMeshResultMatches({ ...result, input: { ...input, shells: [] } }, input, digest)).toBe(false);
  });
});

describe('convex PLC and native tetrahedral chain', () => {
  it('checks a tetrahedron against the independent determinant volume 2*3*4/6', () => {
    const input = tetra();
    const result = decodeTetraMesh(raw(input, [0, 1, 2, 3]), input, hash);
    expect(result.volumeMm3).toBe(4);
    expect(result.minTetVolumeMm3).toBe(4);
  });
  it('checks a non-box triangular prism: area 2*3/2 times height 4', () => {
    const input = wedge();
    const result = decodeTetraMesh(raw(input, [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5]), input, hash);
    expect(result.volumeMm3).toBe(12);
    expect(result.minTetVolumeMm3).toBe(4);
    expect(result.boundaryTags).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });
  it('accepts a box PLC independently of fixed proof dimensions and owns copied arrays', () => {
    const original = box();
    const input = readTetraMeshInput(original);
    expect(input).toEqual(original);
    expect(input.coordinates).not.toBe(original.coordinates);
    expect(input.source).not.toBe(original.source);
    // Connect the centre to each outward face triangle: twelve positive tetrahedra.
    const elements = input.triangles.flatMap((_, i, nodes) => i % 3 === 0 ? [8, nodes[i], nodes[i + 1], nodes[i + 2]] : []);
    const result = decodeTetraMesh({ ...raw(input, elements), coordinates: [...input.coordinates, 1, 1.5, 2] }, input, hash);
    expect(result.volumeMm3).toBe(2 * 3 * 4);
    expect(result.minTetVolumeMm3).toBe(2);
  });
  it('refuses open, reversed, duplicated, concave and nonplanar same-label boundaries', () => {
    const input = tetra();
    expect(() => readTetraMeshInput({ ...input, triangles: input.triangles.slice(0, -3), tags: input.tags.slice(0, -1) })).toThrow();
    expect(() => readTetraMeshInput({ ...input, triangles: [2, 0, 1, ...input.triangles.slice(3)] })).toThrow();
    expect(() => readTetraMeshInput({ ...input, triangles: [...input.triangles, 0, 2, 1], tags: [...input.tags, 0] })).toThrow();
    const dent = box().coordinates.slice(); dent.splice(18, 3, 1, 1, 1);
    expect(() => readTetraMeshInput({ ...box(), coordinates: dent })).toThrow();
    expect(() => readTetraMeshInput({ ...wedge(), tags: [0, 1, 2, 3, 3, 3, 4, 4] })).toThrow(/nonplanar/u);
  });
  it('rejects sparse/nonfinite arrays and unexpected payload fields', () => {
    const sparse = new Array<number>(12); sparse[0] = 0;
    expect(() => readTetraMeshInput({ ...tetra(), coordinates: sparse })).toThrow(/sparse/u);
    expect(() => readTetraMeshInput({ ...tetra(), coordinates: [NaN, ...tetra().coordinates.slice(1)] })).toThrow();
    expect(() => readTetraMeshInput({ ...tetra(), material: 'inferred-steel' })).toThrow(/schema/u);
  });
  it('rejects changed boundary labels/nodes, inverted and duplicate tets and missing volume', () => {
    const input = wedge(), valid = raw(input, [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5]);
    expect(() => decodeTetraMesh({ ...valid, boundaryTags: [...valid.boundaryTags].reverse() }, input, hash)).toThrow();
    expect(() => decodeTetraMesh({ ...valid, coordinates: [0.01, ...input.coordinates.slice(1)] }, input, hash)).toThrow();
    expect(() => decodeTetraMesh(raw(tetra(), [1, 0, 2, 3]), tetra(), hash)).toThrow(/nonpositive/u);
    expect(() => decodeTetraMesh(raw(tetra(), [0, 1, 2, 3, 0, 1, 2, 3]), tetra(), hash)).toThrow();
    expect(() => decodeTetraMesh(raw(input, [0, 1, 2, 3]), input, hash)).toThrow();
  });
  it('strictly associates complete source and input digest without object insertion-order dependence', () => {
    const input = tetra(), result = decodeTetraMesh(raw(input, [0, 1, 2, 3]), input, hash);
    expect(tetraMeshResultMatches({ ...result, input: { ...input, source: {
      bodyKey: source.bodyKey, featureId: source.featureId, revision: source.revision, documentId: source.documentId,
    } } }, input, hash)).toBe(true);
    expect(tetraMeshResultMatches({ ...result, input: { ...input, source: { ...source, bodyKey: 'stale' } } }, input, hash)).toBe(false);
    expect(tetraMeshResultMatches(result, input, 'b'.repeat(64))).toBe(false);
    expect(tetraMeshResultMatches({ ...result, ignored: true }, input, hash)).toBe(false);
  });
});

function worker() {
  let request: FemRequest | undefined;
  let terminations = 0;
  const port: FemWorkerPort = { postMessage: message => { request = message; }, terminate: () => { terminations += 1; },
    onmessage: null, onerror: null, onmessageerror: null };
  return { port, request: () => request, terminations: () => terminations };
}
describe('actual FemClient mesh route ownership', () => {
  it('accepts the correctly bound complete mesh and closes exactly its worker', async () => {
    const owned = worker(), client = new FemClient(() => owned.port), input = tetra();
    try {
      const pending = client.meshTetrahedra(input);
      const request = owned.request();
      if (request?.kind !== 'mesh-cad-convex-tetra') throw new Error('Wrong actual request route');
      const result = decodeTetraMesh(raw(input, [0, 1, 2, 3]), input, await tetraMeshInputSha256(input));
      owned.port.onmessage?.({ data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } } as MessageEvent<unknown>);
      expect(await pending).toMatchObject({ kind: 'result', result: { volumeMm3: 4 } });
      expect(owned.terminations()).toBe(1);
    } finally { client.dispose(); }
  });
  it('abort, supersession and invalid new input terminate and never accept a late reply', async () => {
    const ports = [worker(), worker()]; let created = 0;
    const client = new FemClient(() => ports[created++].port);
    try {
      const first = client.meshTetrahedra(tetra());
      const controller = new AbortController();
      const second = client.meshTetrahedra(tetra(), { signal: controller.signal });
      expect(await first).toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      controller.abort(); expect(await second).toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(ports.map(p => p.terminations())).toEqual([1, 1]);
      expect(ports.every(p => p.port.onmessage === null)).toBe(true);
      await expect(client.meshTetrahedra({})).rejects.toBeInstanceOf(Error);
      expect(created).toBe(2);
    } finally { client.dispose(); }
  });
});
