import { describe, expect, it } from 'vitest';
import { createDetailView } from './detailView.js';

describe('部分拡大図', () => {
  const input = { curves: [{ curve: { kind: 'segment' as const, from: [-5, 0] as const, to: [5, 0] as const }, lineWidth: 0.5 }],
    sourceCenter: [0, 0] as const, sourceRadius: 10, destinationCenter: [100, 50] as const,
    scale: 2, label: 'A', textHeight: 3.5 };
  it('図の中の長さだけ2倍', () => {
    const result = createDetailView(input); expect(result.ok).toBe(true);
    if (result.ok) expect(result.curves[0]?.curve).toEqual({ kind: 'segment', from: [90, 50], to: [110, 50] });
  });
  it('線幅は拡大しない', () => { const result = createDetailView(input); if (result.ok) expect(result.curves[0]?.lineWidth).toBe(0.5); });
  it('文字高さは拡大しない', () => { const result = createDetailView(input); if (result.ok) expect(result.textHeight).toBe(3.5); });
  it('見出しはA (2:1)', () => { const result = createDetailView(input); if (result.ok) expect(result.title).toBe('A (2:1)'); });
  it('円が図の外なら理由を返す', () => expect(createDetailView({ ...input, sourceCenter: [1000, 1000] })).toEqual({
    ok: false, message: 'この円は図の外にあります。図の上に置いてください。',
  }));
});
