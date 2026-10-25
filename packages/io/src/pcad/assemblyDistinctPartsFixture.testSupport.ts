/**
 * EX-12 W01: the one table of 1000 distinct part dimensions, shared by two fixtures (test-only; no product code imports
 * this file):
 * - the io round trip of 1000 box definitions (assemblyDistinctPartsRoundtrip.test.ts, expectations unchanged), and
 * - the host assembly of 1000 distinct real shapes (e2e/tests/assembly1000HostFixture.ts and the real-kernel check in
 *   the same io test file). Definition i uses the same sizes (i + 1, 2 + i / 10, 3 + i % 7) and becomes, by i % 3, a
 *   box, a cylinder or a box with a through hole. Every kind carries its closed-form volume and XYZ range below.
 * The checks here use only the formulas and the written placements; they never read solver output as an expectation.
 */
import {
  absoluteCoordinate, addComponent, appendSolid, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  embedPart, EMPTY_PART_LIBRARY,
  type AssemblyDocument, type BooleanFeature, type Joint, type PartDocument, type PartLibrary, type PrimitiveFeature,
  type RigidPlacement, type SolidBody, type Vec3,
} from '@pointercad/model';

export const DISTINCT_PART_COUNT = 1000;
export const ev = (value: number) => ({ source: String(value), display: String(value), value });

/** Box i: sizes (i + 1, 2 + i / 10, 3 + i % 7); placement i: position (i, 2i, -i), rotation about z by i mrad. */
export function sizesOf(index: number): readonly [number, number, number] { return [index + 1, 2 + index / 10, 3 + (index % 7)]; }
/** Fixture zero convention: only +0. JSON cannot carry -0, so z is 0 - index (+0 for index 0), never -index. */
export function positionOf(index: number): readonly [number, number, number] { return [index, 2 * index, 0 - index]; }
export function rotationOf(index: number): readonly [number, number, number, number] {
  const half = index / 2000;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

/** All authored angles have w > 0. The model stores their unit-length quaternion, not raw sin/cos doubles.
 * Compute that expected representation independently; persistence itself still requires exact document/byte equality. */
export function storedRotationOf(index: number): readonly [number, number, number, number] {
  const rotation = rotationOf(index);
  const factor = 1 / Math.hypot(...rotation);
  return [0, 0, rotation[2] * factor, rotation[3] * factor];
}

export function boxPart(index: number): PartDocument {
  const [x, y, z] = sizesOf(index);
  const box: PrimitiveFeature = { id: 'box-1', name: `box ${String(index)}`, kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: ev(x), sizeY: ev(y), sizeZ: ev(z) } };
  return appendSolid({ ...createEmptyPartDocument(), id: `definition-${String(index)}`, name: `definition ${String(index)}` }, box);
}

export function placementOf(position: readonly [number, number, number], rotation: readonly [number, number, number, number]) {
  return { position: [ev(position[0]), ev(position[1]), ev(position[2])], rotation: [...rotation] } as const;
}

// ---- host assembly: 1000 distinct real shapes --------------------------------------------------------------------

export type HostShape =
  | { readonly kind: 'box'; readonly sizeX: number; readonly sizeY: number; readonly sizeZ: number }
  | { readonly kind: 'cylinder'; readonly radius: number; readonly height: number }
  | { readonly kind: 'holedBox'; readonly sizeX: number; readonly sizeY: number; readonly sizeZ: number;
      readonly holeRadius: number };
export type HostShapeKind = HostShape['kind'];
export const HOST_SHAPE_KINDS: readonly HostShapeKind[] = ['box', 'cylinder', 'holedBox'];

/** Kind by i % 3 on the shared sizes: cylinder r = sy / 2, h = sx; hole radius min(sx, sy) / 4 (wall >= hole radius). */
export function hostShapeOf(index: number): HostShape {
  const [sizeX, sizeY, sizeZ] = sizesOf(index);
  const kind = HOST_SHAPE_KINDS[index % HOST_SHAPE_KINDS.length];
  if (kind === 'cylinder') return { kind, radius: sizeY / 2, height: sizeX };
  if (kind === 'holedBox') return { kind, sizeX, sizeY, sizeZ, holeRadius: Math.min(sizeX, sizeY) / 4 };
  return { kind: 'box', sizeX, sizeY, sizeZ };
}

