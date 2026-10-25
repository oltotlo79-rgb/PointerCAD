import { DENSITY_MATERIALS, type FilletWeldPlan } from '@pointercad/model';
import { useEffect, useRef, useState } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { densityMaterialLabelKey } from '../solid/MeasurementSections.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  FILLET_WELD_PICK_GUIDE_KEYS as PICK_PROMPTS, type FilletWeldDraftIssue, type FilletWeldDraftPatch,
  type FilletWeldDraftPreview,
} from './filletWeldDraft.js';
import { weldPickCount } from './nestedWeldDraft.js';

type SourceField = 'legOnSecondSource' | 'legOnFirstSource' | 'startSource' | 'lengthsSource' | 'gapsSource';

function sourcePatch(field: SourceField, value: string): FilletWeldDraftPatch {
  switch (field) {
    case 'legOnSecondSource': return { legOnSecondSource: value };
    case 'legOnFirstSource': return { legOnFirstSource: value };
    case 'startSource': return { startSource: value };
    case 'lengthsSource': return { lengthsSource: value };
    case 'gapsSource': return { gapsSource: value };
  }
}

function issueText(issue: FilletWeldDraftIssue): string {
  return issue.kind === 'value' ? t(`assembly.filletWeld.issue.value.${issue.field}`)
    : issue.kind === 'occurrence' ? t(`assembly.filletWeld.occurrence.${issue.reason}`) : t(`assembly.filletWeld.issue.${issue.kind}`);
}

