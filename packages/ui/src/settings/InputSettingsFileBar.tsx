import { useState } from 'react';
import { openFileThrough, saveFileAsThrough } from '../file/fileGateway.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  canUndoInputSettings, decodeInputSettingsFile, encodeInputSettingsFile, inputSettingsValuesOf, INPUT_SETTINGS_SECTIONS,
  planInputSettingsImport, type InputSettingsReading, type InputSettingsRefusal, type InputSettingsSection, type InputSettingsValues,
  type SectionReading,
} from './inputSettingsFile.js';

/**
 * 操作の割り当ての窓の「書き出す」「読み込む」(設計 B-09 3-1)。ファイルの出し入れは既存のファイルの口
 * (saveFileAsThrough・openFileThrough。利用者が選んだ場所だけ)を通す。
 * 読み込みは、窓に下書きがある間は断る。読んだ内容は窓の中に示すだけで、［置き換える］を押した時だけ保存し、
 * 直後なら［元に戻す］で置き換える前の値へ戻す(その後に割り当てが変わっていれば戻さない)。
 */
type FileBarState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'message'; readonly text: string; readonly alert: boolean }
  | { readonly kind: 'preview'; readonly fileName: string; readonly reading: InputSettingsReading }
  | { readonly kind: 'replaced'; readonly previous: InputSettingsValues; readonly written: InputSettingsValues };

const SECTION_LABELS: Readonly<Record<InputSettingsSection, MessageKey>> = {
  view: 'settings.inputBindings.tab.view', keys: 'settings.inputBindings.tab.keys',
  mouse: 'settings.inputBindings.tab.mouse', radial: 'settings.inputBindings.tab.radial', snap: 'settings.snapPause.title',
};

const REFUSAL_TEXTS: Readonly<Record<InputSettingsRefusal, MessageKey>> = {
  tooLarge: 'settings.inputBindings.file.refusal.tooLarge', notJson: 'settings.inputBindings.file.refusal.notJson',
  notSettings: 'settings.inputBindings.file.refusal.notSettings', futureVersion: 'settings.inputBindings.file.refusal.futureVersion',
  badVersion: 'settings.inputBindings.file.refusal.badVersion', nothingReadable: 'settings.inputBindings.file.refusal.nothingReadable',
};

function sectionText(reading: SectionReading): string {
  if (reading.state === 'absent') return t('settings.inputBindings.file.state.absent');
  if (reading.state === 'unreadable') return t('settings.inputBindings.file.state.unreadable');
  return reading.dropped === 0 ? t('settings.inputBindings.file.state.read')
    : t('settings.inputBindings.file.state.readDropped').replace('{count}', String(reading.dropped));
}

function failureText(error: unknown): string {
  return t('settings.inputBindings.file.failed').replace('{reason}', error instanceof Error ? error.message : t('file.openFailed'));
}

/** 読んだ内容と、置き換えた時に外す物・置き換えられない理由。今の設定に対して描くたびに計算し直す。 */
function ImportPreview({ fileName, reading, onReplace, onCancel }: {
  readonly fileName: string; readonly reading: InputSettingsReading; readonly onReplace: () => void; readonly onCancel: () => void;
}): React.JSX.Element {
  const current = useAppStore(state => state.displaySettings);
  const plan = planInputSettingsImport(current, reading);
  return (
    <div className="pcad-input-bindings__file-preview">
      <p className="pcad-input-bindings__file-note">{t('settings.inputBindings.file.preview').replace('{name}', fileName)}</p>
      <ul className="pcad-input-bindings__file-result">
        {INPUT_SETTINGS_SECTIONS.map(section => <li key={section}>
          {t(SECTION_LABELS[section])}: {sectionText(reading.sections[section])}</li>)}
      </ul>
      {reading.unknownFields > 0 ? <p role="status" className="pcad-input-bindings__file-note">
        {t('settings.inputBindings.file.unknownFields').replace('{count}', String(reading.unknownFields))}</p> : null}
      {plan.viewKeysDropped > 0 ? <p role="status" className="pcad-input-bindings__file-note">
        {t('settings.inputBindings.file.viewKeysDropped').replace('{count}', String(plan.viewKeysDropped))}</p> : null}
      {plan.blocked ? <p role="alert" className="pcad-input-bindings__file-note">{t('settings.inputBindings.file.blocked')}</p> : null}
      <button type="button" className="pcad-button" title={t('settings.inputBindings.file.replaceGuide')} disabled={plan.blocked}
        onClick={onReplace}>{t('settings.inputBindings.file.replace')}</button>
      <button type="button" className="pcad-button" title={t('settings.inputBindings.file.cancelGuide')}
        onClick={onCancel}>{t('settings.inputBindings.file.cancel')}</button>
    </div>
  );
}

