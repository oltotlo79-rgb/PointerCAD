/**
 * 選ぶ窓の「選んだ枠にパネルをはめる」(E-10 第 1 段)。ビューか木で枠の部材 4 本(同じ面の上で直交する 2 組)を選び、板の行と隙間を
 * 選ぶと、開口の内側の寸法から板の寸法を予告し、1 回で置く(元に戻す 1 回で戻る)。流れは framePanelActions.ts。
 */
import { evaluateExpression } from '@pointercad/expression';
import { PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { useEffect, useState, type KeyboardEvent } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { framePanelPlan, framePanelReasonText, placeFramePanel } from './framePanelActions.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

/** 欄の Enter で選ぶ窓の「置く」が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };

export function FramePanelDetails(): React.JSX.Element {
  const [itemKey, setItemKey] = useState<string | null>(null);
  const [gapText, setGapText] = useState('0');
  const [message, setMessage] = useState<{ readonly role: 'status' | 'alert'; readonly text: string } | null>(null);
  const [ready, setReady] = useState(PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY) !== undefined);
  // 予告は、選択・文書・表示が変わるたびに作り直す。
  useAppStore((state) => state.selection);
  useAppStore((state) => state.assemblyView);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void PRODUCT_CATALOG_REGISTRY.ensure([FENCE_PANEL_FAMILY]).then(() => { if (live) setReady(true); }, () => {});
    return () => { live = false; };
  }, [ready]);
  const gap = evaluateExpression(gapText);
  const plan = !gap.ok ? { ok: false as const, reason: 'invalidNumber' } : framePanelPlan(itemKey, gap.value.value);
  const rows = ready ? PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY)?.rows ?? [] : [];
  const place = (): void => {
    if (!plan.ok || !gap.ok) return;
    const placed = placeFramePanel(itemKey, gap.value.value);
    setMessage(placed.ok ? { role: 'status', text: t('catalog.framePanel.placed') } : { role: 'alert', text: framePanelReasonText(placed.reason) });
  };
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.framePanel.title')}</summary>
      <p>{t('catalog.framePanel.hint')}</p>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.framePanel.panel')}</span>
        <select title={t('catalog.framePanel.panelGuide')} className="pcad-field__input" value={itemKey ?? ''}
          onChange={(event) => { setItemKey(event.currentTarget.value === '' ? null : event.currentTarget.value); setMessage(null); }}>
          <option value="">{t('catalog.framePanel.panelNone')}</option>
          {rows.map((row) => <option key={row.key} value={row.key}>{row.size}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('catalog.framePanel.gap')}</span>
        <input title={t('catalog.framePanel.gapGuide')} className="pcad-field__input" value={gapText} onKeyDown={keepEnter}
          onChange={(event) => { setGapText(event.currentTarget.value); setMessage(null); }} />
        <span className="pcad-field__unit">mm</span>
      </label>
      {plan.ok ? <p>{t('catalog.framePanel.preview').replace('{width}', String(plan.opening.width)).replace('{height}', String(plan.opening.height))}</p>
        : <p className="pcad-field__message">{framePanelReasonText(plan.reason)}</p>}
      <button type="button" className="pcad-button pcad-button--action" disabled={!plan.ok} title={t('catalog.framePanel.placeGuide')}
        onClick={place}>{t('catalog.framePanel.place')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
