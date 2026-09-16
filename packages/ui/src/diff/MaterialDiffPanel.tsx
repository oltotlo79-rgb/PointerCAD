import { useEffect, useRef, useState } from 'react';
import type { MaterialComparisonGeometry } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { runMaterialDiff, type MaterialDiffPhase } from './runMaterialDiff.js';
import { MATERIAL_REGIONS, type MaterialRegionSelection } from './materialDiffView.js';
import { MaterialDiffPreview } from './MaterialDiffPreview.js';

export function MaterialDiffPanel({ beforeBytes, afterBytes }: { readonly beforeBytes: Uint8Array; readonly afterBytes: Uint8Array }): React.JSX.Element {
  const operation = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<MaterialDiffPhase | null>(null), [result, setResult] = useState<MaterialComparisonGeometry | null>(null);
  const [selection, setSelection] = useState<MaterialRegionSelection>('all'), [displayReady, setDisplayReady] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, [beforeBytes, afterBytes]);
  const start = async (): Promise<void> => {
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    setPhase('before'); setMessage(null); setResult(null); setSelection('all'); setDisplayReady(false);
    const outcome = await runMaterialDiff(beforeBytes, afterBytes, controller.signal,
      value => { if (operation.current === controller && !controller.signal.aborted) setPhase(value); });
    if (operation.current !== controller || controller.signal.aborted) return;
    operation.current = null; setPhase(null);
    if (outcome.kind === 'compared') setResult(outcome.result);
    else setMessage({ text: outcome.kind === 'cancelled' ? t('materialDiff.cancelled') : outcome.message, error: outcome.kind === 'failed' });
  };
  const cancel = (): void => { operation.current?.abort(); operation.current = null; setPhase(null); setMessage({ text: t('materialDiff.cancelled'), error: false }); };
  const format = (value: number) => value.toLocaleString('ja-JP', { maximumSignificantDigits: 10 });
  const empty = result !== null && MATERIAL_REGIONS.every(name => result[name].kind === 'empty');
  return <section className="pcad-material-diff" aria-label={t('materialDiff.title')}>
    <h3>{t('materialDiff.title')}</h3><p>{t('materialDiff.intro')}</p>
    <button type="button" disabled={phase !== null} title={t('materialDiff.start')} onClick={() => { void start(); }}>{t('materialDiff.start')}</button>
    {phase === null ? null : <><p role="status">{t(`materialDiff.phase.${phase}`)}</p><button type="button" title={t('materialDiff.cancel')} onClick={cancel}>{t('materialDiff.cancel')}</button></>}
    {message === null ? null : <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {result === null ? null : <>
      <div className="pcad-material-diff__summary">
      <p role="status">{t(empty ? 'materialDiff.empty' : result.added.kind === 'empty' && result.removed.kind === 'empty' ? 'materialDiff.same' : 'materialDiff.different')}</p>
      <p>{t('documentDiff.before')}: <span data-material-volume="before" data-value={result.beforeVolume}>{format(result.beforeVolume)} mm³</span>
        {' / '}{t('documentDiff.after')}: <span data-material-volume="after" data-value={result.afterVolume}>{format(result.afterVolume)} mm³</span></p>
      <div role="group" aria-label={t('materialDiff.regions')}>
        <button type="button" title={t('materialDiff.all')} aria-pressed={selection === 'all'} onClick={() => setSelection('all')}>{t('materialDiff.all')}</button>
        <ul>{MATERIAL_REGIONS.map(name => <li key={name} className={`pcad-material-diff__region pcad-material-diff__region--${name}`}>
          <button type="button" title={t(`materialDiff.region.${name}`)} aria-pressed={selection === name} onClick={() => setSelection(name)}>{t(`materialDiff.region.${name}`)}</button>
          {' '}<span data-material-volume={name} data-value={result[name].volume}>{format(result[name].volume)} mm³</span>
          {result[name].kind === 'empty' ? ` (${t('materialDiff.noMaterial')})` : null}
        </li>)}</ul>
      </div>
      </div>
      {empty ? null : <><MaterialDiffPreview result={result} selection={selection} onDisplay={setDisplayReady} />
        {displayReady ? null : <p role="status">{t('materialDiff.displayUnavailable')}</p>}</>}
    </>}
  </section>;
}
