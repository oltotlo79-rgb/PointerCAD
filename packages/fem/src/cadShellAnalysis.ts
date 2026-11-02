import { createSubShapeReference, isSameSubShape, requestAnalysisBoundary, resolveCurrentOrigin, type AnalysisBoundary,
  type AnalysisBoundarySource, type SolidBody, type SubShapeRef } from '@pointercad/model';
import { readShellCadInput, solidCadFaceKey, type ShellCadSavedInput } from '@pointercad/model/beam-analysis';
import { prepareCadShellSurfaceMesh, type CadShellSurfaceMesh, type CadShellSurfaceOptions } from './cadShellSurfaceMesh.js';
import type { CadTetraContext } from './cadTetraMesh.js';
import { SHELL_ANALYSIS_SCHEMA, type ShellAnalysisInput, type ShellFixed6, type ShellVector3 } from './shellAnalysisModel.js';
import { decodeShellAnalysis, translateShellAnalysis, type ShellAnalysisPlan, type ShellAnalysisResult, type ShellNodal6,
  type ShellTensor6 } from './shellTranslation.js';

/**
 * Idealization of an explicit thin CAD sheet and the binding of the native shell answer back to its CAD faces.
 *
 * Path: the saved three inputs (readShellCadInput: explicit midsurface faces, thickness, offset) -> current CAD shell
 * body -> prepareCadShellSurfaceMesh (unchanged) -> ShellAnalysisInput (thickness, material, supports, loads) ->
 * translateShellAnalysis (unchanged W08 path, TR_SHELL02) -> native run supplied by the caller -> decodeShellAnalysis
 * -> every element, integration point and node result keyed by the solidCadFaceKey of its CAD face.
 *
 * Nothing is inferred: a face of a solid is never turned into a midsurface, a non-planar face is refused (this
 * package binds planar faces only), a saved face without a unique current counterpart is refused, and a face of the
 * sheet without an explicit midsurface entry is refused rather than given a thickness or dropped.
 *
 * Offset: offsetMm is the signed distance along the face's oriented normal (its native triangle winding, the top
 * side of the shell) from the referenced face to the midsurface. The midsurface nodes are placed explicitly at
 * reference point + offsetMm * normal and the native element gets offsetMm 0 (TR_SHELL02 has no eccentricity, and
 * translateShellAnalysis refuses a nonzero element offset). The shift is recorded in the result. A nonzero offset is
 * accepted only when every face has the same oriented normal (one plane direction): the offset of a folded sheet is
 * not a node shift and is refused. Supports and edge loads act on the midsurface; no eccentric transfer moment is
 * added for an offset reference.
 */
export const CAD_SHELL_RESULT_SCHEMA = 'pointercad-cad-shell-result/1';

export interface CadShellMaterial { readonly id: string; readonly youngMPa: number; readonly poisson: number }
/** Global ux, uy, uz, rx, ry, rz prescribed zero at every node of a CAD edge, or at the node of a CAD vertex. */
export type CadShellSupport =
  | { readonly kind: 'edge'; readonly edge: SubShapeRef; readonly fixed: ShellFixed6 }
  | { readonly kind: 'vertex'; readonly vertex: SubShapeRef; readonly fixed: ShellFixed6 };
/** Uniform line loads per unit length of a CAD edge, global axes, applied on the midsurface. */
export interface CadShellEdgeLoad {
  readonly edge: SubShapeRef;
  readonly forceNPerMm: ShellVector3;
  readonly momentNmmPerMm: ShellVector3;
}
export interface CadShellSettings {
  /** The saved three-input idealization; it is read with readShellCadInput and never modified. */
  readonly saved: ShellCadSavedInput;
  readonly material: CadShellMaterial;
  readonly supports: readonly CadShellSupport[];
  readonly edgeLoads: readonly CadShellEdgeLoad[];
  readonly surface: CadShellSurfaceOptions;
}

export type CadShellRefusalCode = 'midsurface-solid-face' | 'midsurface-nonplanar' | 'midsurface-unresolved'
  | 'midsurface-incomplete' | 'midsurface-offset-fold' | 'support-unresolved' | 'load-unresolved' | 'edge-load-fold'
  | 'edge-load-drilling' | 'invalid-settings' | 'result-binding';
