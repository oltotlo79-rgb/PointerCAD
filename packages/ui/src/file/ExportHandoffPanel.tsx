import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { openCamWebsite, openWith, type ExportHandoff, type OpenWithAction } from './openWith.js';

const labels: Readonly<Record<OpenWithAction, MessageKey>> = {
  default: 'cam.openDefault', kiri: 'cam.openKiri', prusa: 'cam.openPrusa', help: 'cam.help',
};
function HandoffContent({ handoff }: { readonly handoff: ExportHandoff }): React.JSX.Element {
  const gateway = useAppStore((state) => state.fileGateway);
  const close = useAppStore((state) => state.clearExportHandoff);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [running, setRunning] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const act = (action: OpenWithAction): void => {
    if (action === 'help') { useAppStore.getState().openHelpTopic('cam'); return; }
    setFailed(false);
    if (action !== 'default' && gateway.openCamTool === undefined) {
      openCamWebsite(action, (url, target, features) => window.open(url, target, features));
      return;
    }
    setRunning(true);
    const opening = action === 'default'
      ? (handoff.token === null ? Promise.resolve(false) : gateway.openExport?.(handoff.token) ?? Promise.resolve(false))
      : gateway.openCamTool?.(action) ?? Promise.resolve(false);
    void opening.then((ok) => { setFailed(!ok); setRunning(false); }, () => { setFailed(true); setRunning(false); });
  };
  return <section className="pcad-card pcad-cam-handoff" role="dialog" aria-label={t('cam.title')} data-help-topic="cam"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <div className="pcad-cam-handoff__heading"><h2>{t('cam.title')}</h2>
      <button className="pcad-button" type="button" ref={closeRef} onClick={close}>{t('cam.close')}</button></div>
    <p>{t('cam.saved').replace('{format}', handoff.format.toUpperCase())}</p>
    <p>{t('cam.noUpload')}</p>
    {openWith(handoff.format, handoff.token !== null && gateway.openExport !== undefined).map((action) =>
      <button className="pcad-button pcad-button--action" type="button" key={action} disabled={running} onClick={() => { act(action); }}>{t(labels[action])}</button>)}
    {handoff.format === 'step' && <p>{t('cam.stepHint')}</p>}
    {failed && <p role="alert">{t('cam.openFailed')}</p>}
  </section>;
}
export function ExportHandoffPanel(): React.JSX.Element | null {
  const handoff = useAppStore((state) => state.exportHandoff);
  return handoff === null ? null : <HandoffContent handoff={handoff} />;
}