/** Id of the one body each host definition yields (the boolean consumes its box and tool, kernel §0.a-0.5). */
export function hostBodyFeatureIdOf(index: number): string {
  const kind = hostShapeOf(index).kind;
  return kind === 'box' ? 'box-1' : kind === 'cylinder' ? 'cylinder-1' : 'cut-1';
}

function primitive(id: string, z: number, shape: PrimitiveFeature['shape']): PrimitiveFeature {
  return { id, name: id, kind: 'primitive', suppressed: false, origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, z) },
    axis: { kind: 'world', axis: 'z' }, shape };
}

/**
 * Definition i of the host. Primitive conventions (kernel makePrimitive.test.ts): a box is centred on its origin, a
 * cylinder stands on its origin along +z. The hole tool starts 1 mm below the box and ends 1 mm above it (through).
 */
export function hostPartOf(index: number): PartDocument {
  const shape = hostShapeOf(index);
  const empty: PartDocument = { ...createEmptyPartDocument(), id: `definition-${String(index)}`, name: `definition ${String(index)}` };
  if (shape.kind === 'cylinder') {
    return appendSolid(empty, primitive('cylinder-1', 0, { kind: 'cylinder', radius: ev(shape.radius), height: ev(shape.height) }));
  }
  const box = primitive('box-1', 0, { kind: 'box', sizeX: ev(shape.sizeX), sizeY: ev(shape.sizeY), sizeZ: ev(shape.sizeZ) });
  if (shape.kind === 'box') return appendSolid(empty, box);
  const tool = primitive('hole-tool-1', 0 - shape.sizeZ / 2 - 1, { kind: 'cylinder', radius: ev(shape.holeRadius), height: ev(shape.sizeZ + 2) });
  const cut: BooleanFeature = { id: 'cut-1', name: 'through hole', kind: 'boolean', suppressed: false, operation: 'subtract',
    targetFeatureId: box.id, toolFeatureId: tool.id };
  return appendSolid(appendSolid(appendSolid(empty, box), tool), cut);
}

/** Closed-form shape in part coordinates: face count, volume and XYZ range. */
export interface ShapeOracle {
  readonly faces: number;
  readonly volume: number;
  readonly min: Vec3;
  readonly max: Vec3;
}

export function hostShapeOracle(index: number): ShapeOracle { return shapeOracleOf(hostShapeOf(index)); }

/** Signature of a closed-form shape (the same fields as geometrySignature of a generated one). */
export function oracleSignature(oracle: ShapeOracle): string {
  return [String(oracle.faces), oracle.volume.toPrecision(12), ...[...oracle.min, ...oracle.max].map((value) => value.toFixed(6))].join('|');
}

export function shapeOracleOf(shape: HostShape): ShapeOracle {
  if (shape.kind === 'cylinder') {
    const { radius: r, height: h } = shape;
    return { faces: 3, volume: Math.PI * r * r * h, min: [-r, -r, 0], max: [r, r, h] };
  }
  const { sizeX: x, sizeY: y, sizeZ: z } = shape;
  const min: Vec3 = [-x / 2, -y / 2, -z / 2], max: Vec3 = [x / 2, y / 2, z / 2];
  if (shape.kind === 'box') return { faces: 6, volume: x * y * z, min, max };
  return { faces: 7, volume: x * y * z - Math.PI * shape.holeRadius ** 2 * z, min, max };
}

// ---- host layout (r141 successor): 120 joined groups and 760 fixed stock parts -------------------------------------

export const HOST_TOTAL = DISTINCT_PART_COUNT;
export const HOST_GROUPS = 120;
export const HOST_SLIDER_GROUPS: readonly number[] = [0, 1];
export const HOST_SAVED_AT = '2026-10-25T00:00:00.000Z';
const GROUPED = 2 * HOST_GROUPS;

