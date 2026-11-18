/**
 * 選ぶ窓の「ケガキの位置」(E-14)。組立の部材ごとに、ほかの部材や溝のナットが取り付く位置を、部材の始点の端からの距離と面で
 * 一覧に出し、CSV に書き出す(中身は frameScribeMarksView.ts)。欄を開いた時と文書・表示が変わった時に求め直す。
 */
import { useMemo, useState } from 'react';

import { saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { scribeMarksOf, scribeMemberText, serializeScribeMarksCsv } from './frameScribeMarksView.js';

export function FrameScribeMarksDetails(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly role: 'status' | 'alert'; readonly text: string } | null>(null);
  const assembly = useAppStore((state) => state.assembly);
  const view = useAppStore((state) => state.assemblyView);
  // 閉じている間は求めない(部材が多い組立で、窓を開くたびに全部を照らさない)。
  const entries = useMemo(() => !open || assembly === null || view === null ? [] : scribeMarksOf(assembly, view.resolved.placements),
    [open, assembly, view]);
  const save = async (): Promise<void> => {
    const state = useAppStore.getState();
    if (assembly === null || entries.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await saveFileAsThrough(state.fileGateway, 'frame-scribe-marks.csv', 'csv', serializeScribeMarksCsv(assembly, entries));
      setMessage({ role: 'status', text: t(saved ? 'catalog.scribe.csv.saved' : 'catalog.scribe.csv.cancelled') });
    } catch (error) {
      setMessage({ role: 'alert', text: error instanceof Error ? error.message : t('catalog.scribe.csv.failed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="pcad-popover__hint" onToggle={(event) => { setOpen(event.currentTarget.open); }}>
      <summary>{t('catalog.scribe.title')}</summary>
      <p>{t('catalog.scribe.hint')}</p>
      {entries.length === 0 ? <p>{t('catalog.scribe.none')}</p>
        : <ul>{entries.map((entry) => <li key={entry.componentId}>{assembly === null ? '' : scribeMemberText(assembly, entry)}</li>)}</ul>}
      <button type="button" className="pcad-button" disabled={busy || entries.length === 0} title={t('catalog.scribe.csv.exportGuide')}
        onClick={() => { void save(); }}>{t('catalog.scribe.csv.export')}</button>
      {message === null ? null : <p role={message.role}>{message.text}</p>}
    </details>
  );
}
