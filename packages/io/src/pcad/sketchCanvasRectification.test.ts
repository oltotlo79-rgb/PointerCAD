import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, type CanvasSourceQuad, type SketchCanvas } from '@pointercad/model';
import { isRecord, isUnknownArray } from './guards.js';
import { parseDocument, serializeDocument } from './documentJson.js';

const savedAt = '2026-10-04T00:00:00.000Z';
const expression = (value: number) => ({ source: String(value), value, display: String(value) });
const sourceQuad: CanvasSourceQuad = [[0.1, 0.1], [0.9, 0.12], [0.85, 0.9], [0.15, 0.85]];
const canvas: SketchCanvas = { id: 'canvas-1', name: 'reference', plane: 'xy', imageId: 'image-1',
  width: expression(400), height: expression(300),
  origin: { mode: 'absolute', x: expression(0), y: expression(0), z: expression(0) },
  rotation: expression(0), opacity: expression(0.5), visible: true,
  rectification: { sourceQuad } };

function withQuad(value: unknown): string {
  const raw: unknown = JSON.parse(serializeDocument({ ...createEmptyPartDocument(), canvases: [canvas] }, { savedAt }));
  if (!isRecord(raw) || !isRecord(raw['document']) || !isUnknownArray(raw['document']['canvases'])
    || !isRecord(raw['document']['canvases'][0])) throw new Error('missing canvas');
  raw['document']['canvases'][0]['rectification'] = { sourceQuad: value };
  return JSON.stringify(raw);
}

describe('saved canvas rectification', () => {
  it('round-trips sourceQuad without derived homography or image bytes', () => {
    const document = { ...createEmptyPartDocument(), canvases: [canvas] };
    const encoded = serializeDocument(document, { savedAt });
    const opened = parseDocument(encoded);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.document.canvases[0]?.rectification).toEqual({ sourceQuad });
    expect(serializeDocument(opened.document, { savedAt })).toBe(encoded);
    expect(encoded).not.toContain('homography');
    expect(encoded).not.toContain('imageBytes');
  });
  it.each([
    null, [], [[0, 0]], [[0, 0], [1, 0], [1, 1], null],
    [[0, 0], [1, 0], [1, 1], [0]],
    [[0, 0], [1, 0], [1, 1], [0, '1']],
    [[0, 0], [1.1, 0], [1, 1], [0, 1]],
    [[0, 0], [1, 1], [1, 0], [0, 1]],
    [[0, 0], [0.5, 0], [1, 0], [0, 1]],
  ])('rejects malformed or degenerate sourceQuad: %j', quad => {
    expect(parseDocument(withQuad(quad)).ok).toBe(false);
  });
  it('keeps an old canvas with no rectification absent', () => {
    const legacy: SketchCanvas = { ...canvas, rectification: undefined };
    const opened = parseDocument(serializeDocument({ ...createEmptyPartDocument(), canvases: [legacy] }, { savedAt }));
    expect(opened.ok && opened.document.canvases[0]).toEqual(canvasWithoutRectification(legacy));
  });
});

function canvasWithoutRectification(value: SketchCanvas): Omit<SketchCanvas, 'rectification'> {
  const result = { ...value };
  delete result.rectification;
  return result;
}
