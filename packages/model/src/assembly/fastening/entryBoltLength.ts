import type { EntryHeadSpec } from './holeEntry.js';
import { entryLengthAvailability } from './entryLengthAvailability.js';
import type { LengthChoice, LengthLimits } from './selectFastener.js';
import { FASTENING_LENGTH_TOLERANCE_MM, type BoltedJointRejection, type BoltLengthAvailability } from './types.js';

export { entryLengthAvailability } from './entryLengthAvailability.js';

/** One candidate length and the list that offered it. */
interface LengthOffer {
  readonly length: number;
  readonly candidate: BoltLengthAvailability;
}

/** Every positive length of every list, shortest first; for the same length the verified list comes first. */
function lengthOffers(candidates: readonly BoltLengthAvailability[]): LengthOffer[] {
  return candidates.flatMap(candidate => candidate.lengths.filter(value => Number.isFinite(value) && value > 0)
    .map(length => ({ length, candidate })))
    .sort((a, b) => a.length - b.length || Number(!a.candidate.verified) - Number(!b.candidate.verified));
}

/**
 * Family lengths are user candidates, not certified standard nominal lengths, unless a row also has a per-diameter evidence list
 * (entryLengthAvailability). The shortest fitting length of all lists for the row wins and reports the basis of the list that offered it
 * (a length on a verified list is verified; a length only on the shared list stays unverified). Countersunk length includes the head.
 */
export function selectEntryBoltLength(head: EntryHeadSpec, availability: readonly BoltLengthAvailability[] = entryLengthAvailability(),
  limits: LengthLimits): LengthChoice | BoltedJointRejection {
  const candidates = availability.filter(item => item.boltRowKey === head.rowKey
    && (item.threadSeries === undefined || item.threadSeries === 'coarse'));
  if (candidates.length === 0) return { code: 'lengthAvailabilityMissing', detail: { boltRowKey: head.rowKey } };
  for (const { length, candidate } of lengthOffers(candidates)) {
    const shaft = length - (head.includesHead ? head.headHeight : 0);
    const reach = length - (head.includesHead ? head.seatDepth : 0);
    const threadLength = Math.min(head.threadLength, shaft);
    if (shaft <= 0 || reach < limits.minimum - FASTENING_LENGTH_TOLERANCE_MM
      || (limits.maximum !== null && reach > limits.maximum + FASTENING_LENGTH_TOLERANCE_MM)
      || reach - threadLength > limits.gripLength + FASTENING_LENGTH_TOLERANCE_MM) continue;
    return { length, threadLength, basis: candidate.basis, verified: candidate.verified,
      missingFacts: candidate.verified ? [] : ['perDiameterLengthAvailability'] };
  }
  return { code: 'noStandardLengthFits', detail: { boltRowKey: head.rowKey, minimum: limits.minimum,
    maximum: limits.maximum ?? 'none', reason: 'noCandidate' } };
}
