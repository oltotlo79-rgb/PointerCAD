import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { importFile } from './exchangeActions.js';
import { IMPORT_FILE_KINDS, type ImportFileKind } from './exchangeFile.js';
import './importFormat.css';

/** ファイルを開く前の形式選択。DWGではファイル選択を起動せず、変換手順を出す。 */
export function ImportFormatPanel({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [dwg, setDwg] = useState(false);
  const documentId = useAppStore(state => state.document.id);
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && container.current !== null && !container.current.contains(event.target)) onClose();
    };
    globalThis.addEventListener('pointerdown', outside);
    return () => { globalThis.removeEventListener('pointerdown', outside); };
  }, [onClose]);
  const initialDocumentId = useRef(documentId);
  useEffect(() => { if (documentId !== initialDocumentId.current) onClose(); }, [documentId, onClose]);
  const choose = (kind?: ImportFileKind): void => {
    if (kind === 'dwg') { setDwg(true); return; }
    onClose();
    void importFile(kind);
  };
  return <div className="pcad-menu pcad-menu--exchange" ref={container}>
    <form className="pcad-menu__panel pcad-exchange pcad-import-format" aria-label={t('exchange.importTitle')}
      data-help-topic="dxf" onSubmit={event => { event.preventDefault(); if (!dwg) choose(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <span className="pcad-exchange__title">{t('exchange.importTitle')}</span>
      <p className="pcad-exchange__notice">{t('exchange.chooseImportFormat')}</p>
      <button type="button" className="pcad-button pcad-button--action" autoFocus onClick={() => { choose(); }}>{t('exchange.chooseImportFile')}</button>
      <div className="pcad-import-format__kinds" role="group" aria-label={t('exchange.format')}>
        {IMPORT_FILE_KINDS.map(kind => <button key={kind} type="button" className="pcad-button pcad-button--action"
          onClick={() => { choose(kind); }} aria-pressed={kind === 'dwg' && dwg}>
          {kind === 'glb' ? 'glTF' : kind.toUpperCase()}{kind === 'dwg' ? ` (${t('exchange.conversionRequired')})` : ''}
        </button>)}
      </div>
      {dwg ? <div className="pcad-import-format__guide" role="status">
        <p>{t('exchange.dwgGuide')}</p>
        <button type="button" className="pcad-button pcad-button--action" onClick={() => {
          useAppStore.getState().openHelpTopic('dxf');
        }}>{t('exchange.dwgHelp')}</button>
        <button type="button" className="pcad-button pcad-button--action" onClick={() => { choose('dxf'); }}>{t('exchange.chooseConvertedDxf')}</button>
      </div> : null}
      <button type="button" className="pcad-button pcad-button--action" onClick={onClose}>{t('exchange.cancel')}</button>
    </form>
  </div>;
}
