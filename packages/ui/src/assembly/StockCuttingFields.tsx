/**
 * 切断の一覧の下の「定尺への割り付け」(J-01 包み 7)。定尺・切断代の欄は端末の表示の設定(stockCutting)を書き、文書は変えない。
 * 定尺が空の時は割り付けと歩留まりを出さず、「定尺を入れると出す」と案内する。割り付けの文字は `stockCuttingView.ts`。
 */
import { useState, type KeyboardEvent } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { DEFAULT_STOCK_CUTTING, type StockCuttingSettings } from './stockCuttingSettings.js';
import { stockCuttingView, type StockCuttingRow } from './stockCuttingView.js';

/** 欄の Enter で選ぶ窓の「置く」が動かないようにする。 */
const keepEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') event.preventDefault(); };

/** 欄の文字を設定の値にする。定尺の空は null(指定しない)。読めない・範囲の外は undefined(書かない)。 */
function parsed(text: string, kind: 'stock' | 'kerf'): number | null | undefined {
  if (text.trim() === '') return kind === 'stock' ? null : 0;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  return kind === 'stock' ? (value > 0 ? value : undefined) : (value >= 0 ? value : undefined);
}

export function StockCuttingFields({ rows }: { readonly rows: readonly StockCuttingRow[] }): React.JSX.Element {
  const settings = useAppStore((state) => state.displaySettings.stockCutting) ?? DEFAULT_STOCK_CUTTING;
  const [texts, setTexts] = useState({ stock: settings.stockLengthMm === null ? '' : String(settings.stockLengthMm),
    kerf: String(settings.kerfMm) });
  const [invalid, setInvalid] = useState(false);
  const change = (kind: 'stock' | 'kerf', text: string): void => {
    setTexts({ ...texts, [kind]: text });
    const value = parsed(text, kind);
    setInvalid(value === undefined);
    if (value === undefined) return;
    const next: StockCuttingSettings = kind === 'stock' ? { ...settings, stockLengthMm: value } : { ...settings, kerfMm: value ?? 0 };
    const app = useAppStore.getState();
    app.setDisplaySettings({ ...app.displaySettings, stockCutting: next });
  };
  const view = stockCuttingView(rows, settings);
  return (
    <div className="pcad-popover__hint">
      <p>{t('catalog.stockCutting.title')}</p>
      {(['stock', 'kerf'] as const).map((kind) => <label key={kind} className="pcad-field">
        <span className="pcad-field__label">{t(kind === 'stock' ? 'catalog.stockCutting.stockLength' : 'catalog.stockCutting.kerf')}</span>
        <input className="pcad-field__input" value={texts[kind]} onKeyDown={keepEnter}
          title={t(kind === 'stock' ? 'catalog.stockCutting.stockLengthGuide' : 'catalog.stockCutting.kerfGuide')}
          onChange={(event) => { change(kind, event.currentTarget.value); }} />
        <span className="pcad-field__unit">mm</span>
      </label>)}
      {invalid ? <p className="pcad-field__message" role="alert">{t('catalog.stockCutting.invalid')}</p> : null}
      {view.kind === 'noStock' ? <p>{t('catalog.stockCutting.noStock')}</p> : <>
        {view.groups.map((group, index) => <div key={index}>
          <p>{group.summary}</p>
          <ul>{group.bars.map((bar) => <li key={bar}>{bar}</li>)}</ul>
        </div>)}
        <p>{t('catalog.stockCutting.note')}</p>
      </>}
    </div>
  );
}
