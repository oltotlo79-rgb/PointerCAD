import { frameSlotBoltNominals } from '@pointercad/model';
import { useEffect, useRef } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  FRAME_SLOT_NUT_ENTRIES, FRAME_SLOT_NUT_MATERIALS, frameSlotPreviewReady, type AssemblyFrameSlotDraft, type FrameSlotDraftPreview,
  type FrameSlotNutMaterial,
} from './frameSlotFasteningDraft.js';
import { frameSlotReasonText } from './frameSlotReasons.js';

const NOMINALS = frameSlotBoltNominals();

const MATERIAL_KEYS: Readonly<Record<FrameSlotNutMaterial, MessageKey>> = {
  steel: 'assembly.frameSlot.material.steel', stainless: 'assembly.frameSlot.material.stainless',
};

const FACE_KEYS: Readonly<Record<'top' | 'bottom' | 'left' | 'right', MessageKey>> = {
  top: 'assembly.frameSlot.face.top', bottom: 'assembly.frameSlot.face.bottom', left: 'assembly.frameSlot.face.left',
  right: 'assembly.frameSlot.face.right',
};

function promptKey(draft: AssemblyFrameSlotDraft): MessageKey {
  return draft.bracketIds !== null ? 'assembly.frameSlot.promptBracket' : 'assembly.frameSlot.pickHole';
}

/** 予告の表: 穴ごとに 1 行(通った穴は当たったフレームと面・溝用のナット・ボルト、断られた穴は理由)。 */
function PreviewTable({ preview }: { readonly preview: FrameSlotDraftPreview | null }): React.JSX.Element | null {
  if (preview === null) return null;
  if (preview.kind === 'issue') return <p role="status" data-testid="frame-slot-issue">{t(`assembly.frameSlot.issue.${preview.issue}`)}</p>;
  const names = new Map(useAppStore.getState().assembly?.components.map((component) => [component.id, component.name]) ?? []);
  const rows = preview.holes.map((label, index) => {
    const failures = preview.result.ok ? [] : preview.result.failures.filter((failure) => failure.holeIndex === index);
    const entry = preview.result.ok ? preview.result.entries.find((candidate) => candidate.holeIndex === index) : undefined;
    return { index, label, failures, entry };
  });
  const simplified = preview.result.ok && preview.result.entries.some((entry) => entry.nutDepthSimplified);
  const positionSimplified = preview.result.ok && preview.result.entries.some((entry) => entry.slotPositionSimplified);
  return <>
    <table className="pcad-table" data-testid="frame-slot-preview">
      <thead><tr>
        <th>{t('assembly.frameSlot.column.hole')}</th><th>{t('assembly.frameSlot.column.frame')}</th>
        <th>{t('assembly.frameSlot.column.nut')}</th><th>{t('assembly.frameSlot.column.bolt')}</th>
      </tr></thead>
      <tbody>{rows.map(({ index, label, failures, entry }) => failures.length > 0
        ? <tr key={index} role="alert" className="pcad-table__row--error"><td>{`${String(index + 1)} ${label.component}`}</td>
          <td colSpan={3}>{failures.map((failure) => frameSlotReasonText(failure, label)).join(' ')}</td></tr>
        : <tr key={index}><td>{`${String(index + 1)} ${label.component}`}</td>
          <td>{entry === undefined ? '' : `${names.get(entry.frameComponentId) ?? entry.frameComponentId} ${t(FACE_KEYS[entry.face])}`}</td>
          <td>{entry?.nut.name ?? ''}</td><td>{entry?.bolt.name ?? ''}</td></tr>)}
      </tbody>
    </table>
    {simplified ? <p className="pcad-field__hint">{t('assembly.frameSlot.depthSimplified')}</p> : null}
    {positionSimplified ? <p className="pcad-field__hint">{t('assembly.frameSlot.positionSimplified')}</p> : null}
    <p className="pcad-field__hint">{t('assembly.frameSlot.noRecord')}</p>
  </>;
}

/** フレームの溝に締結する窓(モーダルにしない。面を選ぶ間も開いたまま。確定だけが文書を変える)。 */
export function FrameSlotFasteningPopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyFrameSlotDraft);
  const preview = useAppStore((state) => state.assemblyFrameSlotPreview);
  useAppStore((state) => state.displaySettings.selectionModifier); // 選択のキーの案内の文(B-08 2-5)を、設定を変えた時に描き直す
  const root = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  const composing = useRef(false);
  const compositionKey = useRef(false);
  const open = draft !== null;
  useEffect(() => {
    composing.current = false;
    compositionKey.current = false;
  }, [open]);
  // 開いた時は最初の欄へ、閉じた時は開いた元(「組む」のメニューの釦など)へ焦点を戻す(C-03)。
  useDialogFocus(() => root.current, open, { initial: () => first.current });
  if (draft === null) return null;
  const store = useAppStore.getState;
  const ready = frameSlotPreviewReady(preview);
  const title = t('assembly.frameSlot.title');
  return (
    <form ref={root} className="pcad-popover pcad-popover--frame-slot" role="dialog" aria-label={title}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onPointerDownCapture={() => { compositionKey.current = false; }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!composing.current && !compositionKey.current && ready) store().commitFrameSlotFastening();
      }}
      onKeyDown={(event) => {
        compositionKey.current = composing.current || isCompositionKey(event.nativeEvent);
        if (compositionKey.current || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        store().cancelFrameSlotFastening();
      }}>
      <DraggableWindowTitle className="pcad-popover__title">{title}</DraggableWindowTitle>
      <p role="status" data-testid="frame-slot-prompt">{t(promptKey(draft))}</p>
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.frameSlot.nominal')}</span>
          <select ref={first} className="pcad-field__input" value={draft.nominal} title={t('assembly.frameSlot.nominalGuide')}
            onChange={(event) => store().updateFrameSlotDraft({ nominal: event.currentTarget.value })}>
            {NOMINALS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.frameSlot.nutEntry')}</span>
          <select className="pcad-field__input" value={draft.nutEntry} title={t('assembly.frameSlot.nutEntryGuide')}
            onChange={(event) => store().updateFrameSlotDraft({ nutEntry: event.currentTarget.value })}>
            {FRAME_SLOT_NUT_ENTRIES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.frameSlot.nutMaterial')}</span>
          <select className="pcad-field__input" value={draft.nutMaterial} title={t('assembly.frameSlot.nutMaterialGuide')}
            onChange={(event) => store().updateFrameSlotDraft({ nutMaterial: event.currentTarget.value })}>
            {FRAME_SLOT_NUT_MATERIALS.map((material) => <option key={material} value={material}>
              {t(MATERIAL_KEYS[material])}</option>)}
          </select>
        </label>
      </div>
      <PreviewTable preview={preview} />
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button" disabled={!ready} title={t('assembly.frameSlot.commitTooltip')}
          data-testid="frame-slot-commit">{t('assembly.frameSlot.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.frameSlot.bracketTooltip')}
          onClick={() => store().beginFrameSlotFastening(store().selection)}>{t('assembly.frameSlot.bracket')}</button>
        <button type="button" className="pcad-button" title={t('assembly.frameSlot.cancelTooltip')}
          onClick={() => store().cancelFrameSlotFastening()}>{t('assembly.frameSlot.cancel')}</button>
      </div>
    </form>
  );
}
