import type { PartDocument } from './types.js';
import type { PointReference } from '../sketch/types.js';

/** Allocated document identity; neither position nor a reference fingerprint. */
export interface PatternPointSlot {
  readonly slotId: string;
  readonly reference: PointReference;
}

export interface PatternPointSlots {
  readonly kind: 'points';
  readonly points: readonly PatternPointSlot[];
  /** High-water mark survives deletion, so a removed slot is never reused. */
  readonly nextSlotSerial: number;
}

export function isPatternPointSlot(
  point: PointReference | PatternPointSlot,
): point is PatternPointSlot {
  return 'slotId' in point && 'reference' in point;
}

export function patternPointReference(point: PointReference | PatternPointSlot): PointReference {
  return isPatternPointSlot(point) ? point.reference : point;
}

function slotSerial(slotId: string): number {
  const match = /^slot-([1-9][0-9]*)$/.exec(slotId);
  const serial = match === null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(serial)) throw new Error('Invalid point-pattern slot identity');
  return serial;
}

/** Only call at creation/update or the legacy document-read boundary. */
export function allocatePatternPointSlots(
  points: readonly (PointReference | PatternPointSlot)[],
  previous?: PatternPointSlots,
  savedNextSlotSerial?: number,
  documentHighWater = 1,
): PatternPointSlots {
  if (savedNextSlotSerial !== undefined
    && (!Number.isSafeInteger(savedNextSlotSerial) || savedNextSlotSerial < 1)) {
    throw new Error('Invalid point-pattern slot counter');
  }
  let next = Math.max(previous?.nextSlotSerial ?? 1, savedNextSlotSerial ?? 1, documentHighWater);
  if (!Number.isSafeInteger(next) || next < 1) throw new Error('Invalid point-pattern slot counter');
  const previousIds = new Set(previous?.points.map((point) => point.slotId));
  const seen = new Set<string>();
  for (const point of points) {
    if (!isPatternPointSlot(point)) continue;
    const serial = slotSerial(point.slotId);
    if (savedNextSlotSerial !== undefined && serial >= savedNextSlotSerial) {
      throw new Error('Point-pattern slot counter must exceed every saved identity');
    }
    if (seen.has(point.slotId)) throw new Error('Duplicate point-pattern slot identity');
    if (!previousIds.has(point.slotId) && serial < Math.max(previous?.nextSlotSerial ?? 1, documentHighWater)) {
      throw new Error('Deleted point-pattern slot identity cannot be reused');
    }
    seen.add(point.slotId);
    next = Math.max(next, serial + 1);
  }
  const slots = points.map((point): PatternPointSlot => {
    if (isPatternPointSlot(point)) return point;
    if (!Number.isSafeInteger(next + 1)) throw new Error('Point-pattern slot identities exhausted');
    const slotId = `slot-${String(next)}`;
    next += 1;
    return { slotId, reference: point };
  });
  if (!Number.isSafeInteger(next)) throw new Error('Point-pattern slot identities exhausted');
  return { kind: 'points', points: slots, nextSlotSerial: next };
}

/** Document-owned issuance ledger survives placement changes and deleted features. */
export function patternSlotHighWater(document: PartDocument, featureId: string): number {
  const ledger = document.patternSlotHighWater;
  const saved = ledger !== undefined && Object.hasOwn(ledger, featureId) ? ledger[featureId] ?? 1 : 1;
  if (!Number.isSafeInteger(saved) || saved < 1) throw new Error('Invalid document point-slot counter');
  const feature = document.solids.find((candidate) => candidate.id === featureId);
  return Math.max(saved, feature?.kind === 'pattern' && feature.placement.kind === 'points'
    ? feature.placement.nextSlotSerial : 1);
}

/** Undo restores geometry, but never makes already issued identities available again. */
export function retainPatternSlotHighWater(next: PartDocument, previous?: PartDocument): PartDocument {
  const entries = new Map<string, number>();
  for (const document of previous === undefined ? [next] : [previous, next]) {
    for (const [id, serial] of Object.entries(document.patternSlotHighWater ?? {})) {
      if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Invalid document point-slot counter');
      entries.set(id, Math.max(entries.get(id) ?? 1, serial));
    }
    for (const feature of document.solids) {
      if (feature.kind === 'pattern' && feature.placement.kind === 'points') {
        entries.set(feature.id, Math.max(entries.get(feature.id) ?? 1, feature.placement.nextSlotSerial));
      }
    }
  }
  if (entries.size === 0) return next;
  const current = Object.entries(next.patternSlotHighWater ?? {});
  if (current.length === entries.size && current.every(([id, serial]) => entries.get(id) === serial)) return next;
  return { ...next, patternSlotHighWater: Object.fromEntries(entries) };
}

/** Strict save/read boundary; deleted feature entries remain meaningful issuance records. */
export function readPatternSlotHighWater(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid document point-slot ledger');
  }
  const entries: [string, number][] = [];
  for (const [id, serial] of Object.entries(value)) {
    if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial < 1) {
      throw new Error('Invalid document point-slot counter');
    }
    entries.push([id, serial]);
  }
  return Object.fromEntries(entries);
}
