import { appendSolid, createEmptyPartDocument, type SweepFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from './documentJson.js';

function source(guided: boolean): string {
  const base = createEmptyPartDocument();
  const feature: SweepFeature = { id: 'sweep', name: 'スイープ', kind: 'sweep', suppressed: false, frenet: true,
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face' },
    path: { sketchId: base.activeSketchId, curveIds: ['path'] },
    ...(guided ? { guide: { sketchId: 'guide-sketch', curveIds: ['guide-1', 'guide-2'] } } : {}) };
  return serializeDocument(appendSolid(base, feature));
}

describe('P11b 案内線の保存形式13', () => {
  it('別スケッチの案内線の曲線順序と参照を往復する', () => {
    const serialized = source(true), parsed = parseDocument(serialized); expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(parsed.document.solids[0]).toMatchObject({ guide: { sketchId: 'guide-sketch', curveIds: ['guide-1', 'guide-2'] } });
    // 保存時刻は保存のたびに変わる。文書の式・参照・指定が残ることを比較する。
    const again = parseDocument(serializeDocument(parsed.document));
    expect(again.ok).toBe(true); if (!again.ok) return;
    expect(again.document).toEqual(parsed.document);
  });
  it('省略された案内線は勝手に補わず、従来の一定断面として往復する', () => {
    const parsed = parseDocument(source(false)); expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(parsed.document.solids[0]).not.toHaveProperty('guide');
  });
  it.each(['null', 'true', '42', '"guide-1"'])('不正な案内線の型%sは拒否する', (value) => {
    const valid = source(true); expect(valid).toContain('"guide": {');
    expect(parseDocument(valid.replace('"guide": {', `"guide": ${value}, "discarded": {`)).ok).toBe(false);
  });
});
