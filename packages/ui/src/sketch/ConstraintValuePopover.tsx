import { useEffect, useRef, useState } from 'react';

import { evaluateExpression, type ExpressionError, type ExpressionValue } from '@pointercad/expression';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { cancelConstraintPrompt, commitConstraintPrompt } from './constraintActions.js';
import { constraintKindLabelKey, constraintValueUnit } from './constraintCommands.js';
import { ExpressionField } from './ExpressionField.js';
import { clampAnchor } from './NumericInputPopover.js';
import type { NumericField } from './numericInput.js';
import type { SketchConstraintKind } from '@pointercad/model';

/**
 * 寸法拘束(距離・角度・半径・直径)の値をその場で聞く小さな入力
 * (FR-313、NFR-UX-2、NFR-UX-4、計画書 docs/plans/P4b-スケッチの仕上げ.md タスク13)。
 *
 * **道具のその場入力(`NumericInputPopover`)とは別の部品にしてある。** 理由は 2 つ。
 * ①拘束は `NumericInputToolId`(道具)ではなく `SketchConstraintKind`(条件の種類)で
 *   決まるので、`numericInput.ts` の段の表(道具 → 段 → 欄)へ素直に入らない。
 * ②聞くのは**式 1 つだけ**で、指定方法(絶対/相対/極)も選択肢もつまみも段の進みも無い。
 * 見た目と操作(欄の形、評価値の表示、Enter で決める・Esc でやめる、置き場の折り返し)は
 * `ExpressionField` と `clampAnchor` を**そのまま共有**するので、2 通りの見た目にはならない。
 *
 * 既定値は「いま測った値」(NFR-UX-4)。空のまま Enter を押すと、いまの形のまま固まる。
 */

/** 種類ごとの欄の説明。名前は `constraint.kind.*`(t12 の表)をそのまま使う。 */
const VALUE_TOOLTIP_KEYS: Readonly<Record<'distance' | 'angle' | 'radius' | 'diameter', MessageKey>> =
  {
    distance: 'constraint.value.lengthTooltip',
    angle: 'constraint.value.angleTooltip',
    radius: 'constraint.value.radiusTooltip',
    diameter: 'constraint.value.diameterTooltip',
  };

/** 数値を聞く 4 種のときだけ説明の鍵を返す(それ以外はこの部品が開かない)。 */
function tooltipKeyOf(kind: SketchConstraintKind): MessageKey {
  switch (kind) {
    case 'distance':
    case 'angle':
    case 'radius':
    case 'diameter':
      return VALUE_TOOLTIP_KEYS[kind];
    default:
      return 'constraint.value.lengthTooltip';
  }
}

export function ConstraintValuePopover(): React.JSX.Element | null {
  const prompt = useAppStore((state) => state.constraintPrompt);
  const viewportSize = useAppStore((state) => state.viewportSize);
  const variables = useAppStore((state) => state.parameterAnalysis.variables);
  const [source, setSource] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // 開き直したら打ちかけを捨てる(前の拘束の値を持ち越さない、NFR-UX-3)。
  const promptKey = prompt === null ? null : `${prompt.kind}:${String(prompt.targets.length)}`;
  useEffect(() => {
    setSource('');
  }, [promptKey]);

  if (prompt === null) {
    return null;
  }

  const unit = constraintValueUnit(prompt.kind) ?? 'mm';
  const field: NumericField = {
    key: 'constraintValue',
    labelKey: constraintKindLabelKey(prompt.kind),
    tooltipKey: tooltipKeyOf(prompt.kind),
    unit,
    defaultSource: prompt.defaultSource,
    source,
  };
  // 空欄は既定値(いま測った値)として読む(`effectiveSource` と同じ約束、NFR-UX-4)。
  const effective = source.trim() === '' ? prompt.defaultSource : source;
  const evaluated = evaluateExpression(effective, { variables });
  const value: ExpressionValue | null = evaluated.ok ? evaluated.value : null;
  const error: ExpressionError | null = evaluated.ok ? null : evaluated.error;
  const position = clampAnchor(prompt.anchor, viewportSize[0], viewportSize[1]);

  /** 欄から焦点を奪わない(ボタンを押しても打ち続けられる)。 */
  function keepFocus(event: React.MouseEvent): void {
    event.preventDefault();
  }

  return (
    <div
      ref={containerRef}
      className="pcad-popover pcad-popover--constraint"
      style={{ left: `${String(position.left)}px`, top: `${String(position.top)}px` }}
      role="dialog"
      aria-label={t('constraint.value.title')}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          commitConstraintPrompt(source);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelConstraintPrompt();
        }
      }}
    >
      <div className="pcad-popover__title">{t('constraint.value.title')}</div>
      <div className="pcad-popover__fields">
        <ExpressionField
          field={field}
          result={{ key: field.key, value, error }}
          focused={true}
          onChange={setSource}
          onFocus={() => {
            // 焦点の正本を持たない小さな入力なので、何もしない(欄は 1 つだけ)。
          }}
        />
      </div>
      <p className="pcad-popover__hint">{t('constraint.value.hint')}</p>
      <div className="pcad-popover__actions">
        <button
          type="button"
          className="pcad-button pcad-button--action"
          aria-disabled={value === null}
          onMouseDown={keepFocus}
          onClick={() => {
            commitConstraintPrompt(source);
          }}
        >
          {t('constraint.value.commit')}
        </button>
        <button
          type="button"
          className="pcad-button"
          onMouseDown={keepFocus}
          onClick={() => {
            cancelConstraintPrompt();
          }}
        >
          {t('constraint.value.cancel')}
        </button>
      </div>
    </div>
  );
}
