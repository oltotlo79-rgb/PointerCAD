import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, type PartDocument, type SubShapeOrigin, type SubShapeRef } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readSubShapeRef, serializeSubShapeRef } from './codecs/shapeReferences.js';

const origin: SubShapeOrigin = { version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box-1', role: 'top' } };
const ref: SubShapeRef = { bodyFeatureId: 'box-1', index: 0,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200,
    position: [0, 0, 20], axis: [0, 0, 1], radius: null }, origin };

describe('saved semantic subshape references', () => {
  it('keeps origin-v1 in the central codec and rejects kind mismatch', () => {
    const encoded = serializeSubShapeRef(ref);
    expect(encoded).toEqual(ref);
    expect(encoded).not.toBe(ref);
    expect(readSubShapeRef(encoded, 'ref')).toEqual({ ok: true, value: ref });
    expect(readSubShapeRef({ ...ref, origin: { ...origin, shapeKind: 'edge' } }, 'ref'))
      .toEqual({ ok: false, problem: { path: 'ref.origin.identity.kind', reason: 'type' } });
    expect(() => serializeSubShapeRef({ ...ref, origin: { version: 1, shapeKind: 'edge',
      identity: { kind: 'box-edge', featureId: 'box-1', role: 'top-front' } } })).toThrow();
  });

  it('round-trips part selection sets without an old index fallback', () => {
    const document: PartDocument = { ...createEmptyPartDocument(),
      selectionSets: [{ id: 'set-1', name: 'top face', members: [{ kind: 'face', ref }] }] };
    const encoded = serializeDocument(document, { savedAt: '2026-10-04T00:00:00.000Z' });
    const opened = parseDocument(encoded);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.document.selectionSets[0]?.members[0]).toEqual({ kind: 'face', ref });
    expect(serializeDocument(opened.document, { savedAt: '2026-10-04T00:00:00.000Z' })).toBe(encoded);
  });
});
