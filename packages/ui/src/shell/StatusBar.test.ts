import React, { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createAssemblyDocument } from '@pointercad/model';
import { StatusBar } from './StatusBar.js';
import { statusBarSlotStyle } from './statusText.js';
import type * as ImportedReactTypes from 'react';

// Nodeで進捗表示までの待ち時間だけを進める。描画とストアの読み取りは本物を使う。
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof ImportedReactTypes>();
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

/** 画面に文字として出る部分(読み上げだけの文と、title などの属性を除く)。 */
function visibleText(markup: string): string {
  return markup.replace(/<span class="pcad-statusbar__spoken"[^>]*>[^<]*<\/span>/gu, '').replace(/<[^>]+>/gu, ' ');
}

/** 読み上げだけに渡す文(画面には出さない)を、帯の並びの順に返す。 */
function spokenTexts(markup: string): string[] {
  return Array.from(markup.matchAll(/<span class="pcad-statusbar__spoken"[^>]*>([^<]*)<\/span>/gu), (match) => match[1]);
}

/** `marker` を含む開きタグの flex-shrink(帯の幅が足りない時に縮む重み)。 */
function flexShrinkOf(markup: string, marker: string): number | null {
  const at = markup.indexOf(marker);
  if (at < 0) return null;
  const tag = markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at));
  const value = /flex-shrink:(\d+)/u.exec(tag)?.[1];
  return value === undefined ? null : Number(value);
}

