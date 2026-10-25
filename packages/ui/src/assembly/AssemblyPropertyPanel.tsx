import { useState } from 'react';
import { evaluateExpression } from '@pointercad/expression';
import { assemblyExpressionContext, findComponent, partFileOf, quaternionToAxisAngle,
  type MechanismGearCoupling } from '@pointercad/model';
import { currentJointSliderValue, jointSliderBounds, jointSliderReference } from './jointSlider.js';
import { ReferenceRepairSection } from '../solid/referenceRepairPanel.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { EmptyBoxIcon } from '../shell/icons.js';
import { JointSliderControls } from './AssemblyMotionControls.js';
import { BomTable } from './BomTable.js';
import { AssemblyContextReferenceForm } from './AssemblyContextReferenceForm.js';
import { interferenceRows } from './interferenceView.js';
import { propertySectionKey } from '../shell/propertySectionKeys.js';
import { AssemblyParameterPanel } from '../parameters/AssemblyParameterPanel.js';
import { AssemblyCamCouplingForm } from './AssemblyCamCouplingForm.js';
import { AssemblyCrossLevelGearForm } from './AssemblyCrossLevelGearForm.js';
import { AssemblyCrossLevelGearRepairs } from './AssemblyCrossLevelGearRepairs.js';
import { AssemblyCrossLevelCamForm } from './AssemblyCrossLevelCamForm.js';
import { SubAssemblyJointControls, subAssemblyOccurrencePathOf } from './SubAssemblyJointControls.js';

/** The actual form keeps authored expressions; all commits use the validated immutable store action. */
export function AssemblyGearCouplingForm(props: {
  readonly jointId: string;
  readonly coupling?: MechanismGearCoupling;
}): React.JSX.Element | null {
  const document = useAppStore(state => state.assembly);
  const view = useAppStore(state => state.assemblyView);
  const computing = useAppStore(state => state.isComputing);
  const aId = props.coupling?.jointAId ?? props.jointId;
  const peers = document?.joints.filter(j => j.id !== aId && j.kind === 'revolute' && !j.suppressed) ?? [];
  const [peerId, setPeerId] = useState(props.coupling?.jointBId ?? peers[0]?.id ?? '');
  const [ratioSource, setRatioSource] = useState(props.coupling?.ratio.source ?? '-2');
  const [phaseSource, setPhaseSource] = useState(props.coupling?.phaseDeg.source ?? '0');
  const [error, setError] = useState(false);
  const joint = document?.joints.find(j => j.id === aId);
  if (document === null || joint === undefined || joint.kind !== 'revolute' || joint.suppressed) return null;
  const ready = view?.sourceDocument === document && !computing;
  const commit = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || view === null || state.assemblyView !== view || view.sourceDocument !== document || state.isComputing) { setError(true); return; }
    const ratio = evaluateExpression(ratioSource, assemblyExpressionContext(document));
    const phaseDeg = evaluateExpression(phaseSource, assemblyExpressionContext(document));
    const bounds = jointSliderBounds(document, joint, 'angle'), frames = view.jointFrames?.get(aId);
    const referenceAngleA = props.coupling?.referenceAngleA ?? (bounds.ok && frames !== undefined
      ? currentJointSliderValue({ document, joint, coordinate: 'angle', frames, placements: view.resolved.placements,
        referenceAngle: jointSliderReference(bounds.bounds) }) : null);
    if (!ratio.ok || !phaseDeg.ok || referenceAngleA === null) { setError(true); return; }
    const previous = document.mechanismCouplings ?? [];
    let serial = 1;
    while (previous.some(c => c.id === `gear-${String(serial)}`)) serial += 1;
    const next: MechanismGearCoupling = { id: props.coupling?.id ?? `gear-${String(serial)}`, kind: 'gear',
      jointAId: aId, jointBId: peerId, ratio: ratio.value, phaseDeg: phaseDeg.value,
      referenceAngleA, suppressed: props.coupling?.suppressed ?? false };
    const rows = props.coupling === undefined ? [...previous, next]
      : previous.map(c => c.id === props.coupling?.id ? next : c);
    setError(!state.setAssemblyMechanismCouplings(rows));
  };
  const remove = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || props.coupling === undefined || state.isComputing) { setError(true); return; }
    setError(!state.setAssemblyMechanismCouplings((document.mechanismCouplings ?? [])
      .filter(c => c.id !== props.coupling?.id)));
  };
  return (
    <form aria-label={t('assembly.gear.title')} data-testid="assembly-gear-form" onSubmit={event => { event.preventDefault(); commit(); }}>
      <h4>{t('assembly.gear.title')}</h4>
      <p>{t('assembly.gear.equation').replace('{a}', joint.name)}</p>
      <label className="pcad-field"><span>{t('assembly.gear.peer')}</span>
        <select className="pcad-field__input" value={peerId} disabled={!ready}
          onChange={event => { setPeerId(event.currentTarget.value); }} title={t('assembly.guide.gearPeer')}>
          {peers.map(peer => <option key={peer.id} value={peer.id}>{peer.name}</option>)}
        </select></label>
      <label className="pcad-field"><span>{t('assembly.gear.ratio')}</span>
        <input className="pcad-field__input" value={ratioSource} disabled={!ready}
          onChange={event => { setRatioSource(event.currentTarget.value); }} title={t('assembly.guide.gearRatio')} /></label>
      <label className="pcad-field"><span>{t('assembly.gear.phase')}</span>
        <input className="pcad-field__input" value={phaseSource} disabled={!ready}
          onChange={event => { setPhaseSource(event.currentTarget.value); }} title={t('assembly.guide.gearPhase')} /><span>°</span></label>
      <button type="submit" className="pcad-button" disabled={!ready || peers.length === 0} title={t('assembly.guide.gearCommit')}>
        {t(props.coupling === undefined ? 'assembly.gear.create' : 'assembly.gear.update')}</button>
      {props.coupling === undefined ? null : <button type="button" className="pcad-button"
        data-testid="assembly-gear-remove" disabled={computing} onClick={remove} title={t('assembly.guide.gearRemove')}>{t('assembly.gear.remove')}</button>}
      {error ? <p role="alert">{t('assembly.gear.invalid')}</p> : null}
    </form>
  );
}

