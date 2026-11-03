import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readShellCadAnalysisInput } from '@pointercad/model/beam-analysis';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { ShellAnalysisPanel } from './ShellAnalysisPanel.js';
import { createShellAnalysisSession, type ShellAnalysisSession } from './shellAnalysisSession.js';
import { literalShellResult } from './shellAnalysis.testSupport.js';

/** Every run state has its own visible text; a non-finite result shows the alert and never a number for it. */
const face = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"top"},"shapeKind":"face","version":1}}';
const geometry = readShellCadAnalysisInput({ schema: 'pointercad-shell-cad-analysis/1', id: 'shell-cad-analysis', source: { documentId: 'part' },
  geometry: { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId: 'part' }, bodyFeatureId: 'sheet',
    midsurfaceFaces: [face], thicknessMm: 2, offsetMm: 0 },
  material: { id: 'material', youngMPa: 1, poisson: 0, source: { kind: 'user-supplied', reference: 'r', condition: 'c' } },
  supports: [{ kind: 'edge', origin: { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-left' } },
    fixed: [true, false, false, false, false, false] }], edgeLoads: [],
  surface: { linearDeflection: 0.1, angularDeflection: 0.3, maximumNodes: 3, maximumTriangles: 1, minimumTriangleAreaMm2: 0,
    minimumAngleDeg: 0, maximumAspectRatio: 1 } }).geometry;
const render = (session: ShellAnalysisSession): string => renderToStaticMarkup(<ShellAnalysisPanel session={session} />);
// Markup escapes some characters; compare with the same escaping.
const text = (value: string): string => renderToStaticMarkup(<>{value}</>);

beforeEach(() => { resetTestStore(); });
afterEach(() => { resetTestStore(); useAppStore.setState({ shellAnalysisSession: null, shellAnalysisRunner: null }); });

describe('shell analysis panel states', () => {
  const base = createShellAnalysisSession('owner');
  it('empty: states the TR_SHELL02 linear static assumptions, the unsupported shapes and that nothing is computed', () => {
    const html = render(base);
    expect(html).toContain(text(t('shellAnalysis.assumptions')));
    expect(html).toContain(text(t('shellAnalysis.unsupported')));
    expect(html).toContain('data-testid="shell-empty"');
    expect(html).not.toContain('data-testid="shell-results"');
    expect(html).toContain(text(t('shellAnalysis.needMidsurface')));
  });
  it('loading, cancelled and error each show their own text and no result', () => {
    expect(render({ ...base, status: 'running' })).toContain('data-testid="shell-running"');
    const cancelled = render({ ...base, status: 'cancelled' });
    expect(cancelled).toContain(text(t('shellAnalysis.cancelled'))); expect(cancelled).not.toContain('data-testid="shell-results"');
    const failed = render({ ...base, status: 'failed', error: t('shellAnalysis.failure.nonplanar') });
    expect(failed).toContain('role="alert"'); expect(failed).toContain(text(t('shellAnalysis.failure.nonplanar')));
    expect(failed).not.toContain('data-testid="shell-results"');
  });
  it('result: shows the literal values with their units', () => {
    const html = render({ ...base, status: 'complete', result: literalShellResult(geometry, face, 7.5) });
    expect(html).toContain('data-testid="shell-results"');
    expect(html).toMatch(/data-testid="shell-max-displacement">5 mm</u);
    expect(html).toContain('7.5');
    expect(html).not.toContain('data-testid="shell-not-finite"');
  });
  it('a NaN or infinite result is never shown as a number or as 0', () => {
    for (const bad of [Number.NaN, Infinity]) {
      const html = render({ ...base, status: 'complete', result: literalShellResult(geometry, face, bad) });
      expect(html).toContain('data-testid="shell-not-finite"');
      expect(html).not.toMatch(/data-testid="shell-max-displacement">[-0-9]/u);
      expect(html).not.toContain('NaN'); expect(html).not.toContain('Infinity');
    }
  });
});