export class CadShellAnalysisRefusal extends Error {
  override readonly name = 'CadShellAnalysisRefusal';
  constructor(readonly code: CadShellRefusalCode, reason: string) { super(`${code}: ${reason}`); }
}
function refuse(code: CadShellRefusalCode, reason: string): never { throw new CadShellAnalysisRefusal(code, reason); }

export interface CadShellFaceBinding {
  readonly faceKey: string;
  /** Revision-local face address; never persisted. */
  readonly faceIndex: number;
  readonly reference: SubShapeRef;
  readonly triangles: readonly number[];
  readonly nodes: readonly number[];
  /** Oriented unit normal of the planar face (native winding): the top side of its elements. */
  readonly normal: ShellVector3;
  readonly areaMm2: number;
}
export interface CadShellMidsurface {
  readonly offsetMm: number;
  /** Midsurface point = referenced CAD face point + shiftMm (zero for offsetMm 0). */
  readonly shiftMm: ShellVector3;
}
export interface CadShellPrepared {
  readonly saved: ShellCadSavedInput;
  readonly source: CadShellSurfaceMesh['source'];
  readonly mesh: CadShellSurfaceMesh;
  /** In the order of saved.midsurfaceFaces. */
  readonly faces: readonly CadShellFaceBinding[];
  /** Element (= triangle) index -> index into faces. */
  readonly elementFaces: readonly number[];
  readonly midsurface: CadShellMidsurface;
  /** Node points on the referenced CAD faces; input.nodes are these plus shiftMm. */
  readonly referenceNodes: readonly ShellVector3[];
  readonly input: ShellAnalysisInput;
  readonly plan: ShellAnalysisPlan;
}
export interface CadShellPointResult {
  /** Native integration point on the midsurface [mm]. */
  readonly xyzMm: ShellVector3;
  /** The same point on the referenced CAD face: xyzMm - shiftMm. */
  readonly referenceXyzMm: ShellVector3;
  /** N/t + 6M/t^2 on the side the element normal points to [MPa], global tensor xx, yy, zz, yz, xz, xy. */
  readonly topMPa: ShellTensor6;
  readonly bottomMPa: ShellTensor6;
}
export interface CadShellElementResult {
  readonly element: number;
  readonly faceKey: string;
  readonly nodes: readonly [number, number, number];
  readonly thicknessMm: number;
  readonly points: readonly CadShellPointResult[];
  /** Global ux, uy, uz [mm], rx, ry, rz [rad] of the three element nodes. */
  readonly displacement: readonly [ShellNodal6, ShellNodal6, ShellNodal6];
}
export interface CadShellNodeResult {
  readonly node: number;
  readonly xyzMm: ShellVector3;
  readonly referenceXyzMm: ShellVector3;
  /** Every CAD face whose elements use this node (two or more on a face boundary), sorted. */
  readonly faceKeys: readonly string[];
  readonly displacement: ShellNodal6;
}
export interface CadShellFaceResult {
  readonly faceKey: string;
  readonly reference: SubShapeRef;
  readonly elements: readonly number[];
  readonly nodes: readonly number[];
  readonly areaMm2: number;
}
export interface CadShellAnalysisResult {
  readonly schema: typeof CAD_SHELL_RESULT_SCHEMA;
  readonly saved: ShellCadSavedInput;
  readonly source: CadShellSurfaceMesh['source'];
  readonly midsurface: CadShellMidsurface;
  readonly faces: readonly CadShellFaceResult[];
  readonly elements: readonly CadShellElementResult[];
  readonly nodes: readonly CadShellNodeResult[];
  /** The decoded native answer (raw integration points, checks, planar recovery), unchanged. */
  readonly shell: ShellAnalysisResult;
}

