import React, { Children, isValidElement, useEffect, useRef, useState } from 'react';
import type * as ReactTypes from 'react';
import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SolidAnalysisMaterialFields } from './SolidAnalysisMaterialFields.js';
import type { SolidAnalysisMaterialFieldsProps } from './SolidAnalysisMaterialFields.js';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof ReactTypes>();
  return { ...actual, useState: vi.fn(actual.useState), useEffect: vi.fn(actual.useEffect), useRef: vi.fn(actual.useRef) };
});

const SS400: AnalysisMaterialCapacity = { materialConditionId: 'ss400-plate-0-16', condition: '圧延鋼板（熱処理の指定なし）',
  thicknessMm: 16, yieldMPa: 245, sourceId: 'jisf-g3101-draft', evidence: 'standard-draft', basis: 'minimum' };
const S45C: AnalysisMaterialCapacity = { materialConditionId: 's45c-quenched-tempered-reference', condition: '焼入焼戻・適用寸法未指定の参考値',
  thicknessMm: 17, yieldMPa: 490, sourceId: 'tsubaki-s45c', evidence: 'manufacturer-reference', basis: 'reference' };
interface FieldProps {
  readonly children?: React.ReactNode;
  readonly 'data-testid'?: string;
  readonly value?: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
  readonly onCompositionStart?: () => void;
  readonly onCompositionEnd?: () => void;
  readonly onKeyDown?: (event: { readonly key: string; readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
    readonly preventDefault: () => void; readonly stopPropagation: () => void }) => void;
}

/** Existing SSR handler technique with persistent useState slots, not a DOM/browser acceptance. */
async function harness(initial: AnalysisMaterialCapacity | null = SS400) {
  const actual = await vi.importActual<typeof ReactTypes>('react');
  const values: unknown[] = [];
  const effects: React.EffectCallback[] = [];
  const refs: React.RefObject<unknown>[] = [];
  let slot = 0, refSlot = 0, key = 'opening-1', value = initial, latestValidity = true;
  let setParent: React.Dispatch<React.SetStateAction<AnalysisMaterialCapacity | null>> | null = null;
  const change = vi.fn((next: AnalysisMaterialCapacity | null, valid: boolean) => { value = next; latestValidity = valid; setParent?.(next); });
  vi.mocked(useState).mockImplementation((initialValue?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
    const index = slot++;
    const [own] = actual.useState(initialValue);
    if (index >= values.length) values[index] = own;
    return [values[index], next => { values[index] = next; }];
  });
  vi.mocked(useEffect).mockImplementation(effect => { effects.push(effect); });
  vi.mocked(useRef).mockImplementation((initialValue: unknown): React.RefObject<unknown> => {
    const index = refSlot++, own = actual.useRef(initialValue);
    if (index >= refs.length) refs[index] = own;
    return refs[index];
  });
  const render = (disabled = false): FieldProps[] => {
    slot = 0; refSlot = 0; effects.length = 0;
    const rows: FieldProps[] = [];
    const walk = (node: React.ReactNode): void => { Children.forEach(node, child => {
      if (isValidElement<FieldProps>(child)) { rows.push(child.props); walk(child.props.children); }
    }); };
    function Probe(): null {
      const [parentValue, setParentValue] = useState(value);
      setParent = setParentValue;
      const outer = SolidAnalysisMaterialFields({ value: parentValue, selectionKey: key, onChange: change, disabled });
      expect(outer.key).toBe(key);
      // The public keyed element uses the same typed component props.
      const element: React.ReactElement<SolidAnalysisMaterialFieldsProps, (props: SolidAnalysisMaterialFieldsProps) => React.JSX.Element> = outer;
      walk(element.type(element.props)); return null;
    }
    renderToStaticMarkup(<Probe />);
    for (const effect of [...effects]) effect();
    return rows;
  };
  const field = (id: string, disabled = false): FieldProps => {
    const row = render(disabled).find(item => item['data-testid'] === id);
    if (!row) throw new Error(id);
    return row;
  };
  return { change, render, field,
    setValue(next: AnalysisMaterialCapacity | null) { value = next; setParent?.(next); },
    reopen() { key = 'opening-2'; values.length = 0; refs.length = 0; },
    value: () => value, valid: () => latestValidity };
}

afterEach(async () => {
  const actual = await vi.importActual<typeof ReactTypes>('react');
  vi.mocked(useState).mockImplementation(actual.useState); vi.mocked(useEffect).mockImplementation(actual.useEffect);
  vi.mocked(useRef).mockImplementation(actual.useRef);
});