/** `marker` を含む開きタグの min-width(縮めても残す最小の幅)。 */
function minWidthOf(markup: string, marker: string): string | null {
  const at = markup.indexOf(marker);
  if (at < 0) return null;
  const tag = markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at));
  return /min-width:([^;"]+)/u.exec(tag)?.[1] ?? null;
}

describe('帯の保存の印・縮む順・文書の種類ごとの札(点検の指摘 1・小 21)', () => {
  const saver = { markDirty: () => undefined, saveNow: () => Promise.resolve(), stop: () => undefined,
    readLatest: () => Promise.resolve(null), discard: () => Promise.resolve() };

  function editedWithSaving(): void {
    useAppStore.setState({ document: { ...useAppStore.getState().document, name: '編集した部品' } });
    const state = useAppStore.getState();
    useAppStore.setState({ autoSaver: saver,
      recoverySaveState: { documentId: state.activeDocumentId, saver, stage: 'pending' },
      documentSaveOperation: { id: 'save', documentId: state.activeDocumentId, gateway: state.fileGateway,
        stage: 'compressing', fileName: null, cancel: vi.fn() } });
  }

  it('保存していない変更・保存中・復元の待ちがあっても、帯の文字は短い印だけにし、全文はツールチップと読み上げへ渡す', () => {
    editedWithSaving();
    const html = renderStatus();
    const visible = visibleText(html);
    expect(visible).not.toContain(t('file.unsavedChanges'));
    expect(visible).not.toContain(t('file.save.compressing'));
    expect(visible).not.toContain(t('file.recovery.pending'));
    expect(visible).toContain(t('statusBar.saveMark.running'));
    expect(visible).toContain(t('file.save.cancel'));
    // 保存していない事はファイル名の * とツールチップで伝える。
    expect(html).toContain(`class="pcad-statusbar__file" title="${t('file.unsavedChanges')}"`);
    expect(spokenTexts(html)).toEqual([t('file.save.compressing'), t('file.recovery.pending')]);
    expect(html).toContain(`title="${t('file.save.compressing')}"`);
    expect(html).toContain(`data-recovery-stage="pending" title="${t('file.recovery.pending')}"`);
  });

  it('幅が足りない時に縮む重みを欄ごとに渡し、案内の 1 文を最後に縮める', () => {
    editedWithSaving();
    useAppStore.setState({ recoverySaveState: { documentId: useAppStore.getState().activeDocumentId, saver, stage: 'failed' },
      activeTool: 'projectedCurve', isComputing: true, kernelLoaded: true,
      recomputeProgress: { featureId: 'extrude-1', label: '押し出し1', index: 0, total: 3 } });
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
    const html = renderStatus();
    const slots = [['class="pcad-statusbar__progress"', 'progress'], ['data-save-stage="compressing"', 'save'],
      ['class="pcad-statusbar__file"', 'file'], ['data-recovery-stage="failed"', 'recovery'],
      ['class="pcad-statusbar__message"', 'message']] as const;
    for (const [marker, slot] of slots) {
      expect(flexShrinkOf(html, marker), slot).toBe(statusBarSlotStyle(slot).flexShrink);
      // 縮めても図柄・中止のボタンを残す最小の幅(幅 0 に潰れて見えなくならない。C-02a の直し)。
      expect(minWidthOf(html, marker), slot).toBe(statusBarSlotStyle(slot).minWidth);
    }
    expect(statusBarSlotStyle('message').flexShrink).toBe(1);
  });

  it('保存の中止のボタンは保存の印の外に置き、印が縮んでもボタンは隠れない', () => {
    editedWithSaving();
    const html = renderStatus();
    const start = html.indexOf('data-save-stage="compressing"');
    const markEnd = html.indexOf(`${t('file.save.compressing')}</span></span>`, start);
    expect(start).toBeGreaterThan(0);
    expect(markEnd).toBeGreaterThan(start);
    expect(html.slice(start, markEnd)).not.toContain('pcad-statusbar__cancel');
    expect(html.slice(markEnd)).toContain(`>${t('file.save.cancel')}</button>`);
  });

  it('復元用の保存の失敗は危険の色の短い印で出し、全文と理由をツールチップと読み上げへ渡す', () => {
    const documentId = useAppStore.getState().activeDocumentId;
    useAppStore.setState({ autoSaver: saver,
      recoverySaveState: { documentId, saver, stage: 'failed', detail: '空き容量が足りません' } });
    const html = renderStatus();
    const full = `${t('file.recovery.failed')} 空き容量が足りません`;
    expect(html).toContain('pcad-statusbar__mark--failed');
    expect(visibleText(html)).toContain(t('statusBar.recoveryMark.failed'));
    expect(visibleText(html)).not.toContain(t('file.recovery.failed'));
    expect(html).toContain(`data-recovery-stage="failed" title="${full}"`);
    expect(spokenTexts(html)).toEqual([full]);
  });

  it('保存の完了は図柄だけを出し、保存したファイル名の文はツールチップと読み上げへ渡す', () => {
    const state = useAppStore.getState();
    useAppStore.setState({ documentSaveOperation: { id: 'save', documentId: state.activeDocumentId,
      gateway: state.fileGateway, stage: 'complete', fileName: '完成.pcad', cancel: null } });
    const html = renderStatus();
    const done = t('file.save.complete').replace('{name}', '完成.pcad');
    expect(spokenTexts(html)).toEqual([done]);
    expect(visibleText(html)).not.toContain(done);
    expect(html).not.toContain('pcad-statusbar__mark-text');
  });

  it('作図面・吸着・拘束の推定の札は部品の帯だけに出し、アセンブリの帯には出さない(小 21)', () => {
    const part = renderStatus();
    expect(part).toContain(t('statusBar.plane'));
    expect(part).toContain(t('statusBar.inferConstraints'));
    expect(part.includes(t('statusBar.snapOn')) || part.includes(t('statusBar.snapOff'))).toBe(true);
    useAppStore.setState({ assembly: createAssemblyDocument('組立') });
    const assembly = renderStatus();
    for (const label of [t('statusBar.plane'), t('statusBar.snapOn'), t('statusBar.snapOff'), t('statusBar.inferConstraints')]) {
      expect(assembly).not.toContain(label);
    }
    // 選ぶものの札と単位の札はアセンブリでも使うので残す。
    expect(assembly).toContain(t('statusBar.unitMillimeter'));
    expect(assembly).toContain(t('statusBar.selectionFilterHint'));
  });
});