function sub(a: ShellVector3, b: ShellVector3): ShellVector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: ShellVector3, b: ShellVector3): ShellVector3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function dot(a: ShellVector3, b: ShellVector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: ShellVector3, b: ShellVector3): ShellVector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: ShellVector3): number { return Math.hypot(a[0], a[1], a[2]); }
function scaled(a: ShellVector3, factor: number): ShellVector3 { return [a[0] * factor, a[1] * factor, a[2] * factor]; }
function finiteVector(value: unknown, what: string): ShellVector3 {
  if (!Array.isArray(value) || value.length !== 3) return refuse('invalid-settings', `${what} needs three finite components`);
  const items: unknown[] = Array.from(value);
  const [x, y, z] = items;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return refuse('invalid-settings', `${what} needs three finite components`);
  }
  return [x, y, z];
}
function fixedFlags(value: unknown, what: string): ShellFixed6 {
  if (!Array.isArray(value) || value.length !== 6) return refuse('invalid-settings', `${what} needs six fixed flags`);
  const items: unknown[] = Array.from(value);
  const [ux, uy, uz, rx, ry, rz] = items;
  if (typeof ux !== 'boolean' || typeof uy !== 'boolean' || typeof uz !== 'boolean'
    || typeof rx !== 'boolean' || typeof ry !== 'boolean' || typeof rz !== 'boolean') {
    return refuse('invalid-settings', `${what} needs six fixed flags`);
  }
  if (!(ux || uy || uz || rx || ry || rz)) refuse('invalid-settings', `${what} fixes no degree of freedom`);
  return [ux, uy, uz, rx, ry, rz];
}
function edgeKey(a: number, b: number): string { return `${Math.min(a, b)}:${Math.max(a, b)}`; }

/** Work-equivalent nodal loads of uniform line loads on a chain of straight shell element edges.
 * Segment a -> b with length h, tangent s, the element normal n of the segment and nu = s x n:
 * - force f: f h/2 at each end; the transverse part (f.n) adds the cubic Hermite end moments +-(f.n) h^2/12 nu (DKT w);
 *   the in-plane normal part (f.nu) adds the Allman drilling moments -+(f.nu) h^2/12 n.
 * - moment m: the part about the edge (m.s) is m.s h/2 at each end (DKT normal rotation, linear along an edge);
 *   the part about nu turns the edge slope dw/ds and is the end-force pair -+(m.nu) n; a part about n (drilling) has
 *   no work-equivalent edge load in the native element and is refused.
 * Every term is independent of the chain direction and of the sign of n. Returns one global row per chain point. */
export function distributeShellEdgeLoad(points: readonly ShellVector3[], normals: readonly ShellVector3[],
  forceNPerMm: ShellVector3, momentNmmPerMm: ShellVector3): ShellNodal6[] {
  if (points.length < 2 || normals.length !== points.length - 1) refuse('invalid-settings', 'an edge load needs one normal per segment');
  const force = finiteVector(forceNPerMm, 'edge load force'), moment = finiteVector(momentNmmPerMm, 'edge load moment');
  const rows = points.map(() => [0, 0, 0, 0, 0, 0]);
  const momentSize = norm(moment);
  for (let k = 0; k + 1 < points.length; k += 1) {
    const step = sub(points[k + 1], points[k]), h = norm(step), n = normals[k];
    if (!(h > 0) || !Number.isFinite(h)) refuse('invalid-settings', `edge load segment ${k} has no length`);
    if (!(Math.abs(norm(n) - 1) <= 1e-9)) refuse('invalid-settings', `edge load segment ${k} needs a unit element normal`);
    const s = scaled(step, 1 / h), nu = cross(s, n), quarter = h * h / 12;
    const fn = dot(force, n), fnu = dot(force, nu), ms = dot(moment, s), mnu = dot(moment, nu), mn = dot(moment, n);
    if (Math.abs(mn) > 1e-9 * momentSize) {
      refuse('edge-load-drilling', `edge load segment ${k} has a moment of ${mn} N mm/mm about the shell normal (drilling); `
        + 'it has no work-equivalent edge load in the native shell element and is not distributed silently');
    }
    for (let axis = 0; axis < 3; axis += 1) {
      rows[k][axis] += force[axis] * h / 2 - mnu * n[axis];
      rows[k + 1][axis] += force[axis] * h / 2 + mnu * n[axis];
      rows[k][3 + axis] += fn * quarter * nu[axis] - fnu * quarter * n[axis] + ms * s[axis] * h / 2;
      rows[k + 1][3 + axis] += -fn * quarter * nu[axis] + fnu * quarter * n[axis] + ms * s[axis] * h / 2;
    }
  }
  return rows.map(([a, b, c, d, e, f]): ShellNodal6 => [a, b, c, d, e, f]);
}

