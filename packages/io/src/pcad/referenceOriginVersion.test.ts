import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument,
  type AssemblyDocument, type DrawingDocument, type PartDocument, type SubShapeRef } from '@pointercad/model';
import { writeAssemblyDocument } from './assemblyJson.js';
import { serializeDocument } from './documentJson.js';
import { serializeDrawing } from './drawingJson.js';
import { assertReferenceOriginVersion } from './referenceOriginVersion.js';

const face = { bodyFeatureId: 'box-1', index: 0, fingerprint: { kind: 'face', area: 1 },
  origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box-1', role: 'top' } } };

describe('schema admission for saved origins', () => {
  it('requires version 18 at each public document writer without changing saved references', () => {
    const ref: SubShapeRef = { bodyFeatureId: 'box-1', index: 5,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 400,
        position: [0, 0, 20], axis: [0, 0, 1], radius: null },
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box-1', role: 'top' } } };
    const part: PartDocument = { ...createEmptyPartDocument(),
      selectionSets: [{ id: 'selected', name: 'top', members: [{ kind: 'face', ref }] }] };
    const assembly: AssemblyDocument = { ...createAssemblyDocument('assembly'), mates: [{
      id: 'mate-1', name: '合致1', kind: 'coincident', suppressed: false, flipped: false,
      a: { kind: 'subShape', componentId: 'component-1', ref },
      b: { kind: 'origin', componentId: 'component-2', element: 'xy' },
      value: { source: '0', value: 0, display: '0' },
    }] };
    const drawing: DrawingDocument = { ...createDrawingDocument('drawing', { sourceRef: 'source',
      sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' }),
      dimensions: [{ id: 'dimension-1', kind: 'length', measurement: 'trueDistance',
        targets: [{ kind: 'subShape', viewId: 'front', sourceRef: 'source', ref }],
        placement: { commonNormalCoordinate: 30, textPosition: null },
        origin: 'manual', reference: false, layerId: 'layer-4' }] };
    const before = JSON.stringify([part, assembly, drawing]);
    const writers = [
      (schemaVersion: number) => serializeDocument({ ...part, schemaVersion }),
      (schemaVersion: number) => writeAssemblyDocument({ ...assembly, schemaVersion }),
      (schemaVersion: number) => serializeDrawing({ ...drawing, schemaVersion }),
    ];
    for (const write of writers) {
      expect(() => write(17)).toThrow('意味起点を保存するには保存形式の版18が必要です。');
      const encoded: unknown = JSON.parse(write(18));
      expect(encoded).toMatchObject({ schema: 18, document: { schemaVersion: 18 } });
    }
    expect(JSON.stringify([part, assembly, drawing])).toBe(before);
  });

  it('finds references in part, assembly, drawing and nested math families', () => {
    const documents: readonly unknown[] = [
      { selectionSets: [{ members: [{ kind: 'face', ref: face }] }] },
      { mates: [{ a: { kind: 'subShape', componentId: 'component-1', ref: face } }] },
      { dimensions: [{ targets: [{ kind: 'subShape', ref: face }] }] },
      { mathGeometry: [{ quantity: { first: { kind: 'face', reference: face } } }] },
    ];
    for (const document of documents) {
      expect(() => assertReferenceOriginVersion(document, 17)).toThrow(/18/);
      expect(() => assertReferenceOriginVersion(document, 18)).not.toThrow();
    }
  });
  it('separates canvas rectification from unrelated coordinate origin fields', () => {
    const document = { canvases: [{ id: 'canvas-1', imageId: 'image-1', plane: 'xy',
      origin: { mode: 'absolute' }, rectification: { sourceQuad: [[0, 0], [1, 0], [1, 1], [0, 1]] } }] };
    expect(() => assertReferenceOriginVersion(document, 17)).toThrow(/18/);
    expect(() => assertReferenceOriginVersion({ canvases: [{ ...document.canvases[0], rectification: undefined }] }, 17)).toThrow();
    expect(() => assertReferenceOriginVersion({ canvases: [{ id: 'canvas-1', imageId: 'image-1',
      plane: 'xy', origin: { mode: 'absolute' } }] }, 17)).not.toThrow();
  });
  it('accepts old references without origin and bounds a cyclic object graph', () => {
    const legacy = { ...face, origin: undefined };
    const document: Record<string, unknown> = { refs: [{ bodyFeatureId: legacy.bodyFeatureId,
      index: legacy.index, fingerprint: legacy.fingerprint }] };
    document['self'] = document;
    expect(() => assertReferenceOriginVersion(document, 17)).not.toThrow();
  });
});
