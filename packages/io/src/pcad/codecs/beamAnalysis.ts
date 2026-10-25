import {
  readBeamAnalysisInputs,
  type BeamAnalysisInputs,
} from '@pointercad/model/beam-analysis';
import { fieldProblem, type Checked } from '../guards.js';

/** Single-solid definitions refer to a part's feature/face identities. Keep both codec boundaries identical. */
function requiresPartDocument(input: BeamAnalysisInputs['analyses'][number]): boolean {
  return input.kind === 'fatigue-solid-proportional' || input.kind === 'solid-cad' || input.kind === 'solid-plastic-cad'
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
  const checked = readBeamAnalysisInputs(record.beamAnalysisInputs, ownerId);
  if (!checked.ok) {
    return fieldProblem(`${path}.beamAnalysisInputs.${checked.issue.path}`, 'type');
  }
  if (ownerKind === 'part' && checked.value.analyses.some(input => input.kind === 'standard-members')) {
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
  const checked = readBeamAnalysisInputs(value, ownerId);
  if (!checked.ok) {
    throw new RangeError(`${checked.issue.code}: beamAnalysisInputs.${checked.issue.path}: ${checked.issue.message}`);
  }
  if (ownerKind === 'part' && checked.value.analyses.some(input => input.kind === 'standard-members')) {
    throw new RangeError('Standard member occurrence inputs require an assembly document');
  }
  if (ownerKind === 'assembly' && checked.value.analyses.some(requiresPartDocument)) {
    throw new RangeError('Single solid CAD inputs require a part document');
  }
  return checked.value;
}
