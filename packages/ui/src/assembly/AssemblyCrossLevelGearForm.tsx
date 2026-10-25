import { useState } from 'react';
import { evaluateExpression } from '@pointercad/expression';
import {
  assemblyExpressionContext, MAX_SUB_ASSEMBLY_DEPTH, type AssemblyDocument, type CrossLevelGearCouplingDefinition,
  type PartLibrary,
} from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { currentOccurrenceDrive, jointValueKey, type CrossLevelNoticeCode } from '../store/assemblyOccurrenceDriveSlice.js';
import { useAppStore } from '../store/useAppStore.js';

/** A revolute joint inside one subassembly placement: the typed path of component ids, never the row text. */
export interface CrossLevelGearTarget {
  readonly path: readonly string[];
  readonly jointId: string;
  readonly label: string;
}

/** Every active joint of `kind` (revolute unless given) inside every subassembly placement of the document (repeated placements separately). */
export function crossLevelGearTargets(document: AssemblyDocument, library: PartLibrary, kind: 'revolute' | 'slider' = 'revolute'): readonly CrossLevelGearTarget[] {
  const targets: CrossLevelGearTarget[] = [];
  const visit = (assembly: AssemblyDocument, prefix: readonly string[], names: readonly string[], ancestors: readonly string[]): void => {
    if (prefix.length >= MAX_SUB_ASSEMBLY_DEPTH) return;
    for (const component of assembly.components) {
      if (component.suppressed || component.source.kind !== 'subAssembly') continue;
      const ref = component.source.assemblyRef;
      const child = library.assemblies?.get(ref);
      if (child === undefined || ancestors.includes(ref)) continue;
      const path = [...prefix, component.id], label = [...names, component.name];
      for (const joint of child.joints) {
        if (joint.kind === kind && !joint.suppressed) targets.push({ path, jointId: joint.id, label: `${label.join(' / ')} : ${joint.name}` });
      }
      visit(child, path, label, [...ancestors, ref]);
    }
  };
  visit(document, [], [], []);
  return targets;
}

const REASONS: Partial<Record<CrossLevelNoticeCode, MessageKey>> = {
  'coupled-parent-joint': 'assembly.crossGear.reason.coupledParent',
  'duplicate-occurrence': 'assembly.crossGear.reason.duplicateOccurrence',
  'parent-solve-failed': 'assembly.crossGear.reason.parentSolve',
  'child-solve-failed': 'assembly.crossGear.reason.childSolve',
  'child-at-limit': 'assembly.crossGear.reason.childLimit',
  'stale-view': 'assembly.crossGear.reason.stale',
  'coupled-motion': 'assembly.crossGear.reason.coupledMotion',
  'invalid-cam-dimensions': 'assembly.crossCam.reason.dimensions',
  'invalid-offset': 'assembly.crossCam.reason.offset',
  'unsupported-follower-drive': 'assembly.crossCam.reason.followerDrive',
  'coupled-drag-mixed': 'assembly.crossGear.reason.coupledDragMixed',
};
/** The reason text alone for a code (also used to explain an edit's repairs). */
export function crossLevelGearReason(code: CrossLevelNoticeCode): string {
  return t(REASONS[code] ?? 'assembly.crossGear.reason.invalid');
}
/** The visible refusal text for a code (the specific reason when there is one). */
export function crossLevelGearRefusal(code: CrossLevelNoticeCode): string {
  return t('assembly.crossGear.refused').replace('{reason}', t(REASONS[code] ?? 'assembly.crossGear.reason.invalid'));
}

const targetKey = (path: readonly string[], jointId: string): string => JSON.stringify([path, jointId]);

/**
 * Cross-level gear on a top-level revolute joint: create, edit and remove (one Undo step each, through
 * setAssemblyCrossLevelGears) and, for a saved active one, drive it from either side (transient motion through
 * driveAssemblyCrossLevelGear). Refusals are shown with their reason; nothing is changed by a refused operation.
 */
