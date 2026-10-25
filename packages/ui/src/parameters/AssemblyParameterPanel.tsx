/**
 * アセンブリ文書のパラメータ表(合致の距離・分解の距離・ジョイントの範囲などが名前で呼ぶ数値)。
 *
 * 部品のパラメータ表(`ParameterPanel.tsx`)と同じ流儀を守る。
 * - 確定は Enter か欄の外を押したとき(blur)だけ。打っている途中は下書きに置く。
 * - 日本語の変換中(isComposing / keyCode 229)の Enter では確定しない。Escape で下書きを捨てる。
 * - 断られたら文書は変えず、理由を欄の下へ出す(aria-invalid と aria-describedby で欄と結ぶ)。
 *
 * 確定は必ず「確定の瞬間のストアのアセンブリ」に対して命令を作り、`applyAssembly` だけで反映する
 * (Undo / Redo はアセンブリの既存の履歴)。描画した時の文書と確定時の文書が違えば、古い文書から
 * 作った結果で後の編集を上書きしないよう、何もしないで下書きを捨てる。部品の表は変えない。
 */
import { useState } from 'react';
import { PARAMETER_UNITS, type AssemblyDocument, type LengthUnit, type ParameterUnit } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { applyDisplayUnit, fieldValueText } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  assemblyParameterDraftFor,
  assemblyParameterRows,
  commitAddAssemblyParameter,
  commitRemoveAssemblyParameter,
  commitRenameAssemblyParameter,
  commitReorderAssemblyParameters,
  commitReplaceAssemblyParameter,
  type AssemblyParameterCommandOutcome,
} from './assemblyParameterCommands.js';
import type { ParameterRow } from './parameterCommands.js';

type AssemblyParameterField = 'name' | 'source' | 'description';

interface AssemblyParameterDraft {
  readonly name: string;
  readonly field: AssemblyParameterField;
  readonly text: string;
  readonly message: string | null;
}

/** 単位の見出しは部品の表と同じ文言を使う。 */
const UNIT_KEYS: Readonly<Record<ParameterUnit, MessageKey>> = {
  mm: 'numericInput.unit.mm',
  degree: 'numericInput.unit.degree',
  none: 'parameterPanel.unit.none',
};

const FIELD_LABELS: Readonly<Record<AssemblyParameterField, MessageKey>> = {
  name: 'parameterPanel.nameLabel',
  source: 'parameterPanel.sourceLabel',
  description: 'parameterPanel.descriptionLabel',
};

/**
 * 打った式を保存する式へ直す。長さ(mm)の行だけ、部品の表(ParameterPanel)と同じ `applyDisplayUnit` で表示の
 * 単位を被せる(inch 表示で単位の無い `2` は `(2)in`)。角度・無次元の行は打った文字のまま。
 */
export function assemblyParameterSource(unit: ParameterUnit, text: string, lengthUnit: LengthUnit): string {
  return unit === 'mm' ? applyDisplayUnit(text, 'mm', lengthUnit) : text;
}

/** 値の行。部品の表と同じ `fieldValueText` で表示の単位へ直す(inch のときは単位も helper が添える)。 */
export function assemblyParameterValueText(row: ParameterRow, lengthUnit: LengthUnit): string {
  const shown = fieldValueText(row.unit === 'mm' ? 'mm' : 'degree', { value: row.value, display: String(row.value) }, lengthUnit);
  return row.unit === 'none' || (row.unit === 'mm' && lengthUnit === 'inch') ? `= ${shown}` : `= ${shown} ${t(UNIT_KEYS[row.unit])}`;
}

export type AssemblyParameterCommitResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'stale' };

/**
 * 1 回の確定。`rendered` と `renderedVersion` は画面を描いた時のアセンブリと documentVersion。現在のものが違う(閉じた・
 * 開き直した・別の編集が先に入った・Undo した)なら、命令を作らず 'stale' を返す。同じなら、その
 * 現在の文書から命令を作り、通ったときだけ `applyAssembly` を 1 回呼ぶ。
 */
export function commitAssemblyParameterEdit(
  rendered: AssemblyDocument,
  command: (current: AssemblyDocument) => AssemblyParameterCommandOutcome,
  renderedVersion: number,
): AssemblyParameterCommitResult {
  const store = useAppStore.getState();
  const current = store.assembly;
  // Undo / Redo と開き直しは同じオブジェクトを戻せるので、同一性だけでは版を区別できない。下書きと同じく版も比べる。
  if (current === null || current !== rendered || store.documentVersion !== renderedVersion) return { kind: 'stale' };
  const outcome = command(current);
  if (!outcome.ok) return { kind: 'rejected', message: outcome.message };
  store.applyAssembly(outcome.document);
  return { kind: 'applied' };
}

