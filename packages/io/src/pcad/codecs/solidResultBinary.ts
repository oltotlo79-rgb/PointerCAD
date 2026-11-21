import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';

type Solid = Extract<SavedAnalysisResult, { kind: 'oofem-linear-solid-tet4' }>;
type Input = Solid['mesh']['input'];
type Shell = Extract<Input, { schema: 'pointercad-plc/2' }>['shells'][number];
type Local = NonNullable<NonNullable<Input['meshing']>['localSizeConstraints']>[number];
interface SolidArrays {
  readonly input: Pick<Input, 'coordinates' | 'triangles' | 'tags'> & {
    readonly shells: readonly Shell[];
    readonly localSizeConstraints: readonly Local[] | undefined;
  };
  readonly mesh: Pick<Solid['mesh'], 'coordinates' | 'tetrahedra' | 'boundaryTriangles' | 'boundaryTags'>;
  readonly result: Pick<Solid['result'], 'displacementMm' | 'reactionN' | 'reactionsN' | 'elements' | 'nativeElementForcesN'>;
}

export const SOLID_RESULT_MAX_BYTES = 16 * 1024 * 1024;
const magic = 0x31525350; // ASCII PSR1
const headerBytes = 40;

function check(condition: boolean): asserts condition {
  if (!condition) throw new RangeError('invalidResult');
}

function uint(value: number, limit = 0x100000000): number {
  check(Number.isInteger(value) && !Object.is(value, -0) && value >= 0 && value < limit);
  return value;
}

function real(value: number): number {
  check(Number.isFinite(value) && !Object.is(value, -0));
  return value;
}

interface Counts {
  nodes: number; elements: number; faces: number; inputNodes: number; inputFaces: number;
  flags: number; shells: number; shellFaces: number; locals: number;
}

function countsOf({ result, mesh }: Solid): Counts {
  const input = mesh.input;
  const shells = input.schema === 'pointercad-plc/2' ? input.shells : [];
  const locals = input.meshing?.localSizeConstraints;
  return { nodes: uint(mesh.coordinates.length / 3), elements: uint(mesh.tetrahedra.length / 4),
    faces: uint(mesh.boundaryTriangles.length / 3), inputNodes: uint(input.coordinates.length / 3),
    inputFaces: uint(input.triangles.length / 3), flags: Number(result.reactionsN !== undefined) + 2 * Number(locals !== undefined),
    shells: shells.length, shellFaces: shells.reduce((sum, shell) => sum + shell.triangles.length, 0),
    locals: locals?.length ?? 0 };
}

function byteLength(c: Counts): number {
  check(c.nodes >= 4 && c.inputNodes >= 4 && c.elements > 0 && c.faces > 0 && c.inputFaces > 0
    && c.flags <= 3 && (c.locals === 0 || (c.flags & 2) !== 0));
  // Each element owns 4 indices, 6 strains, 6 stresses and 12 native force components.
  const size = headerBytes + c.nodes * (72 + (c.flags & 1) * 24) + c.elements * 208 + c.faces * 16
    + c.inputNodes * 24 + c.inputFaces * 16 + c.shells * 8 + c.shellFaces * 4 + c.locals * 32;
  if (size > SOLID_RESULT_MAX_BYTES) throw new RangeError('resultTooLarge');
  return size;
}

/** All fields little endian. Fixed header (10 uint32) is followed by:
 * input xyz/f64, triangles/u32, tags/u32; shells (role, count, triangle ids/u32); local xyz+size/f64;
 * mesh xyz/f64, tetrahedra/u32, boundary triangles/u32, tags/u32;
 * displacement, reaction, optional native reaction (xyz/f64); element strain[6], stress[6]; native forces[12]/f64.
 * Header: PSR1, node/tet/face counts, input node/face counts, flags, shell count/total indices, local count.
 */
class Cursor {
  offset = 0;
  constructor(readonly view: DataView) {}
  writeUint(n: number, limit?: number): void { this.view.setUint32(this.offset, uint(n, limit), true); this.offset += 4; }
  readUint(limit?: number): number { const n = this.view.getUint32(this.offset, true); this.offset += 4; return uint(n, limit); }
  writeReal(n: number): void { this.view.setFloat64(this.offset, real(n), true); this.offset += 8; }
  readReal(): number { const n = this.view.getFloat64(this.offset, true); this.offset += 8; return real(n); }
  read3(): [number, number, number] { return [this.readReal(), this.readReal(), this.readReal()]; }
  read6(): [number, number, number, number, number, number] { return [...this.read3(), ...this.read3()]; }
  writeValues(values: readonly number[], length: number, limit?: number): void {
    check(values.length === length);
    for (const n of values) {
      if (limit === undefined) this.writeReal(n);
      else this.writeUint(n, limit);
    }
  }
  writeRows(rows: readonly (readonly number[])[], count: number, width: number): void {
    check(rows.length === count);
    for (const row of rows) this.writeValues(row, width);
  }
}