/** Current address of a saved semantic edge/vertex reference: same body, a unique current origin, and no other
 * origin claiming that address (the same complete claim check as analysis face regions). No index fallback. */
function currentAddress(body: SolidBody, reference: SubShapeRef, kind: 'edge' | 'vertex'): number | null {
  if (reference.bodyFeatureId !== body.featureId || reference.fingerprint.kind !== kind || reference.origin?.shapeKind !== kind) return null;
  const lookup = resolveCurrentOrigin(body, reference);
  if (lookup.status !== 'matched' || lookup.address.kind !== kind) return null;
  const claim = createSubShapeReference(body, kind, lookup.address.index);
  return claim !== null && isSameSubShape(claim, reference) ? lookup.address.index : null;
}

/** solidCadFaceKey -> current face address, for faces with a strict unique origin that round-trips. */
function currentFaceKeys(body: SolidBody): Map<string, number> {
  const keys = new Map<string, number>();
  for (const face of body.faces) {
    const reference = createSubShapeReference(body, 'face', face.index);
    if (reference === null || reference.origin === undefined) continue;
    const lookup = resolveCurrentOrigin(body, reference);
    if (lookup.status === 'matched' && lookup.address.kind === 'face' && lookup.address.index === face.index) {
      keys.set(solidCadFaceKey(reference), face.index);
    }
  }
  return keys;
}

/** The checks that never meet a mesh: the saved idealization must name every face of one current explicit CAD
 * sheet, each planar. Returns the current face address of each saved key, in the saved order. */
function explicitMidsurface(saved: ShellCadSavedInput, context: CadTetraContext): readonly number[] {
  const { body } = context;
  if (saved.source.documentId !== context.documentId || saved.bodyFeatureId !== body.featureId) {
    refuse('midsurface-unresolved', `the saved midsurface belongs to body ${saved.bodyFeatureId} of document `
      + `${saved.source.documentId}, not to the current body ${body.featureId} of document ${context.documentId}`);
  }
  const keys = currentFaceKeys(body);
  if (body.bodyKind === 'solid' || body.bodyKind === 'mixed') {
    const named = saved.midsurfaceFaces.map(key => keys.get(key)).filter(index => index !== undefined);
    refuse('midsurface-solid-face', `${named.length > 0 ? `face ${named.join(', ')} is a boundary face` : 'the selected body is'} `
      + `of a ${body.bodyKind} body; a solid's midsurface is never inferred. Model the sheet as an explicit CAD surface `
      + '(shell) body and select its faces as the midsurface');
  }
  if (!body.isValid || body.bodyKind !== 'shell') {
    refuse('midsurface-unresolved', 'an explicit current valid CAD shell (sheet) body is required for a midsurface');
  }
  const faces = saved.midsurfaceFaces.map((key, position) => {
    const index = keys.get(key);
    if (index === undefined) {
      return refuse('midsurface-unresolved', `saved midsurface face ${position} has no unique current counterpart `
        + '(deleted, split, merged or untracked); its midsurface is not looked up by index or geometry');
    }
    const face = body.faces.find(entry => entry.index === index);
    if (face === undefined || face.surfaceKind !== 'plane') {
      return refuse('midsurface-nonplanar', `saved midsurface face ${position} is a ${face?.surfaceKind ?? 'missing'} face; `
        + 'only planar CAD faces are bound to shell elements here, a curved midsurface is not flattened or approximated');
    }
    return index;
  });
  const listed = new Set(faces);
  const missing = body.faces.filter(face => !listed.has(face.index)).map(face => face.index);
  if (missing.length > 0) {
    refuse('midsurface-incomplete', `face ${missing.join(', ')} of the sheet has no explicit midsurface entry; it is `
      + 'neither given the thickness of another face nor dropped from the structure');
  }
  return faces;
}

