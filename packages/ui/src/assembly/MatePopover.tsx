import { isCompositionKey } from '../commands/compositionKey.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useEffect, useRef } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { ASSEMBLY_JOINT_TOOLS, ASSEMBLY_MATE_TOOLS } from '../shell/menus/AssemblyGroup.js';
import { addSelectedOriginTarget, cancelMate, commitJointDraft, commitMateDraft, handleMateKey, jointDraftReady,
  jointDraftCheck, jointFailureText, mateDraftCheck, mateFailureText, mateKindChoices, mateKindReadiness, removeDraftTarget,
  startJoint, startMate, toggleDraftFlipped, updateJointRangeSource, updateMateSource } from './mateActions.js';
import { mateKindNeedsValue } from './mateCommands.js';
import { focusFirstTextField } from './popoverFocus.js';

export function MatePopover(): React.JSX.Element | null {
  const state = useAppStore();
  const draft = state.assemblyMateDraft;
  const panel = useRef<HTMLDivElement>(null);
  const commitButton = useRef<HTMLButtonElement>(null);
  const pickedCandidate = useRef(false);
  const open = draft !== null;
  const pair = draft?.targets.length === 2;
  const kind = draft?.kind;
  const jointKind = draft?.jointKind;
  const editingId = draft?.editingMateId;
  useDialogFocus(() => panel.current, open, { initial: 'managed' });
  useEffect(() => {
    if (open && !pickedCandidate.current) focusFirstTextField(panel.current);
  }, [open, pair, kind, editingId]);
  useEffect(() => {
    // 同じ候補を押しても startMate は下書きを更新する。新しい欄が描かれてから焦点を渡す。
    if (!pickedCandidate.current) return;
    pickedCandidate.current = false;
    focusFirstTextField(panel.current, commitButton.current);
  }, [draft]);
  if (draft === null || state.assemblyPlacement !== null) return null;
  const check = jointKind === undefined ? mateDraftCheck(state) : null;
  const jointCheck = jointKind === undefined ? null : jointDraftCheck(state, jointKind);
  const ready = jointKind === undefined ? check?.ok === true : jointDraftReady(state, jointKind);
  const error = draft.issue ?? (draft.targets.length >= 2
    ? jointKind === undefined ? mateFailureText(check) : jointFailureText(jointCheck)
    : null);
  const needsValue = jointKind === undefined && mateKindNeedsValue(draft.kind, draft.targetKinds);
  const choices = jointKind === undefined ? mateKindChoices(state) : undefined;
  const candidates = choices?.kinds ?? [];
  const titleKey = jointKind === undefined
    ? draft.editingMateId === null ? 'assembly.mate.title' : 'assembly.mate.edit'
    : 'assembly.joint.title';
  const componentSelected = state.selection.filter((id) => state.assembly?.components.some((c) => c.id === id && !c.suppressed)).length === 1;
  // 対象を選ぶモデルブラウザは左にあるため、入力は右へ寄せて互いの操作面を重ねない。
  return (
    <div ref={panel} tabIndex={-1} className="pcad-popover pcad-popover--numeric" role="dialog"
      aria-label={t(titleKey)}
      style={{ right: 12, top: 12, maxWidth: 'calc(100% - 24px)', maxHeight: 'calc(100% - 24px)', overflow: 'auto' }}
      onKeyDown={(event) => {
        if (handleMateKey(event.key, isCompositionKey(event.nativeEvent))) {
          event.preventDefault(); event.stopPropagation();
        }
      }}>
      <DraggableWindowTitle className="pcad-popover__title">{t(titleKey)}</DraggableWindowTitle>
      <p className="pcad-popover__hint">
        {t(draft.targets.length === 0 ? 'assembly.mate.pickFirst' : draft.targets.length === 1 ? 'assembly.mate.pickSecond'
          : draft.targets.length === 2 ? 'assembly.mate.ready' : 'assembly.mate.needTwo')}
      </p>
      {jointKind === undefined ? <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.mate.kind')}</span>
        <select className="pcad-field__input" title={t('assembly.guide.mateKind')} value={draft.kind} onChange={(event) => {
          const item = ASSEMBLY_MATE_TOOLS.find((candidate) => candidate.kind === event.target.value);
          if (item !== undefined) startMate(item.kind);
        }}>
          {ASSEMBLY_MATE_TOOLS.map((item) => {
            const readiness = mateKindReadiness(state, item.kind, choices);
            return <option key={item.kind} value={item.kind} disabled={!readiness.ready}>
              {!readiness.ready && readiness.reasonKey !== null ? `${t(item.labelKey)} — ${t(readiness.reasonKey)}` : t(item.labelKey)}
            </option>;
          })}
        </select>
      </label> : <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.tool.joint')}</span>
        <select className="pcad-field__input" title={t('assembly.guide.jointKind')} value={jointKind} onChange={(event) => {
          const item = ASSEMBLY_JOINT_TOOLS.find((candidate) => candidate.kind === event.target.value);
          if (item !== undefined) startJoint(item.kind);
        }}>
          {ASSEMBLY_JOINT_TOOLS.map((item) => (
            <option key={item.kind} value={item.kind}>{t(item.labelKey)}</option>
          ))}
        </select>
      </label>}
      {candidates.length > 0 && <>
        {!candidates.includes(draft.kind) && <p className="pcad-popover__hint">{t('assembly.mate.chooseCandidate')}</p>}
        <div role="group" aria-label={t('assembly.mate.candidates')} className="pcad-popover__actions pcad-popover__actions--mate-targets"
          onKeyDown={(event) => {
            // 候補での Enter は釦自身に渡し、窓の確定には使わない。
            if (event.key === 'Enter') event.stopPropagation();
          }}>
          {candidates.map((candidate, index) => {
            const tool = ASSEMBLY_MATE_TOOLS.find((item) => item.kind === candidate);
            if (tool === undefined) return null;
            const recommended = index === 0 ? t('assembly.mate.recommended') : undefined;
            return <button type="button" key={candidate} className="pcad-button" aria-pressed={candidate === draft.kind}
              title={t(tool.tooltipKey)} aria-description={recommended} onClick={() => {
                pickedCandidate.current = true;
                startMate(candidate);
              }}>
              {t(tool.labelKey)}{recommended && <small aria-hidden="true">{recommended}</small>}
            </button>;
          })}
        </div>
      </>}
      <ul>
        {draft.targets.map((target, index) => {
          const component = state.assembly?.components.find((item) => item.id === target.componentId);
          const element = target.kind === 'origin' ? t(`assembly.mate.origin.${target.element}`)
            : t(`selection.kind.${target.ref.fingerprint.kind}`);
          return <li key={target.componentId}>
            {t('assembly.mate.target').replace('{count}', String(index + 1)).replace('{name}', (component?.name ?? target.componentId) + ' / ' + element)}
            <button type="button" className="pcad-button" title={t('assembly.guide.removeTarget')}
              onClick={() => { removeDraftTarget(index); }}>{t('assembly.mate.removeTarget')}</button>
          </li>;
        })}
      </ul>
      <div className="pcad-popover__actions pcad-popover__actions--mate-targets">
        {(['origin', 'x', 'y', 'z', 'xy', 'xz', 'yz'] as const).map((element) => (
          <button key={element} type="button" className="pcad-button" aria-disabled={!componentSelected}
            title={componentSelected ? t('assembly.guide.originTarget').replace('{target}', t(`assembly.mate.origin.${element}`)) : t('assembly.mate.selectComponent')}
            onClick={() => { if (componentSelected) addSelectedOriginTarget(element); }}>
            {t(`assembly.mate.origin.${element}`)}
          </button>
        ))}
      </div>
      {needsValue ? (
        <label className="pcad-field">
          <span className="pcad-field__label">{t(draft.kind === 'angle' ? 'assembly.mate.angle' : draft.kind === 'coincident' ? 'assembly.mate.offset' : 'assembly.mate.distance')}</span>
          <input title={t(draft.kind === 'angle' ? 'assembly.guide.mateAngle' : 'assembly.guide.mateDistance')} className="pcad-field__input" value={draft.source} aria-invalid={error !== null}
            onChange={(event) => { updateMateSource(event.target.value); }} />
          <span className="pcad-field__unit">{t(draft.kind === 'angle' ? 'numericInput.unit.degree' : 'numericInput.unit.mm')}</span>
        </label>
      ) : null}
      {jointKind !== undefined && jointKind !== 'ball' ? <>
        <p className="pcad-popover__hint">{t('assembly.joint.rangeHint')}</p>
        {(['min', 'max'] as const).map((bound) => <label className="pcad-field" key={bound}>
          <span className="pcad-field__label">{t(bound === 'min' ? 'assembly.joint.rangeMinimum' : 'assembly.joint.rangeMaximum')}</span>
          <input title={t('assembly.joint.rangeHint')} className="pcad-field__input" value={bound === 'min' ? draft.minSource : draft.maxSource}
            aria-invalid={error !== null} onChange={(event) => { updateJointRangeSource(bound, event.target.value); }} />
          <span className="pcad-field__unit">{t(jointKind === 'slider' ? 'numericInput.unit.mm' : 'numericInput.unit.degree')}</span>
        </label>)}
      </> : null}
      {error === null ? null : <p role="status" className="pcad-field__message pcad-field__message--error">{error}</p>}
      {jointKind === undefined ? <label className="pcad-checkbox">
        <input title={t('assembly.guide.mateFlipped')} type="checkbox" checked={draft.flipped} onChange={() => { toggleDraftFlipped(); }} />
        {t('assembly.mate.flipped')}
      </label> : null}
      <div className="pcad-popover__actions">
        <button ref={commitButton} type="button" className="pcad-button pcad-button--action" aria-disabled={!ready}
          title={jointKind === undefined ? mateFailureText(check) ?? t('assembly.guide.commitMate') : t('assembly.guide.commitJoint')}
          onClick={() => {
            if (!ready) return;
            if (jointKind === undefined) commitMateDraft();
            else commitJointDraft();
          }}>
          {t(jointKind === undefined
            ? draft.editingMateId === null ? 'assembly.mate.commit' : 'assembly.mate.update'
            : 'assembly.joint.commit')}
        </button>
        <button type="button" className="pcad-button" title={t('assembly.guide.cancelMate')} onClick={cancelMate}>{t('assembly.mate.cancel')}</button>
      </div>
    </div>
  );
}