function writeInput(w: Cursor, input: Input, c: Counts): void {
  w.writeValues(input.coordinates, c.inputNodes * 3);
  w.writeValues(input.triangles, c.inputFaces * 3, c.inputNodes);
  w.writeValues(input.tags, c.inputFaces, input.tagCount);
  if (input.schema === 'pointercad-plc/2') {
    for (const shell of input.shells) {
      check(shell.role === 'outer' || shell.role === 'cavity');
      w.writeUint(Number(shell.role === 'cavity'));
      w.writeUint(shell.triangles.length);
      w.writeValues(shell.triangles, shell.triangles.length, c.inputFaces);
    }
  }
  for (const local of input.meshing?.localSizeConstraints ?? []) {
    w.writeValues(local.positionMm, 3);
    w.writeReal(local.targetSizeMm);
  }
}

export function packSolid(saved: Solid) {
  const { mesh, result } = saved;
  const c = countsOf(saved);
  const bytes = new Uint8Array(byteLength(c));
  const w = new Cursor(new DataView(bytes.buffer));
  for (const n of [magic, c.nodes, c.elements, c.faces, c.inputNodes, c.inputFaces,
    c.flags, c.shells, c.shellFaces, c.locals]) w.writeUint(n);
  writeInput(w, mesh.input, c);
  w.writeValues(mesh.coordinates, c.nodes * 3);
  w.writeValues(mesh.tetrahedra, c.elements * 4, c.nodes);
  w.writeValues(mesh.boundaryTriangles, c.faces * 3, c.nodes);
  w.writeValues(mesh.boundaryTags, c.faces, mesh.input.tagCount);
  w.writeRows(result.displacementMm, c.nodes, 3);
  w.writeRows(result.reactionN, c.nodes, 3);
  if (result.reactionsN !== undefined) w.writeRows(result.reactionsN, c.nodes, 3);
  check(result.elements.length === c.elements);
  for (const element of result.elements) {
    w.writeValues(element.strain, 6);
    w.writeValues(element.stressMPa, 6);
  }
  w.writeRows(result.nativeElementForcesN, c.elements, 12);
  check(w.offset === bytes.byteLength);
  return bytes;
}

function readCounts(r: Cursor): Counts {
  check(r.readUint() === magic);
  return { nodes: r.readUint(), elements: r.readUint(), faces: r.readUint(), inputNodes: r.readUint(), inputFaces: r.readUint(),
    flags: r.readUint(), shells: r.readUint(), shellFaces: r.readUint(), locals: r.readUint() };
}

function readInput(r: Cursor, c: Counts, tagCount: number) {
  const coordinates = Array.from({ length: c.inputNodes * 3 }, () => r.readReal());
  const triangles = Array.from({ length: c.inputFaces * 3 }, () => r.readUint(c.inputNodes));
  const tags = Array.from({ length: c.inputFaces }, () => r.readUint(tagCount));
  let remaining = c.shellFaces;
  const shells: Shell[] = Array.from({ length: c.shells }, () => {
    const role = r.readUint(2) === 0 ? 'outer' : 'cavity';
    const length = r.readUint(remaining + 1);
    remaining -= length;
    return { role, triangles: Array.from({ length }, () => r.readUint(c.inputFaces)) };
  });
  check(remaining === 0);
  const localSizeConstraints: Local[] | undefined = (c.flags & 2) === 0 ? undefined
    : Array.from({ length: c.locals }, () => ({ positionMm: r.read3(), targetSizeMm: r.readReal() }));
  return { coordinates, triangles, tags, shells, localSizeConstraints };
}

export function unpackSolid(bytes: Uint8Array, tagCount: number): SolidArrays {
  const r = new Cursor(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const c = readCounts(r);
  check(byteLength(c) === bytes.byteLength);
  const input = readInput(r, c, tagCount);
  const coordinates = Array.from({ length: c.nodes * 3 }, () => r.readReal());
  const tetrahedra = Array.from({ length: c.elements * 4 }, () => r.readUint(c.nodes));
  const boundaryTriangles = Array.from({ length: c.faces * 3 }, () => r.readUint(c.nodes));
  const boundaryTags = Array.from({ length: c.faces }, () => r.readUint(tagCount));
  const nodeVectors = () => Array.from({ length: c.nodes }, () => r.read3());
  const displacementMm = nodeVectors(), reactionN = nodeVectors();
  const native = (c.flags & 1) === 0 ? {} : { reactionsN: nodeVectors() };
  const elements = Array.from({ length: c.elements }, () => ({ strain: r.read6(), stressMPa: r.read6() }));
  const nativeElementForcesN = Array.from({ length: c.elements }, () => Array.from({ length: 12 }, () => r.readReal()));
  check(r.offset === bytes.byteLength);
  return { input, mesh: { coordinates, tetrahedra, boundaryTriangles, boundaryTags },
    result: { displacementMm, reactionN, ...native, elements, nativeElementForcesN } };
}
