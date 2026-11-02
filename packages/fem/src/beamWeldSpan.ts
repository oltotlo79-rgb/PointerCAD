import { subVec3 as sub, addVec3 as add, scaleVec3 as scale, crossVec3 as cross } from '@pointercad/model/vec3';
import type { Vector3, Vector6 } from './analysisModel.js';
import type { OofemContactPlan } from './contactTranslation.js';
import type { WeldLayerGeometry } from './beamWeldContact.js';

/** Internal SI kernel. No saved schema, native solver, initial strain or public index registration. */
export type WeldSpanMesh = Pick<OofemContactPlan, 'nodes' | 'members' | 'materials' | 'sections' | 'originalNodeCount'>;
export type WeldSpanSide = { readonly kind: 'span'; readonly memberId: string }
  | { readonly kind: 'section'; readonly node: number };
export interface WeldSpanPatch extends WeldLayerGeometry {
  readonly first: WeldSpanSide;
  readonly second: WeldSpanSide;
}
export interface WeldSpanPlan { readonly mesh: WeldSpanMesh; readonly patches: readonly WeldSpanPatch[] }
type Matrix = number[][];
type Element = WeldSpanMesh['members'][number];
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((v, x, i) => v + x*b[i], 0);
const zeros = (n: number, m: number): Matrix => Array.from({ length: n }, () => Array<number>(m).fill(0));
const fail = (): never => { throw new Error('weld-span: invalid, unsupported or unbounded input'); };
const finite = (v: number): boolean => Number.isFinite(v) && Math.abs(v) <= 1e30;
const positive = (v: number): boolean => finite(v) && v > 1e-30;
function data(v: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return finite(v);
  if (typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    if (v.length > 4096 || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length+1) return false;
    return Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, i))
      .every(d => d !== undefined && 'value' in d && data(d.value, depth+1));
  }
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
  return Reflect.ownKeys(v).every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return typeof k === 'string' && d !== undefined && 'value' in d && data(d.value, depth+1);
  });
}
function keys(v: object, names: readonly string[]): void {
  if (Reflect.ownKeys(v).length !== names.length || names.some(n => !Object.hasOwn(v, n))) fail();
}
function vector(v: readonly number[], size: number): void { if (v.length !== size || !v.every(finite)) fail(); }
function unit(v: Vector3): void { vector(v, 3); if (Math.abs(dot(v, v)-1) > 1e-10) fail(); }
function sideKey(s: WeldSpanSide): string { return s.kind === 'span' ? `m:${s.memberId}` : `n:${s.node}`; }

/** Fixed OOFEM 214b161ed Beam3d 6x12 N, including independent cross-section rotations. */
export function beamSpanShape(length: number, ky: number, kz: number, xi: number): Matrix {
  if (!positive(length) || ![ky, kz, xi].every(finite) || ky < 0 || kz < 0 || xi < 0 || xi > 1) fail();
  const n = zeros(6, 12);
  n[0][0] = n[3][3] = 1-xi; n[0][6] = n[3][9] = xi;
  for (const [k, t, r, sign] of [[kz, 1, 5, 1], [ky, 2, 4, -1]]) {
    const c = 1+2*k, x2 = xi*xi, x3 = x2*xi;
    n[t][t] = (c-2*k*xi-3*x2+2*x3)/c;
    n[t][r] = sign*length*((1+k)*xi-(2+k)*x2+x3)/c;
    n[t][t+6] = (2*k*xi+3*x2-2*x3)/c;
    n[t][r+6] = -sign*length*(k*xi+(1-k)*x2-x3)/c;
    n[r][t] = -sign*6*xi*(1-xi)/(length*c);
    n[r][r] = (c-2*(2+k)*xi+3*x2)/c;
    n[r][t+6] = sign*6*xi*(1-xi)/(length*c);
    n[r][r+6] = (-2*(1-k)*xi+3*x2)/c;
  }
  if (!n.flat().every(finite)) fail();
  return n;
}

