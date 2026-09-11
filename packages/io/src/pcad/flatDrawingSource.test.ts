import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, replaceSketch, createSheetBaseFeature, resolvePart,
  createDrawingDocument, embedDrawingSource, emptyDrawingSourceLibrary, drawingSourceInputHash, drawingSourceInputOf,
  replaceDrawingSource, type DrawingSourceInput } from '@pointercad/model';
import { readDrawingBundle, writeDrawingBundle } from './drawingBundle.js';
import { readPcaddFile, writePcaddFile } from './pcadFile.js';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import { isRecord } from './guards.js';

const savedAt = '2026-09-11T00:00:00.000Z';
async function fixture() {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const profile = replaceSketch(empty, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '外周', planeId: 'xy', construction: false, corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
    { kind: 'face', id: 'face', name: '面', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
  ] });
  const base = createSheetBaseFeature(profile, { sketchId: sketch.id, faceFeatureId: 'face' });
  const part = appendSolid(profile, base), body = resolvePart(part).sheetMetalBodies?.get(base.id);
  if (body === undefined) throw new Error('板金の基板が必要です');
  const flatSheet = { partId: part.id, sourceFeatureId: base.id, fixedPanelId: body.panels[0].id, seamConnectionIds: [] };
  const source = { sourceKind: 'part' as const, document: part, flatSheet };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, '板金.pcad', '', { importedAt: savedAt });
  return { source, embedded, drawing: createDrawingDocument('板金展開図', embedded.source) };
}

function alteredSource(text: string, patch: Record<string, unknown>): string {
  const envelope: unknown = JSON.parse(text);
  if (!isRecord(envelope) || !isRecord(envelope['document']) || !isRecord(envelope['document']['source'])) throw new Error('図面の封筒が必要です');
  Object.assign(envelope['document']['source'], patch);
  return JSON.stringify(envelope);
}

describe('P10 元部品の履歴と展開条件を持つ図面source', () => {
  it('従来pcaddと原本bundleの双方が元部品・固定面・継ぎ目を往復する', async () => {
    const { source, drawing } = await fixture();
    const plain = writePcaddFile(drawing, { source, savedAt });
    expect(readPcaddFile(plain)).toMatchObject({ ok: true, document: drawing, source });
    const bundle = await writeDrawingBundle(drawing, { source, savedAt });
    expect(await readDrawingBundle(bundle)).toMatchObject({ ok: true, document: drawing, source });
    expect(bundle).toEqual(await writeDrawingBundle(drawing, { source, savedAt }));
  });
  it('同じ部品でも折曲げと展開を別hashで保持し、取り込み直しても条件を維持する', async () => {
    const { source, embedded } = await fixture();
    const folded: DrawingSourceInput = { sourceKind: 'part', document: source.document };
    expect(await drawingSourceInputHash(source)).not.toBe(await drawingSourceInputHash(folded));
    expect(drawingSourceInputOf(embedded.library.sources[0])).toEqual(source);
    const changed = { ...source, document: { ...source.document, name: '更新後の板金' } };
    const library = await replaceDrawingSource(embedded.library, embedded.source.sourceRef, changed);
    expect(library.sources[0].metadata.flatSheet).toEqual(source.flatSheet);
    expect(library.sources[0].metadata.contentHash).not.toBe(embedded.source.contentHash);
    expect(embedded.library.sources[0].document.name).not.toBe(changed.document.name);
    const normal = await replaceDrawingSource(library, embedded.source.sourceRef, folded);
    expect(normal.sources[0].metadata).not.toHaveProperty('flatSheet');
  });
  it('誤った元部品・フィーチャーや別の展開条件の混入を保存前に拒否する', async () => {
    const { source, drawing } = await fixture();
    await expect(drawingSourceInputHash({ ...source, document: { ...source.document, id: 'different-part' } })).rejects.toThrow('元部品');
    await expect(drawingSourceInputHash({ ...source, flatSheet: { ...source.flatSheet, sourceFeatureId: 'missing' } })).rejects.toThrow('見つかりません');
    expect(() => writePcaddFile(drawing, { source: { ...source, flatSheet: { ...source.flatSheet, fixedPanelId: 'other' } }, savedAt })).toThrow('mismatch');
  });
  it('破損した参照、重複継ぎ目、組立の展開指定を読込時に拒否する', async () => {
    const { source, drawing } = await fixture(), text = serializeDrawing(drawing, { savedAt });
    for (const flatSheet of [null, {}, { ...source.flatSheet, partId: '' }, { ...source.flatSheet, fixedPanelId: 1 },
      { ...source.flatSheet, seamConnectionIds: ['same', 'same'] }, { ...source.flatSheet, seamConnectionIds: [null] }])
      expect(parseDrawing(alteredSource(text, { flatSheet })).ok).toBe(false);
    expect(parseDrawing(alteredSource(text, { sourceKind: 'assembly' })).ok).toBe(false);
  });
  it('実行時の派生メッシュや座標が参照へ混ざっても保存しない', async () => {
    const { source, drawing } = await fixture();
    const transient = { ...drawing, source: { ...drawing.source, flatSheet: { ...source.flatSheet, mesh: [1, 2], flatCoordinates: [0, 0] } } };
    const saved = serializeDrawing(transient, { savedAt });
    expect(saved).not.toContain('flatCoordinates'); expect(saved).not.toContain('mesh');
    expect(parseDrawing(saved)).toMatchObject({ ok: true, document: drawing });
    const futureSource = { ...drawing.source, flatSheet: { ...source.flatSheet, futureInput: '保持' } };
    const future = serializeDrawing({ ...drawing, source: futureSource }, { savedAt });
    expect(future).toContain('futureInput');
  });
});
