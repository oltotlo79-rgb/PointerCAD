import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { parseSolidModeAmplitude, SolidModePanel, type SolidModePanelProps } from './SolidModePanel.js';
import { projectSolidMode, type SolidModeDisplay, type SolidModeResult } from './solidModeView.js';

const source = { documentId: 'doc-1', revision: 3, meshKey: 'mesh-a' };
const result: SolidModeResult = {
  source,
  nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
  elements: [{ nodes: [0, 1, 2, 3] }],
  fixed: [[true, true, true], [false, false, false], [false, false, false], [false, false, false]],
  modes: [
    { number: 1, frequencyHz: 120.5, normalizedResidual: 1e-12, massNormalizedShapePerSqrtT: [[0, 0, 0], [3, 4, 0], [0, 0, 1], [1, 0, 0]] },
    { number: 2, frequencyHz: 310.25, normalizedResidual: 1e-12, massNormalizedShapePerSqrtT: [[0, 0, 0], [0, 0, 2], [0, 2, 0], [2, 0, 0]] },
  ],
};
const display: SolidModeDisplay = { modeNumber: 1, amplitudeMm: 1, phase: 1 };

interface ProbeProps {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
}

function props(overrides: Partial<SolidModePanelProps> = {}): SolidModePanelProps {
  return {
    result, failed: false, display, amplitudeText: '1', preview: projectSolidMode(result, source, display),
    onDisplayChange: vi.fn(), onAmplitudeTextChange: vi.fn(), ...overrides,
  };
}

function byTestId(node: ReactNode, id: string): ProbeProps {
  const found: ProbeProps[] = [];
  const walk = (value: ReactNode): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isValidElement<ProbeProps>(value)) return;
    if (value.props['data-testid'] === id) found.push(value.props);
    walk(value.props.children);
  };
  walk(node);
  expect(found).toHaveLength(1);
  return found[0];
}

interface LabelledInput { readonly leadingText: string; readonly attributes: ReadonlyMap<string, string> }

/**
 * Every <input> that sits directly in its <label> (only text before it), with its attributes by name. React's server
 * renderer writes name, value and checked after the other attributes, so the attribute order is not part of the check.
 * Attribute names are keyed in lower case, as HTML compares them: React writes some names as spelled in JSX (inputMode,
 * not inputmode), and a browser DOM reads them case-insensitively.
 */
function labelledInputs(markup: string): readonly LabelledInput[] {
  return [...markup.matchAll(/<label>([^<]*)<input ([^>]*)\/>/g)].map(([, leadingText, attributes]) => ({
    leadingText, attributes: new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name.toLowerCase(), value])),
  }));
}

