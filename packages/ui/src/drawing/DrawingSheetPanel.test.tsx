import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument, type DrawingSheet } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { DrawingSheetPanel } from './DrawingSheetPanel.js';
import { t } from '../i18n/t.js';

const rendered = vi.hoisted(() => ({ tags: [] as { tag: string; props: Record<string, unknown> }[] }));
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (typeof type === 'string' && props !== null && typeof props === 'object') {
      rendered.tags.push({ tag: type, props: props as Record<string, unknown> });
    }
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (typeof type === 'string' && props !== null && typeof props === 'object') {
      rendered.tags.push({ tag: type, props: props as Record<string, unknown> });
    }
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});

function setup(sheet: Partial<DrawingSheet> = {}): void {
  const document = createDrawingDocument('drawing', { sourceRef: 'source-1', sourceKind: 'part', path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' });
  useAppStore.getState().openDrawing({ ...document, sheet: { ...document.sheet, ...sheet } });
}
function markup(): string {
  rendered.tags = [];
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(<DrawingSheetPanel />); } finally { snapshot.mockRestore(); }
}
function input(label: string): Record<string, unknown> {
  const id = rendered.tags.find((tag) => tag.tag === 'label' && tag.props.children === label)?.props.htmlFor;
  const result = rendered.tags.find((tag) => tag.tag === 'input' && tag.props.id === id);
  if (result === undefined || id === undefined) throw new Error(`missing input: ${label}`);
  return result.props;
}
function submit(): void {
  const handler = rendered.tags.find((tag) => tag.tag === 'form')?.props.onSubmit as React.FormEventHandler<HTMLFormElement> | undefined;
  if (handler === undefined) throw new Error('missing form');
  handler({ preventDefault() {} } as React.FormEvent<HTMLFormElement>);
}

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('Sheet expressions and field errors (F24/UX10)', () => {
  it('restores the original expressions in every field for editing', () => {
    setup({ scale: 0.5, scaleExpression: '1/2', textHeight: 3.5, textHeightExpression: '7/2',
      scaleOptions: [0.5, 1, 2], scaleOptionExpressions: ['1/2', '1', 'root(8, 3)'],
      titleBlockFields: [{ key: 'title', label: t('drawing.sheet.title'), widthWeight: 2, widthExpression: '1+1' }] });
    markup();
    for (const [label, value] of [[t('drawing.sheet.scale'), '1/2'], [t('drawing.table.textHeight'), '7/2'],
      [t('drawing.sheet.scales'), '1/2, 1, root(8, 3)'], [t('drawing.sheet.fieldWidth'), '1+1']]) {
      expect(input(label)).toMatchObject({ value, type: 'text', 'aria-invalid': false });
    }
  });
  it('formats legacy numeric fields as expressions without rounding their values', () => {
    setup({ scale: 0.0000001, textHeight: 3.5, scaleOptions: [0.0000001, 1],
      titleBlockFields: [{ key: 'title', label: t('drawing.sheet.title'), widthWeight: 2 }] });
    markup();
    expect(input(t('drawing.sheet.scale')).value).toBe('0.0000001');
    expect(input(t('drawing.sheet.scales')).value).toBe('0.0000001, 1');
    expect(input(t('drawing.sheet.fieldWidth')).value).toBe('2');
    submit();
    expect(useAppStore.getState().drawing?.sheet).toMatchObject({ scale: 0.0000001, textHeight: 3.5 });
  });
  it('keeps 7/2 as 3.5 paper millimetres when the model uses inches', () => {
    setup({ textHeightExpression: '7/2' });
    useAppStore.setState({ displaySettings: { ...useAppStore.getState().displaySettings, lengthUnit: 'inch' } });
    markup();
    submit();
    expect(useAppStore.getState().drawing?.sheet).toMatchObject({ textHeight: 3.5, textHeightExpression: '7/2' });
  });
  it('links each reason to its input and rejects applying or saving invalid drafts', () => {
    // 編集途中と同じ原式をフォームの初期値へ渡し、実際の送信・保存ハンドラーを検査する。
    setup({ scaleExpression: '1/0', textHeightExpression: '0', scaleOptionExpressions: ['1', '1/0'],
      titleBlockFields: [{ key: 'title', label: '', widthExpression: '-1' }] });
    const original = useAppStore.getState().drawing;
    const save = vi.fn<(name: string, kind: string, bytes: Uint8Array) => Promise<boolean>>().mockResolvedValue(true);
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway, saveFileAs: save } });
    const html = markup();
    expect(html).toContain('<details open="">');
    for (const label of [t('drawing.sheet.scale'), t('drawing.table.textHeight'), t('drawing.sheet.scales'),
      t('drawing.sheet.fieldLabel'), t('drawing.sheet.fieldWidth')]) {
      const props = input(label);
      expect(props['aria-invalid']).toBe(true);
      const error = rendered.tags.find((tag) => tag.props.id === props['aria-describedby']);
      expect(error?.props.role).toBe('alert');
      expect(error?.props.children).toEqual(expect.any(String));
    }
    expect(html).toContain(t('drawing.sheet.positive'));
    expect(html).toContain(t('drawing.sheet.emptyFieldLabel'));
    submit();
    const handler = rendered.tags.find((tag) => tag.tag === 'button' && tag.props.children === t('drawing.template.save'))?.props.onClick as React.MouseEventHandler<HTMLButtonElement> | undefined;
    if (handler === undefined) throw new Error('missing save handler');
    handler({} as React.MouseEvent<HTMLButtonElement>);
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().drawing).toBe(original);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});
