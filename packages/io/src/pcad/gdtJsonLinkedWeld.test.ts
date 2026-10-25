import { describe, expect, it } from 'vitest';
import { createDrawingDocument, type DrawingDocument } from '@pointercad/model';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import { isRecord, isUnknownArray } from './guards.js';

const expression = (source: string) => ({ source, value: 999, display: '999' });
const target = { kind: 'subShape' as const, viewId: 'view-1', sourceRef: 'source', componentId: 'component-3',
  ref: { bodyFeatureId: 'weld', index: 0, fingerprint: { kind: 'edge' as const, curveKind: 'line' as const, length: 20,
    position: [10, 34, 10] as const, axis: [1, 0, 0] as const, radius: null } } };

function document(weldId?: string): DrawingDocument {
  return { ...createDrawingDocument('溶接図', { sourceRef: 'source', sourceKind: 'assembly', fileName: 'assembly.pcada', path: '', contentHash: 'hash', importedAt: '' }),
    weldSymbols: [{ id: 'weld-symbol-1', system: 'B', target, sides: [
      { kind: 'fillet', side: 'arrow', size: { kind: 'leg', value: { expression: expression('6'), unit: 'mm' } }, contour: 'none', finish: 'none' },
    ], allAround: false, fieldWeld: false, tail: '', position: [60, 40], height: 3.5, layerId: 'layer-5',
    ...(weldId === undefined ? {} : { weldId }) }] };
}

function savedSymbol(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  const symbols = isRecord(value) && isRecord(value['document']) ? value['document']['weldSymbols'] : undefined;
  if (!isUnknownArray(symbols) || !isRecord(symbols[0])) throw new Error('fixture');
  return symbols[0];
}

describe('linked weld symbols keep only the weld id and stay compatible with manual symbols', () => {
  it('round-trips the explicit link to the model weld', () => {
    const source = document('weld-1');
    expect(savedSymbol(serializeDrawing(source))['weldId']).toBe('weld-1');
    expect(parseDrawing(serializeDrawing(source))).toMatchObject({ ok: true, document: source });
  });

  it('reads a symbol saved without the field as an independent manual symbol and does not add one', () => {
    const manual = document();
    const text = serializeDrawing(manual);
    expect('weldId' in savedSymbol(text)).toBe(false);
    const parsed = parseDrawing(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    expect(parsed.document.weldSymbols[0]?.weldId).toBeUndefined();
    expect(parsed).toMatchObject({ ok: true, document: manual });
  });

  it.each([[''], [7], [null], ['x'.repeat(257)]])('refuses a malformed weld id %j instead of dropping the link silently', (weldId) => {
    const value: unknown = JSON.parse(serializeDrawing(document('weld-1')));
    if (!isRecord(value) || !isRecord(value['document']) || !isUnknownArray(value['document']['weldSymbols'])) throw new Error('fixture');
    const symbol = value['document']['weldSymbols'][0];
    if (!isRecord(symbol)) throw new Error('fixture');
    symbol['weldId'] = weldId;
    expect(parseDrawing(JSON.stringify(value)).ok).toBe(false);
  });
});