function validateMesh(mesh: WeldSpanMesh): void {
  keys(mesh, ['nodes', 'members', 'materials', 'sections', 'originalNodeCount']);
  if (mesh.nodes.length < 2 || mesh.nodes.length > 128 || !mesh.members.length || mesh.members.length > 512
    || !mesh.materials.length || !mesh.sections.length || !Number.isInteger(mesh.originalNodeCount)
    || mesh.originalNodeCount < 2 || mesh.originalNodeCount > mesh.nodes.length) fail();
  mesh.nodes.forEach((n, i) => {
    keys(n, ['number', 'positionM', 'restrained', 'load']);
    vector(n.positionM, 3); vector(n.load, 6);
    if (n.number !== i+1 || n.positionM.some(v => Math.abs(v) > 1e9)
      || n.restrained.length !== 6 || n.restrained.some(v => typeof v !== 'boolean')) fail();
  });
  mesh.materials.forEach((m, i) => {
    keys(m, ['number', 'youngPa', 'poisson', 'densityKgM3']);
    if (m.number !== i+1 || !positive(m.youngPa) || !positive(m.densityKgM3) || !finite(m.poisson) || m.poisson <= -1 || m.poisson >= .5) fail();
  });
  mesh.sections.forEach((s, i) => {
    keys(s, ['number', 'areaM2', 'iyM4', 'izM4', 'torsionM4', 'shearFactor']);
    if (s.number !== i+1 || ![s.areaM2, s.iyM4, s.izM4, s.torsionM4, s.shearFactor].every(positive)) fail();
  });
  const groups = new Map<string, Element[]>();
  mesh.members.forEach((e, i) => {
    keys(e, ['number', 'id', 'componentId', 'occurrencePath', 'nodes', 'material', 'section', 'frame']);
    keys(e.frame, ['x', 'y', 'z', 'lengthM']);
    if (e.number !== i+1 || typeof e.id !== 'string' || !e.id || typeof e.componentId !== 'string' || !e.componentId || !e.occurrencePath.length
      || e.occurrencePath.some(v => typeof v !== 'string' || !v) || e.nodes.length !== 2
      || e.nodes.some(v => !Number.isInteger(v) || v < 1 || v > mesh.nodes.length)
      || e.nodes[0] === e.nodes[1] || !Number.isInteger(e.material) || !mesh.materials[e.material-1]
      || !Number.isInteger(e.section) || !mesh.sections[e.section-1]) fail();
    const f = e.frame, delta = sub(mesh.nodes[e.nodes[1]-1].positionM, mesh.nodes[e.nodes[0]-1].positionM);
    const length = Math.hypot(...delta);
    [f.x, f.y, f.z].forEach(unit);
    if (length <= 1e-9 || !positive(f.lengthM) || Math.abs(f.lengthM-length) > 1e-9*length
      || Math.hypot(...sub(scale(delta, 1/length), f.x)) > 1e-10
      || Math.abs(dot(f.x, f.y)) > 1e-10 || Math.hypot(...sub(cross(f.x, f.y), f.z)) > 1e-10) fail();
    const previous = groups.get(e.id) ?? [];
    if (previous.some(p => p.componentId !== e.componentId || JSON.stringify(p.occurrencePath) !== JSON.stringify(e.occurrencePath)
      || p.material !== e.material || p.section !== e.section || Math.hypot(...sub(p.frame.x, f.x)) > 1e-10
      || Math.hypot(...sub(p.frame.y, f.y)) > 1e-10)) fail();
    groups.set(e.id, [...previous, e]);
  });
  for (const group of groups.values()) {
    if (group.length > 32) fail();
    const ordered = [...group].sort((a, b) => dot(mesh.nodes[a.nodes[0]-1].positionM, a.frame.x)
      - dot(mesh.nodes[b.nodes[0]-1].positionM, a.frame.x));
    if (ordered.some((e, i) => i > 0 && ordered[i-1].nodes[1] !== e.nodes[0])) fail();
  }
}

