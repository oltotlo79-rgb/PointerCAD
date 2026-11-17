import { withinMagnitude } from '../../numericTolerance.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { COUNTERSUNK_SOCKET_SCREW_FAMILY } from '../catalog/families/countersunkSocketScrew.js';
import type { FastenerHeadKind, FasteningHoleEntry, FasteningExtensionRejection } from './holeEntryTypes.js';
import { FASTENING_DIRECTION_TOLERANCE, FASTENING_LENGTH_TOLERANCE_MM, type BoltedJointRejection,
} from './types.js';

export function fastenerHeadForEntry(entry?: FasteningHoleEntry): FastenerHeadKind {
  return entry === undefined ? 'hex' : entry.kind === 'counterbore' ? 'socket' : 'countersunk';
}

/** Dimension values are read from the existing family, not transcribed into another table. */
export interface EntryHeadSpec {
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  readonly rowKey: string;
  readonly headDiameter: number;
  readonly headHeight: number;
  readonly threadLength: number;
  readonly includesHead: boolean;
  readonly seatDepth: number;
}

export function entryHeadSpec(entry: FasteningHoleEntry, nominal: string, pitch: number): EntryHeadSpec | BoltedJointRejection {
  const family = entry.kind === 'counterbore' ? SOCKET_HEAD_CAP_SCREW_FAMILY : COUNTERSUNK_SOCKET_SCREW_FAMILY;
  const row = family.rows.find(candidate => candidate.size === nominal);
  if (row === undefined) return { code: 'boltRowMissing', detail: { nominal, family: family.id } };
  if (!withinMagnitude((row.dims.pitch ?? NaN) - pitch, FASTENING_LENGTH_TOLERANCE_MM)) {
    return { code: 'pitchNotInCatalog', detail: { nominal, pitch, family: family.id } };
  }
  const headDiameter = row.dims.headDiameter ?? NaN, headHeight = row.dims.headHeight ?? NaN;
  const threadLength = row.dims.threadLength ?? NaN;
  if (![headDiameter, headHeight, threadLength].every(value => Number.isFinite(value) && value > 0)) {
    return { code: 'invalidDimension', detail: { nominal, family: family.id } };
  }
  return { family, row, rowKey: `${family.id}:${row.key}`, headDiameter, headHeight, threadLength,
    includesHead: entry.kind === 'countersink', seatDepth: entry.depth };
}

/** Counterbores require radial clearance. Countersinks require a flush, matching cone. */
export function entryHeadRejections(entry: FasteningHoleEntry, head: EntryHeadSpec,
  washerDiameter: number, washerThickness: number): FasteningExtensionRejection[] {
  const detail = { nominal: head.row.size, diameter: entry.diameter, headDiameter: head.headDiameter,
    depth: entry.depth, headHeight: head.headHeight };
  if (entry.kind === 'counterbore') {
    return entry.diameter <= Math.max(head.headDiameter, washerDiameter) + FASTENING_LENGTH_TOLERANCE_MM
      || entry.depth + FASTENING_LENGTH_TOLERANCE_MM < head.headHeight + washerThickness
      ? [{ code: 'counterboreTooSmall', detail: { ...detail, washerDiameter, washerThickness } }] : [];
  }
  // This is the actual simplified cone in profiles/screw.ts, including its table-derived angle.
  const angle = 2 * Math.atan((head.headDiameter - (head.row.dims.nominalDiameter ?? NaN)) / (2 * head.headHeight));
  const matches = withinMagnitude(entry.angle * Math.PI / 180 - angle, FASTENING_DIRECTION_TOLERANCE)
    && withinMagnitude(entry.diameter - head.headDiameter, FASTENING_LENGTH_TOLERANCE_MM);
  return matches ? [] : [{ code: 'countersinkMismatch', detail: { ...detail, angle: entry.angle, headAngle: angle * 180 / Math.PI } }];
}

