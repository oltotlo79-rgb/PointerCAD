import { useState } from 'react';
import { evaluateExpression } from '@pointercad/expression';
import { assemblyExpressionContext, type MechanismCamCoupling } from '@pointercad/model';
import { currentJointSliderValue, jointSliderBounds, jointSliderReference } from './jointSlider.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/** Same safeguard as the parameter tables: the Enter that confirms a Japanese conversion (isComposing / keyCode 229)
 * must not submit the form. */
export function ignoreComposingEnter(event: { readonly key: string; readonly keyCode: number;
  readonly nativeEvent: { readonly isComposing: boolean }; preventDefault(): void }): void {
  if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
}

/** Eccentric disc cam on the selected revolute joint driving an in-line follower slider. Authored expressions are kept;
 * every commit goes through the validated immutable store action, which refuses and keeps the scene. */
export function AssemblyCamCouplingForm(props: {
  readonly jointId: string;
  readonly coupling?: MechanismCamCoupling;
}): React.JSX.Element | null {
  const document = useAppStore(state => state.assembly);
  const view = useAppStore(state => state.assemblyView);
  const computing = useAppStore(state => state.isComputing);
  const camId = props.coupling?.camJointId ?? props.jointId;
  const followers = document?.joints.filter(j => j.kind === 'slider' && !j.suppressed) ?? [];
  const [followerId, setFollowerId] = useState(props.coupling?.followerJointId ?? followers[0]?.id ?? '');
  const [discSource, setDiscSource] = useState(props.coupling?.discRadiusMm.source ?? '20');
  const [eccentricitySource, setEccentricitySource] = useState(props.coupling?.eccentricityMm.source ?? '5');
  const [rollerSource, setRollerSource] = useState(props.coupling?.rollerRadiusMm.source ?? '0');
  const [phaseSource, setPhaseSource] = useState(props.coupling?.phaseDeg.source ?? '0');
  const [error, setError] = useState(false);
  const joint = document?.joints.find(j => j.id === camId);
  if (document === null || joint === undefined || joint.kind !== 'revolute' || joint.suppressed) return null;
  const ready = view?.sourceDocument === document && !computing;
  const commit = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || view === null || state.assemblyView !== view || view.sourceDocument !== document || state.isComputing) { setError(true); return; }
    const context = assemblyExpressionContext(document);
    const disc = evaluateExpression(discSource, context), eccentricity = evaluateExpression(eccentricitySource, context);
    const roller = evaluateExpression(rollerSource, context), phaseDeg = evaluateExpression(phaseSource, context);
    const bounds = jointSliderBounds(document, joint, 'angle'), frames = view.jointFrames?.get(camId);
    const referenceAngleCam = props.coupling?.referenceAngleCam ?? (bounds.ok && frames !== undefined
      ? currentJointSliderValue({ document, joint, coordinate: 'angle', frames, placements: view.resolved.placements,
        referenceAngle: jointSliderReference(bounds.bounds) }) : null);
    if (!disc.ok || !eccentricity.ok || !roller.ok || !phaseDeg.ok || referenceAngleCam === null) { setError(true); return; }
    const previous = document.camCouplings ?? [];
    let serial = 1;
    while (previous.some(c => c.id === `cam-${String(serial)}`)) serial += 1;
    const next: MechanismCamCoupling = { id: props.coupling?.id ?? `cam-${String(serial)}`, kind: 'cam',
      camJointId: camId, followerJointId: followerId, discRadiusMm: disc.value, eccentricityMm: eccentricity.value,
      rollerRadiusMm: roller.value, phaseDeg: phaseDeg.value, referenceAngleCam, suppressed: props.coupling?.suppressed ?? false };
    const rows = props.coupling === undefined ? [...previous, next]
      : previous.map(c => c.id === props.coupling?.id ? next : c);
    setError(!state.setAssemblyCamCouplings(rows));
  };
  const remove = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || props.coupling === undefined || state.isComputing) { setError(true); return; }
    setError(!state.setAssemblyCamCouplings((document.camCouplings ?? []).filter(c => c.id !== props.coupling?.id)));
  };
  return (
    <form aria-label={t('assembly.cam.title')} data-testid="assembly-cam-form" onSubmit={event => { event.preventDefault(); commit(); }}>
      <h4>{t('assembly.cam.title')}</h4>
      <p>{t('assembly.cam.law')}</p>
      <p>{t('assembly.cam.validity')}</p>
      <label className="pcad-field"><span>{t('assembly.cam.follower')}</span>
        <select className="pcad-field__input" value={followerId} disabled={!ready}
          onChange={event => { setFollowerId(event.currentTarget.value); }} title={t('assembly.guide.camFollower')}>
          {followers.map(follower => <option key={follower.id} value={follower.id}>{follower.name}</option>)}
        </select></label>
      <label className="pcad-field"><span>{t('assembly.cam.discRadius')}</span>
        <input className="pcad-field__input" onKeyDown={ignoreComposingEnter} value={discSource} disabled={!ready}
          onChange={event => { setDiscSource(event.currentTarget.value); }} title={t('assembly.guide.camDiscRadius')} /></label>
      <label className="pcad-field"><span>{t('assembly.cam.eccentricity')}</span>
        <input className="pcad-field__input" onKeyDown={ignoreComposingEnter} value={eccentricitySource} disabled={!ready}
          onChange={event => { setEccentricitySource(event.currentTarget.value); }} title={t('assembly.guide.camEccentricity')} /></label>
      <label className="pcad-field"><span>{t('assembly.cam.rollerRadius')}</span>
        <input className="pcad-field__input" onKeyDown={ignoreComposingEnter} value={rollerSource} disabled={!ready}
          onChange={event => { setRollerSource(event.currentTarget.value); }} title={t('assembly.guide.camRollerRadius')} /></label>
      <label className="pcad-field"><span>{t('assembly.cam.phase')}</span>
        <input className="pcad-field__input" onKeyDown={ignoreComposingEnter} value={phaseSource} disabled={!ready}
          onChange={event => { setPhaseSource(event.currentTarget.value); }} title={t('assembly.guide.camPhase')} /><span>°</span></label>
      <button type="submit" className="pcad-button" disabled={!ready || followers.length === 0} title={t('assembly.guide.camCommit')}>
        {t(props.coupling === undefined ? 'assembly.cam.create' : 'assembly.cam.update')}</button>
      {props.coupling === undefined ? null : <button type="button" className="pcad-button"
        data-testid="assembly-cam-remove" disabled={computing} onClick={remove} title={t('assembly.guide.camRemove')}>{t('assembly.cam.remove')}</button>}
      {error ? <p role="alert">{t('assembly.cam.invalid')}</p> : null}
    </form>
  );
}
