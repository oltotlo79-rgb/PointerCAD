import React, { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { StatusBar } from './StatusBar.js';

// Nodeで進捗表示までの待ち時間だけを進める。描画とストアの読み取りは本物を使う。
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ documentSaveOperation: null, recoverySaveState: null });
  vi.mocked(useState).mockReset();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTestStore();
});

function renderStatus(): string {
  return renderToStaticMarkup(createElement(StatusBar));
}

function primaryText(markup: string): string {
  return markup.split('class="pcad-statusbar__text"')[1]?.split('>')[1]?.split('</span')[0] ?? '';
}

describe('ステータスバーの操作案内と計算表示(FR-905)', () => {
  it('保存段階を読み上げ、準備・圧縮中だけキーボードで使える取消ボタンを示す', () => {
    const state = useAppStore.getState();
    const operation = { id: 'save', documentId: state.activeDocumentId, gateway: state.fileGateway,
      stage: 'compressing' as const, fileName: null, cancel: vi.fn() };
    useAppStore.setState({ documentSaveOperation: operation });
    const html = renderStatus();
    expect(html).toContain('data-save-stage="compressing"'); expect(html).toContain('aria-live="polite"');
    expect(html.match(/class="pcad-statusbar__text"/gu)).toHaveLength(1);
    expect(html.match(/class="pcad-statusbar__file"/gu)).toHaveLength(1);
    expect(html).toContain(t('file.save.compressing')); expect(html).toContain(`>${t('file.save.cancel')}</button>`);
    useAppStore.setState({ documentSaveOperation: { ...operation, stage: 'writing', cancel: null } });
    expect(renderStatus()).not.toContain(t('file.save.cancel'));
    useAppStore.setState({ documentSaveOperation: { ...operation, stage: 'complete', fileName: '完成.pcad', cancel: null } });
    expect(renderStatus()).toContain('完成.pcad');
    useAppStore.setState({ activeDocumentId: crypto.randomUUID() });
    expect(renderStatus()).not.toContain('完成.pcad');
  });

  it('復元用保存の状態は現在文書と現在の所有者だけを表示する', () => {
    const saver = { markDirty: () => undefined, saveNow: () => Promise.resolve(), stop: () => undefined,
      readLatest: () => Promise.resolve(null), discard: () => Promise.resolve() };
    // 待機の表示は保存していない変更がある文書のものなので、先に実際の編集を加える。
    useAppStore.setState({ document: { ...useAppStore.getState().document, name: '編集した部品' } });
    useAppStore.setState({ autoSaver: saver, recoverySaveState: {
      documentId: useAppStore.getState().activeDocumentId, saver, stage: 'pending' } });
    expect(renderStatus()).toContain(t('file.recovery.pending'));
    useAppStore.setState({ autoSaver: null });
    expect(renderStatus()).not.toContain(t('file.recovery.pending'));
  });

  it('保存していない変更が無い文書には復元の待機を出さず、実際の控えの処理と失敗は出す(R06)', () => {
    const saver = { markDirty: () => undefined, saveNow: () => Promise.resolve(), stop: () => undefined,
      readLatest: () => Promise.resolve(null), discard: () => Promise.resolve() };
    const documentId = useAppStore.getState().activeDocumentId;
    // 新規・開くの差し替えの途中で付いた待機(文書は保存済みの内容)。
    useAppStore.setState({ autoSaver: saver, recoverySaveState: { documentId, saver, stage: 'pending' } });
    expect(renderStatus()).not.toContain(t('file.recovery.pending'));
    expect(renderStatus()).not.toContain(t('file.unsavedChanges'));
    for (const stage of ['compressing', 'saved', 'failed'] as const) {
      useAppStore.setState({ recoverySaveState: { documentId, saver, stage } });
      expect(renderStatus()).toContain(t(`file.recovery.${stage}`));
    }
    useAppStore.setState({ document: { ...useAppStore.getState().document, name: '編集した部品' },
      recoverySaveState: { documentId, saver, stage: 'pending' } });
    expect(renderStatus()).toContain(t('file.recovery.pending'));
    expect(renderStatus()).toContain(t('file.unsavedChanges'));
  });
  it('計算中＋道具ありでは案内と独立した計算表示を描く', () => {
    useAppStore.setState({ activeTool: 'projectedCurve', isComputing: true, kernelLoaded: true });
    const html = renderStatus();
    expect(primaryText(html)).toBe(t('statusBar.guide.projectedCurve'));
    expect(html).toContain('class="pcad-statusbar__activity" role="status"');
    expect(html).toContain(`aria-label="${t('statusBar.loading')}"`);
    expect(html).toContain(`title="${t('statusBar.loading')}"`);
    expect(html).toContain(`<span>${t('statusBar.activityComputing')}</span>`);
    expect(html.split('pcad-spinner')).toHaveLength(2);
  });

  it('計算中＋道具なしでは従来の計算中文を重複せず描く', () => {
    useAppStore.setState({ activeTool: 'select', isComputing: true, kernelLoaded: true });
    const html = renderStatus();
    expect(primaryText(html)).toBe(t('statusBar.loading'));
    expect(html).not.toContain('pcad-statusbar__activity');
    expect(html.split('pcad-spinner')).toHaveLength(2);
  });

  it('計算なし＋道具ありでは案内だけを描く', () => {
    useAppStore.setState({ activeTool: 'projectedCurve', isComputing: false });
    const html = renderStatus();
    expect(primaryText(html)).toBe(t('statusBar.guide.projectedCurve'));
    expect(html).not.toContain('pcad-statusbar__activity');
    expect(html).not.toContain('pcad-spinner');
  });

  it('初回の準備中も案内と読み込みの詳細を描く', () => {
    useAppStore.setState({ activeTool: 'planeSection', isComputing: true, kernelLoaded: false });
    const html = renderStatus();
    expect(primaryText(html)).toBe(t('statusBar.guide.planeSection'));
    expect(html).toContain(`<span>${t('statusBar.activityPreparing')}</span>`);
    expect(html).toContain(`aria-label="${t('statusBar.loadingKernel')}"`);
  });

  it('進捗を表示する時期になっても案内と中止の操作を残す', () => {
    useAppStore.setState({
      activeTool: 'projectedCurve', isComputing: true, kernelLoaded: true,
      recomputeProgress: { featureId: 'extrude-1', label: '押し出し1', index: 0, total: 3 },
    });
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
    const html = renderStatus();
    expect(primaryText(html)).toBe(t('statusBar.guide.projectedCurve'));
    expect(html).toContain('<span>計算中 1/3</span>');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="3" aria-valuenow="1"');
    expect(html).toContain('pcad-statusbar__cancel');
    expect(html).toContain(`title="${t('statusBar.progressHint')}"`);
    expect(html).toContain(`>${t('statusBar.cancel')}</button>`);
  });

  it('開いているその場入力の段に合わせて案内を描く(線分の終点・外ねじの大きさ)', () => {
    useAppStore.setState({ activeTool: 'line', numericInput: createNumericInput('line', 'lineStart') });
    expect(primaryText(renderStatus())).toBe(t('statusBar.guide.line'));
    useAppStore.setState({ numericInput: createNumericInput('line', 'lineEnd') });
    expect(primaryText(renderStatus())).toBe(t('statusBar.guide.lineEnd'));
    useAppStore.setState({
      activeTool: 'threadShaft',
      numericInput: createNumericInput('threadShaft', 'threadShaftSize'),
    });
    expect(primaryText(renderStatus())).toBe(t('statusBar.guide.threadShaftSize'));
  });

  it('今の道具のものでない窓の段は案内に混ぜない', () => {
    useAppStore.setState({ activeTool: 'circle', numericInput: createNumericInput('line', 'lineEnd') });
    expect(primaryText(renderStatus())).toBe(t('statusBar.guide.circle'));
  });
});