/** anchor-g (fixed) and member-g (movable) for components 2g and 2g + 1, then stock-k (fixed). */
export function hostComponentName(index: number): string {
  if (index >= GROUPED) return `stock-${String(index - GROUPED)}`;
  return `${index % 2 === 0 ? 'anchor' : 'member'}-${String(Math.floor(index / 2))}`;
}
export function hostFixedOf(index: number): boolean { return index >= GROUPED || index % 2 === 0; }
export function hostJointId(group: number): string { return `host-joint-${String(group)}`; }
/** A member shares its anchor's written placement, so every joint holds at rest. */
function placementBase(index: number): number { return index < GROUPED ? index - (index % 2) : index; }
export function hostPositionOf(index: number): Vec3 {
  if (index < GROUPED) return [300 * Math.floor(index / 2), 0, 0];
  const k = index - GROUPED;
  return [200 * (k % 40), 2000 + 200 * Math.floor(k / 40), 0];
}
/** Written angle about z in radians (the shared rotationOf table: i mrad). */
export function hostAngleOf(index: number): number { return placementBase(index) / 1000; }
export function hostRotationOf(index: number): readonly [number, number, number, number] { return rotationOf(placementBase(index)); }
export function hostStoredRotationOf(index: number): readonly [number, number, number, number] {
  return storedRotationOf(placementBase(index));
}

/** Closed-form world XYZ range of component i at its written placement (rotation about z only). */
export function hostWorldRangeOracle(index: number): { readonly min: Vec3; readonly max: Vec3 } {
  const [px, py, pz] = hostPositionOf(index), shape = hostShapeOf(index), angle = hostAngleOf(index);
  if (shape.kind === 'cylinder') {
    const { radius: r, height: h } = shape;
    return { min: [px - r, py - r, pz], max: [px + r, py + r, pz + h] };
  }
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const hx = (c * shape.sizeX + s * shape.sizeY) / 2, hy = (s * shape.sizeX + c * shape.sizeY) / 2, hz = shape.sizeZ / 2;
  return { min: [px - hx, py - hy, pz - hz], max: [px + hx, py + hy, pz + hz] };
}

export interface HostAssemblyFixture {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  /** Part reference of definition i, which component i uses. */
  readonly refs: readonly string[];
}

export async function buildHostAssembly(): Promise<HostAssemblyFixture> {
  let library = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (let index = 0; index < HOST_TOTAL; index += 1) {
    const embedded = await embedPart(library, hostPartOf(index), `definition-${String(index)}.pcad`, '', { importedAt: HOST_SAVED_AT });
    if (embedded.reused) throw new Error(`definition ${String(index)} duplicates an earlier definition`);
    library = embedded.library;
    refs.push(embedded.partRef);
  }
  let document = createAssemblyDocument('host1000');
  for (let index = 0; index < HOST_TOTAL; index += 1) {
    const [x, y, z] = hostPositionOf(index);
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: refs[index] },
      { name: hostComponentName(index), placement: placementOf([x, y, z], hostRotationOf(index)) }));
  }
  const ids = document.components.map((component) => component.id);
  const joints: Joint[] = Array.from({ length: HOST_GROUPS }, (_, group) => ({
    id: hostJointId(group), name: hostJointId(group), kind: HOST_SLIDER_GROUPS.includes(group) ? 'slider' : 'revolute',
    a: { kind: 'origin', componentId: ids[2 * group + 1], element: 'z' },
    b: { kind: 'origin', componentId: ids[2 * group], element: 'z' },
    minValue: null, maxValue: null, suppressed: false,
  }));
  document = { ...document, joints,
    components: document.components.map((component, index) => ({ ...component, fixed: hostFixedOf(index) })) };
  return { document, library, refs };
}

/** Negative fixture: the same assembly whose library lost definition `index` (the component still points at it). */
export function withoutDefinition(fixture: HostAssemblyFixture, index: number): HostAssemblyFixture {
  const ref = fixture.refs[index];
  const parts = new Map(fixture.library.parts), attachments = new Map(fixture.library.attachments);
  parts.delete(ref);
  attachments.delete(ref);
  return { ...fixture, library: { ...fixture.library, partFiles: fixture.library.partFiles.filter((file) => file.ref !== ref),
    parts, attachments } };
}

// ---- checks shared by the io kernel test and the host flow --------------------------------------------------------

const POSITION_MM = 1e-6;
const ROTATION = 1e-9;
const VOLUME_RELATIVE = 1e-9;

