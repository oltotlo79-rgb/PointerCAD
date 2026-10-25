import { useState } from 'react';
import { evaluateExpression } from '@pointercad/expression';
import { assemblyExpressionContext, type CrossLevelCamCouplingDefinition } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { currentOccurrenceDrive, jointValueKey, type CrossLevelNoticeCode } from '../store/assemblyOccurrenceDriveSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { crossLevelGearReason, crossLevelGearTargets } from './AssemblyCrossLevelGearForm.js';

const CAM_REASONS: Partial<Record<CrossLevelNoticeCode, MessageKey>> = {
  'invalid-expression': 'assembly.crossCam.reason.expression',
  'invalid-cam-dimensions': 'assembly.crossCam.reason.dimensions',
  'invalid-offset': 'assembly.crossCam.reason.offset',
  'unsupported-follower-drive': 'assembly.crossCam.reason.followerDrive',
  'unsupported-child-joint': 'assembly.crossCam.reason.childKind',
};
/** The visible refusal text of a cross-level cam (cam wording where it differs from the gear's). */
export function crossLevelCamRefusal(code: CrossLevelNoticeCode): string {
  const reason = CAM_REASONS[code];
  return t('assembly.crossGear.refused').replace('{reason}', reason === undefined ? crossLevelGearReason(code) : t(reason));
}

const targetKey = (path: readonly string[], jointId: string): string => JSON.stringify([path, jointId]);
type Sources = { readonly disc: string; readonly eccentricity: string; readonly roller: string; readonly phase: string; readonly offset: string };
const CAM_FIELD_GUIDES: Readonly<Record<keyof Sources, MessageKey>> = { disc: 'assembly.guide.crossCamDisc',
  eccentricity: 'assembly.guide.crossCamEccentricity', roller: 'assembly.guide.crossCamRoller', phase: 'assembly.guide.crossCamPhase',
  offset: 'assembly.guide.crossCamOffset' };

/**
 * Cross-level cam on a top-level revolute joint (the cam): create, edit and remove (one Undo step each, through
 * setAssemblyCrossLevelCams) and, for a saved active one, drive it from the cam side (transient motion through
 * driveAssemblyCrossLevelCam). The follower translation is shown, not entered: the cam law has two cam angles for most
 * follower positions. The offset and direction are labelled as the user's law, never as a checked contact.
 */
