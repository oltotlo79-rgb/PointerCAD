import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { IO_LIMITS } from '../../limits.js';
import { isRecord } from '../guards.js';
import { readBeamAnalysisResult, serializeBeamAnalysisResult } from './beamAnalysisResult.js';

const SCHEMA = 'pointercad-analysis-result/1';
const codecs = {
  'oofem-linear-beam-3d': { read: readBeamAnalysisResult, write: serializeBeamAnalysisResult },
} satisfies Record<SavedAnalysisResult['kind'], { read: typeof readBeamAnalysisResult; write: typeof serializeBeamAnalysisResult }>;

function knownKind(value: unknown): value is SavedAnalysisResult['kind'] {
  return typeof value === 'string' && Object.hasOwn(codecs, value);
}

export type AnalysisResultIssue = 'invalidResult' | 'unknownSchema' | 'unknownKind' | 'bindingMismatch';
type Decoded = { readonly ok: true; readonly value: SavedAnalysisResult }
  | { readonly ok: false; readonly issue: AnalysisResultIssue };

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

export function readAnalysisResult(bytes: Uint8Array, id: string, binding: string): Decoded {
  const raw = parseEnvelope(bytes);
  if (!isRecord(raw) || typeof raw.schema !== 'string') return { ok: false, issue: 'invalidResult' };
  if (raw.schema !== SCHEMA) return { ok: false, issue: 'unknownSchema' };
  if (typeof raw.kind !== 'string') return { ok: false, issue: 'invalidResult' };
  if (!knownKind(raw.kind)) return { ok: false, issue: 'unknownKind' };
  if (Object.keys(raw).length !== 7) return { ok: false, issue: 'invalidResult' };
  if (raw.analysisId !== id || !validVersion(raw.appVersion) || typeof raw.bindingSha256 !== 'string'
    || raw.bindingSha256.length !== 64 || !/^[0-9a-f]{64}$/u.test(raw.bindingSha256)) return { ok: false, issue: 'invalidResult' };
  if (raw.bindingSha256 !== binding) return { ok: false, issue: 'bindingMismatch' };
  const payload = codecs[raw.kind].read(raw.result, 'result');
  if (!payload.ok || payload.value.kind !== raw.kind || payload.value.analysisId !== id
    || payload.value.analysisRevision !== raw.analysisRevision) return { ok: false, issue: 'invalidResult' };
  return { ok: true, value: { analysisId: id, kind: raw.kind, analysisRevision: payload.value.analysisRevision,
    bindingSha256: binding, appVersion: raw.appVersion, result: payload.value } };
}

export function serializeAnalysisResult(saved: SavedAnalysisResult, id: string, binding: string): Uint8Array | undefined {
  if (saved.analysisId !== id || !knownKind(saved.kind) || !validVersion(saved.appVersion)) return undefined;
  const codec = codecs[saved.kind];
  const checked = codec.read(saved.result, 'result');
  if (!checked.ok || checked.value.kind !== saved.kind || checked.value.analysisId !== id
    || checked.value.analysisRevision !== saved.analysisRevision) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify({
    schema: SCHEMA, analysisId: id, kind: saved.kind, analysisRevision: saved.analysisRevision,
    bindingSha256: binding, appVersion: saved.appVersion, result: codec.write(checked.value),
  }));
  return bytes.byteLength <= IO_LIMITS.archiveEntryExpandedBytes ? bytes : undefined;
}
