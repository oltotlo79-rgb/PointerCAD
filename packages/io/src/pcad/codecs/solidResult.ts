import { sha256HexSync } from '@pointercad/model';
import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { isRecord } from '../guards.js';
import { packSolid, SOLID_RESULT_MAX_BYTES, unpackSolid } from './solidResultBinary.js';

type Solid = Extract<SavedAnalysisResult, { kind: 'oofem-linear-solid-tet4' }>;
type Input = Solid['mesh']['input'];
type Controls = NonNullable<Input['meshing']>;
interface Issue { readonly ok: false; readonly issue: 'invalidResult' | 'resultTooLarge' }
type EncodedSolid = Issue | { readonly ok: true; readonly payload: Readonly<Record<string, unknown>>; readonly binary: Uint8Array };
type DecodedSolid = Issue | ({ readonly ok: true } & Pick<Solid, 'mesh' | 'result'>);
const kind = 'oofem-linear-solid-tet4';
const method = 'oofem-ltrspace-isole-native-ldlt/1';

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new RangeError('invalidResult');
}
function failure(error: unknown): Issue {
  return { ok: false, issue: error instanceof RangeError && error.message === 'resultTooLarge' ? 'resultTooLarge' : 'invalidResult' };
}
function text(v: unknown): string {
  requireValue(typeof v === 'string' && v.trim().length > 0);
  return v;
}
function digest(v: unknown): string {
  requireValue(typeof v === 'string' && v.length === 64 && /^[0-9a-f]+$/u.test(v));
  return v;
}
function finite(v: unknown): number {
  requireValue(typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0));
  return v;
}
function count(v: unknown): number {
  const n = finite(v);
  requireValue(Number.isSafeInteger(n) && n >= 0);
  return n;
}

function controls(raw: unknown): Omit<Controls, 'localSizeConstraints'> | undefined {
  if (raw === undefined) return undefined;
  requireValue(isRecord(raw) && isRecord(raw.quality));
  return { targetSizeMm: finite(raw.targetSizeMm), grading: finite(raw.grading),
    maximumOptimizationPasses: count(raw.maximumOptimizationPasses),
    quality: { minimumMeanRatio: finite(raw.quality.minimumMeanRatio), maximumEdgeRatio: finite(raw.quality.maximumEdgeRatio) } };
}

function metadata(raw: unknown) {
  requireValue(isRecord(raw) && isRecord(raw.source) && isRecord(raw.meshSource));
  const source = { documentId: text(raw.source.documentId), revision: count(raw.source.revision), meshKey: digest(raw.source.meshKey) };
  const meshSource = { documentId: text(raw.meshSource.documentId), revision: count(raw.meshSource.revision),
    featureId: text(raw.meshSource.featureId), bodyKey: text(raw.meshSource.bodyKey) };
  requireValue(raw.inputSchema === 'pointercad-convex-plc/1' || raw.inputSchema === 'pointercad-plc/2');
  requireValue(raw.meshSha256 === source.meshKey && meshSource.documentId === source.documentId && meshSource.revision === source.revision);
  const inputSchema: Input['schema'] = raw.inputSchema;
  const tagCount = count(raw.tagCount);
  requireValue(tagCount > 0 && tagCount <= 0xffffffff);
  return { inputSchema, source, meshSource, inputSha256: digest(raw.inputSha256), meshSha256: source.meshKey, tagCount,
    meshing: controls(raw.meshing), strainEnergyNmm: finite(raw.strainEnergyNmm),
    maximumRelativeEquilibriumResidual: finite(raw.maximumRelativeEquilibriumResidual),
    reservedNumericBytes: count(raw.reservedNumericBytes), minimumScaledPivot: finite(raw.minimumScaledPivot),
    volumeMm3: finite(raw.volumeMm3), minTetVolumeMm3: finite(raw.minTetVolumeMm3) };
}

function meshKind(schema: Input['schema']): Solid['mesh']['kind'] {
  return schema === 'pointercad-convex-plc/1' ? 'netgen-convex-tetra-mesh' : 'netgen-tetra-mesh';
}

export function encodeSolid(saved: Solid): EncodedSolid {
  try {
    const { result, mesh } = saved;
    requireValue(result.kind === kind && result.method === method && result.units === 'N-mm-MPa'
      && result.structuralCertification === false && mesh.kind === meshKind(mesh.input.schema) && mesh.input.units === 'mm');
    const meta = metadata({ ...result, inputSchema: mesh.input.schema, meshSource: mesh.input.source, meshSha256: mesh.inputSha256,
      tagCount: mesh.input.tagCount, meshing: mesh.input.meshing, volumeMm3: mesh.volumeMm3, minTetVolumeMm3: mesh.minTetVolumeMm3 });
    const binary = packSolid(saved);
    const payload = { ...meta, nodes: result.displacementMm.length, elements: result.elements.length, boundaryFaces: mesh.boundaryTags.length,
      byteLength: binary.byteLength, binarySha256: sha256HexSync(binary) };
    return { ok: true as const, payload, binary };
  } catch (error) { return failure(error); }
}

export function decodeSolid(raw: unknown, binary: Uint8Array | undefined): DecodedSolid {
  try {
    requireValue(isRecord(raw) && binary !== undefined);
    if (binary.byteLength > SOLID_RESULT_MAX_BYTES) throw new RangeError('resultTooLarge');
    requireValue(count(raw.byteLength) === binary.byteLength && digest(raw.binarySha256) === sha256HexSync(binary.subarray()));
    const meta = metadata(raw);
    const data = unpackSolid(binary, meta.tagCount);
    requireValue(data.mesh.coordinates.length === count(raw.nodes) * 3 && data.result.elements.length === count(raw.elements)
      && data.mesh.boundaryTags.length === count(raw.boundaryFaces));
    const { shells, localSizeConstraints, ...inputArrays } = data.input;
    requireValue((meta.inputSchema === 'pointercad-plc/2' || shells.length === 0)
      && (meta.meshing !== undefined || localSizeConstraints === undefined));
    const meshing = meta.meshing === undefined ? {} : { meshing: { ...meta.meshing,
      ...(localSizeConstraints === undefined ? {} : { localSizeConstraints }) } };
    const common = { ...inputArrays, ...meshing, source: meta.meshSource, units: 'mm' as const, tagCount: meta.tagCount };
    const input: Input = meta.inputSchema === 'pointercad-plc/2' ? { ...common, schema: meta.inputSchema, shells }
      : { ...common, schema: meta.inputSchema };
    const mesh: Solid['mesh'] = { ...data.mesh, input, kind: meshKind(input.schema), inputSha256: meta.meshSha256,
      volumeMm3: meta.volumeMm3, minTetVolumeMm3: meta.minTetVolumeMm3 };
    const result: Solid['result'] = { ...data.result, kind, method, units: 'N-mm-MPa', structuralCertification: false,
      source: meta.source, inputSha256: meta.inputSha256, strainEnergyNmm: meta.strainEnergyNmm,
      maximumRelativeEquilibriumResidual: meta.maximumRelativeEquilibriumResidual, reservedNumericBytes: meta.reservedNumericBytes,
      minimumScaledPivot: meta.minimumScaledPivot };
    return { ok: true as const, result, mesh };
  } catch (error) { return failure(error); }
}