function near(actual: readonly number[], expected: readonly number[], tolerance: number): boolean {
  return actual.length === expected.length && expected.every((value, axis) => Math.abs((actual[axis] ?? Number.NaN) - value) <= tolerance);
}

/** The definition's shape read back from its features, or null when it is not one of the three host kinds. */
export function definitionShapeOf(definition: PartDocument): HostShape | null {
  const at = (feature: PrimitiveFeature): readonly number[] | null => feature.origin.kind === 'coordinate'
    && feature.origin.value.mode === 'absolute' && feature.axis.kind === 'world' && feature.axis.axis === 'z'
    ? [feature.origin.value.x.value, feature.origin.value.y.value, feature.origin.value.z.value] : null;
  const [first, second, third] = definition.solids;
  if (definition.solids.length === 1 && first.kind === 'primitive' && near(at(first) ?? [], [0, 0, 0], 0)) {
    const shape = first.shape;
    if (shape.kind === 'box') return { kind: 'box', sizeX: shape.sizeX.value, sizeY: shape.sizeY.value, sizeZ: shape.sizeZ.value };
    if (shape.kind === 'cylinder') return { kind: 'cylinder', radius: shape.radius.value, height: shape.height.value };
    return null;
  }
  if (definition.solids.length !== 3 || first.kind !== 'primitive' || first.shape.kind !== 'box' || second.kind !== 'primitive'
    || second.shape.kind !== 'cylinder' || third.kind !== 'boolean' || third.operation !== 'subtract'
    || third.targetFeatureId !== first.id || third.toolFeatureId !== second.id || !near(at(first) ?? [], [0, 0, 0], 0)) return null;
  const sizeZ = first.shape.sizeZ.value;
  if (!near(at(second) ?? [], [0, 0, 0 - sizeZ / 2 - 1], 0) || second.shape.height.value !== sizeZ + 2) return null;
  return { kind: 'holedBox', sizeX: first.shape.sizeX.value, sizeY: first.shape.sizeY.value, sizeZ,
    holeRadius: second.shape.radius.value };
}

function sameShape(a: HostShape | null, b: HostShape): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every component and definition as the shared table writes them: name, fixed flag, written placement, one distinct
 * definition per component with id definition-i and the kind/dimensions of hostShapeOf(i), and the 120 joints.
 * Returns [] only for the complete host fixture (or its saved and reopened copy).
 */
export function hostDefinitionProblems(document: AssemblyDocument, library: PartLibrary): string[] {
  const problems: string[] = [];
  if (document.components.length !== HOST_TOTAL) problems.push(`components: ${String(document.components.length)} of ${String(HOST_TOTAL)}`);
  const refs = new Set<string>(), definitionIds = new Set<string>();
  document.components.forEach((component, index) => {
    const name = hostComponentName(index);
    if (component.name !== name) problems.push(`component ${String(index)}: name ${component.name}, expected ${name}`);
    if (component.fixed !== hostFixedOf(index)) problems.push(`${name}: fixed ${String(component.fixed)}`);
    if (!near(component.placement.position.map((value) => value.value), hostPositionOf(index), POSITION_MM)
      || !near(component.placement.rotation, hostStoredRotationOf(index), ROTATION)) problems.push(`${name}: written placement changed`);
    if (component.source.kind !== 'part') { problems.push(`${name}: source ${component.source.kind}`); return; }
    refs.add(component.source.partRef);
    const definition = library.parts.get(component.source.partRef);
    if (definition === undefined) { problems.push(`${name}: definition ${component.source.partRef} missing`); return; }
    definitionIds.add(definition.id);
    if (definition.id !== `definition-${String(index)}`) problems.push(`${name}: definition id ${definition.id}`);
    if (!sameShape(definitionShapeOf(definition), hostShapeOf(index))) problems.push(`${name}: definition shape differs from the table`);
  });
  if (refs.size !== HOST_TOTAL) problems.push(`distinct part references: ${String(refs.size)} of ${String(HOST_TOTAL)}`);
  if (definitionIds.size !== HOST_TOTAL) problems.push(`distinct definition ids: ${String(definitionIds.size)} of ${String(HOST_TOTAL)}`);
  if (document.joints.length !== HOST_GROUPS) problems.push(`joints: ${String(document.joints.length)} of ${String(HOST_GROUPS)}`);
  document.joints.forEach((joint, group) => {
    const anchor = document.components[2 * group]?.id, member = document.components[2 * group + 1]?.id;
    const kind = HOST_SLIDER_GROUPS.includes(group) ? 'slider' : 'revolute';
    if (joint.id !== hostJointId(group) || joint.kind !== kind || joint.suppressed || joint.a.kind !== 'origin'
      || joint.a.componentId !== member || joint.a.element !== 'z' || joint.b.kind !== 'origin' || joint.b.componentId !== anchor
      || joint.b.element !== 'z') problems.push(`joint ${String(group)}: differs from the table`);
  });
  return problems;
}

