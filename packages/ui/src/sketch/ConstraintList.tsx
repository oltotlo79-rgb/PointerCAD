import { useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { changeConstraintValue, removeConstraintById } from './constraintActions.js';
import type { ConstraintState, ConstraintSummary } from './constraintSummary.js';

/**
 * 拘束の一覧(FR-313、FR-501、FR-504、NFR-UX-7、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク13)。
 *
 * **区画は増やさない**(rules/04-設計の規律.md)。右のプロパティ区画の「プロパティ」タブの
 * 下に、いま編集しているスケッチの拘束を並べる。行には記号・名前・何を指しているか・
 * 値(寸法拘束だけ)・状態を出し、行を押すと 3D の印が光り、「×」で消せる。
 *
 * 拘束が 1 つも無いスケッチでは**何も出さない**(空の見出しで区画を埋めない)。
 * 行の中身の組み立ては `constraintSummary.ts`(t12、純関数)が持ち、ここは描くだけ。
 */

/** 状態ごとの行の飾り。文言は `constraintSummary.ts` が `stateMessage` に入れている。 */
const STATE_CLASS: Readonly<Record<ConstraintState, string>> = {
  ok: '',
  conflicting: ' pcad-constraint-row--conflicting',
  redundant: ' pcad-constraint-row--redundant',
  dangling: ' pcad-constraint-row--dangling',
};

interface ConstraintValueFieldProps {
  readonly summary: ConstraintSummary;
}

/**
 * 寸法拘束の値の欄(FR-313、FR-207)。式のまま入るので、パラメータ表の名前を書けば
 * 表を 1 か所直すだけで形が追従する。
 *
 * 打ちかけの文字列だけを `useState` で持つ(表示専用の一時状態、rules/04)。読める式に
 * なった時点で文書へ流し、読めないあいだは形を変えない(打っている途中で壊れないように)。
 */
function ConstraintValueField({ summary }: ConstraintValueFieldProps): React.JSX.Element {
  const analysis = useAppStore((state) => state.parameterAnalysis);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? summary.value?.source ?? '';
  const readable = evaluateExpression(shown, analysis).ok;

  return (
    <input
      type="text"
      className={
        readable
          ? 'pcad-constraint-row__value'
          : 'pcad-constraint-row__value pcad-constraint-row__value--error'
      }
      value={shown}
      spellCheck={false}
      autoComplete="off"
      inputMode="text"
      title={t('constraintList.valueTooltip')}
      aria-label={`${summary.label} ${t('constraintList.valueTooltip')}`}
      aria-invalid={!readable}
      onChange={(event) => {
        setDraft(event.target.value);
        // 読めない式のあいだは `changeConstraintValue` が文書を変えない(そちらの注釈)。
        changeConstraintValue(summary.id, event.target.value);
      }}
      onBlur={() => {
        // 打ちかけを捨てて、文書に入っている式へ戻す。
        setDraft(null);
      }}
    />
  );
}

export function ConstraintList(): React.JSX.Element | null {
  const summaries = useAppStore((state) => state.constraintSummaries);
  const selectedConstraintId = useAppStore((state) => state.selectedConstraintId);
  const setSelectedConstraint = useAppStore((state) => state.setSelectedConstraint);

  if (summaries.length === 0) {
    return null;
  }

  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('constraintList.title')}</h3>
      <ul className="pcad-constraint-list">
        {summaries.map((summary) => {
          const chosen = summary.id === selectedConstraintId;
          const className = `pcad-constraint-row${
            chosen ? ' pcad-constraint-row--selected' : ''
          }${STATE_CLASS[summary.state]}`;
          return (
            <li key={summary.id} className={className}>
              <button
                type="button"
                className="pcad-constraint-row__pick"
                title={summary.stateMessage ?? t('constraintList.rowTooltip')}
                aria-pressed={chosen}
                onClick={() => {
                  // もう一度押したら解除(選び直せる、NFR-UX-1)。
                  setSelectedConstraint(chosen ? null : summary.id);
                }}
              >
                <span className="pcad-constraint-row__symbol" aria-hidden="true">
                  {summary.symbol}
                </span>
                <span className="pcad-constraint-row__label">{summary.label}</span>
                <span className="pcad-constraint-row__detail">{summary.detail}</span>
              </button>
              {summary.value === null ? null : <ConstraintValueField summary={summary} />}
              <button
                type="button"
                className="pcad-button pcad-constraint-row__remove"
                title={t('constraintList.remove')}
                aria-label={`${summary.label} ${t('constraintList.remove')}`}
                onClick={() => {
                  removeConstraintById(summary.id);
                }}
              >
                {t('constraintList.removeMark')}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
