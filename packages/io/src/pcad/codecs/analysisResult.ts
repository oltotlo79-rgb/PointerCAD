import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { IO_LIMITS } from '../../limits.js';
import { isRecord } from '../guards.js';
import { readBeamAnalysisResult, serializeBeamAnalysisResult } from './beamAnalysisResult.js';
import { decodeSolid, encodeSolid } from './solidResult.js';
import { SOLID_RESULT_MAX_BYTES } from './solidResultBinary.js';

const SCHEMA = 'pointercad-analysis-result/1';
const codecs = {
  'oofem-linear-beam-3d': { read: readBeamAnalysisResult, write: serializeBeamAnalysisResult },
  'oofem-linear-solid-tet4': { read: decodeSolid, write: encodeSolid },
} satisfies Record<SavedAnalysisResult['kind'], unknown>;

export type AnalysisResultIssue = 'invalidResult' | 'unknownSchema' | 'unknownKind' | 'bindingMismatch' | 'resultTooLarge';
interface Failure { readonly ok: false; readonly issue: AnalysisResultIssue }
type Decoded = { readonly ok: true; readonly value: SavedAnalysisResult } | Failure;
type Encoded = { readonly ok: true; readonly json: Uint8Array; readonly binary?: Uint8Array } | Failure;

function parseEnvelope(bytes: Uint8Array): unknown {
  if (bytes.byteLength > IO_LIMITS.archiveEntryExpandedBytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value;
  } catch {
    return null;
  }
}

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && version.trim().length > 0;
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function readAnalysisResult(bytes: Uint8Array, id: string, binding: string, binary?: Uint8Array): Decoded {
  const raw = parseEnvelope(bytes);
  if (!isRecord(raw) || typeof raw.schema !== 'string') return { ok: false, issue: 'invalidResult' };
  if (raw.schema !== SCHEMA) return { ok: false, issue: 'unknownSchema' };
  if (typeof raw.kind !== 'string') return { ok: false, issue: 'invalidResult' };
  if (!Object.hasOwn(codecs, raw.kind)) return { ok: false, issue: 'unknownKind' };
  if (Object.keys(raw).length !== 7 || !validRevision(raw.analysisRevision)
    || raw.analysisId !== id || !validVersion(raw.appVersion) || typeof raw.bindingSha256 !== 'string'
    || raw.bindingSha256.length !== 64 || !/^[0-9a-f]{64}$/u.test(raw.bindingSha256)) return { ok: false, issue: 'invalidResult' };
  if (raw.bindingSha256 !== binding) return { ok: false, issue: 'bindingMismatch' };
  const identity = { analysisId: id, analysisRevision: raw.analysisRevision, bindingSha256: binding, appVersion: raw.appVersion };
  if (raw.kind === 'oofem-linear-solid-tet4') {
    if (bytes.length + (binary?.length ?? 0) > SOLID_RESULT_MAX_BYTES) return { ok: false, issue: 'resultTooLarge' };
    const solid = codecs[raw.kind].read(raw.result, binary);
    if (!solid.ok) return solid;
    return { ok: true, value: { ...identity, kind: raw.kind, result: solid.result, mesh: solid.mesh,
      ...(solid.prepared === undefined ? {} : { prepared: solid.prepared }) } };
  }
  if (raw.kind !== 'oofem-linear-beam-3d' || binary !== undefined) return { ok: false, issue: 'invalidResult' };
  const payload = codecs[raw.kind].read(raw.result, 'result');
  if (!payload.ok || payload.value.kind !== raw.kind || payload.value.analysisId !== id
    || payload.value.analysisRevision !== raw.analysisRevision) return { ok: false, issue: 'invalidResult' };
  return { ok: true, value: { ...identity, kind: raw.kind, result: payload.value } };
}

export function serializeAnalysisResult(saved: SavedAnalysisResult, id: string, binding: string): Encoded {
  if (saved.analysisId !== id || !validVersion(saved.appVersion) || !validRevision(saved.analysisRevision)) return { ok: false, issue: 'invalidResult' };
  const envelope = { schema: SCHEMA, analysisId: id, kind: saved.kind, analysisRevision: saved.analysisRevision,
    bindingSha256: binding, appVersion: saved.appVersion };
  if (saved.kind === 'oofem-linear-solid-tet4') {
    const solid = codecs[saved.kind].write(saved);
    if (!solid.ok) return solid;
    const json = new TextEncoder().encode(JSON.stringify({ ...envelope, result: solid.payload }));
    return json.length + solid.binary.length <= SOLID_RESULT_MAX_BYTES ? { ok: true, json, binary: solid.binary }
      : { ok: false, issue: 'resultTooLarge' };
  }
  if (saved.kind !== 'oofem-linear-beam-3d') return { ok: false, issue: 'unknownKind' };
  const checked = codecs[saved.kind].read(saved.result, 'result');
  if (!checked.ok || checked.value.analysisId !== id || checked.value.analysisRevision !== saved.analysisRevision) {
    return { ok: false, issue: 'invalidResult' };
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...envelope, result: codecs[saved.kind].write(checked.value) }));
  return json.length <= IO_LIMITS.archiveEntryExpandedBytes ? { ok: true, json } : { ok: false, issue: 'resultTooLarge' };
}
