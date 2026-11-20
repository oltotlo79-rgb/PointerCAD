import { HEX_BOLT_TABLE, type BoltedJointPlan, type BoltedJointSetPlan, type FasteningWasherKind } from '@pointercad/model';
import { useEffect, useMemo, useRef, useState } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { addAllBoltedJointSameHoles, type BoltedJointSameHolesResult } from '../store/boltedJointSameHoles.js';
import { useAppStore } from '../store/useAppStore.js';
import { boltedJointAllSameHoles, boltedJointHoleHints } from './boltedJointHoleHints.js';
import {
  BOLTED_JOINT_PICK_GUIDE_KEYS as PICK_PROMPTS, boltedJointHoleCounts, boltedJointPreviewReady, boltedJointReasonLines,
  boltedJointReasonText, type AssemblyBoltedJointDraft, type BoltedJointDraftIssue, type BoltedJointDraftPatch,
  type BoltedJointDraftPreview,
} from './boltedJointDraft.js';
import { pendingBoltedJointRebuilds } from './boltedJointRebuild.js';
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

/** 提案の要約。`facts` は出す未確認の注(既定はこの計画の注。まとめて締結する時は全部の組の注を渡す)。 */
function PlanSummary({ plan, facts = plan.missingFacts }: {
  readonly plan: BoltedJointPlan; readonly facts?: BoltedJointPlan['missingFacts'];
}): React.JSX.Element {
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
    {facts.map((fact) => <p key={fact} className="pcad-field__hint" data-testid="bolted-joint-fact">
      {t(`assembly.boltedJoint.fact.${fact}`)}</p>)}
    <p className="pcad-field__hint">{t('assembly.boltedJoint.fastenNote')}</p>
  </div>;
}

type HeadKind = BoltedJointSetPlan['joints'][number]['headKind'];

/** 穴の入口から決めた頭の形(入口なし→六角、ざぐり→六角穴付き、皿もみ→皿頭)。 */
const HEAD_KEYS = {
  hex: 'assembly.boltedJoint.head.hex', socket: 'assembly.boltedJoint.head.socket', countersunk: 'assembly.boltedJoint.head.countersunk',
} as const satisfies Record<HeadKind, MessageKey>;

function setRowText(joint: BoltedJointSetPlan['joints'][number], index: number): string {
  return t('assembly.boltedJoint.setRow').replace('{index}', String(index + 1)).replace('{head}', t(HEAD_KEYS[joint.headKind]))
    .replace('{nominal}', joint.joint.nominal).replace('{length}', numberText(joint.joint.boltLength));
}

/** 新しい締結の提案。1 組目の提案を今までの形で見せ、頭の形と、2 組以上の時は組ごとの長さを添える。 */
function SetSummary({ plan }: { readonly plan: BoltedJointSetPlan }): React.JSX.Element | null {
  const [first] = plan.joints;
  if (first === undefined) return null;
  // 未確認の注は全部の組の分を重ねずに出す(1 組目の注だけでは、未確認の値で選んだ組を見せない組み合わせが出る)。
  const facts = [...new Set(plan.joints.flatMap((joint) => joint.joint.missingFacts))].sort();
  return <>
    <PlanSummary plan={first.joint} facts={facts} />
    <div className="pcad-popover__fields" data-testid="bolted-joint-set">
      <p data-testid="bolted-joint-head">{`${t('assembly.boltedJoint.head')} ${t(HEAD_KEYS[first.headKind])}`}</p>
      {plan.joints.length < 2 ? null : <>
        <p data-testid="bolted-joint-set-count">{`${t('assembly.boltedJoint.setCount')} ${String(plan.joints.length)}`}</p>
        {plan.joints.map((joint, index) => <p key={`joint-${String(index)}`} data-testid="bolted-joint-set-row">
          {setRowText(joint, index)}</p>)}
      </>}
    </div>
  </>;
}

function PreviewView({ preview }: { readonly preview: BoltedJointDraftPreview | null }): React.JSX.Element | null {
  if (preview === null) return null;
  if (preview.kind === 'issue') return <p role="status" data-testid="bolted-joint-issue">{issueText(preview.issue)}</p>;
  if (preview.kind === 'set' && preview.result.ok) return <SetSummary plan={preview.result.plan} />;
  if (preview.kind === 'plan' && preview.result.ok) return <PlanSummary plan={preview.result.plan} />;
  // 1 組でも断られたら確定は押せない(統括の決定 ③)。組全体の断りを先に、2 組以上の時の穴の組ごとの断りは、
  // 番号とその組の頭側・相手側の穴を添えて並べる(押した順を間違えた時に、どの穴とどの穴かが分かるように)。
  return <ul role="alert" data-testid="bolted-joint-reasons">
    {boltedJointReasonLines(preview).map((line, index) => <li key={`${line.key}-${String(index)}`}
      data-hole={line.hole === null ? undefined : String(line.hole.number)}>{boltedJointReasonText(line)}</li>)}
  </ul>;
}

/** 「同じ穴を全部足す」の結果の文(足した時は出さない)。 */
function sameHolesText(result: BoltedJointSameHolesResult | null): string | null {
  if (result === null || result.ok) return null;
  return t(`assembly.boltedJoint.sameHoles.${result.reason}`).replace('{first}', String(result.first)).replace('{second}', String(result.second));
}

