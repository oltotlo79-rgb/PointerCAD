/**
 * パラメータ表(名前を付けた数値)のパネル(要件 FR-207・FR-201・FR-502、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md §0.a-0.15・タスク11)。
 *
 * プロパティ区画の「パラメータ」タブの中身。**区画は増やさない**(rules/04-設計の規律.md)。
 *
 * **右の区画は 280px しかないので、名前・式・値・単位・説明を横 5 列には並べられない。**
 * 1 つのパラメータを縦 1 かたまり(印と操作 → 名前 → 式(下に値)→ 単位 → 説明)にして
 * 積む。見出しと欄の組み方は、いま使っている `pcad-field` の作り(プロパティの式の欄)と
 * 同じにして、利用者が同じ形の欄として見分けられるようにする(NFR-UX-1)。
 *
 * **確定は Enter か、欄の外を押したとき(blur)だけ。** 1 文字打つごとに確定すると
 * `applyParameters`(部品文書を隅々まで歩く)が毎打鍵で走る(タスク10 の落とし穴)。
 * 打っている途中は下書き(表示専用の一時状態)に置き、確定のときに 1 度だけ通す。
 *
 * 文書がまるごと差し替わった(開く・新規・復元・Undo / Redo)ときは、打ちかけの
 * 下書きを捨てて保存済みの値を出す(`fieldDraft.ts`、docs/報告記録.md 2026-09-04
 * 14:05 の 9b。同じ不具合をこの表でも起こさないため)。
 */

import { useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';
import { PARAMETER_UNITS, type ParameterUnit } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { ConfigurationPanel } from './ConfigurationPanel.js';
import { initialDraftVersionState, reconcileDraftVersion } from '../shell/fieldDraft.js';
import { applyDisplayUnit, fieldValueText } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  commitAddParameter,
  commitRemoveParameter,
  commitRenameParameter,
  commitReorderParameters,
  commitReplaceParameter,
  parameterDraftFor,
  parameterRowsOf,
  parameterUsageCounts,
  type ParameterCommandOutcome,
  type ParameterRow,
} from './parameterCommands.js';

/** 表の中で打ちかけになっている欄の種類。 */
type ParameterFieldKind = 'name' | 'source' | 'description';

/**
 * 打ちかけの欄 1 つ。同時に打てる欄は 1 つだけなので 1 件しか持たない
 * (`PropertyPanel.tsx` の `FieldDraft` と同じ流儀)。
 * 断られた理由(NFR-UX-5)は、打った文字をそのまま残して直せるようにしたいので
 * 下書きへ一緒に持つ。
 */
interface ParameterDraft {
  /** どの行か。パラメータの名前(文書の中で重ならない)で指す。 */
  readonly name: string;
  readonly field: ParameterFieldKind;
  readonly text: string;
  /** 断りの理由。断られていなければ null。 */
  readonly message: string | null;
}

/**
 * 単位の見出し。長さと角度は既存の欄と同じ文言を使い回す(同じ語を 2 か所に書かない)。
 * 「なし」だけはこの表にしか出てこないので新しく足す。
 */
const PARAMETER_UNIT_KEYS: Readonly<Record<ParameterUnit, MessageKey>> = {
  mm: 'numericInput.unit.mm',
  degree: 'numericInput.unit.degree',
  none: 'parameterPanel.unit.none',
};