function sideElements(mesh: WeldSpanMesh, side: WeldSpanSide): readonly Element[] {
  if (side.kind === 'section') {
    keys(side, ['kind', 'node']);
    if (!Number.isInteger(side.node) || side.node < 1 || side.node > mesh.originalNodeCount) fail();
    return [];
  }
  keys(side, ['kind', 'memberId']);
  if (side.kind !== 'span' || typeof side.memberId !== 'string') fail();
  const elements = mesh.members.filter(e => e.id === side.memberId);
  if (!elements.length) fail();
  return elements;
}

function pointMap(mesh: WeldSpanMesh, side: WeldSpanSide, point: Vector3): { indices: number[]; h: Matrix } {
  if (side.kind === 'section') {
    const r = sub(point, mesh.nodes[side.node-1].positionM), h = zeros(3, 6);
    for (let i = 0; i < 3; i++) h[i][i] = 1;
    for (let j = 0; j < 3; j++) {
      const basis: Vector3 = [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0];
      const v = cross(basis, r); for (let i = 0; i < 3; i++) h[i][j+3] = v[i];
    }
    return { h, indices: Array.from({ length: 6 }, (_, i) => 6*(side.node-1)+i) };
  }
  const candidates = sideElements(mesh, side).filter(e => {
    const x = dot(sub(point, mesh.nodes[e.nodes[0]-1].positionM), e.frame.x);
    return x >= 0 && x <= e.frame.lengthM;
  });
  if (!candidates.length) fail();
  const e = candidates[0], f = e.frame, p = mesh.nodes[e.nodes[0]-1].positionM;
  const x = dot(sub(point, p), f.x), r = sub(point, add(p, scale(f.x, x)));
  const material = mesh.materials[e.material-1], section = mesh.sections[e.section-1];
  const g = material.youngPa/(2*(1+material.poisson)), den = g*section.shearFactor*section.areaM2*f.lengthM**2;
  const n = beamSpanShape(f.lengthM, 6*material.youngPa*section.iyM4/den,
    6*material.youngPa*section.izM4/den, x/f.lengthM);
  const axes = [f.x, f.y, f.z], h = zeros(3, 12);
  for (let j = 0; j < 12; j++) {
    const local = Array<number>(12).fill(0), block = Math.floor(j/3)*3;
    for (let a = 0; a < 3; a++) local[block+a] = axes[a][j%3];
    const motion = n.map(row => dot(row, local));
    let u: Vector3 = [0, 0, 0], theta: Vector3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) { u = add(u, scale(axes[a], motion[a])); theta = add(theta, scale(axes[a], motion[a+3])); }
    const v = add(u, cross(theta, r)); for (let i = 0; i < 3; i++) h[i][j] = v[i];
  }
  if (!h.flat().every(finite)) fail();
  return { h, indices: e.nodes.flatMap(node => Array.from({ length: 6 }, (_, i) => 6*(node-1)+i)) };
}