describe('solid material fields real React handlers (pure SSR)', () => {
  it('clears the parent capacity atomically while keeping an invalid typed thickness visible', async () => {
    const h = await harness(); h.render(); h.change.mockClear();
    h.field('solid-material-thickness').onChange?.({ target: { value: '17' } });
    expect(h.change).toHaveBeenLastCalledWith(null, false);
    expect(h.field('solid-material-thickness').value).toBe('17');
    expect(h.valid()).toBe(false);
    expect(h.field('solid-material-condition').value).toBe('ss400-plate-0-16');
    h.field('solid-material-condition').onChange?.({ target: { value: 'ss400-plate-16-40' } });
    expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ yieldMPa: 235, thicknessMm: 17 }), true);
  });
  it.each(['', 'NaN', '-1', '0', '途中'])('removes the previous valid capacity for unfinished thickness %j', async text => {
    const h = await harness(); h.field('solid-material-thickness').onChange?.({ target: { value: text } });
    expect(h.change).toHaveBeenLastCalledWith(null, false);
    expect(h.field('solid-material-thickness').value).toBe(text);
    expect(h.value()).toBeNull();
  });
  it('clearing the selection explicitly restores optional elastic-only mode', async () => {
    const h = await harness(); h.field('solid-material-condition').onChange?.({ target: { value: '' } });
    expect(h.change).toHaveBeenLastCalledWith(null, true);
    expect(h.field('solid-material-condition').value).toBe('');
  });
  it('does not make an initial null value block legacy elastic analysis', async () => {
    const h = await harness(null); h.render();
    expect(h.change).toHaveBeenLastCalledWith(null, true);
    h.field('solid-material-condition').onChange?.({ target: { value: 'ss400-plate-0-16' } });
    expect(h.change).toHaveBeenLastCalledWith(null, false);
  });
  it('switches to a different saved value immediately, including after invalid edits', async () => {
    const h = await harness(); h.field('solid-material-thickness').onChange?.({ target: { value: 'unfinished' } });
    h.setValue(S45C);
    expect(h.field('solid-material-condition').value).toBe('s45c-quenched-tempered-reference');
    expect(h.field('solid-material-thickness').value).toBe('17');
    expect(h.change).toHaveBeenLastCalledWith(S45C, true);
    h.setValue(null); h.reopen();
    expect(h.field('solid-material-condition').value).toBe('');
    expect(h.field('solid-material-thickness').value).toBe('');
  });
  it('does not reinterpret a forged saved yield value as explicit no-yield mode', async () => {
    const h = await harness({ ...SS400, yieldMPa: 999 }); h.render();
    expect(h.change).toHaveBeenLastCalledWith(null, false);
    expect(h.field('solid-material-condition').value).toBe('ss400-plate-0-16');
    expect(h.change).toHaveBeenLastCalledWith(null, false);
  });
  it('preserves saved S45C null thickness without forcing a fabricated dimension', async () => {
    const saved = { ...S45C, thicknessMm: null };
    const h = await harness(saved); h.render();
    expect(h.field('solid-material-thickness').value).toBe('');
    expect(h.change).toHaveBeenLastCalledWith(saved, true);
  });
  it('keeps the parent null echo and fullwidth draft until the actual compositionEnd', async () => {
    const h = await harness(); const field = h.field('solid-material-fields');
    field.onCompositionStart?.();
    expect(h.change).toHaveBeenLastCalledWith(null, false);
    h.field('solid-material-thickness').onChange?.({ target: { value: '１６' } });
    expect(h.change).toHaveBeenLastCalledWith(null, false);
    expect(h.field('solid-material-thickness').value).toBe('１６');
    h.field('solid-material-fields').onCompositionEnd?.();
    expect(h.change).toHaveBeenLastCalledWith(expect.objectContaining({ thicknessMm: 16, yieldMPa: 245 }), true);
  });
  it.each([['Enter', 13, true], ['Enter', 229, false], ['Process', 0, false]] as const)(
    'contains IME key %s/%i without any capacity confirmation or parent calculation', async (key, keyCode, isComposing) => {
      const h = await harness(); const field = h.field('solid-material-fields');
      field.onCompositionStart?.(); h.change.mockClear();
      const preventDefault = vi.fn(), stopPropagation = vi.fn();
      field.onKeyDown?.({ key, nativeEvent: { key, keyCode, isComposing }, preventDefault, stopPropagation });
      expect(h.change).not.toHaveBeenCalled(); expect(stopPropagation).toHaveBeenCalledOnce();
      if (key === 'Enter') expect(preventDefault).toHaveBeenCalledOnce();
    });
  it('contains ordinary Enter and has no submit/run control', async () => {
    const h = await harness(); const stopPropagation = vi.fn(), preventDefault = vi.fn();
    h.field('solid-material-fields').onKeyDown?.({ key: 'Enter', nativeEvent: { key: 'Enter', keyCode: 13, isComposing: false }, preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(<SolidAnalysisMaterialFields value={SS400} selectionKey="one" onChange={vi.fn()} />);
    expect(html).not.toContain('<form'); expect(html).not.toContain('<button');
  });
  it('renders Japanese evidence, exact source metadata and separate elastic guidance with accessible fields', async () => {
    const h = await harness();
    for (const id of ['solid-material-condition', 'solid-material-thickness']) expect(h.field(id).title).toBeTruthy();
    const html = renderToStaticMarkup(<SolidAnalysisMaterialFields value={SS400} selectionKey="one" onChange={vi.fn()} disabled />);
    expect(html).toContain('disabled=""'); expect(html.match(/<label>/gu)).toHaveLength(2);
    expect(html).toContain('245 MPa'); expect(html).toContain('下限値'); expect(html).toContain('規格案');
    expect(html).toContain('797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893');
    expect(html).toContain('2023-07-26'); expect(html).toContain('ヤング率・ポアソン比');
    expect(html).toContain('href="https://www.jisf.or.jp/'); expect(html).toContain('0 &lt; t ≤ 16 mm');
    const reference = renderToStaticMarkup(<SolidAnalysisMaterialFields value={S45C} selectionKey="two" onChange={vi.fn()} />);
    expect(reference).toContain('参考値'); expect(reference).toContain('板厚・寸法の範囲を指定していません');
    expect(reference).toContain('490 MPa');
  });
});