/** Synchronous and pure: validates, binds and translates; neither the boundary, the context nor the settings change. */
export function prepareCadShellAnalysis(boundary: AnalysisBoundary, context: CadTetraContext,
  settings: CadShellSettings): CadShellPrepared {
  const saved = readShellCadInput(settings.saved);
  const faceAddresses = explicitMidsurface(saved, context);
  const material = settings.material;
  if (typeof material !== 'object' || material === null || typeof material.id !== 'string') {
    refuse('invalid-settings', 'a shell material with an id, Young modulus and Poisson ratio is required');
  }
  const mesh = prepareCadShellSurfaceMesh(boundary, context, settings.surface);
  const point = (node: number): ShellVector3 => [mesh.coordinates[3 * node], mesh.coordinates[3 * node + 1], mesh.coordinates[3 * node + 2]];
  const nodeCount = mesh.coordinates.length / 3, triangleCount = mesh.triangleFaces.length;
  const referenceNodes = Array.from({ length: nodeCount }, (_, node) => point(node));
  const low: number[] = [Infinity, Infinity, Infinity], high: number[] = [-Infinity, -Infinity, -Infinity];
  for (const xyz of referenceNodes) for (let axis = 0; axis < 3; axis += 1) {
    low[axis] = Math.min(low[axis], xyz[axis]); high[axis] = Math.max(high[axis], xyz[axis]);
  }
  const diagonal = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
  const magnitude = Math.max(...low.map(Math.abs), ...high.map(Math.abs));
  const lengthTolerance = 1e-9 * diagonal + 8 * Number.EPSILON * magnitude;
  const triangleNodes = (t: number): [number, number, number] => [mesh.triangles[3 * t], mesh.triangles[3 * t + 1], mesh.triangles[3 * t + 2]];
  const normalOf = (t: number): ShellVector3 => [mesh.normals[3 * t], mesh.normals[3 * t + 1], mesh.normals[3 * t + 2]];
  const keys = currentFaceKeys(context.body);
  const regionByFace = new Map(mesh.regions.map(region => [region.tag, region]));
  const faces = faceAddresses.map((faceIndex, position): CadShellFaceBinding => {
    const region = regionByFace.get(faceIndex), faceKey = saved.midsurfaceFaces[position];
    if (region === undefined || solidCadFaceKey(region.reference) !== faceKey || keys.get(faceKey) !== faceIndex) {
      return refuse('midsurface-unresolved', `saved midsurface face ${position} does not match the analysis surface region of the current face`);
    }
    const triangles = [...region.triangleIndices];
    const normal = normalOf(triangles[0]), origin = point(triangleNodes(triangles[0])[0]);
    const nodes = [...new Set(triangles.flatMap(triangleNodes))].sort((a, b) => a - b);
    // Mesh evidence: one oriented plane. A face whose triangles fold or curve is refused, not flattened.
    if (triangles.some(t => norm(sub(normalOf(t), normal)) > 1e-9)
      || nodes.some(node => Math.abs(dot(sub(point(node), origin), normal)) > lengthTolerance)) {
      return refuse('midsurface-nonplanar', `the analysis surface of saved midsurface face ${position} is not one plane `
        + '(triangle normals or node offsets disagree); it is not flattened');
    }
    const areaMm2 = triangles.reduce((sum, t) => sum + mesh.areasMm2[t], 0);
    return { faceKey, faceIndex, reference: structuredClone(region.reference), triangles, nodes, normal, areaMm2 };
  });
  const bindingOf = new Map(faces.map((face, index) => [face.faceIndex, index]));
  const elementFaces = Array.from({ length: triangleCount }, (_, t) => {
    const binding = bindingOf.get(mesh.triangleFaces[t]);
    return binding ?? refuse('midsurface-incomplete', `triangle ${t} belongs to no saved midsurface face`);
  });
  let shiftMm: ShellVector3 = [0, 0, 0];
  if (saved.offsetMm !== 0) {
    const normal = faces[0].normal;
    if (faces.some(face => norm(sub(face.normal, normal)) > 1e-9)) {
      refuse('midsurface-offset-fold', `offsetMm ${saved.offsetMm} on faces with different oriented normals: the offset `
        + 'surface of a folded or reversed sheet is not a shift of its nodes, so no midsurface is constructed');
    }
    // Adding +0 keeps the recorded shift free of negative zeros (a sign of nothing).
    const shift = scaled(normal, saved.offsetMm);
    shiftMm = [shift[0] + 0, shift[1] + 0, shift[2] + 0];
  }
  const nodes = referenceNodes.map(xyz => add(xyz, shiftMm));

  const meshEdges = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    const [a, b, c] = triangleNodes(t);
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(from, to);
      meshEdges.set(key, [...(meshEdges.get(key) ?? []), t]);
    }
  }
  const chainOf = (reference: SubShapeRef, code: 'support-unresolved' | 'load-unresolved', what: string): readonly number[] => {
    const address = currentAddress(context.body, reference, 'edge');
    if (address === null) return refuse(code, `${what} names no unique current CAD edge of this body`);
    const chains = boundary.mesh.edges.filter(chain => chain.index === address);
    if (chains.length !== 1 || chains[0].degenerated || chains[0].nodes.length < 2) {
      return refuse(code, `${what}: CAD edge ${address} has no node chain on the analysis surface`);
    }
    const chain = [...chains[0].nodes];
    for (let k = 0; k < chain.length; k += 1) {
      if (!Number.isSafeInteger(chain[k]) || chain[k] < 0 || chain[k] >= nodeCount
        || (k > 0 && !meshEdges.has(edgeKey(chain[k - 1], chain[k])))) {
        return refuse(code, `${what}: the node chain of CAD edge ${address} does not follow analysis surface edges`);
      }
    }
    return chain;
  };
  const vertexNodes = new Set<number>();
  for (const chain of boundary.mesh.edges) {
    if (chain.nodes.length > 0) { vertexNodes.add(chain.nodes[0]); vertexNodes.add(chain.nodes[chain.nodes.length - 1]); }
  }
  const vertexNode = (reference: SubShapeRef, what: string): number => {
    const address = currentAddress(context.body, reference, 'vertex');
    const vertex = address === null ? undefined : context.body.vertices.find(entry => entry.index === address);
    if (vertex === undefined) return refuse('support-unresolved', `${what} names no unique current CAD vertex of this body`);
    // Same revision: the vertex node of the edge chains is the native vertex point itself.
    const matches = [...vertexNodes].filter(node => node >= 0 && node < nodeCount
      && norm(sub(point(node), [vertex.position[0], vertex.position[1], vertex.position[2]])) <= lengthTolerance);
    if (matches.length !== 1) {
      return refuse('support-unresolved', `${what}: CAD vertex ${address} is not exactly one vertex node of the analysis surface`);
    }
    return matches[0];
  };

  const fixed = new Map<number, boolean[]>();
  settings.supports.forEach((support, index) => {
    const what = `support ${index}`;
    const flags = fixedFlags(support.fixed, what);
    const targets = support.kind === 'edge' ? chainOf(support.edge, 'support-unresolved', what)
      : support.kind === 'vertex' ? [vertexNode(support.vertex, what)]
        : refuse('invalid-settings', `${what} must be on a CAD edge or vertex`);
    for (const node of targets) {
      const row = fixed.get(node) ?? [false, false, false, false, false, false];
      flags.forEach((restrained, axis) => { if (restrained) row[axis] = true; });
      fixed.set(node, row);
    }
  });
  const loads = new Map<number, number[]>();
  settings.edgeLoads.forEach((load, index) => {
    const what = `edge load ${index}`;
    const chain = chainOf(load.edge, 'load-unresolved', what);
    const normals = chain.slice(1).map((node, k) => {
      const using = meshEdges.get(edgeKey(chain[k], node)) ?? [];
      const normal = normalOf(using[0]);
      if (using.some(t => norm(sub(normalOf(t), normal)) > 1e-9)) {
        return refuse('edge-load-fold', `${what}: segment ${k} lies on a fold between differently oriented elements, `
          + 'so a line load there has no single shell normal');
      }
      return normal;
    });
    const rows = distributeShellEdgeLoad(chain.map(node => nodes[node]), normals, load.forceNPerMm, load.momentNmmPerMm);
    chain.forEach((node, k) => {
      const row = loads.get(node) ?? [0, 0, 0, 0, 0, 0];
      rows[k].forEach((value, axis) => { row[axis] += value; });
      loads.set(node, row);
    });
  });
  const toVector = (row: readonly number[], start: number): ShellVector3 => [row[start], row[start + 1], row[start + 2]];
  const input: ShellAnalysisInput = { schema: SHELL_ANALYSIS_SCHEMA,
    source: { documentId: context.documentId, revision: context.revision, meshKey: JSON.stringify({ featureId: mesh.source.featureId,
      bodyKey: mesh.source.bodyKey, deflection: mesh.deflection, thicknessMm: saved.thicknessMm, offsetMm: saved.offsetMm }) },
    units: 'N-mm-MPa-rad', surface: 'explicit-reference-surface', nodes,
    elements: Array.from({ length: triangleCount }, (_, t) => ({ nodes: triangleNodes(t), materialId: material.id,
      thicknessMm: saved.thicknessMm, offsetMm: 0 })),
    materials: [{ id: material.id, youngMPa: material.youngMPa, poisson: material.poisson }],
    constraints: [...fixed].sort(([a], [b]) => a - b).map(([node, row]) => ({ node, fixed: fixedFlags(row, `node ${node}`) })),
    nodalLoads: [...loads].sort(([a], [b]) => a - b).filter(([, row]) => row.some(value => value !== 0))
      .map(([node, row]) => ({ node, forceN: toVector(row, 0), momentNmm: toVector(row, 3) })) };
  const translated = translateShellAnalysis(input);
  return { saved, source: { ...mesh.source }, mesh, faces, elementFaces, midsurface: { offsetMm: saved.offsetMm, shiftMm },
    referenceNodes, input: translated.input, plan: translated.plan };
}

