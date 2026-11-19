/**
 * 配置の補助 P-A 寸法で動かすの窓(モーダルにしない。確定だけが文書を変える。伸縮の窓 MemberStretchPopover.tsx と同じ形)。
 * 向き・基準・寸法の取り方・寸法を入れると、今の寸法と、動かす量・動く部品の数を予告し、断る時は理由を出す。予告が通るまで確定を押せない。
 * 1 回だけ動かし、拘束は残さない(残す時は距離の合致)。アルミフレーム・鋼材・機械要素のどれを選んでも同じ窓。
 * - 向きは世界の X・Y・Z か、成分で決める斜めの向き。斜めの時は、予告に向き(有効 6 桁)と数で書き換える座標を出す。
 *   式を入れていた座標を書き換える時は、式が消えて数になる事を確定の前に出す(統括の決定 2026-11-19)。
 * - 基準は一覧から選ぶか、「3D で選ぶ」を押してから 3D の画面で部品を押す(3D の画面で押した物を欄へ入れる共通の頼み componentPickActions)。
 * - 斜めの向きは成分を打つか、「3D の面・辺から」を押してから 3D の画面で面・辺を押す(平らな面は法線、まっすぐな辺は向き、円柱・円は軸)。
 * - 今の寸法は式で測れる形なら式の値。式で測れない形(自由な曲面など)を表示の網で測った時は「表示の網から測った値(誤差は最大 ○ mm)」を添える。
 */
import { useMemo, useRef } from 'react';
import type { DimensionMoveAxis } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import { activeComponentPick } from '../store/componentPickActions.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  DIMENSION_MOVE_BASES, DIMENSION_MOVE_DIRECTIONS, dimensionMoveDirectionPatch, dimensionMovePickCandidates, dimensionMoveReady,
  dimensionMoveReferences, withVectorComponent, type DimensionMoveDirectionChoice, type DimensionMovePreview,
} from './dimensionMoveDraft.js';

const AXIS_KEYS: Readonly<Record<DimensionMoveAxis, MessageKey>> = {
  0: 'assembly.dimensionMove.axis.x', 1: 'assembly.dimensionMove.axis.y', 2: 'assembly.dimensionMove.axis.z',
};
const DIRECTION_KEYS: Readonly<Record<DimensionMoveDirectionChoice, MessageKey>> = { ...AXIS_KEYS, vector: 'assembly.dimensionMove.axis.vector' };
/** 斜めの向きの成分の欄(X・Y・Z の順)。 */
const VECTOR_FIELDS: readonly { readonly axis: DimensionMoveAxis; readonly key: MessageKey }[] = [
  { axis: 0, key: 'assembly.dimensionMove.vector.x' }, { axis: 1, key: 'assembly.dimensionMove.vector.y' },
  { axis: 2, key: 'assembly.dimensionMove.vector.z' },
];

const axesText = (axes: readonly DimensionMoveAxis[]): string => axes.map((axis) => t(AXIS_KEYS[axis])).join(t('display.listSeparator'));

/** 計画が通る時の後書き: 斜めの向きなら向きと書き換える座標、式を入れていた座標を書き換えるならその旨。 */
function rewriteText(preview: DimensionMovePreview, oblique: boolean): string {
  const plan = preview.plan;
  if (plan === null || !plan.ok) return '';
  const unit = preview.unit;
  const parts: string[] = [];
  if (oblique && unit !== null) {
    parts.push(t('assembly.dimensionMove.direction').replace('{x}', displayNumber(unit[0]).text).replace('{y}', displayNumber(unit[1]).text)
      .replace('{z}', displayNumber(unit[2]).text));
    parts.push(t('assembly.dimensionMove.rewrite').replace('{axes}', axesText(plan.rewrittenAxes)));
  }
  if (plan.formulaAxes.length > 0) parts.push(t('assembly.dimensionMove.rewriteFormula').replace('{axes}', axesText(plan.formulaAxes)));
  return parts.map((part) => ` ${part}`).join('');
}

/** 予告の文(今の寸法・動かす量・断る理由・入力の理由。計画が通る時は書き換える座標の後書き)。 */
function previewText(preview: DimensionMovePreview | null, oblique: boolean): string {
  if (preview === null) return '';
  if (preview.issue !== null) return t(`assembly.dimensionMove.issue.${preview.issue}`);
  // 式で測れない形を表示の網で測った時は、近似を正確な値のように見せず、誤差の上限を添える(有効 6 桁)。
  const approximate = preview.meshErrorMm > 0
    ? ` ${t('assembly.dimensionMove.meshApproximate').replace('{error}', displayNumber(preview.meshErrorMm).text)}` : '';
  const current = `${t('assembly.dimensionMove.current').replace('{value}', String(preview.current))}${approximate}`;
  const plan = preview.plan;
  if (plan === null) return current;
  if (!plan.ok) return `${current} ${t(`assembly.dimensionMove.reason.${plan.reason}`).replace('{count}', String(plan.count))}`;
  const summary = t('assembly.dimensionMove.summary').replace('{delta}', String(plan.delta)).replace('{count}', String(plan.movedIds.length));
  return `${current} ${summary}${rewriteText(preview, oblique)}`;
}

