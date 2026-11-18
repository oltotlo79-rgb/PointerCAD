import {
  readBeamAnalysisInputs,
  type BeamAnalysisInputs,
} from '@pointercad/model/beam-analysis';
import { fieldProblem, isRecord, type Checked } from '../guards.js';
import { canonicalSteelPartKey } from './componentSource.js';

/**
 * 入力の中の部品の鍵(`expectedPartKey`)を、部品の options と同じ表で今の表記へ直す(旧版の鋼材の古い表記を持つ古いファイル)。
 * 読む時は読んだ部品の今の鍵と合わせ、書く時は古い表記を書かない。直す物が無い枝は元の値をそのまま返す。
 */
function canonicalPartKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value.map(canonicalPartKeys);
    return items.every((item, index) => item === value[index]) ? value : items;
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).map(([name, item]): [string, unknown] =>
    [name, name === 'expectedPartKey' && typeof item === 'string' ? canonicalSteelPartKey(item) : canonicalPartKeys(item)]);
  return entries.every(([name, item]) => item === value[name]) ? value : Object.fromEntries(entries);
}

/** Single-solid definitions refer to a part's feature/face identities. Keep both codec boundaries identical. */
function requiresPartDocument(input: BeamAnalysisInputs['analyses'][number]): boolean {
  return input.kind === 'fatigue-solid-proportional' || input.kind === 'solid-cad' || input.kind === 'solid-plastic-cad' || input.kind === 'solid-finite-cad'
    || input.kind === 'shell-cad'
    || input.kind === 'shell-cad-analysis'
    || input.kind === 'solid-modal-cad' || input.kind === 'solid-buckling-cad';
}

/** One canonical parser is shared with model edits and the solver boundary.
 * It preserves optional yield capacity/source IDs and leaves legacy missing evidence absent. */
export function readOptionalBeamAnalysisInputs(
  record: Record<string, unknown>,
  ownerId: string,
  ownerKind: 'part' | 'assembly',
  path: string,
): Checked<BeamAnalysisInputs | undefined> {
  if (!Object.hasOwn(record, 'beamAnalysisInputs')) {
    return { ok: true, value: undefined };
  }
  const checked = readBeamAnalysisInputs(canonicalPartKeys(record.beamAnalysisInputs), ownerId);
  if (!checked.ok) {
    return fieldProblem(`${path}.beamAnalysisInputs.${checked.issue.path}`, 'type');
  }
  if (ownerKind === 'part' && checked.value.analyses.some(input => (input.kind === 'standard-members' || input.kind === 'native-bolt-preload'))) {
    return fieldProblem(`${path}.beamAnalysisInputs.analyses`, 'type');
  }
  if (ownerKind === 'assembly' && checked.value.analyses.some(requiresPartDocument)) {
    return fieldProblem(`${path}.beamAnalysisInputs.analyses`, 'type');
  }
  return checked;
}

export function serializeBeamAnalysisInputs(
  value: BeamAnalysisInputs,
  ownerId: string,
  ownerKind: 'part' | 'assembly',
): BeamAnalysisInputs {
  const checked = readBeamAnalysisInputs(canonicalPartKeys(value), ownerId);
  if (!checked.ok) {
    throw new RangeError(`${checked.issue.code}: beamAnalysisInputs.${checked.issue.path}: ${checked.issue.message}`);
  }
  if (ownerKind === 'part' && checked.value.analyses.some(input => (input.kind === 'standard-members' || input.kind === 'native-bolt-preload'))) {
    throw new RangeError('Standard member occurrence inputs require an assembly document');
  }
  if (ownerKind === 'assembly' && checked.value.analyses.some(requiresPartDocument)) {
    throw new RangeError('Single solid CAD inputs require a part document');
  }
  return checked.value;
}
