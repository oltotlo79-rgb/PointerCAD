import { HEX_BOLT_TABLE, type BoltedJointPlan, type FasteningWasherKind } from '@pointercad/model';
import { useEffect, useRef } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  BOLTED_JOINT_PICK_GUIDE_KEYS as PICK_PROMPTS, type BoltedJointDraftIssue, type BoltedJointDraftPatch,
  type BoltedJointDraftPreview,
} from './boltedJointDraft.js';
import { nestedBoltedJointRefusalKey } from './nestedBoltedJointDisplay.js';

const WASHER_CHOICES = ['none', 'plainWasher', 'springWasher'] as const;
type WasherChoice = typeof WASHER_CHOICES[number];

/** 呼びの選択肢は寸法表の行の呼び(重複を除く)。表に無い呼びは出さない。 */
const NOMINALS = [...new Set(HEX_BOLT_TABLE.map((row) => row.size))];

function washerList(choice: WasherChoice): readonly FasteningWasherKind[] {
  return choice === 'none' ? [] : [choice];
}

function washerChoice(list: readonly FasteningWasherKind[]): WasherChoice {
  return list[0] ?? 'none';
}

type SourceField = 'engagementSource' | 'bottomClearanceSource' | 'protrusionSource';

function sourcePatch(field: SourceField, value: string): BoltedJointDraftPatch {
  switch (field) {
    case 'engagementSource': return { engagementSource: value };
    case 'bottomClearanceSource': return { bottomClearanceSource: value };
    case 'protrusionSource': return { protrusionSource: value };
  }
}

function washerPatch(field: 'headWashers' | 'nutWashers', value: WasherChoice): BoltedJointDraftPatch {
  return field === 'headWashers' ? { headWashers: washerList(value) } : { nutWashers: washerList(value) };
}

function issueText(issue: BoltedJointDraftIssue): string {
  return t(`assembly.boltedJoint.issue.${issue.kind}`);
}

function numberText(value: number | null): string {
  return value === null ? '-' : String(Math.round(value * 1000) / 1000);
}

function PlanSummary({ plan }: { readonly plan: BoltedJointPlan }): React.JSX.Element {
  return <div className="pcad-popover__fields" data-testid="bolted-joint-plan">
    <p>{t('assembly.boltedJoint.proposal')}</p>
    <p data-testid="bolted-joint-bolt">{`${t('assembly.boltedJoint.bolt')} ${plan.nominal} ${t('assembly.boltedJoint.length')} ${numberText(plan.boltLength)}`}</p>
    <p data-testid="bolted-joint-nut">{plan.configuration === 'throughBoltWithNut'
      ? `${t('assembly.boltedJoint.nut')} ${plan.nominal}` : t('assembly.boltedJoint.noNut')}</p>
    <p>{`${t('assembly.boltedJoint.grip')} ${numberText(plan.gripLength)}`}</p>
    {plan.engagedLength === null ? null
      : <p data-testid="bolted-joint-engaged">{`${t('assembly.boltedJoint.engaged')} ${numberText(plan.engagedLength)}`}</p>}
    {plan.protrusion === null ? null : <p>{`${t('assembly.boltedJoint.protrusionResult')} ${numberText(plan.protrusion)}`}</p>}
    {plan.alignment.movedComponentIds.length === 0 ? null : <p>{t('assembly.boltedJoint.moves')}</p>}
    {plan.missingFacts.map((fact) => <p key={fact} className="pcad-field__hint" data-testid="bolted-joint-fact">
      {t(`assembly.boltedJoint.fact.${fact}`)}</p>)}
    <p className="pcad-field__hint">{t('assembly.boltedJoint.fastenNote')}</p>
  </div>;
}

function PreviewView({ preview }: { readonly preview: BoltedJointDraftPreview | null }): React.JSX.Element | null {
  if (preview === null) return null;
  if (preview.kind === 'issue') return <p role="status" data-testid="bolted-joint-issue">{issueText(preview.issue)}</p>;
  if (preview.result.ok) return <PlanSummary plan={preview.result.plan} />;
  return <ul role="alert" data-testid="bolted-joint-reasons">
    {preview.result.rejections.map((rejection, index) => <li key={`${rejection.code}-${String(index)}`}>
      {t(`assembly.boltedJoint.reason.${rejection.code}`)}</li>)}
  </ul>;
}

