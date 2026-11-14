import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PropertyPanel } from '../shell/PropertyPanel.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from './referenceRepairFixture.js';
import { ReferenceRepairSection } from './referenceRepairPanel.js';
import { ReferenceRepairDetail, REPAIR_STATUS_LABELS } from './referenceRepairDetail.js';
import { beginReferenceRepair, cancelReferenceRepair } from './referenceRepair.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { repairResolution } from './referenceRepairCandidates.js';

beforeEach(() => {
  resetTestStore();
  const { document, body } = repairFixture();
  useAppStore.getState().applyDocument(document);
  useAppStore.setState({ bodies: [body], isComputing: false, requestedGeneration: 1, completedGeneration: 1,
    lastOutcome: 'success', recomputeCancelled: false, timelineIndex: null });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('既存プロパティ内の修復欄', () => {
  it('選択なしでも未解決行の入口を表示し、文書も履歴も変更しない', () => {
    const before = useAppStore.getState(), markup = renderToStaticMarkup(createElement(PropertyPanel));
    expect(markup).toContain('data-testid="reference-repair"');
    expect(markup).toContain(t('propertyPanel.repair.open'));
    expect(markup).toContain('修復対象R / 曖昧');
    expect(useAppStore.getState()).toBe(before);
  });
  it('開いた行に元参照・意味付き候補・影響先・取消・確定を同時表示する', () => {
    const slot = currentRepairSlots(useAppStore.getState())[0], session = beginReferenceRepair(slot.key);
    if (session === null) throw new Error('セッションが必要');
    const before = useAppStore.getState(), markup = renderToStaticMarkup(createElement(ReferenceRepairDetail, {
      session, selected: session.candidates[0], fresh: true, ready: true,
      onSelect: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), onRefresh: vi.fn(),
    }));
    for (const key of ['propertyPanel.repair.original', 'propertyPanel.repair.candidates', 'propertyPanel.repair.impacts',
      'propertyPanel.repair.cancel', 'propertyPanel.repair.confirm'] as const) expect(markup).toContain(t(key));
    expect(markup).toContain('辺 99');
    expect(markup).toContain('長さ 10 mm');
    expect(markup).toContain('長さ 40 mm');
    expect(markup).toContain('加工: 修復対象R / 曖昧');
    expect(useAppStore.getState()).toBe(before);
    cancelReferenceRepair(session);
  });
  it('三状態の文言が相互に異なる', () => {
    expect(['matched', 'missing', 'ambiguous'].map(status => status === 'matched' ? t(REPAIR_STATUS_LABELS.matched)
      : status === 'missing' ? t(REPAIR_STATUS_LABELS.missing) : t(REPAIR_STATUS_LABELS.ambiguous))).toEqual(['一意', '消失', '曖昧']);
  });
  it('直す必要のある参照が 0 件の時は、プロパティの先頭に節を出さない(点検の指摘 4)', () => {
    const { body, reference } = repairFixture();
    const fp = reference.fingerprint;
    if (fp.kind !== 'edge') throw new Error('辺の参照が必要');
    // 保存した辺と同じ長さ・位置・向きの辺だけを持つ形にして、参照を一意にする。
    useAppStore.setState({ bodies: [{ ...body, edges: [{ index: 0, curveKind: 'line', length: fp.length,
      midpoint: fp.position, start: [-fp.length / 2, 0, 0], end: [fp.length / 2, 0, 0], axis: [1, 0, 0], radius: null,
      segmentOffset: 0, segmentCount: 1 }] }] });
    const rows = currentRepairSlots(useAppStore.getState());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(slot => [slot.available, repairResolution(slot).status])).toEqual(rows.map(() => [true, 'matched']));
    expect(renderToStaticMarkup(createElement(ReferenceRepairSection))).toBe('');
    expect(renderToStaticMarkup(createElement(PropertyPanel))).not.toContain('data-testid="reference-repair"');
  });

  it('既存加工に消費された未取得bodyを消失と断定しない', () => {
    useAppStore.setState({ bodies: [] });
    const markup = renderToStaticMarkup(createElement(ReferenceRepairSection));
    expect(markup).toContain(t('propertyPanel.repair.unavailable'));
    expect(markup).not.toContain('修復対象R / 消失');
  });
});