export function assemblyPropertyKey(kind: 'component' | 'mate' | 'joint' | 'step', id: string): string {
  return `${kind}:${id}`;
}

const MATE_KIND_LABELS: Readonly<Record<'coincident' | 'concentric' | 'distance' | 'angle' | 'parallel' | 'tangent', MessageKey>> = {
  coincident: 'assembly.tool.mateCoincident', concentric: 'assembly.tool.mateConcentric',
  distance: 'assembly.tool.mateDistance', angle: 'assembly.tool.mateAngle',
  parallel: 'assembly.tool.mateParallel', tangent: 'assembly.tool.mateTangent',
};

const JOINT_KIND_LABELS: Readonly<Record<'revolute' | 'slider' | 'cylindrical' | 'ball', MessageKey>> = {
  revolute: 'assembly.tool.jointRevolute', slider: 'assembly.tool.jointSlider',
  cylindrical: 'assembly.tool.jointCylindrical', ball: 'assembly.tool.jointBall',
};

interface MatePropertyDiagnosis {
  readonly provenConflictMateIds: readonly string[];
  readonly suspectedConflictMateIds: readonly string[];
  readonly unresolvedMateIds: readonly string[];
}

/** 数学的な証明と未収束の疑いを混同せず、木と同じ状態名をプロパティへ出す。 */
export function assemblyMatePropertyState(
  mateId: string,
  hasTargetError: boolean,
  diagnosis: MatePropertyDiagnosis | null | undefined,
): MessageKey {
  if (hasTargetError || diagnosis?.unresolvedMateIds.includes(mateId) === true) {
    return 'assembly.property.unresolved';
  }
  if (diagnosis?.provenConflictMateIds.includes(mateId) === true) {
    return 'assembly.property.conflicting';
  }
  if (diagnosis?.suspectedConflictMateIds.includes(mateId) === true) {
    return 'assembly.mate.suspected';
  }
  return 'assembly.property.resolved';
}