/** Maps every decoded element, integration point and node to the CAD face keys; refuses a missing or extra face. */
export function bindCadShellResult(prepared: CadShellPrepared, result: ShellAnalysisResult): CadShellAnalysisResult {
  const { input } = prepared;
  if (JSON.stringify(result.source) !== JSON.stringify(input.source)) refuse('result-binding', 'the shell result belongs to another source');
  if (result.elements.length !== input.elements.length || prepared.elementFaces.length !== input.elements.length
    || result.displacement.length !== input.nodes.length) {
    refuse('result-binding', 'the shell result does not have one entry per element and node of the prepared surface');
  }
  const shift = prepared.midsurface.shiftMm;
  const elements = result.elements.map((element, index): CadShellElementResult => {
    const face = prepared.faces[prepared.elementFaces[index]];
    if (face === undefined) return refuse('result-binding', `element ${index} has no CAD face`);
    const [a, b, c] = input.elements[index].nodes;
    const row = (node: number): ShellNodal6 => {
      const [ux, uy, uz, rx, ry, rz] = result.displacement[node];
      return [ux, uy, uz, rx, ry, rz];
    };
    return { element: index, faceKey: face.faceKey, nodes: [a, b, c], thicknessMm: element.thicknessMm,
      points: element.points.map(point => ({ xyzMm: [...point.xyzMm], referenceXyzMm: sub(point.xyzMm, shift),
        topMPa: [...point.surface.topMPa], bottomMPa: [...point.surface.bottomMPa] })),
      displacement: [row(a), row(b), row(c)] };
  });
  const nodeFaces = input.nodes.map(() => new Set<string>());
  for (const element of elements) for (const node of element.nodes) nodeFaces[node].add(element.faceKey);
  const nodes = input.nodes.map((xyz, node): CadShellNodeResult => {
    const [ux, uy, uz, rx, ry, rz] = result.displacement[node];
    return { node, xyzMm: [...xyz], referenceXyzMm: [...prepared.referenceNodes[node]], faceKeys: [...nodeFaces[node]].sort(),
      displacement: [ux, uy, uz, rx, ry, rz] };
  });
  const used = new Set(elements.map(element => element.faceKey)), savedKeys = new Set(prepared.saved.midsurfaceFaces);
  if (used.size !== savedKeys.size || [...savedKeys].some(key => !used.has(key)) || nodes.some(node => node.faceKeys.length === 0)) {
    refuse('result-binding', 'the element face keys are not exactly the saved midsurface faces');
  }
  return { schema: CAD_SHELL_RESULT_SCHEMA, saved: structuredClone(prepared.saved), source: { ...prepared.source },
    midsurface: { offsetMm: prepared.midsurface.offsetMm, shiftMm: [...shift] },
    faces: prepared.faces.map(face => ({ faceKey: face.faceKey, reference: structuredClone(face.reference),
      elements: [...face.triangles], nodes: [...face.nodes], areaMm2: face.areaMm2 })),
    elements, nodes, shell: result };
}