export function AssemblyParameterPanel(): React.JSX.Element | null {
  const document = useAppStore((state) => state.assembly);
  const documentVersion = useAppStore((state) => state.documentVersion);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const [draft, setDraftState] = useState<{ readonly value: AssemblyParameterDraft; readonly owner: AssemblyDocument;
    readonly version: number } | null>(null);
  if (document === null) return null;
  // 文書が差し替わった(開く・Undo / Redo・他の確定)ら、打ちかけを捨てて保存済みの値を出す。
  const current = draft !== null && draft.owner === document && draft.version === documentVersion ? draft.value : null;
  const rows = assemblyParameterRows(document);

  const setDraft = (value: AssemblyParameterDraft | null): void => {
    setDraftState(value === null ? null : { value, owner: document, version: documentVersion });
  };
  const draftOf = (row: ParameterRow, field: AssemblyParameterField): AssemblyParameterDraft | null =>
    current !== null && current.name === row.name && current.field === field ? current : null;

  /**
   * 結果を画面へ返す。断りは打った文字を残したまま欄の下へ出す。通ったとき、または古い文書だった
   * ときは下書きを捨てる(古い文書のときは部品の表の run() と同じく、最新の文書の値がそのまま見える)。
   */
  const settle = (result: AssemblyParameterCommitResult, rejected: Omit<AssemblyParameterDraft, 'message'>): void => {
    if (result.kind === 'rejected') {
      setDraft({ ...rejected, message: result.message });
      return;
    }
    setDraft(null);
  };

  /** 打ちかけを確定する。打ちかけが無ければ何もしない(Enter の後の blur で二重に通さない)。 */
  const commitDraft = (row: ParameterRow, field: AssemblyParameterField): void => {
    const pending = draftOf(row, field);
    if (pending === null) return;
    const rejected = { name: row.name, field, text: pending.text };
    setDraft(null);
    switch (field) {
      case 'name':
        settle(commitAssemblyParameterEdit(document, (doc) => commitRenameAssemblyParameter(doc, row.name, pending.text.trim()), documentVersion), rejected);
        return;
      case 'source':
        // 式は文字列のまま入れる。読めない式・循環も断らずに残し、理由を行に出す(部品の表と同じ)。
        settle(commitAssemblyParameterEdit(document, (doc) => commitReplaceAssemblyParameter(doc, row.name, {
          value: { source: assemblyParameterSource(row.unit, pending.text, lengthUnit), value: row.value, display: String(row.value) },
        }), documentVersion), rejected);
        return;
      case 'description':
        settle(commitAssemblyParameterEdit(document, (doc) => commitReplaceAssemblyParameter(doc, row.name, { description: pending.text }), documentVersion), rejected);
        return;
    }
  };

  const rowRejection = (row: ParameterRow): Omit<AssemblyParameterDraft, 'message'> => ({ name: row.name, field: 'name', text: row.name });

  const renderTextField = (row: ParameterRow, index: number, field: AssemblyParameterField, stored: string,
    message: string, hasError: boolean): React.JSX.Element => {
    const pending = draftOf(row, field);
    const messageId = `assembly-parameter-${String(index)}-${field}-message`;
    return (
      <div className={hasError ? 'pcad-field pcad-field--error' : 'pcad-field'}>
        <span className="pcad-field__label" title={t(FIELD_LABELS[field])}>{t(FIELD_LABELS[field])}</span>
        <input title={t(`controlGuide.parameter.${field}`)} className="pcad-field__input" type="text" inputMode="text"
          autoComplete="off" spellCheck={false} aria-label={`${t(FIELD_LABELS[field])} ${row.name}`}
          aria-invalid={hasError} aria-describedby={messageId}
          value={pending === null ? stored : pending.text}
          onChange={(event) => { setDraft({ name: row.name, field, text: event.target.value, message: null }); }}
          onBlur={() => { commitDraft(row, field); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') { event.preventDefault(); commitDraft(row, field); return; }
            if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
          }} />
        <span className="pcad-field__unit" />
        <p id={messageId} role={hasError ? 'alert' : undefined}
          className={hasError ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'}>{message}</p>
      </div>
    );
  };

  const renderRow = (row: ParameterRow, index: number): React.JSX.Element => {
    const nameDraft = draftOf(row, 'name');
    const sourceDraft = draftOf(row, 'source');
    const descriptionDraft = draftOf(row, 'description');
    const sourceMessage = sourceDraft?.message ?? row.failureMessage
      ?? assemblyParameterValueText(row, lengthUnit);
    return (
      <li key={row.name} className={row.circular ? 'pcad-parameter pcad-parameter--circular' : 'pcad-parameter'}>
        <div className="pcad-parameter__head">
          <span className="pcad-parameter__marks">
            {row.unused ? <span className="pcad-parameter__mark pcad-parameter__mark--unused" title={t('parameterPanel.unusedTooltip')}>
              {t('parameterPanel.unused')}</span> : null}
            {row.circular ? <span className="pcad-parameter__mark pcad-parameter__mark--circular" title={t('parameterPanel.circularTooltip')}>
              {t('parameterPanel.circular')}</span> : null}
          </span>
          <span className="pcad-parameter__actions">
            <button type="button" className="pcad-button pcad-parameter__action" title={t('parameterPanel.moveUpTooltip')}
              aria-label={`${t('parameterPanel.moveUpTooltip')} ${row.name}`} disabled={index === 0}
              onClick={() => { settle(commitAssemblyParameterEdit(document, (doc) => commitReorderAssemblyParameters(doc, index, index - 1), documentVersion), rowRejection(row)); }}>
              {t('parameterPanel.moveUpMark')}</button>
            <button type="button" className="pcad-button pcad-parameter__action" title={t('parameterPanel.moveDownTooltip')}
              aria-label={`${t('parameterPanel.moveDownTooltip')} ${row.name}`} disabled={index === rows.length - 1}
              onClick={() => { settle(commitAssemblyParameterEdit(document, (doc) => commitReorderAssemblyParameters(doc, index, index + 1), documentVersion), rowRejection(row)); }}>
              {t('parameterPanel.moveDownMark')}</button>
            <button type="button" className="pcad-button pcad-parameter__action" title={t('parameterPanel.removeTooltip')}
              aria-label={`${t('parameterPanel.removeTooltip')} ${row.name}`}
              onClick={() => { settle(commitAssemblyParameterEdit(document, (doc) => commitRemoveAssemblyParameter(doc, row.name), documentVersion), rowRejection(row)); }}>
              {t('parameterPanel.removeMark')}</button>
          </span>
        </div>
        {renderTextField(row, index, 'name', row.name, nameDraft?.message ?? '', nameDraft?.message != null)}
        {renderTextField(row, index, 'source', row.source, sourceMessage,
          row.circular || row.failureMessage !== null || sourceDraft?.message != null)}
        <div className="pcad-choice pcad-parameter__units">
          <span className="pcad-choice__label">{t('parameterPanel.unitLabel')}</span>
          <div className="pcad-segmented pcad-choice__options" role="group" aria-label={`${t('parameterPanel.unitLabel')} ${row.name}`}>
            {PARAMETER_UNITS.map((unit) => (
              <button key={unit} type="button" className="pcad-button" title={t('controlGuide.parameter.unit')} aria-pressed={row.unit === unit}
                onClick={() => { settle(commitAssemblyParameterEdit(document, (doc) => commitReplaceAssemblyParameter(doc, row.name, { unit }), documentVersion), rowRejection(row)); }}>
                {t(UNIT_KEYS[unit])}</button>
            ))}
          </div>
        </div>
        {renderTextField(row, index, 'description', row.description, descriptionDraft?.message ?? '', descriptionDraft?.message != null)}
      </li>
    );
  };

  return (
    <section className="pcad-section pcad-parameters" data-testid="assembly-parameters">
      <h3 className="pcad-section__title">{t('propertyPanel.tabParameters')}</h3>
      {rows.some((row) => row.circular) ? <p className="pcad-panel__error">{t('parameterPanel.circularNote')}</p> : null}
      {rows.length === 0 ? (
        <div className="pcad-panel__empty">
          <p className="pcad-panel__empty-text">{t('parameterPanel.empty')}</p>
          <p className="pcad-panel__empty-text">{t('parameterPanel.emptyHint')}</p>
        </div>
      ) : <ol className="pcad-parameters__list">{rows.map(renderRow)}</ol>}
      <div className="pcad-parameters__footer">
        <button type="button" className="pcad-button pcad-button--action" title={t('parameterPanel.addTooltip')}
          aria-label={t('parameterPanel.addTooltip')}
          onClick={() => {
            const next = assemblyParameterDraftFor(document);
            settle(commitAssemblyParameterEdit(document, (doc) => commitAddAssemblyParameter(doc, next), documentVersion),
              { name: next.name, field: 'name', text: next.name });
          }}>{t('parameterPanel.addMark')}</button>
      </div>
    </section>
  );
}