export function ParameterPanel(): React.JSX.Element {
  const document = useAppStore((state) => state.document);
  const analysis = useAppStore((state) => state.parameterAnalysis);
  const documentVersion = useAppStore((state) => state.documentVersion);
  /*
   * 表示の単位と「長さでないパラメータの名前」(FR-811、P6 タスク3b、§0.a-0.63)。
   *
   * **この表の行が長さかどうかは、名前がこの集合にあるかで決める。** 行そのものは
   * `unit`(mm / 度 / なし)を持っているが、その `unit` から「長さか」を決める規則は
   * model の `nonLengthVariables` 1 か所にしかなく、ここで `row.unit === 'mm'` と
   * 書き直すと同じ規則が 2 か所に分かれる。
   */
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const nonLengthVariables = useAppStore((state) => state.nonLengthVariables);
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<ParameterDraft>(documentVersion),
  );
  // 文書が丸ごと差し替わっていたら、この描画のうちに下書きを捨てて文書の値を出す。
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;

  const rows = parameterRowsOf(document, analysis);
  const usage = parameterUsageCounts(document);

  /** 打ちかけを覚える。まだ文書は変えない(確定は Enter / blur、タスク10 の落とし穴)。 */
  const setDraft = (next: ParameterDraft | null): void => {
    setDraftState({ draft: next, seenVersion: documentVersion });
  };

  /**
   * 確定関数の結果をストアへ渡す。断られたら文書は変えず、理由だけを欄の下へ出す
   * (FR-504「止めずに警告する」、NFR-UX-5)。
   */
  const run = (
    outcome: ParameterCommandOutcome,
    rejected: Omit<ParameterDraft, 'message'>,
    coalesceKey?: string,
  ): void => {
    if (!outcome.ok) {
      setDraft({ ...rejected, message: outcome.message });
      return;
    }
    setDraft(null);
    useAppStore
      .getState()
      .applyDocument(outcome.document, coalesceKey === undefined ? undefined : { coalesceKey });
  };

  /** その行の打ちかけ。別の行を打っているときは null。 */
  const draftOf = (row: ParameterRow, field: ParameterFieldKind): ParameterDraft | null =>
    draft !== null && draft.name === row.name && draft.field === field ? draft : null;

  /**
   * その行が**長さ**のパラメータか(タスク3b)。長さの行だけが、表示が inch のときに
   * 単位の無い入力を `(…)in` で包まれる。角度と無次元の行は影響を受けない(FR-205)。
   */
  const isLengthRow = (row: ParameterRow): boolean => !nonLengthVariables.has(row.name);

  /**
   * 打った文字を、**保存する式の文字列**へ直す(§0.a-0.63)。長さの行のときだけ
   * 表示の単位を被せる。判定も綴りも `applyDisplayUnit`(model の `parseDisplayInput`)
   * の 1 か所にある。
   */
  const parameterExpression = (row: ParameterRow, text: string): string =>
    isLengthRow(row) ? applyDisplayUnit(text, 'mm', lengthUnit) : text;

  /** 打ちかけを確定する。打ちかけが無ければ何もしない(Enter の後の blur で二重に通さない)。 */
  const commitDraft = (row: ParameterRow, field: ParameterFieldKind): void => {
    const current = draftOf(row, field);
    if (current === null) {
      return;
    }
    const text = current.text;
    const rejected = { name: row.name, field, text };
    const key = `parameter:${row.name}:${field}`;
    switch (field) {
      case 'name':
        // 改名は参照している式もすべて書き換える(`commitRenameParameter`、FR-207)。
        run(commitRenameParameter(document, row.name, text.trim()), rejected, key);
        return;
      case 'source':
        /*
         * 式は**文字列のまま**入れる(FR-202)。読めない式でも断らず、値は前のまま
         * 据え置く(§2.6 の③)。読めたかどうかは `applyParameters` が判断し、読めなければ
         * `analysis.failures` に理由が入って欄の下へ赤で出る(FR-207、NFR-RE-1)。
         */
        run(
          commitReplaceParameter(document, row.name, {
            value: {
              // 表示が inch なら、単位の無い入力を `(…)in` で包んで保存する(タスク3b)。
              source: parameterExpression(row, text),
              value: row.value,
              display: String(row.value),
            },
          }),
          rejected,
          key,
        );
        return;
      case 'description':
        run(commitReplaceParameter(document, row.name, { description: text }), rejected, key);
        return;
    }
  };

  /**
   * 式の欄の下に出す 1 行。断りが最優先、次に評価できなかった理由、最後に計算した値。
   * 打っている途中の式も 1 本だけなら軽いので、その場で評価して見せる(FR-202、FR-204)。
   */
  const sourceMessage = (row: ParameterRow): string => {
    const current = draftOf(row, 'source');
    if (current !== null && current.message !== null) {
      return current.message;
    }
    // 値だけを表示の単位で出す(タスク3b)。式そのものは書き換えない(FR-202)。
    const unit = isLengthRow(row) ? 'mm' : 'degree';
    if (current === null) {
      return (
        row.failureMessage ??
        `= ${fieldValueText(unit, { value: row.value, display: String(row.value) }, lengthUnit)}`
      );
    }
    const result = evaluateExpression(parameterExpression(row, current.text), {
      ...analysis,
      nonLengthVariables,
    });
    return result.ok
      ? `= ${fieldValueText(unit, result.value, lengthUnit)}`
      : result.error.message;
  };

  /** 名前・式・説明のどれか 1 欄。見出し・入力・下の 1 行の作りは `pcad-field` と同じ。 */
  const renderTextField = (
    row: ParameterRow,
    field: ParameterFieldKind,
    labelKey: MessageKey,
    stored: string,
    message: string,
    hasError: boolean,
  ): React.JSX.Element => {
    const current = draftOf(row, field);
    return (
      <div className={hasError ? 'pcad-field pcad-field--error' : 'pcad-field'}>
        <span className="pcad-field__label" title={t(labelKey)}>
          {t(labelKey)}
        </span>
        <input
          className="pcad-field__input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${t(labelKey)} ${row.name}`}
          aria-invalid={hasError}
          value={current === null ? stored : current.text}
          onChange={(event) => {
            setDraft({ name: row.name, field, text: event.target.value, message: null });
          }}
          onBlur={() => {
            commitDraft(row, field);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitDraft(row, field);
              return;
            }
            if (event.key === 'Escape') {
              // 打ちかけを捨てて保存済みの値へ戻す(NFR-UX-3)。
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
        <span className="pcad-field__unit" />
        <p
          className={
            hasError ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'
          }
        >
          {message}
        </p>
      </div>
    );
  };

  /** 行そのものを差し替える操作(消す・動かす・単位を変える)の断り先。 */
  const rowRejection = (row: ParameterRow): Omit<ParameterDraft, 'message'> => ({
    name: row.name,
    field: 'name',
    text: row.name,
  });

  const renderRow = (row: ParameterRow, index: number): React.JSX.Element => {
    const nameDraft = draftOf(row, 'name');
    const descriptionDraft = draftOf(row, 'description');
    return (
      <li
        className={row.circular ? 'pcad-parameter pcad-parameter--circular' : 'pcad-parameter'}
        key={row.name}
      >
        <div className="pcad-parameter__head">
          <span className="pcad-parameter__marks">
            {/* 使われていない名前は薄い印で示す(FR-207)。消してよいかの手掛かりになる。 */}
            {row.unused ? (
              <span
                className="pcad-parameter__mark pcad-parameter__mark--unused"
                title={t('parameterPanel.unusedTooltip')}
              >
                {t('parameterPanel.unused')}
              </span>
            ) : (
              <span className="pcad-parameter__mark" title={t('parameterPanel.usageTooltip')}>
                {`${String(usage.get(row.name) ?? 0)}${t('parameterPanel.usageSuffix')}`}
              </span>
            )}
            {/* 参照が循環している名前も画面上で示す(FR-207)。理由は表の頭の 1 文で出す。 */}
            {row.circular ? (
              <span
                className="pcad-parameter__mark pcad-parameter__mark--circular"
                title={t('parameterPanel.circularTooltip')}
              >
                {t('parameterPanel.circular')}
              </span>
            ) : null}
          </span>
          <span className="pcad-parameter__actions">
            <button
              type="button"
              className="pcad-button pcad-parameter__action"
              title={t('parameterPanel.moveUpTooltip')}
              aria-label={t('parameterPanel.moveUpTooltip')}
              disabled={index === 0}
              onClick={() => {
                run(commitReorderParameters(document, index, index - 1), rowRejection(row));
              }}
            >
              {t('parameterPanel.moveUpMark')}
            </button>
            <button
              type="button"
              className="pcad-button pcad-parameter__action"
              title={t('parameterPanel.moveDownTooltip')}
              aria-label={t('parameterPanel.moveDownTooltip')}
              disabled={index === rows.length - 1}
              onClick={() => {
                run(commitReorderParameters(document, index, index + 1), rowRejection(row));
              }}
            >
              {t('parameterPanel.moveDownMark')}
            </button>
            <button
              type="button"
              className="pcad-button pcad-parameter__action"
              title={t('parameterPanel.removeTooltip')}
              aria-label={t('parameterPanel.removeTooltip')}
              onClick={() => {
                // 参照が残っている名前は断られる(件数入りの文が名前の欄の下へ出る、タスク10)。
                run(commitRemoveParameter(document, row.name), rowRejection(row));
              }}
            >
              {t('parameterPanel.removeMark')}
            </button>
          </span>
        </div>

        {renderTextField(
          row,
          'name',
          'parameterPanel.nameLabel',
          row.name,
          nameDraft?.message ?? '',
          nameDraft?.message != null,
        )}

        {renderTextField(
          row,
          'source',
          'parameterPanel.sourceLabel',
          row.source,
          sourceMessage(row),
          row.circular || row.failureMessage !== null || draftOf(row, 'source')?.message != null,
        )}

        <div className="pcad-choice pcad-parameter__units">
          <span className="pcad-choice__label">{t('parameterPanel.unitLabel')}</span>
          <div
            className="pcad-segmented pcad-choice__options"
            role="group"
            aria-label={t('parameterPanel.unitLabel')}
          >
            {PARAMETER_UNITS.map((unit) => (
              <button
                key={unit}
                type="button"
                className="pcad-button"
                aria-pressed={row.unit === unit}
                onClick={() => {
                  run(commitReplaceParameter(document, row.name, { unit }), rowRejection(row));
                }}
              >
                {t(PARAMETER_UNIT_KEYS[unit])}
              </button>
            ))}
          </div>
        </div>

        {renderTextField(
          row,
          'description',
          'parameterPanel.descriptionLabel',
          row.description,
          descriptionDraft?.message ?? '',
          descriptionDraft?.message != null,
        )}
      </li>
    );
  };

  return (
    <div className="pcad-section pcad-parameters">
      <ConfigurationPanel key={documentVersion} />
      {/* 循環しているときの 1 文(FR-207、FR-504)。行の赤い印だけでは理由が分からない。 */}
      {analysis.circular.length === 0 ? null : (
        <p className="pcad-panel__error">{t('parameterPanel.circularNote')}</p>
      )}

      {rows.length === 0 ? (
        <div className="pcad-panel__empty">
          <p className="pcad-panel__empty-text">{t('parameterPanel.empty')}</p>
          <p className="pcad-panel__empty-text">{t('parameterPanel.emptyHint')}</p>
        </div>
      ) : (
        <ol className="pcad-parameters__list">{rows.map(renderRow)}</ol>
      )}

      <div className="pcad-parameters__footer">
        <button
          type="button"
          className="pcad-button pcad-button--action"
          title={t('parameterPanel.addTooltip')}
          aria-label={t('parameterPanel.addTooltip')}
          onClick={() => {
            const next = parameterDraftFor(document);
            run(commitAddParameter(document, next), {
              name: next.name,
              field: 'name',
              text: next.name,
            });
          }}
        >
          {t('parameterPanel.addMark')}
        </button>
      </div>
    </div>
  );
}