export function AssemblyCrossLevelCamForm(props: {
  readonly jointId: string;
  readonly cam?: CrossLevelCamCouplingDefinition;
}): React.JSX.Element | null {
  const document = useAppStore(state => state.assembly);
  const library = useAppStore(state => state.assemblyLibrary);
  const view = useAppStore(state => state.assemblyView);
  const computing = useAppStore(state => state.isComputing);
  const motionValues = useAppStore(state => state.assemblyMotionJointValues);
  const motionDocument = useAppStore(state => state.assemblyMotionSourceDocument);
  const drives = useAppStore(state => state.assemblyOccurrenceDrives);
  const targets = document === null ? [] : crossLevelGearTargets(document, library, 'slider');
  const [target, setTarget] = useState(props.cam === undefined ? (targets[0] === undefined ? '' : targetKey(targets[0].path, targets[0].jointId))
    : targetKey(props.cam.childPath, props.cam.childJointId));
  const [sources, setSources] = useState<Sources>({ disc: props.cam?.discRadiusMm.source ?? '20',
    eccentricity: props.cam?.eccentricityMm.source ?? '5', roller: props.cam?.rollerRadiusMm.source ?? '5',
    phase: props.cam?.phaseDeg.source ?? '0', offset: props.cam?.offsetMm.source ?? '-25' });
  const [direction, setDirection] = useState<1 | -1>(props.cam?.direction ?? 1);
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
    const values = [sources.disc, sources.eccentricity, sources.roller, sources.phase, sources.offset].map(source => evaluateExpression(source, context));
    const [disc, eccentricity, roller, phase, offset] = values;
    if (disc === undefined || !disc.ok || eccentricity === undefined || !eccentricity.ok || roller === undefined || !roller.ok
        || phase === undefined || !phase.ok || offset === undefined || !offset.ok) { setRefusal('invalid-expression'); return; }
    const previous = document.crossLevelCamCouplings ?? [];
    const taken = new Set([...previous, ...(document.crossLevelGearCouplings ?? []), ...(document.mechanismCouplings ?? []),
      ...(document.camCouplings ?? [])].map(c => c.id));
    let serial = 1;
    while (taken.has(`cross-cam-${String(serial)}`)) serial += 1;
    const next: CrossLevelCamCouplingDefinition = { id: props.cam?.id ?? `cross-cam-${String(serial)}`, kind: 'crossLevelCam',
      camJointId: joint.id, childPath: [...chosen.path], childJointId: chosen.jointId, discRadiusMm: disc.value,
      eccentricityMm: eccentricity.value, rollerRadiusMm: roller.value, phaseDeg: phase.value, offsetMm: offset.value, direction,
      suppressed: props.cam?.suppressed ?? false };
    const rows = props.cam === undefined ? [...previous, next] : previous.map(c => c.id === props.cam?.id ? next : c);
    if (state.setAssemblyCrossLevelCams(rows)) setRefusal(null); else refused();
  };
  const remove = (): void => {
    const state = useAppStore.getState();
    if (state.assembly !== document || props.cam === undefined) return;
    if (state.setAssemblyCrossLevelCams((document.crossLevelCamCouplings ?? []).filter(c => c.id !== props.cam?.id))) setRefusal(null);
    else refused();
  };
  const drive = (source: string): void => {
    const value = Number(source);
    if (props.cam === undefined || source.trim() === '' || !Number.isFinite(value)) return;
    if (useAppStore.getState().driveAssemblyCrossLevelCam(props.cam.id, 'cam', value)) setRefusal(null); else refused();
  };
  const cam = props.cam;
  const followerName = chosen?.label ?? cam?.childJointId ?? '';
  const camValue = cam !== undefined && motionDocument === document ? motionValues.get(jointValueKey(joint.id, 'angle')) : undefined;
  const followerValue = cam === undefined ? undefined : currentOccurrenceDrive({ assembly: document, assemblyView: view,
    assemblyOccurrenceDrives: drives }, cam.childPath)?.values.get(jointValueKey(cam.childJointId, 'translation'));
  const field = (key: keyof Sources, label: MessageKey, unit: string): React.JSX.Element => (
    <label className="pcad-field"><span>{t(label)}</span>
      <input className="pcad-field__input" value={sources[key]} disabled={!ready}
        onChange={event => { const value = event.currentTarget.value; setSources(current => ({ ...current, [key]: value })); }} title={t(CAM_FIELD_GUIDES[key])} />
      <span>{unit}</span></label>);
  return (
    <form aria-label={t('assembly.crossCam.title')} data-testid="assembly-cross-cam-form"
      onSubmit={event => { event.preventDefault(); commit(); }}>
      <h4>{t('assembly.crossCam.title')}</h4>
      <p>{t('assembly.crossCam.law').replace('{a}', joint.name)}</p>
      <p>{t('assembly.crossCam.authoredLaw')}</p>
      {targets.length === 0 ? <p>{t('assembly.crossCam.none')}</p> : (
        <label className="pcad-field"><span>{t('assembly.crossCam.target')}</span>
          <select className="pcad-field__input" value={target} disabled={!ready}
            onChange={event => { setTarget(event.currentTarget.value); }} title={t('assembly.guide.crossCamTarget')}>
            {targets.map(item => <option key={targetKey(item.path, item.jointId)} value={targetKey(item.path, item.jointId)}>{item.label}</option>)}
          </select></label>)}
      {field('disc', 'assembly.crossCam.discRadius', 'mm')}
      {field('eccentricity', 'assembly.crossCam.eccentricity', 'mm')}
      {field('roller', 'assembly.crossCam.rollerRadius', 'mm')}
      {field('phase', 'assembly.crossCam.phase', '°')}
      {field('offset', 'assembly.crossCam.offset', 'mm')}
      <label className="pcad-field"><span>{t('assembly.crossCam.direction')}</span>
        <select className="pcad-field__input" value={String(direction)} disabled={!ready}
          onChange={event => { setDirection(event.currentTarget.value === '-1' ? -1 : 1); }} title={t('assembly.guide.crossCamDirection')}>
          <option value="1">{t('assembly.crossCam.directionPlus')}</option>
          <option value="-1">{t('assembly.crossCam.directionMinus')}</option>
        </select></label>
      <button type="submit" className="pcad-button" disabled={!ready || chosen === undefined} title={t('assembly.guide.crossCamCommit')}>
        {t(cam === undefined ? 'assembly.crossCam.create' : 'assembly.crossCam.update')}</button>
      {cam === undefined ? null : <button type="button" className="pcad-button" disabled={computing} onClick={remove} title={t('assembly.guide.crossCamRemove')}>
        {t('assembly.crossCam.remove')}</button>}
      {cam === undefined || cam.suppressed ? null : <>
        <p>{t('assembly.crossCam.driveHint')}</p>
        <label className="pcad-field"><span>{t('assembly.crossCam.camAngle').replace('{joint}', joint.name)}</span>
          <input type="number" className="pcad-field__input" disabled={!ready} value={camValue ?? ''}
            aria-label={t('assembly.crossCam.camAngle').replace('{joint}', joint.name)}
            onChange={event => { drive(event.currentTarget.value); }} title={t('assembly.guide.crossCamDrive')} /><span>°</span></label>
        <p><span>{t('assembly.crossCam.follower').replace('{joint}', followerName)}</span>{' '}
          <output aria-label={t('assembly.crossCam.follower').replace('{joint}', followerName)}>
            {followerValue === undefined ? '' : `${followerValue.toFixed(3)} mm`}</output></p>
      </>}
      {refusal === null ? null : <p role="alert">{crossLevelCamRefusal(refusal)}</p>}
    </form>
  );
}
