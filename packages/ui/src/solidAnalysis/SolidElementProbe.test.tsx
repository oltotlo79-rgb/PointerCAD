import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { probeYieldText, SolidElementProbe } from './SolidElementProbe.js';
import { createSolidAnalysisSession, type SolidAnalysisSession } from './solidAnalysisSession.js';

function completed(): SolidAnalysisSession {
  const source = { documentId: 'document', revision: 1, meshKey: 'mesh' };
  const outcome = { kind: 'result', prepared: { input: { source,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }] } },
  result: { source, displacementMm: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
    elements: [{ strain: [0, 0, 0, 0, 0, 0], stressMPa: [1, 0, 0, 0, 0, 0] }] } };
  return { ...createSolidAnalysisSession('owner'), status: 'complete', result: outcome as unknown as NonNullable<SolidAnalysisSession['result']> };
}

describe('element probe SSR', () => {
  it('shows the one-based element input with real React and no completed asynchronous result', () => {
    const html = renderToStaticMarkup(<SolidElementProbe session={completed()} ownerId="owner" documentId="document" />);
    expect(html).toContain('data-testid="solid-element-probe"');
    expect(html).toContain('min="1"'); expect(html).toContain('value="1"');
    expect(html).toContain('要素番号（1から）');
    expect(html).toContain('title="計算済みの要素を1からの番号で指定します。材料・応力・ひずみと節点の値を表示します。解析条件は変更しません。"');
  });
  it('does not show an absent or differently owned result', () => {
    const session = completed();
    expect(renderToStaticMarkup(<SolidElementProbe session={session} ownerId="other" documentId="document" />)).toBe('');
    expect(renderToStaticMarkup(<SolidElementProbe session={session} ownerId="owner" documentId="other" />)).toBe('');
    expect(renderToStaticMarkup(<SolidElementProbe session={{ ...session, status: 'editing', result: null }}
      ownerId="owner" documentId="document" />)).toBe('');
  });
  it('shows only a finite positive yield/von Mises ratio as a number and says why there is none otherwise', () => {
    // 245 MPa yield evidence over 7.56 sqrt(3) MPa von Mises (hand value of readSolidElementProbe.test.ts).
    const ratio = 245 / (7.56 * Math.sqrt(3));
    expect(probeYieldText({ yieldRatio: ratio, capacityMissing: false, zeroStress: false })).toBe(String(ratio));
    expect(probeYieldText({ yieldRatio: null, capacityMissing: true, zeroStress: false }))
      .toBe('未評価（材料の降伏点・耐力の根拠がありません）');
    expect(probeYieldText({ yieldRatio: null, capacityMissing: false, zeroStress: true }))
      .toBe('相当応力0：比は算出しません。安全性の認定ではありません。');
    // Missing evidence wins over zero stress: there is nothing to divide either way.
    expect(probeYieldText({ yieldRatio: null, capacityMissing: true, zeroStress: true }))
      .toBe('未評価（材料の降伏点・耐力の根拠がありません）');
    for (const yieldRatio of [null, 0, -1, Infinity, Number.NaN]) {
      const text = probeYieldText({ yieldRatio, capacityMissing: false, zeroStress: false });
      expect(text).toBe('未評価'); expect(text).not.toMatch(/\d|Infinity|NaN/u);
    }
  });
});
