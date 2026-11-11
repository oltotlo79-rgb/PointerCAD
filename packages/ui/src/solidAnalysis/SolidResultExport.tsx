import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import type { SolidAnalysisSession } from './solidAnalysisSession.js';
import { exportSolidResultCsv } from './exportSolidResultCsv.js';

export function SolidResultExport({ session }: { readonly session: SolidAnalysisSession }): React.JSX.Element {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly result: SolidAnalysisSession['result']; readonly text: string } | null>(null);
  const message = notice !== null && notice.result === session.result ? notice.text : '';
  useEffect(() => () => { const old = pending.current; pending.current = null; old?.abort(); }, []);
  const save = async (): Promise<void> => {
    if (pending.current !== null) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setNotice(null);
    try {
      const saved = await exportSolidResultCsv(session, controller.signal);
      if (pending.current === controller && saved !== null) setNotice({ result: session.result, text: t(saved
        ? 'solidAnalysis.exportCsvSaved' : 'solidAnalysis.exportCsvCancelled') });
    } catch {
      if (pending.current === controller) setNotice({ result: session.result, text: t('solidAnalysis.exportCsvFailed') });
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };
  return <div>
    <button type="button" disabled={busy || session.status !== 'complete' || session.result === null}
      title={t('solidAnalysis.exportCsvHelp')} onClick={() => { void save(); }}>{t('solidAnalysis.exportCsv')}</button>
    <p>{t('solidAnalysis.exportCsvHelp')}</p>
    {message === '' ? null : <p role="status">{message}</p>}
  </div>;
}
