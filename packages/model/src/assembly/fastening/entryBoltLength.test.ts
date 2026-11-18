import { describe, expect, it } from 'vitest';
import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { COUNTERSUNK_SOCKET_SCREW_FAMILY } from '../catalog/families/countersunkSocketScrew.js';
import { HEX_BOLT_NOMINAL_LENGTHS } from '../standard/fasteners.js';
import { entryLengthAvailability as availability, selectEntryBoltLength } from './entryBoltLength.js';
import { entryHeadSpec } from './holeEntry.js';

describe('entry length candidates', () => {
  it('keys every row by family and item and keeps the existing unverified 12–150 mm list for every row', () => {
    const candidates = availability();
    const keys = [SOCKET_HEAD_CAP_SCREW_FAMILY, COUNTERSUNK_SOCKET_SCREW_FAMILY]
      .flatMap(family => family.rows.map(row => `${family.id}:${row.key}`));
    const shared = candidates.filter(candidate => candidate.basis === 'globalUnverifiedList');
    expect(shared.map(candidate => candidate.boltRowKey)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(shared.length).toBeGreaterThan(0);
    for (const candidate of shared) {
      expect(candidate.lengths).toEqual(HEX_BOLT_NOMINAL_LENGTHS);
      expect(candidate.lengths[0]).toBe(12);
      expect(candidate.lengths.at(-1)).toBe(150);
      expect(candidate.verified).toBe(false);
      expect(candidate.source).not.toBe('');
    }
  });

  it('adds a verified per-diameter list only to the socket head cap screw rows M2–M24, listed just before the shared list of the same row', () => {
    const candidates = availability();
    const evidence = candidates.flatMap((candidate, index) => candidate.basis === 'perDiameterEvidence'
      ? [[candidate.boltRowKey, candidate.verified, candidates[index + 1]?.boltRowKey, candidates[index + 1]?.basis]] : []);
    const sizes = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24'];
    expect(evidence).toEqual(sizes.map(size => [`${SOCKET_HEAD_CAP_SCREW_FAMILY.id}:${size}`, true,
      `${SOCKET_HEAD_CAP_SCREW_FAMILY.id}:${size}`, 'globalUnverifiedList']));
  });

  it('does not share mutable length arrays between calls or rows', () => {
    const first = availability(), second = availability();
    expect(first[0]?.lengths).not.toBe(second[0]?.lengths);
    expect(first[0]?.lengths).not.toBe(first[1]?.lengths);
    expect(first[0]?.lengths).not.toBe(HEX_BOLT_NOMINAL_LENGTHS);
  });

  it('keeps missing, empty and wrong-family candidates distinct from a fitting length', () => {
    const head = entryHeadSpec({ kind: 'counterbore', diameter: 14, depth: 8, side: 'outer' }, 'M8', 1.25);
    if ('code' in head) throw new Error(JSON.stringify(head));
    const limits = { minimum: 35, maximum: 36, gripLength: 24 };
    expect(selectEntryBoltLength(head, [], limits)).toMatchObject({ code: 'lengthAvailabilityMissing' });
    expect(selectEntryBoltLength(head, availability().filter(row => row.boltRowKey.startsWith('countersunk')), limits))
      .toMatchObject({ code: 'lengthAvailabilityMissing' });
    expect(selectEntryBoltLength(head, [{ boltRowKey: head.rowKey, lengths: [], basis: 'globalUnverifiedList',
      verified: false, source: 'explicit empty candidates' }], limits)).toMatchObject({ code: 'noStandardLengthFits' });
    expect(selectEntryBoltLength(head, availability(), limits)).toEqual({ length: 35, threadLength: 28,
      basis: 'perDiameterEvidence', verified: true, missingFacts: [] });
    expect(selectEntryBoltLength(head, undefined, limits)).toEqual(selectEntryBoltLength(head, availability(), limits));
  });
});