/** 置き換えた直後の知らせ。5 つの欄が置き換えた時のままの間だけ、［元に戻す］を出す。 */
function ReplacedNotice({ written, onUndo }: { readonly written: InputSettingsValues; readonly onUndo: () => void }): React.JSX.Element {
  const current = useAppStore(state => state.displaySettings);
  if (!canUndoInputSettings(current, written)) {
    return <p role="status" className="pcad-input-bindings__file-note">{t('settings.inputBindings.file.undoUnavailable')}</p>;
  }
  return (
    <p role="status" className="pcad-input-bindings__file-note">{t('settings.inputBindings.file.replaced')}{' '}
      <button type="button" className="pcad-button" title={t('settings.inputBindings.file.undoGuide')}
        onClick={onUndo}>{t('settings.inputBindings.file.undo')}</button></p>
  );
}

export function InputSettingsFileBar({ hasDraft }: { readonly hasDraft: () => boolean }): React.JSX.Element {
  const [state, setState] = useState<FileBarState>({ kind: 'idle' });
  const notify = (text: string, alert: boolean): void => { setState({ kind: 'message', text, alert }); };
  const exportFile = async (): Promise<void> => {
    const { fileGateway, displaySettings } = useAppStore.getState();
    const fileName = `${t('settings.inputBindings.file.defaultName')}.pcadinput`;
    try {
      if (await saveFileAsThrough(fileGateway, fileName, 'pcadinput', encodeInputSettingsFile(displaySettings))) {
        notify(t('settings.inputBindings.file.exported'), false);
      }
    } catch (error) { notify(failureText(error), true); }
  };
  const importFile = async (): Promise<void> => {
    if (hasDraft()) { notify(t('settings.inputBindings.file.draftFirst'), true); return; }
    try {
      const picked = await openFileThrough(useAppStore.getState().fileGateway, ['pcadinput']);
      if (picked === null) return;
      const decoded = decodeInputSettingsFile(picked.bytes);
      if (decoded.ok) setState({ kind: 'preview', fileName: picked.fileName, reading: decoded });
      else notify(t(REFUSAL_TEXTS[decoded.reason]), true);
    } catch (error) { notify(failureText(error), true); }
  };
  const replace = (reading: InputSettingsReading): void => {
    if (hasDraft()) { notify(t('settings.inputBindings.file.draftFirst'), true); return; }
    const store = useAppStore.getState();
    const plan = planInputSettingsImport(store.displaySettings, reading);
    if (plan.blocked) return;
    const previous = inputSettingsValuesOf(store.displaySettings);
    store.setDisplaySettings(plan.next);
    setState({ kind: 'replaced', previous, written: inputSettingsValuesOf(plan.next) });
  };
  const undo = (previous: InputSettingsValues, written: InputSettingsValues): void => {
    const store = useAppStore.getState();
    if (!canUndoInputSettings(store.displaySettings, written)) return;
    store.setDisplaySettings({ ...store.displaySettings, ...previous });
    notify(t('settings.inputBindings.file.undone'), false);
  };
  return (
    <section className="pcad-input-bindings__file" aria-label={t('settings.inputBindings.file.title')}>
      <button type="button" className="pcad-button" title={t('settings.inputBindings.file.exportGuide')}
        onClick={() => { void exportFile(); }}>{t('settings.inputBindings.file.export')}</button>
      <button type="button" className="pcad-button" title={t('settings.inputBindings.file.importGuide')}
        onClick={() => { void importFile(); }}>{t('settings.inputBindings.file.import')}</button>
      {state.kind === 'message' ? <p role={state.alert ? 'alert' : 'status'} className="pcad-input-bindings__file-note">{state.text}</p> : null}
      {state.kind === 'preview' ? <ImportPreview fileName={state.fileName} reading={state.reading}
        onReplace={() => { replace(state.reading); }} onCancel={() => { setState({ kind: 'idle' }); }} /> : null}
      {state.kind === 'replaced' ? <ReplacedNotice written={state.written}
        onUndo={() => { undo(state.previous, state.written); }} /> : null}
    </section>
  );
}