function numberText(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function PlanSummary({ plan }: { readonly plan: FilletWeldPlan }): React.JSX.Element {
  return <div className="pcad-popover__fields" data-testid="fillet-weld-plan">
    <p data-testid="fillet-weld-legs">{`${t('assembly.filletWeld.legs')} ${numberText(plan.legOnSecond)} / ${numberText(plan.legOnFirst)}`}</p>
    {plan.interiorAngle === null ? null : <p data-testid="fillet-weld-angle">
      {`${t('assembly.filletWeld.interiorAngle')} ${numberText(plan.interiorAngle.degrees)}`}</p>}
    <p data-testid="fillet-weld-segments">{`${t('assembly.filletWeld.segmentCount')} ${String(plan.segments.length)}`}</p>
    <p data-testid="fillet-weld-total">{`${t('assembly.filletWeld.totalLength')} ${numberText(plan.totalLength)}`}</p>
    <p data-testid="fillet-weld-volume">{`${t('assembly.filletWeld.nominalVolume')} ${numberText(plan.nominalVolume)}`}</p>
    <p className="pcad-field__hint">{t('assembly.filletWeld.contactNote')}</p>
    <p className="pcad-field__hint">{t('assembly.filletWeld.strengthNote')}</p>
  </div>;
}

function PreviewView({ preview }: { readonly preview: FilletWeldDraftPreview | null }): React.JSX.Element | null {
  if (preview === null) return null;
  if (preview.kind === 'issue') return <p role="status" data-testid="fillet-weld-issue">{issueText(preview.issue)}</p>;
  if (preview.result.ok) return <PlanSummary plan={preview.result.plan} />;
  return <ul role="alert" data-testid="fillet-weld-reasons">
    {preview.result.rejections.map((rejection, index) => <li key={`${rejection.code}-${String(index)}`}>
      {t(`assembly.filletWeld.reason.${rejection.code}`)}</li>)}
  </ul>;
}

/** 面と辺を選ぶ間も開いたままの、モーダルにしない溶接の窓。確定(と直す時の削除)だけが文書を変える。 */
export function FilletWeldPopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyFilletWeldDraft);
  const preview = useAppStore((state) => state.assemblyFilletWeldPreview);
  const nested = useAppStore((state) => state.assemblyNestedWeldDraft);
  // 子の定義の溶接を直す時は、定義を置いた全ての配置が変わる。数を見せ、確かめてからだけ確定する(決定 B)。
  const childEdit = useAppStore((state) => state.assemblyChildWeldEdit);
  const [definitionConfirmed, setDefinitionConfirmed] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const compositionKey = useRef(false);
  const open = draft !== null;
  useEffect(() => {
    composing.current = false;
    compositionKey.current = false;
    if (open) first.current?.focus();
  }, [open]);
  // 別の対象・数になったら、前の確かめは使わない。
  useEffect(() => { setDefinitionConfirmed(false); }, [childEdit]);
  if (draft === null) return null;
  const store = useAppStore.getState;
  const planned = preview?.kind === 'plan' && preview.result.ok;
  const ready = planned && (childEdit === null || definitionConfirmed);
  const editing = draft.weldId !== null;
  // 入れ子の葉を選んだ溶接では、選んだものは入れ子の下書きにある(平らな picks は空)。
  const prompt = editing ? undefined : PICK_PROMPTS[weldPickCount(draft, nested)];
  const title = editing ? t('assembly.filletWeld.editTitle') : t('assembly.filletWeld.title');
  const commit = (): void => {
    if (childEdit === null) {
      store().commitFilletWeld();
      return;
    }
    store().commitChildFilletWeldEdit(definitionConfirmed ? { scope: 'definition', assemblyRef: childEdit.assemblyRef,
      affectedPlacements: childEdit.affectedPlacements } : null);
  };
  return (
    <form className="pcad-popover pcad-popover--fillet-weld" role="dialog" aria-label={title}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onPointerDownCapture={() => { compositionKey.current = false; }}
      onSubmit={(event) => {
        event.preventDefault();
        // compositionend can precede the implicit submit from its confirming Enter (same rule as the bolted joint).
        if (!composing.current && !compositionKey.current && ready) commit();
      }}
      onKeyDown={(event) => {
        compositionKey.current = composing.current || isCompositionKey(event.nativeEvent);
        if (compositionKey.current || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        store().cancelFilletWeld();
      }}>
      <DraggableWindowTitle className="pcad-popover__title">{title}</DraggableWindowTitle>
      <p role="status" data-testid="fillet-weld-prompt">
        {prompt === undefined ? t(editing ? 'assembly.filletWeld.editPrompt' : 'assembly.filletWeld.picked') : t(prompt)}
      </p>
      <div className="pcad-popover__fields">
        {([['legOnSecondSource', 'assembly.filletWeld.legOnSecond', 'fillet-weld-leg-second'],
          ['legOnFirstSource', 'assembly.filletWeld.legOnFirst', 'fillet-weld-leg-first']] as const).map(([field, label, testId], index) =>
          <label key={field} className="pcad-field">
            <span className="pcad-field__label">{t(label)}</span>
            <input ref={index === 0 ? first : undefined} className="pcad-field__input" data-testid={testId} value={draft[field]}
              onChange={(event) => store().updateFilletWeldDraft(sourcePatch(field, event.currentTarget.value))} title={t(field === 'legOnSecondSource' ? 'assembly.guide.weldLegSecond' : 'assembly.guide.weldLegFirst')} />
          </label>)}
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.filletWeld.mode')}</span>
          <select className="pcad-field__input" value={draft.mode} data-testid="fillet-weld-mode"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'continuous' || value === 'intermittent') store().updateFilletWeldDraft({ mode: value });
            }} title={t('assembly.guide.weldMode')}>
            <option value="continuous">{t('assembly.filletWeld.mode.continuous')}</option>
            <option value="intermittent">{t('assembly.filletWeld.mode.intermittent')}</option>
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.filletWeld.start')}</span>
          <input className="pcad-field__input" data-testid="fillet-weld-start" value={draft.startSource}
            onChange={(event) => store().updateFilletWeldDraft(sourcePatch('startSource', event.currentTarget.value))} title={t('assembly.guide.weldStart')} />
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">
            {t(draft.mode === 'continuous' ? 'assembly.filletWeld.length' : 'assembly.filletWeld.lengths')}</span>
          <input className="pcad-field__input" data-testid="fillet-weld-lengths" value={draft.lengthsSource}
            onChange={(event) => store().updateFilletWeldDraft(sourcePatch('lengthsSource', event.currentTarget.value))} title={t(draft.mode === 'continuous' ? 'assembly.guide.weldLength' : 'assembly.guide.weldLengths')} />
        </label>
        {draft.mode === 'intermittent' ? <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.filletWeld.gaps')}</span>
          <input className="pcad-field__input" data-testid="fillet-weld-gaps" value={draft.gapsSource}
            onChange={(event) => store().updateFilletWeldDraft(sourcePatch('gapsSource', event.currentTarget.value))} title={t('assembly.guide.weldGaps')} />
        </label> : null}
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.filletWeld.material')}</span>
          <select className="pcad-field__input" value={draft.materialId} data-testid="fillet-weld-material"
            onChange={(event) => store().updateFilletWeldDraft({ materialId: event.currentTarget.value })} title={t('assembly.guide.weldMaterial')}>
            <option value="">{t('assembly.filletWeld.materialChoose')}</option>
            {DENSITY_MATERIALS.map((material) => <option key={material.id} value={material.id}>
              {t(densityMaterialLabelKey(material.id))}</option>)}
          </select>
        </label>
      </div>
      {childEdit === null ? null : <div className="pcad-popover__fields" data-testid="fillet-weld-shared-definition">
        <p role="status" data-testid="fillet-weld-affected-placements">
          {`${t('assembly.filletWeld.sharedDefinition')} ${String(childEdit.affectedPlacements)}`}</p>
        <label className="pcad-field">
          <input type="checkbox" data-testid="fillet-weld-confirm-definition" checked={definitionConfirmed}
            onChange={(event) => setDefinitionConfirmed(event.currentTarget.checked)} title={t('assembly.guide.weldConfirmDefinition')} />
          <span className="pcad-field__label">{t('assembly.filletWeld.sharedDefinitionConfirm')}</span>
        </label>
      </div>}
      <PreviewView preview={preview} />
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button" disabled={!ready} title={t('assembly.filletWeld.commitTooltip')}
          data-testid="fillet-weld-commit">{t('assembly.filletWeld.commit')}</button>
        {editing && childEdit === null ? <button type="button" className="pcad-button" title={t('assembly.filletWeld.removeTooltip')}
          data-testid="fillet-weld-remove" onClick={() => store().removeFilletWeldDraft()}>{t('assembly.filletWeld.remove')}</button> : null}
        <button type="button" className="pcad-button" title={t('assembly.filletWeld.cancelTooltip')}
          onClick={() => store().cancelFilletWeld()}>{t('assembly.filletWeld.cancel')}</button>
      </div>
    </form>
  );
}
