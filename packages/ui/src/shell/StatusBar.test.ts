import React, { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
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
});