/** decodeShellAnalysis (unchanged W08 checks of the native answer) followed by the CAD face binding. */
export function decodeCadShellAnalysis(prepared: CadShellPrepared, raw: unknown): CadShellAnalysisResult {
  return bindCadShellResult(prepared, decodeShellAnalysis(raw, prepared.plan));
}

/** Runs the fixed native wrapper shellAnalysis.py for a plan and returns its raw JSON answer. */
export type CadShellNativeRunner = (plan: ShellAnalysisPlan, signal: AbortSignal) => Promise<unknown>;
export type CadShellOutcome =
  | { readonly kind: 'result'; readonly result: CadShellAnalysisResult; readonly prepared: CadShellPrepared }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled' };

/** Actual open CAD boundary -> prepareCadShellAnalysis -> native run -> decode -> CAD revision recheck -> binding.
 * A solid is refused before any boundary is requested. No document or previous result is changed. */
export async function analyzeCadShell(kernel: AnalysisBoundarySource, readCurrent: () => CadTetraContext,
  requested: CadShellSettings, run: CadShellNativeRunner, signal?: AbortSignal): Promise<CadShellOutcome> {
  const owner = new AbortController();
  const abort = (): void => owner.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) owner.abort();
  try {
    // Capture the request before the first await; later caller mutation cannot retarget it.
    const settings = structuredClone(requested);
    const initial = readCurrent();
    explicitMidsurface(readShellCadInput(settings.saved), initial);
    if (owner.signal.aborted) return { kind: 'cancelled' };
    const outcome = await requestAnalysisBoundary(kernel, initial.steps, initial.body, { boundary: 'open',
      linearDeflection: settings.surface.linearDeflection, angularDeflection: settings.surface.angularDeflection });
    if (owner.signal.aborted) return { kind: 'cancelled' };
    if (outcome.kind === 'failed') return { kind: 'failed', code: outcome.code, message: outcome.message };
    const current = readCurrent();
    if (current.documentId !== initial.documentId || current.revision !== initial.revision) {
      return { kind: 'failed', code: 'stale', message: 'CAD changed while obtaining the shell boundary' };
    }
    const prepared = prepareCadShellAnalysis(outcome.boundary, current, settings);
    const raw = await run(prepared.plan, owner.signal);
    if (owner.signal.aborted) return { kind: 'cancelled' };
    const latest = readCurrent();
    if (latest.documentId !== initial.documentId || latest.revision !== initial.revision) {
      return { kind: 'failed', code: 'stale', message: 'CAD changed during the native shell analysis' };
    }
    return { kind: 'result', result: decodeCadShellAnalysis(prepared, raw), prepared };
  } catch (error) {
    if (owner.signal.aborted) return { kind: 'cancelled' };
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'cad-shell';
    return { kind: 'failed', code, message: error instanceof Error ? error.message : 'CAD shell analysis failed' };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