/** 窓の下の案内: 3D の画面で基準・向きを選ぶ間はその案内(押した物を断った時は理由)、ほかは使い方。 */
function hintText(pick: ReturnType<typeof activeComponentPick>): string {
  if (pick === null) return t('assembly.dimensionMove.hint');
  if (pick.purpose === 'dimensionMoveDirection') {
    return t(pick.notice === null ? 'assembly.dimensionMove.pickDirectionHint' : 'assembly.dimensionMove.pickDirectionRefused');
  }
  return t(pick.notice === null ? 'assembly.dimensionMove.pickHint' : 'assembly.dimensionMove.pickRefused');
}

export function DimensionMovePopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyDimensionMoveDraft);
  const preview = useAppStore((state) => state.assemblyDimensionMovePreview);
  const document = useAppStore((state) => state.assembly);
  // 3D の画面で基準を選ぶ頼み(この窓の物だけ。今の頼みが無い・ほかの道具の頼みなら null)。
  const pick = useAppStore((state) => activeComponentPick(state));
  const root = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  // 開いた時は最初の欄へ、閉じた時は開いた元(「組む」のメニューの釦など)へ焦点を戻す(C-03)。
  useDialogFocus(() => root.current, draft !== null, { initial: () => first.current });
  const references = useMemo(() => document === null || draft === null ? [] : dimensionMoveReferences(document, draft.componentId),
    [document, draft]);
  if (draft === null) return null;
  const title = t('assembly.dimensionMove.title');
  const update = useAppStore.getState().updateDimensionMoveDraft;
  const pickingReference = pick?.purpose === 'dimensionMoveReference';
  const pickingDirection = pick?.purpose === 'dimensionMoveDirection';
  const oblique = draft.direction === 'vector';
  return (
    <form ref={root} className="pcad-popover pcad-popover--frame-slot" role="dialog" aria-label={title} data-testid="dimension-move"
      onSubmit={(event) => { event.preventDefault(); useAppStore.getState().commitDimensionMove(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); useAppStore.getState().cancelDimensionMove(); } }}>
      <strong className="pcad-popover__title">{title}</strong>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.axis')}</span>
        <select ref={first} className="pcad-field__input" title={t('assembly.dimensionMove.axisGuide')} value={String(draft.direction)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            update(dimensionMoveDirectionPatch(draft, DIMENSION_MOVE_DIRECTIONS.find((choice) => String(choice) === value) ?? 0));
          }}>
          {DIMENSION_MOVE_DIRECTIONS.map((choice) => <option key={choice} value={String(choice)}>{t(DIRECTION_KEYS[choice])}</option>)}
        </select>
      </label>
      {oblique ? VECTOR_FIELDS.map(({ axis, key }) => (
        <label key={key} className="pcad-field">
          <span className="pcad-field__label">{t(key)}</span>
          <input className="pcad-field__input" title={t('assembly.dimensionMove.vectorGuide')} value={draft.vector[axis]}
            onChange={(event) => { update({ vector: withVectorComponent(draft.vector, axis, event.currentTarget.value) }); }} />
        </label>
      )) : null}
      {oblique ? (
        <button type="button" className="pcad-button" aria-pressed={pickingDirection} title={t('assembly.dimensionMove.pickDirectionGuide')}
          onClick={() => { useAppStore.getState().toggleComponentPick('dimensionMoveDirection', []); }}>
          {t('assembly.dimensionMove.pickDirection')}</button>
      ) : null}
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.reference')}</span>
        <select className="pcad-field__input" title={t('assembly.dimensionMove.referenceGuide')} value={draft.reference}
          onChange={(event) => { update({ reference: event.currentTarget.value }); }}>
          {references.map((item) => <option key={item.value} value={item.value}>
            {item.name ?? t('assembly.dimensionMove.reference.origin')}</option>)}
        </select>
      </label>
      <button type="button" className="pcad-button" aria-pressed={pickingReference} title={t('assembly.dimensionMove.pickGuide')}
        onClick={() => {
          if (document !== null) {
            useAppStore.getState().toggleComponentPick('dimensionMoveReference', dimensionMovePickCandidates(document, draft.componentId));
          }
        }}>{t('assembly.dimensionMove.pick')}</button>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.basis')}</span>
        <select className="pcad-field__input" title={t('assembly.dimensionMove.basisGuide')} value={draft.basis}
          onChange={(event) => { update({ basis: DIMENSION_MOVE_BASES.find((basis) => basis === event.currentTarget.value) ?? 'inner' }); }}>
          {DIMENSION_MOVE_BASES.map((basis) => <option key={basis} value={basis}>{t(`assembly.dimensionMove.basis.${basis}`)}</option>)}
        </select>
      </label>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.dimensionMove.target')}</span>
        <input className="pcad-field__input" title={t('assembly.dimensionMove.targetGuide')} value={draft.target}
          onChange={(event) => { update({ target: event.currentTarget.value }); }} />
        <span className="pcad-field__unit">mm</span>
      </label>
      <p role="status">{previewText(preview, oblique)}</p>
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button pcad-button--action" title={t('assembly.dimensionMove.commitGuide')}
          disabled={!dimensionMoveReady(preview)}>{t('assembly.dimensionMove.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.dimensionMove.cancelGuide')}
          onClick={() => { useAppStore.getState().cancelDimensionMove(); }}>{t('assembly.dimensionMove.cancel')}</button>
      </div>
      <p aria-live="polite">{hintText(pick)}</p>
    </form>
  );
}