/** 4 つの面を選ぶ間も開いたままの、モーダルにしない締結の窓。確定だけが文書を変える。 */
export function BoltedJointPopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyBoltedJointDraft);
  const preview = useAppStore((state) => state.assemblyBoltedJointPreview);
  // 入れ子の葉を選んだ締結は選んだものが入れ子の下書きにある(平らな picks は空)ので、その数で案内する。
  const nested = useAppStore((state) => state.assemblyNestedBoltDraft);
  const nestedRefusal = nestedBoltedJointRefusalKey(useAppStore((state) => state.assemblyNestedBoltPreview));
  const first = useRef<HTMLSelectElement>(null);
  const composing = useRef(false);
  const compositionKey = useRef(false);
  const open = draft !== null;
  useEffect(() => {
    composing.current = false;
    compositionKey.current = false;
    if (open) first.current?.focus();
  }, [open]);
  if (draft === null) return null;
  const store = useAppStore.getState;
  const ready = preview?.kind === 'plan' && preview.result.ok;
  const picked = nested !== null ? nested.picks.length : draft.picks.length;
  const prompt = picked < PICK_PROMPTS.length ? PICK_PROMPTS[picked] : undefined;
  // 直す時は面を選び直さない(記録した選び方を使う)。題と案内だけを変え、欄・予告・確定は同じ窓を使う。
  const editing = draft.editRecordId !== undefined;
  const title = t(editing ? 'assembly.boltedJoint.editTitle' : 'assembly.boltedJoint.title');
  return (
    <form className="pcad-popover pcad-popover--bolted-joint" role="dialog" aria-label={title}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onPointerDownCapture={() => { compositionKey.current = false; }}
      onSubmit={(event) => {
        event.preventDefault();
        // compositionend can precede the implicit submit from its confirming Enter.
        // A subsequent normal key or explicit pointer activation clears only that key.
        if (!composing.current && !compositionKey.current && ready) store().commitBoltedJoint();
      }}
      onKeyDown={(event) => {
        compositionKey.current = composing.current || isCompositionKey(event.nativeEvent);
        if (compositionKey.current || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        store().cancelBoltedJoint();
      }}>
      <DraggableWindowTitle className="pcad-popover__title">{title}</DraggableWindowTitle>
      <p role="status" data-testid="bolted-joint-prompt">
        {editing ? t('assembly.boltedJoint.editPrompt')
          : prompt === undefined ? `${t('assembly.boltedJoint.pickedCount')} ${String(picked)}` : t(prompt)}
      </p>
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.dimensionSeries')}</span>
          <select ref={first} className="pcad-field__input" value={draft.dimensionSeries}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'annexJA' || value === 'main') store().updateBoltedJointDraft({ dimensionSeries: value });
            }} title={t('assembly.guide.standardDimensions')}>
            <option value="annexJA">{t('assembly.standardPart.dimensionSeries.annexJA')}</option>
            <option value="main">{t('assembly.standardPart.dimensionSeries.main')}</option>
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.boltedJoint.nominal')}</span>
          <select className="pcad-field__input" value={draft.nominal} data-testid="bolted-joint-nominal"
            onChange={(event) => store().updateBoltedJointDraft({ nominal: event.currentTarget.value })} title={t('assembly.guide.boltedNominal')}>
            <option value="">{t('assembly.boltedJoint.nominalAuto')}</option>
            {NOMINALS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.threadSeries')}</span>
          <select className="pcad-field__input" value={draft.threadSeries}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'coarse' || value === 'fine') store().updateBoltedJointDraft({ threadSeries: value });
            }} title={t('assembly.guide.standardThread')}>
            <option value="coarse">{t('assembly.standardPart.threadSeries.coarse')}</option>
            <option value="fine">{t('assembly.standardPart.threadSeries.fine')}</option>
          </select>
        </label>
        {([['engagementSource', 'assembly.boltedJoint.engagement', 'bolted-joint-engagement'],
          ['bottomClearanceSource', 'assembly.boltedJoint.bottomClearance', 'bolted-joint-bottom'],
          ['protrusionSource', 'assembly.boltedJoint.protrusion', 'bolted-joint-protrusion']] as const).map(([field, label, testId]) =>
          <label key={field} className="pcad-field">
            <span className="pcad-field__label">{t(label)}</span>
            <input className="pcad-field__input" data-testid={testId} value={draft[field]}
              onChange={(event) => store().updateBoltedJointDraft(sourcePatch(field, event.currentTarget.value))} title={t(field === 'engagementSource' ? 'assembly.guide.boltedEngagement' : field === 'bottomClearanceSource' ? 'assembly.guide.boltedBottomClearance' : 'assembly.guide.boltedProtrusion')} />
          </label>)}
        {([['headWashers', 'assembly.boltedJoint.headWasher'], ['nutWashers', 'assembly.boltedJoint.nutWasher']] as const)
          .map(([field, label]) => <label key={field} className="pcad-field">
            <span className="pcad-field__label">{t(label)}</span>
            <select className="pcad-field__input" value={washerChoice(draft[field])}
              onChange={(event) => {
                const value = WASHER_CHOICES.find((choice) => choice === event.currentTarget.value);
                if (value !== undefined) store().updateBoltedJointDraft(washerPatch(field, value));
              }} title={t(field === 'headWashers' ? 'assembly.guide.boltedHeadWasher' : 'assembly.guide.boltedNutWasher')}>
              {WASHER_CHOICES.map((choice) => <option key={choice} value={choice}>{t(`assembly.boltedJoint.washer.${choice}`)}</option>)}
            </select>
          </label>)}
      </div>
      {nestedRefusal === null ? <PreviewView preview={preview} />
        : <p role="alert" data-testid="bolted-joint-nested-refusal">{t(nestedRefusal)}</p>}
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button" disabled={!ready} title={t('assembly.boltedJoint.commitTooltip')}
          data-testid="bolted-joint-commit">{t('assembly.boltedJoint.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.boltedJoint.cancelTooltip')}
          onClick={() => store().cancelBoltedJoint()}>{t('assembly.boltedJoint.cancel')}</button>
      </div>
    </form>
  );
}
