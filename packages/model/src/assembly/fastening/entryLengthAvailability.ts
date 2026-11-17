import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { COUNTERSUNK_SOCKET_SCREW_FAMILY } from '../catalog/families/countersunkSocketScrew.js';
import { globalUnverifiedLengthAvailability } from './selectFastener.js';
import type { BoltLengthAvailability } from './types.js';

/** Candidate lengths only: the shared list is not evidence of availability for either screw family. */
export function entryLengthAvailability(): readonly BoltLengthAvailability[] {
  return [SOCKET_HEAD_CAP_SCREW_FAMILY, COUNTERSUNK_SOCKET_SCREW_FAMILY].flatMap(family =>
    family.rows.map(row => ({ ...globalUnverifiedLengthAvailability(`${family.id}:${row.key}`), threadSeries: 'coarse' as const })));
}