/** アセンブリを開いたとき、右の既存区画へ選択内容を表示する。 */
export function AssemblyPropertyPanel(): React.JSX.Element {
  const document = useAppStore((state) => state.assembly);
  const selection = useAppStore((state) => state.selection);
  const library = useAppStore((state) => state.assemblyLibrary);
  const view = useAppStore((state) => state.assemblyView);
  const interference = useAppStore((state) => state.assemblyInterferenceResult);
  const id = selection.length === 1 ? selection[0] : undefined;
  const component = document === null || id === undefined ? undefined : findComponent(document, id);
  const mate = document?.mates.find((item) => item.id === id);
  const joint = document?.joints.find((item) => item.id === id);
  const step = document?.presentation.find((item) => item.id === id);
  // A nested subassembly row (ids joined by '/') has no top-level component; its path comes from the resolved tree.
  const nestedPath = component === undefined && id !== undefined && document !== null ? subAssemblyOccurrencePathOf(document, view, id) : null;
  const nestedSection = nestedPath === null ? null
    : <SubAssemblyJointControls key={`subJoints:${nestedPath.join('/')}`} path={nestedPath} />;
  const componentName = (componentId: string): string => document?.components.find((item) => item.id === componentId)?.name ?? componentId;
  const section = component === undefined ? mate === undefined ? joint === undefined ? step === undefined ? null : (
    <dl key={assemblyPropertyKey('step', step.id)} className="pcad-property-list">
      <dt>{t('assembly.property.name')}</dt><dd>{step.name}</dd>
      <dt>{t('assembly.property.interval')}</dt><dd>{String(step.start)}–{String(step.end)}</dd>
      {step.body.kind === 'explode' ? <><dt>{t('assembly.explode.distance')}</dt><dd>{step.body.distance.source}</dd></> : null}
    </dl>
  ) : (
    <section key={propertySectionKey('joint', joint.id)} className="pcad-section">
      <h3 className="pcad-section__title">{t('assembly.property.jointSection')}</h3>
      <dl className="pcad-property-list">
        <dt>{t('assembly.property.name')}</dt><dd>{joint.name}</dd>
        <dt>{t('assembly.property.kind')}</dt><dd>{t(JOINT_KIND_LABELS[joint.kind])}</dd>
        <dt>{t('assembly.property.targets')}</dt><dd>{componentName(joint.a.componentId)} / {componentName(joint.b.componentId)}</dd>
        <dt>{t('assembly.property.range')}</dt><dd>{joint.minValue?.source ?? t('assembly.property.unlimited')} – {joint.maxValue?.source ?? t('assembly.property.unlimited')}</dd>
      </dl>
      <JointSliderControls joint={joint} idPrefix="property" />
      {joint.kind === 'revolute' && !joint.suppressed ? <>
        {(document?.mechanismCouplings ?? []).filter(c => c.jointAId === joint.id || c.jointBId === joint.id)
          .map(c => <AssemblyGearCouplingForm key={JSON.stringify([c.id, c.jointAId, c.jointBId, c.ratio.source, c.phaseDeg.source, c.referenceAngleA, c.suppressed])}
            jointId={joint.id} coupling={c} />)}
        <AssemblyGearCouplingForm key={`new:${joint.id}`} jointId={joint.id} />
        {(document?.camCouplings ?? []).filter(c => c.camJointId === joint.id)
          .map(c => <AssemblyCamCouplingForm key={JSON.stringify([c.id, c.followerJointId, c.discRadiusMm.source, c.eccentricityMm.source,
            c.rollerRadiusMm.source, c.phaseDeg.source, c.referenceAngleCam, c.suppressed])} jointId={joint.id} coupling={c} />)}
        <AssemblyCamCouplingForm key={`newCam:${joint.id}`} jointId={joint.id} />
        {(document?.crossLevelGearCouplings ?? []).filter(c => c.parentJointId === joint.id)
          .map(c => <AssemblyCrossLevelGearForm key={JSON.stringify([c.id, c.childPath, c.childJointId, c.ratio.source,
            c.phaseDeg.source, c.suppressed])} jointId={joint.id} coupling={c} />)}
        <AssemblyCrossLevelGearForm key={`newCross:${joint.id}`} jointId={joint.id} />
        {(document?.crossLevelCamCouplings ?? []).filter(c => c.camJointId === joint.id)
          .map(c => <AssemblyCrossLevelCamForm key={JSON.stringify([c.id, c.childPath, c.childJointId, c.discRadiusMm.source,
            c.eccentricityMm.source, c.rollerRadiusMm.source, c.phaseDeg.source, c.offsetMm.source, c.direction, c.suppressed])}
            jointId={joint.id} cam={c} />)}
        <AssemblyCrossLevelCamForm key={`newCrossCam:${joint.id}`} jointId={joint.id} />
      </> : null}
    </section>
  ) : (
    <section key={propertySectionKey('mate', mate.id)} className="pcad-section">
      <h3 className="pcad-section__title">{t('assembly.property.mateSection')}</h3>
      <dl className="pcad-property-list">
        <dt>{t('assembly.property.name')}</dt><dd>{mate.name}</dd>
        <dt>{t('assembly.property.kind')}</dt><dd>{t(MATE_KIND_LABELS[mate.kind])}</dd>
        <dt>{t('assembly.property.targets')}</dt><dd>{componentName(mate.a.componentId)} / {componentName(mate.b.componentId)}</dd>
        <dt>{t('assembly.property.value')}</dt><dd>{mate.value?.source ?? '0'}</dd>
        <dt>{t('assembly.property.state')}</dt><dd>{t(assemblyMatePropertyState(
          mate.id,
          (view?.mateTargetErrors.get(mate.id)?.length ?? 0) > 0,
          view?.diagnosis,
        ))}</dd>
      </dl>
    </section>
  ) : (
    <section key={propertySectionKey('component', component.id)} className="pcad-section">
      <h3 className="pcad-section__title">{t('assembly.property.componentSection')}</h3>
      <dl className="pcad-property-list">
        <dt>{t('assembly.property.name')}</dt><dd>{component.name}</dd>
        <dt>{t('assembly.property.fixed')}</dt><dd>{t(component.fixed ? 'assembly.property.yes' : 'assembly.property.no')}</dd>
        <dt>{t('assembly.property.visible')}</dt><dd>{t(component.visible ? 'assembly.property.yes' : 'assembly.property.no')}</dd>
        <dt>{t('assembly.property.material')}</dt><dd>{component.materialId ?? t('assembly.property.unset')}</dd>
        <dt>{t('assembly.property.position')}</dt><dd>{component.placement.position.map((value) => value.source).join(', ')}</dd>
        <dt>{t('assembly.property.orientation')}</dt><dd>{(() => {
          const value = quaternionToAxisAngle(component.placement.rotation);
          return `${(value.angleRadians * 180 / Math.PI).toFixed(2)}° (${value.axis.map((item) => item.toFixed(2)).join(', ')})`;
        })()}</dd>
        <dt>{t('assembly.property.sourceFile')}</dt><dd>{component.source.kind === 'part'
          ? partFileOf(library, component.source.partRef)?.fileName ?? component.source.partRef
          : component.source.kind === 'standardPart'
            ? `${component.source.catalog} ${component.source.size}`
            : library.assemblies?.get(component.source.assemblyRef)?.name ?? component.source.assemblyRef}</dd>
      </dl>
      {component.source.kind === 'part'
        ? <AssemblyContextReferenceForm key={`context:${component.id}`} componentId={component.id} /> : null}
      {component.source.kind === 'subAssembly'
        ? <SubAssemblyJointControls key={`subJoints:${component.id}`} path={[component.id]} /> : null}
    </section>
  );
  const interferenceSection = interference === null ? null : (
    <section key={propertySectionKey('interference')} className="pcad-section">
      <h3 className="pcad-section__title">{t('assembly.property.interferenceSection')}</h3>
      {interference.pairs.length === 0 ? <p>{t('assembly.interference.none')}</p> : (
        <dl className="pcad-property-list">
          {interferenceRows(interference, componentName).map((row) => (
            <div key={row.key} className="pcad-property-list__pair">
              <dt>{row.aName} × {row.bName}</dt><dd>{row.volumeText}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__body">
        <ReferenceRepairSection />
        <AssemblyCrossLevelGearRepairs />
        {section ?? nestedSection ?? <div className="pcad-panel__empty"><EmptyBoxIcon size={28} />
          <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p></div>}
        <AssemblyParameterPanel />
        {interferenceSection}
        <div key={propertySectionKey('bom')}><BomTable /></div>
      </div>
    </section>
  );
}