/**
 * 4 面がそろった新しい締結だけ: 締結する穴の数と、Shift で 2 組目からの穴を足す案内。同じ穴フィーチャーのほかの穴(当たり。3D に破線の輪で
 * 示す)があれば、足した後の数を添えた「同じ穴を全部足す」を出す(J-02c。組が 1 つに決まらない時は足さずに理由)。
 */
function HoleCounts({ draft }: { readonly draft: AssemblyBoltedJointDraft }): React.JSX.Element | null {
  const document = useAppStore((state) => state.assembly);
  const view = useAppStore((state) => state.assemblyView);
  const [result, setResult] = useState<BoltedJointSameHolesResult | null>(null);
  const hints = useMemo(() => (document === null || view === null ? [] : boltedJointHoleHints(document, view, draft)), [document, view, draft]);
  const counts = boltedJointHoleCounts(draft);
  if (draft.editRecordId !== undefined || counts.first === 0) return null;
  const all = boltedJointAllSameHoles(draft, hints);
  const issue = sameHolesText(result);
  return <div className="pcad-popover__fields">
    <p data-testid="bolted-joint-hole-counts">{t('assembly.boltedJoint.holeCounts')
      .replace('{first}', String(counts.first)).replace('{second}', String(counts.second))}</p>
    <p className="pcad-field__hint">{t('assembly.boltedJoint.addHolesGuide')}</p>
    {all === null ? null : (
      <button type="button" className="pcad-button" data-testid="bolted-joint-add-same-holes" title={t('assembly.boltedJoint.sameHoles.tooltip')}
        onClick={() => { setResult(addAllBoltedJointSameHoles()); }}>
        {t('assembly.boltedJoint.sameHoles.action').replace('{first}', String(all.first)).replace('{second}', String(all.second))}</button>
    )}
    {issue === null ? null : <p role="alert" data-testid="bolted-joint-same-holes-issue">{issue}</p>}
  </div>;
}

/**
 * 部品の差し替え・取り込み直しで板が替わった締結の知らせ(J-02 P8)。締結の窓が閉じている間だけ出す。
 * 「作り直す」は待つ締結の 1 つ目を「直す」の窓で開く(確定は直す窓の「締結する」。元に戻す 1 回)。
 */
export function BoltedJointRebuildPanel(): React.JSX.Element | null {
  const notice = useAppStore((state) => state.assemblyBoltedJointRebuild);
  const draft = useAppStore((state) => state.assemblyBoltedJointDraft);
  const documentId = useAppStore((state) => state.activeDocumentId);
  const assembly = useAppStore((state) => state.assembly);
  const library = useAppStore((state) => state.assemblyLibrary);
  const pending = pendingBoltedJointRebuilds(notice, documentId, assembly, library);
  if (draft !== null || pending.length === 0) return null;
  const store = useAppStore.getState;
  const title = t('assembly.boltedJoint.rebuild.title');
  return (
    <section className="pcad-popover pcad-popover--bolted-joint" role="dialog" aria-label={title} data-testid="bolted-joint-rebuild">
      <DraggableWindowTitle className="pcad-popover__title">{title}</DraggableWindowTitle>
      <p role="status" data-testid="bolted-joint-rebuild-count">
        {t('assembly.boltedJoint.rebuild.notice').replace('{count}', String(pending.length))}</p>
      <div className="pcad-popover__actions">
        <button type="button" className="pcad-button" title={t('assembly.boltedJoint.rebuild.actionTooltip')}
          data-testid="bolted-joint-rebuild-start" onClick={() => store().beginBoltedJointRebuild()}>
          {t('assembly.boltedJoint.rebuild.action')}</button>
        <button type="button" className="pcad-button" title={t('assembly.boltedJoint.rebuild.dismissTooltip')}
          onClick={() => store().dismissBoltedJointRebuild()}>{t('assembly.boltedJoint.rebuild.dismiss')}</button>
      </div>
    </section>
  );
}

/** 4 つの面を選ぶ間も開いたままの、モーダルにしない締結の窓。確定だけが文書を変える。 */
export function BoltedJointPopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyBoltedJointDraft);
  const preview = useAppStore((state) => state.assemblyBoltedJointPreview);
  // 入れ子の葉を選んだ締結は選んだものが入れ子の下書きにある(平らな picks は空)ので、その数で案内する。
  const nested = useAppStore((state) => state.assemblyNestedBoltDraft);
  const nestedRefusal = nestedBoltedJointRefusalKey(useAppStore((state) => state.assemblyNestedBoltPreview));
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
  const ready = boltedJointPreviewReady(preview);
  const picked = nested !== null ? nested.picks.length : draft.picks.length;
  const prompt = picked < PICK_PROMPTS.length ? PICK_PROMPTS[picked] : undefined;
  // 直す時は面を選び直さない(記録した選び方を使う)。題と案内だけを変え、欄・予告・確定は同じ窓を使う。
  const editing = draft.editRecordId !== undefined;
  const title = t(editing ? 'assembly.boltedJoint.editTitle' : 'assembly.boltedJoint.title');
  return (
    <form ref={root} className="pcad-popover pcad-popover--bolted-joint" role="dialog" aria-label={title}
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
      {nested === null ? <HoleCounts draft={draft} /> : null}
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