/** Preparation snapshots all plain input data; later input mutation cannot change this kernel. */
export function prepareWeldSpan(value: WeldSpanPlan) {
  if (!data(value)) fail();
  keys(value, ['mesh', 'patches']);
  const plan = structuredClone(value), { mesh, patches } = plan;
  validateMesh(mesh);
  if (patches.length < 1 || patches.length > 64) fail();
  const ids = new Set<string>();
  const gx = [Math.sqrt((3-2*Math.sqrt(6/5))/7), Math.sqrt((3+2*Math.sqrt(6/5))/7)];
  const gw = [(18+Math.sqrt(30))/36, (18-Math.sqrt(30))/36];
  const stiffness = zeros(mesh.nodes.length*6, mesh.nodes.length*6);
  const operators = patches.map((patch, pi) => {
    keys(patch, ['id', 'centerM', 'normal', 'along', 'widthM', 'lengthM', 'thicknessM', 'youngPa', 'poisson', 'first', 'second']);
    if (typeof patch.id !== 'string' || !patch.id || patch.id.length > 64 || ids.has(patch.id)) fail();
    ids.add(patch.id); vector(patch.centerM, 3); unit(patch.normal); unit(patch.along);
    if (Math.abs(dot(patch.normal, patch.along)) > 1e-10 || ![patch.widthM, patch.lengthM, patch.thicknessM, patch.youngPa].every(positive)
      || !finite(patch.poisson) || patch.poisson < 0 || patch.poisson >= .5 || sideKey(patch.first) === sideKey(patch.second)) fail();
    const q = cross(patch.normal, patch.along), breaks = [-patch.widthM/2, patch.widthM/2];
    for (const side of [patch.first, patch.second]) {
      const elements = sideElements(mesh, side);
      if (!elements.length) continue;
      const axis = elements[0].frame.x;
      if (Math.abs(Math.abs(dot(axis, patch.along))-1) > 1e-10 || Math.abs(dot(axis, q)) > 1e-10) fail();
      const origin = mesh.nodes[elements[0].nodes[0]-1].positionM;
      const extent = elements.flatMap(e => e.nodes.map(node => dot(sub(mesh.nodes[node-1].positionM, origin), axis)));
      const ends = [-1, 1].map(sign => dot(sub(add(patch.centerM, scale(patch.along, sign*patch.widthM/2)), origin), axis));
      if (Math.min(...ends) < Math.min(...extent) || Math.max(...ends) > Math.max(...extent)) fail();
      const stations = elements.flatMap(e => e.nodes.map(node => dot(sub(mesh.nodes[node-1].positionM, patch.centerM), patch.along)));
      for (const t of stations) if (t > breaks[0] && t < breaks[1]) breaks.push(t);
    }
    for (const other of patches.slice(0, pi)) {
      const pair = JSON.stringify([sideKey(patch.first), sideKey(patch.second)].sort());
      if (pair !== JSON.stringify([sideKey(other.first), sideKey(other.second)].sort())) continue;
      if (Math.hypot(...sub(patch.normal, other.normal)) > 1e-10 || Math.hypot(...sub(patch.along, other.along)) > 1e-10) fail();
      const delta = sub(patch.centerM, other.centerM), station = dot(delta, patch.along);
      if (Math.hypot(...sub(delta, scale(patch.along, station))) > 1e-10*Math.max(patch.widthM, patch.lengthM, other.widthM, other.lengthM)) fail();
      const radius = (patch.widthM+other.widthM)/2;
      const rounding = 32*Number.EPSILON*(radius+patch.along.reduce((v, s, i) => v+(Math.abs(patch.centerM[i])+Math.abs(other.centerM[i]))*Math.abs(s), 0));
      if (Math.abs(station) <= radius+rounding) fail();
    }
    const sorted = [...new Set(breaks)].sort((a, b) => a-b);
    if (sorted.length > 64) fail();
    const density = zeros(3, 3), shear = patch.youngPa/(2*(1+patch.poisson));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      density[i][j] = ((i === j ? shear : 0)+(patch.youngPa-shear)*patch.normal[i]*patch.normal[j])/patch.thicknessM;
    }
    if (!density.flat().every(finite)) fail();
    const points = [];
    for (let cell = 1; cell < sorted.length; cell++) {
      const half = (sorted[cell]-sorted[cell-1])/2, mid = (sorted[cell]+sorted[cell-1])/2;
      if (!(half > 0)) fail();
      for (let a = 0; a < 2; a++) for (const sign of [-1, 1]) for (const transverse of [-1, 1]) {
        const point = add(patch.centerM, add(scale(patch.along, mid+sign*gx[a]*half), scale(q, transverse*patch.lengthM/Math.sqrt(12))));
        const first = pointMap(mesh, patch.first, point), second = pointMap(mesh, patch.second, point);
        const indices = [...first.indices, ...second.indices], b = first.h.map((row, i) => [...row.map(v => -v), ...second.h[i]]);
        const weight = half*gw[a]*patch.lengthM/2;
        const weighted = density.map(row => row.map(v => v*weight));
        if (!positive(weight) || !weighted.flat().every(finite)) fail();
        for (let i = 0; i < indices.length; i++) for (let j = 0; j < indices.length; j++) {
          let v = 0; for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) v += b[r][i]*weighted[r][s]*b[s][j];
          stiffness[indices[i]][indices[j]] += v;
        }
        points.push({ point, first, second, weighted, weight });
      }
    }
    return { patch, points, density, cellCount: sorted.length-1 };
  });
  if (!stiffness.flat().every(finite)) fail();
  return { stiffness, cellCounts: operators.map(o => o.cellCount), evaluate(motions: readonly Vector6[]) {
    if (!data(motions) || motions.length !== mesh.nodes.length) fail();
    motions.forEach((v, i) => { vector(v, 6); if (v.some((x, a) => mesh.nodes[i].restrained[a] && x !== 0)) fail(); });
    const flat = motions.flat();
    return operators.map(({ patch, points }) => {
      const first = zeros(mesh.nodes.length, 6), second = zeros(mesh.nodes.length, 6);
      let energyJ = 0, forceOnFirstN: Vector3 = [0, 0, 0], momentAtCenterNm: Vector3 = [0, 0, 0];
      for (const p of points) {
        const u = (map: typeof p.first) => map.h.map(row => dot(row, map.indices.map(i => flat[i])));
        const a = u(p.first), b = u(p.second), d: Vector3 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
        const f: Vector3 = [dot(p.weighted[0], d), dot(p.weighted[1], d), dot(p.weighted[2], d)];
        energyJ += dot(d, f)/2; forceOnFirstN = add(forceOnFirstN, f);
        momentAtCenterNm = add(momentAtCenterNm, cross(sub(p.point, patch.centerM), f));
        for (const [map, result, sign] of [[p.first, first, 1], [p.second, second, -1]] as const) {
          for (let j = 0; j < map.indices.length; j++) {
            const index = map.indices[j];
            result[Math.floor(index/6)][index%6] += sign*(map.h[0][j]*f[0]+map.h[1][j]*f[1]+map.h[2][j]*f[2]);
          }
        }
      }
      if (![energyJ, ...first.flat(), ...second.flat(), ...forceOnFirstN, ...momentAtCenterNm].every(finite) || energyJ < 0) fail();
      return { id: patch.id, first, second, forceOnFirstN, momentAtCenterNm, energyJ, structuralCertification: false as const };
    });
  },
  /** Traction on the first side, sampled at the existing quadrature points; not an exact surface maximum. */
  evaluateStress(motions: readonly Vector6[]) {
    if (!data(motions) || motions.length !== mesh.nodes.length) fail();
    motions.forEach((v, i) => { vector(v, 6); if (v.some((x, a) => mesh.nodes[i].restrained[a] && x !== 0)) fail(); });
    const flat = motions.flat();
    return operators.map(({ patch, points, density }) => {
      const across = cross(patch.normal, patch.along);
      return { id: patch.id, sampling: 'gauss-4x2-per-cell' as const, structuralCertification: false as const,
        points: points.map(p => {
          const u = (map: typeof p.first) => map.h.map(row => dot(row, map.indices.map(i => flat[i])));
          const a = u(p.first), b = u(p.second), relativeDisplacementM: Vector3 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
          const traction: Vector3 = [dot(density[0], relativeDisplacementM), dot(density[1], relativeDisplacementM), dot(density[2], relativeDisplacementM)];
          const normalPa = dot(traction, patch.normal), shearAlongPa = dot(traction, patch.along), shearAcrossPa = dot(traction, across);
          if (![...relativeDisplacementM, ...traction, normalPa, shearAlongPa, shearAcrossPa].every(finite)) fail();
          // Return owned vectors; a caller must not mutate a prepared operator through its samples.
          const positionM: Vector3 = [...p.point];
          return { positionM, areaWeightM2: p.weight, relativeDisplacementM, normalPa, shearAlongPa, shearAcrossPa };
        }) };
    });
  } };
}