export function AssemblyCrossLevelGearForm(props: {
  readonly jointId: string;
  readonly coupling?: CrossLevelGearCouplingDefinition;
}): React.JSX.Element | null {
  const document = useAppStore(state => state.assembly);
  const library = useAppStore(state => state.assemblyLibrary);
  const view = useAppStore(state => state.assemblyView);
  const computing = useAppStore(state => state.isComputing);
  const motionValues = useAppStore(state => state.assemblyMotionJointValues);
  const motionDocument = useAppStore(state => state.assemblyMotionSourceDocument);
  const drives = useAppStore(state => state.assemblyOccurrenceDrives);
  const targets = document === null ? [] : crossLevelGearTargets(document, library);
  const [target, setTarget] = useState(props.coupling === undefined ? (targets[0] === undefined ? '' : targetKey(targets[0].path, targets[0].jointId))
    : targetKey(props.coupling.childPath, props.coupling.childJointId));
  const [ratioSource, setRatioSource] = useState(props.coupling?.ratio.source ?? '-2');
  const [phaseSource, setPhaseSource] = useState(props.coupling?.phaseDeg.source ?? '0');
  const [refusal, setRefusal] = useState<CrossLevelNoticeCode | null>(null);
  const joint = document?.joints.find(item => item.id === props.jointId);
  if (document === null || joint === undefined || joint.kind !== 'revolute' || joint.suppressed) return null;
  const ready = view?.sourceDocument === document && !computing;
  const chosen = targets.find(item => targetKey(item.path, item.jointId) === target);
  const refused = (): void => { setRefusal(useAppStore.getState().assemblyCrossLevelGearNotice?.code ?? 'invalid-expression'); };
  const commit = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || chosen === undefined) { setRefusal('missing-child-joint'); return; }
    const context = assemblyExpressionContext(document);
    const ratio = evaluateExpression(ratioSource, context), phaseDeg = evaluateExpression(phaseSource, context);
    if (!ratio.ok || !phaseDeg.ok) { setRefusal('invalid-expression'); return; }
    const previous = document.crossLevelGearCouplings ?? [];
    const taken = new Set([...previous, ...(document.mechanismCouplings ?? []), ...(document.camCouplings ?? [])].map(c => c.id));
    let serial = 1;
    while (taken.has(`cross-gear-${String(serial)}`)) serial += 1;
    const next: CrossLevelGearCouplingDefinition = { id: props.coupling?.id ?? `cross-gear-${String(serial)}`, kind: 'crossLevelGear',
      parentJointId: joint.id, childPath: [...chosen.path], childJointId: chosen.jointId, ratio: ratio.value, phaseDeg: phaseDeg.value,
      suppressed: props.coupling?.suppressed ?? false };
    const rows = props.coupling === undefined ? [...previous, next] : previous.map(c => c.id === props.coupling?.id ? next : c);
    if (state.setAssemblyCrossLevelGears(rows)) setRefusal(null); else refused();
  };
  const remove = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || props.coupling === undefined) return;
    if (state.setAssemblyCrossLevelGears((document.crossLevelGearCouplings ?? []).filter(c => c.id !== props.coupling?.id))) setRefusal(null);
    else refused();
  };
  const drive = (side: 'parent' | 'child', source: string): void => {
    const value = Number(source);
    if (props.coupling === undefined || source.trim() === '' || !Number.isFinite(value)) return;
    if (useAppStore.getState().driveAssemblyCrossLevelGear(props.coupling.id, side, value)) setRefusal(null); else refused();
  };
  const coupling = props.coupling;
  const childName = chosen?.label ?? coupling?.childJointId ?? '';
  const parentValue = coupling !== undefined && motionDocument === document ? motionValues.get(jointValueKey(joint.id, 'angle')) : undefined;
  const childValue = coupling === undefined ? undefined : currentOccurrenceDrive({ assembly: document, assemblyView: view,
    assemblyOccurrenceDrives: drives }, coupling.childPath)?.values.get(jointValueKey(coupling.childJointId, 'angle'));
  return (
    <form aria-label={t('assembly.crossGear.title')} data-testid="assembly-cross-gear-form"
      onSubmit={event => { event.preventDefault(); commit(); }}>
      <h4>{t('assembly.crossGear.title')}</h4>
      <p>{t('assembly.crossGear.equation').replace('{a}', joint.name)}</p>
      {targets.length === 0 ? <p>{t('assembly.crossGear.none')}</p> : (
        <label className="pcad-field"><span>{t('assembly.crossGear.target')}</span>
          <select className="pcad-field__input" value={target} disabled={!ready}
            onChange={event => { setTarget(event.currentTarget.value); }} title={t('assembly.guide.crossGearTarget')}>
            {targets.map(item => <option key={targetKey(item.path, item.jointId)} value={targetKey(item.path, item.jointId)}>{item.label}</option>)}
          </select></label>)}
      <label className="pcad-field"><span>{t('assembly.crossGear.ratio')}</span>
        <input className="pcad-field__input" value={ratioSource} disabled={!ready}
          onChange={event => { setRatioSource(event.currentTarget.value); }} title={t('assembly.guide.crossGearRatio')} /></label>
      <label className="pcad-field"><span>{t('assembly.crossGear.phase')}</span>
        <input className="pcad-field__input" value={phaseSource} disabled={!ready}
          onChange={event => { setPhaseSource(event.currentTarget.value); }} title={t('assembly.guide.crossGearPhase')} /><span>°</span></label>
      <button type="submit" className="pcad-button" disabled={!ready || chosen === undefined} title={t('assembly.guide.crossGearCommit')}>
        {t(coupling === undefined ? 'assembly.crossGear.create' : 'assembly.crossGear.update')}</button>
      {coupling === undefined ? null : <button type="button" className="pcad-button" disabled={computing} onClick={remove} title={t('assembly.guide.crossGearRemove')}>
        {t('assembly.crossGear.remove')}</button>}
      {coupling === undefined || coupling.suppressed ? null : <>
        <p>{t('assembly.crossGear.driveHint')}</p>
        <label className="pcad-field"><span>{t('assembly.crossGear.parentAngle').replace('{joint}', joint.name)}</span>
          <input type="number" className="pcad-field__input" disabled={!ready} value={parentValue ?? ''}
            aria-label={t('assembly.crossGear.parentAngle').replace('{joint}', joint.name)}
            onChange={event => { drive('parent', event.currentTarget.value); }} title={t('assembly.guide.crossGearParentAngle')} /><span>°</span></label>
        <label className="pcad-field"><span>{t('assembly.crossGear.childAngle').replace('{joint}', childName)}</span>
          <input type="number" className="pcad-field__input" disabled={!ready} value={childValue ?? ''}
            aria-label={t('assembly.crossGear.childAngle').replace('{joint}', childName)}
            onChange={event => { drive('child', event.currentTarget.value); }} title={t('assembly.guide.crossGearChildAngle')} /><span>°</span></label>
      </>}
      <p>{t('assembly.crossGear.camPending')}</p>
      {refusal === null ? null : <p role="alert">{crossLevelGearRefusal(refusal)}</p>}
    </form>
  );
}
