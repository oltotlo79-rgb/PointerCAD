import type { EntryHeadSpec } from './holeEntry.js';
import type { LengthChoice, LengthLimits } from './selectFastener.js';
import { FASTENING_LENGTH_TOLERANCE_MM, type BoltedJointRejection, type BoltLengthAvailability } from './types.js';

/** Family lengths are user candidates, not certified standard nominal lengths. Countersunk length includes the head. */
export function selectEntryBoltLength(head: EntryHeadSpec, availability: readonly BoltLengthAvailability[],
  limits: LengthLimits): LengthChoice | BoltedJointRejection {
  const candidates = availability.find(item => item.boltRowKey === head.rowKey
    && (item.threadSeries === undefined || item.threadSeries === 'coarse'));
  if (candidates === undefined) return { code: 'lengthAvailabilityMissing', detail: { boltRowKey: head.rowKey } };
  const sorted = [...candidates.lengths].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  for (const length of sorted) {
    const shaft = length - (head.includesHead ? head.headHeight : 0);
    const reach = length - (head.includesHead ? head.seatDepth : 0);
    const threadLength = Math.min(head.threadLength, shaft);
    if (shaft <= 0 || reach < limits.minimum - FASTENING_LENGTH_TOLERANCE_MM
      || (limits.maximum !== null && reach > limits.maximum + FASTENING_LENGTH_TOLERANCE_MM)
      || reach - threadLength > limits.gripLength + FASTENING_LENGTH_TOLERANCE_MM) continue;
    return { length, threadLength, basis: 'globalUnverifiedList', verified: false, missingFacts: ['perDiameterLengthAvailability'] };
  }
  return { code: 'noStandardLengthFits', detail: { boltRowKey: head.rowKey, minimum: limits.minimum,
    maximum: limits.maximum ?? 'none', reason: 'noCandidate' } };
}