/** Part-coordinate geometry of one generated body, read from its exact B-rep (vertices, straight and circular edges). */
export interface PartGeometry {
  readonly faces: number;
  readonly volume: number;
  readonly points: readonly Vec3[];
  readonly circles: readonly { readonly center: Vec3; readonly axis: Vec3; readonly radius: number }[];
}

/**
 * Mesh vertices need not reach a circle's extremes, so the range comes from B-rep data: vertices, line end points
 * and full circles (centre, axis, radius). Any other edge (arc, ellipse, free curve) is refused, never approximated.
 */
export function partGeometryOf(body: SolidBody): PartGeometry | string {
  const points: Vec3[] = body.vertices.map((vertex) => vertex.position);
  const circles: { center: Vec3; axis: Vec3; radius: number }[] = [];
  for (const edge of body.edges) {
    if (edge.curveKind === 'line') { points.push(edge.start, edge.end); continue; }
    const { radius, axis, axisOrigin } = edge;
    if (edge.curveKind !== 'circle' || radius === null || axis === null || axisOrigin === undefined || axisOrigin === null) {
      return `edge ${String(edge.index)}: ${edge.curveKind} edge without a circle definition`;
    }
    const full = 2 * Math.PI * radius;
    if (Math.abs(edge.length - full) > VOLUME_RELATIVE * full) return `edge ${String(edge.index)}: circular arc, not a full circle`;
    circles.push({ center: axisOrigin, axis, radius });
  }
  if (points.length === 0) return 'no B-rep vertex';
  return { faces: body.faces.length, volume: body.volume, points, circles };
}

/** p' = R(q) p (unit quaternion [x, y, z, w]): p + 2w (q x p) + 2 q x (q x p). */
function rotate(rotation: readonly number[], p: Vec3): Vec3 {
  const [x = 0, y = 0, z = 0, w = 1] = rotation;
  const t: Vec3 = [y * p[2] - z * p[1], z * p[0] - x * p[2], x * p[1] - y * p[0]];
  const u: Vec3 = [y * t[2] - z * t[1], z * t[0] - x * t[2], x * t[1] - y * t[0]];
  return [p[0] + 2 * w * t[0] + 2 * u[0], p[1] + 2 * w * t[1] + 2 * u[1], p[2] + 2 * w * t[2] + 2 * u[2]];
}

const IDENTITY: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** Exact XYZ range of the geometry at a placement: points moved, each circle widened by r sqrt(1 - a_k^2) per axis. */
export function rangeOf(geometry: PartGeometry, placement: RigidPlacement = IDENTITY): { readonly min: Vec3; readonly max: Vec3 } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const include = (centre: Vec3, half: Vec3): void => {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], centre[axis] - half[axis]);
      max[axis] = Math.max(max[axis], centre[axis] + half[axis]);
    }
  };
  const move = (p: Vec3): Vec3 => {
    const r = rotate(placement.rotation, p);
    return [r[0] + placement.position[0], r[1] + placement.position[1], r[2] + placement.position[2]];
  };
  for (const point of geometry.points) include(move(point), [0, 0, 0]);
  for (const circle of geometry.circles) {
    const length = Math.hypot(...circle.axis);
    const a = rotate(placement.rotation, [circle.axis[0] / length, circle.axis[1] / length, circle.axis[2] / length]);
    const half = a.map((value) => circle.radius * Math.sqrt(Math.max(0, 1 - value * value)));
    include(move(circle.center), [half[0] ?? 0, half[1] ?? 0, half[2] ?? 0]);
  }
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/** Geometric signature of a generated shape: face count, volume and part-coordinate XYZ range. */
export function geometrySignature(geometry: PartGeometry): string {
  return oracleSignature({ faces: geometry.faces, volume: geometry.volume, ...rangeOf(geometry) });
}

