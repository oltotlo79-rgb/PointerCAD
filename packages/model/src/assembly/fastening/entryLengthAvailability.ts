import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { COUNTERSUNK_SOCKET_SCREW_FAMILY } from '../catalog/families/countersunkSocketScrew.js';
import { globalUnverifiedLengthAvailability } from './selectFastener.js';
import { socketHeadCapScrewLengthAvailability } from './socketHeadCapScrewLengths.js';
import type { BoltLengthAvailability } from './types.js';

/**
 * Candidate lengths per family row. The shared list is not evidence of availability for either screw family and stays for every row;
 * socket head cap screw rows with a two-source nominal length table (socketHeadCapScrewLengths.ts) also get that table, listed first.
 */
export function entryLengthAvailability(): readonly BoltLengthAvailability[] {
  return [SOCKET_HEAD_CAP_SCREW_FAMILY, COUNTERSUNK_SOCKET_SCREW_FAMILY].flatMap(family => family.rows.flatMap(row => {
    const boltRowKey = `${family.id}:${row.key}`;
    const shared: BoltLengthAvailability = { ...globalUnverifiedLengthAvailability(boltRowKey), threadSeries: 'coarse' };
    const evidence = family === SOCKET_HEAD_CAP_SCREW_FAMILY ? socketHeadCapScrewLengthAvailability(boltRowKey, row.size) : null;
    return evidence === null ? [shared] : [evidence, shared];
  }));
}
