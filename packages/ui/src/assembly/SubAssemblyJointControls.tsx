import { useEffect, useRef, useState } from 'react';
import { jointOccurrencePath, type AssemblyDocument, type JointOccurrencePath, type PartLibrary } from '@pointercad/model';
import { t } from '../i18n/t.js';
import type { AssemblyJointDrive, AssemblyView } from '../store/assemblySlice.js';
import { currentOccurrenceDrive, occurrenceDriveKey } from '../store/assemblyOccurrenceDriveSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { jointSliderCoordinates } from './jointSlider.js';

/**
 * The occurrence path of the subassembly placement behind a tree row id. Tree row ids are the component ids joined
 * with '/' (assemblyTreeRows.ts componentRowsOf); the path is taken from the resolved tree, never split from the text,
 * and a row id shared by two different paths is ambiguous (null), like flattenAssemblyGeometry's occurrencePaths.
 */
export function subAssemblyOccurrencePathOf(document: AssemblyDocument, view: AssemblyView | null, rowId: string):
  JointOccurrencePath | null {
  if (view === null || view.sourceDocument !== document) return null;
  const matches: JointOccurrencePath[] = [];
  const visit = (assembly: AssemblyDocument, resolved: AssemblyView['resolved'], prefix: readonly string[]): void => {
    for (const component of assembly.components) {
      if (component.suppressed || component.source.kind !== 'subAssembly') continue;
      const nested = resolved.subAssemblies?.get(component.id);
      const path = jointOccurrencePath([...prefix, component.id]);
      if (nested === undefined || path === null) continue;
      if (path.join('/') === rowId) matches.push(path);
      visit(nested.assembly, nested.resolved, path);
    }
  };
  visit(document, view.resolved, []);
  return matches.length === 1 ? matches[0] ?? null : null;
}

/** The child document owned by the last subassembly of `path`, walked through the document and library. */
function ownerOf(document: AssemblyDocument, library: PartLibrary, path: readonly string[]): AssemblyDocument | null {
  let current: AssemblyDocument = document;
  for (const id of path) {
    const component = current.components.find(item => item.id === id);
    if (component === undefined || component.source.kind !== 'subAssembly') return null;
    const child = library.assemblies?.get(component.source.assemblyRef);
    if (child === undefined) return null;
    current = child;
  }
  return path.length === 0 ? null : current;
}

/**
 * Flexible subassembly (EX12): the child joints of ONE subassembly placement (any depth, `path` from the top level),
 * driven for this placement only. Values are transient motion state (driveAssemblyOccurrenceJoint): no document edit,
 * no Undo step, not saved; other placements of the same child keep their own values.
 */
export function SubAssemblyJointControls(props: { readonly path: readonly string[] }): React.JSX.Element | null {
  const document = useAppStore(state => state.assembly);
  const library = useAppStore(state => state.assemblyLibrary);
  const view = useAppStore(state => state.assemblyView);
  const drives = useAppStore(state => state.assemblyOccurrenceDrives);
  const pending = useAppStore(state => state.assemblyJointDrive);
  const notice = useAppStore(state => state.assemblyMotionNotice);
  const requested = useRef<AssemblyJointDrive | null>(null);
  const [refused, setRefused] = useState(false);
  useEffect(() => () => {
    const owner = requested.current;
    if (owner !== null) useAppStore.getState().cancelAssemblyJointDrive(owner);
  }, []);
  if (document === null) return null;
  const child = ownerOf(document, library, props.path);
  if (child === null) return null;
  const joints = child.joints.filter(joint => !joint.suppressed && jointSliderCoordinates(joint).length > 0);
  const drive = currentOccurrenceDrive({ assembly: document, assemblyView: view, assemblyOccurrenceDrives: drives }, props.path);
  const ready = view !== null && view.sourceDocument === document;
  const waiting = pending?.path !== undefined && occurrenceDriveKey(pending.path) === occurrenceDriveKey(props.path);
  return (
    <section aria-label={t('assembly.subJoint.title')} data-testid="assembly-subjoint-controls" data-occurrence-path={props.path.join('/')}>
      <h4>{t('assembly.subJoint.title')}</h4>
      <p>{t('assembly.subJoint.hint')}</p>
      {joints.length === 0 ? <p>{t('assembly.subJoint.none')}</p> : joints.flatMap(joint => jointSliderCoordinates(joint).map(coordinate => {
        const key = `${joint.id}${String.fromCharCode(0)}${coordinate}`;
        const label = `${joint.name} ${t(coordinate === 'angle' ? 'assembly.motion.angle' : 'assembly.motion.translation')}`;
        const active = waiting && pending.jointId === joint.id && pending.coordinate === coordinate;
        const value = active ? pending.value : drive?.values.get(key);
        return (
          <label key={key} className="pcad-field">
            <span>{label}</span>
            <input type="number" className="pcad-field__input" aria-label={label} disabled={!ready}
              title={t('assembly.subJoint.guide').replace('{joint}', label)} value={value ?? ''}
              onChange={event => {
                const source = event.currentTarget.value, next = Number(source);
                if (source.trim() === '' || !Number.isFinite(next)) return;
                const accepted = useAppStore.getState().requestAssemblyJointDrive(joint.id, coordinate, next, props.path);
                setRefused(!accepted);
                if (accepted) requested.current = useAppStore.getState().assemblyJointDrive;
              }} />
            <span className="pcad-field__unit">{coordinate === 'angle' ? '°' : 'mm'}</span>
          </label>
        );
      }))}
      {waiting ? <span className="pcad-field__message" role="status">
        {t('assembly.motion.pending').replace('{coordinate}', t(pending.coordinate === 'angle' ? 'assembly.motion.angle' : 'assembly.motion.translation'))}
        <button type="button" className="pcad-button" title={t('assembly.motion.cancelTooltip')}
          onClick={() => { useAppStore.getState().cancelAssemblyJointDrive(pending); }}>
          {t('assembly.motion.cancel')}
        </button>
      </span> : refused || notice?.kind === 'failed' ? <p role="alert">{t('assembly.subJoint.refused')}</p> : null}
    </section>
  );
}