/** Component i at `placement` with generated geometry against its closed-form values. */
export function hostShapeProblems(index: number, geometry: PartGeometry, placement: RigidPlacement): string[] {
  const name = hostComponentName(index), oracle = hostShapeOracle(index), world = hostWorldRangeOracle(index);
  const problems: string[] = [];
  if (geometry.faces !== oracle.faces) problems.push(`${name}: ${String(geometry.faces)} faces, expected ${String(oracle.faces)}`);
  if (!(Math.abs(geometry.volume - oracle.volume) <= VOLUME_RELATIVE * oracle.volume)) {
    problems.push(`${name}: volume ${String(geometry.volume)}, expected ${String(oracle.volume)}`);
  }
  const local = rangeOf(geometry), placed = rangeOf(geometry, placement);
  if (!near(local.min, oracle.min, POSITION_MM) || !near(local.max, oracle.max, POSITION_MM)) problems.push(`${name}: part XYZ range differs`);
  if (!near(placed.min, world.min, POSITION_MM) || !near(placed.max, world.max, POSITION_MM)) problems.push(`${name}: world XYZ range differs`);
  if (!near(placement.position, hostPositionOf(index), POSITION_MM) || !near(placement.rotation, hostStoredRotationOf(index), ROTATION)) {
    problems.push(`${name}: resolved placement differs from the written one`);
  }
  return problems;
}

export interface HostAssemblyEvidence {
  readonly definitionIds: ReadonlySet<string>;
  readonly generatedShapes: number;
  readonly signatures: ReadonlySet<string>;
  readonly problems: readonly string[];
}

/**
 * The fixture verdict: definitions as written, a resolved placement and exactly one valid generated solid per component,
 * every volume/range on its formula, and 1000 definition ids, 1000 generated shapes and 1000 distinct signatures.
 */
export function verifyHostAssembly(input: {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly errors: readonly { readonly componentId: string; readonly code: string }[];
  readonly bodiesOf: (ref: string) => readonly SolidBody[] | undefined;
}): HostAssemblyEvidence {
  const problems = hostDefinitionProblems(input.document, input.library);
  for (const error of input.errors) problems.push(`resolve ${error.componentId}: ${error.code}`);
  const definitionIds = new Set<string>(), signatures = new Set<string>();
  let generatedShapes = 0;
  input.document.components.forEach((component, index) => {
    const name = hostComponentName(index);
    if (component.source.kind !== 'part') return;
    const definition = input.library.parts.get(component.source.partRef);
    if (definition === undefined) return;
    definitionIds.add(definition.id);
    const bodies = input.bodiesOf(component.source.partRef) ?? [];
    const body = bodies[0];
    if (bodies.length !== 1 || body === undefined || !body.isValid || body.bodyKind !== 'solid'
      || body.featureId !== hostBodyFeatureIdOf(index)) { problems.push(`${name}: ${String(bodies.length)} generated bodies`); return; }
    generatedShapes += 1;
    const geometry = partGeometryOf(body);
    if (typeof geometry === 'string') { problems.push(`${name}: ${geometry}`); return; }
    signatures.add(geometrySignature(geometry));
    const placement = input.placements.get(component.id);
    if (placement === undefined) { problems.push(`${name}: no resolved placement`); return; }
    problems.push(...hostShapeProblems(index, geometry, placement));
  });
  if (definitionIds.size !== HOST_TOTAL) problems.push(`definition ids: ${String(definitionIds.size)} of ${String(HOST_TOTAL)}`);
  if (generatedShapes !== HOST_TOTAL) problems.push(`generated shapes: ${String(generatedShapes)} of ${String(HOST_TOTAL)}`);
  if (signatures.size !== HOST_TOTAL) problems.push(`distinct signatures: ${String(signatures.size)} of ${String(HOST_TOTAL)}`);
  return { definitionIds, generatedShapes, signatures, problems };
}