describe('SolidModePanel', () => {
  it('shows a failed solve as an alert without any mode or preview control', () => {
    const markup = renderToStaticMarkup(<SolidModePanel {...props({ failed: true })} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(t('solidAnalysis.modalFailed'));
    expect(markup).not.toContain('solid-modal-mode-');
    expect(markup).not.toContain('solid-modal-amplitude');
  });

  it('offers nothing to select before a result exists', () => {
    const markup = renderToStaticMarkup(<SolidModePanel {...props({ result: null, preview: null })} />);
    expect(markup).toContain(t('solidAnalysis.modalEmpty'));
    expect(markup).not.toContain('type="radio"');
  });

  it('lists every frequency in Hz with labelled keyboard controls and the meaning of the amplitude', () => {
    const markup = renderToStaticMarkup(<SolidModePanel {...props()} />);
    expect(markup).toContain('120.5 Hz');
    expect(markup).toContain('310.25 Hz');
    expect(markup).toContain(t('solidAnalysis.modalMeaning'));
    expect(markup).toContain(t('solidAnalysis.modalAmplitude'));
    // Native radios and a text field wrapped in their <label>: Tab/arrow keys and an accessible name for each.
    const inputs = labelledInputs(markup);
    const radios = (name: string) => inputs.filter(input => input.leadingText === ''
      && input.attributes.get('type') === 'radio' && input.attributes.get('name') === name);
    expect(radios('solid-modal-mode').map(input => input.attributes.get('data-testid'))).toEqual(['solid-modal-mode-1', 'solid-modal-mode-2']);
    expect(radios('solid-modal-phase').map(input => input.attributes.get('data-testid')))
      .toEqual(['solid-modal-phase-positive', 'solid-modal-phase-negative']);
    expect(inputs.filter(input => input.attributes.get('type') === 'text' && input.attributes.get('inputmode') === 'decimal'
      && input.attributes.get('data-testid') === 'solid-modal-amplitude')).toHaveLength(1);
    expect(markup).toContain(`${t('solidAnalysis.modalMode')} 1: 120.5 Hz`);
    expect(markup).toContain('aria-describedby="solid-modal-meaning"');
    expect(markup).not.toContain(t('solidAnalysis.modalAmplitudeInvalid'));
  });

  it('changes only the chosen mode or phase', () => {
    const onDisplayChange = vi.fn<(next: SolidModeDisplay) => void>();
    const tree = SolidModePanel(props({ onDisplayChange }));
    byTestId(tree, 'solid-modal-mode-2').onChange?.({ currentTarget: { value: '2' } });
    byTestId(tree, 'solid-modal-phase-negative').onChange?.({ currentTarget: { value: '-1' } });
    expect(onDisplayChange.mock.calls).toEqual([[{ modeNumber: 2, amplitudeMm: 1, phase: 1 }], [{ modeNumber: 1, amplitudeMm: 1, phase: -1 }]]);
  });

  it('passes a valid amplitude and turns an invalid draft into a cleared preview', () => {
    const onDisplayChange = vi.fn<(next: SolidModeDisplay) => void>(), onAmplitudeTextChange = vi.fn<(text: string) => void>();
    const tree = SolidModePanel(props({ onDisplayChange, onAmplitudeTextChange }));
    const field = byTestId(tree, 'solid-modal-amplitude');
    field.onChange?.({ currentTarget: { value: '2.5' } });
    field.onChange?.({ currentTarget: { value: 'abc' } });
    expect(onAmplitudeTextChange.mock.calls).toEqual([['2.5'], ['abc']]);
    expect(onDisplayChange.mock.calls[0]).toEqual([{ modeNumber: 1, amplitudeMm: 2.5, phase: 1 }]);
    const invalid: SolidModeDisplay = onDisplayChange.mock.calls[1][0];
    expect(Number.isNaN(invalid.amplitudeMm)).toBe(true);
    expect(projectSolidMode(result, source, invalid)).toEqual({ kind: 'none', reason: 'amplitude' });
  });

  it('marks an invalid amplitude draft and explains a cleared stale preview', () => {
    const markup = renderToStaticMarkup(<SolidModePanel {...props({
      amplitudeText: '-1', preview: projectSolidMode(result, { ...source, revision: 4 }, display) })} />);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(t('solidAnalysis.modalAmplitudeInvalid'));
    expect(markup).toContain('role="status"');
    expect(markup).toContain(t('solidAnalysis.modalStale'));
  });

  it('reads attribute names of the markup case-insensitively, as a browser does', () => {
    // React's server renderer keeps the JSX spelling of inputMode; the amplitude field must still be found by its name.
    const fields = labelledInputs('<label>A<input type="text" inputMode="decimal" data-testid="x"/></label>');
    expect(fields.map(field => [field.leadingText, field.attributes.get('inputmode'), field.attributes.get('inputMode'),
      field.attributes.get('data-testid')])).toEqual([['A', 'decimal', undefined, 'x']]);
  });

  it('parses only finite non-negative amplitudes', () => {
    expect([' 3 ', '0', '1e-3'].map(parseSolidModeAmplitude)).toEqual([3, 0, 0.001]);
    expect(['', ' ', '-0.1', 'NaN', 'Infinity', '1mm'].map(parseSolidModeAmplitude)).toEqual([null, null, null, null, null, null]);
  });
});
