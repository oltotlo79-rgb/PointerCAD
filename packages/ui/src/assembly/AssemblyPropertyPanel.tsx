import { findComponent, partFileOf, quaternionToAxisAngle } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { EmptyBoxIcon } from '../shell/icons.js';
import { JointSliderControls } from './AssemblyMotionControls.js';
import { BomTable } from './BomTable.js';
import { interferenceRows } from './interferenceView.js';
import { propertySectionKey } from '../shell/propertySectionKeys.js';

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
    </section>
  ) : (
    <section key={propertySectionKey('mate', mate.id)} className="pcad-section">
      <h3 className="pcad-section__title">{t('assembly.property.mateSection')}</h3>
      <dl className="pcad-property-list">
        <dt>{t('assembly.property.name')}</dt><dd>{mate.name}</dd>
        <dt>{t('assembly.property.kind')}</dt><dd>{t(MATE_KIND_LABELS[mate.kind])}</dd>
        <dt>{t('assembly.property.targets')}</dt><dd>{componentName(mate.a.componentId)} / {componentName(mate.b.componentId)}</dd>
        <dt>{t('assembly.property.value')}</dt><dd>{mate.value?.source ?? '0'}</dd>
        <dt>{t('assembly.property.state')}</dt><dd>{
          (view?.mateTargetErrors.get(mate.id)?.length ?? 0) > 0
            ? t('assembly.property.unresolved')
            : view?.diagnosis?.provenConflictMateIds.includes(mate.id) === true
              ? t('assembly.property.conflicting') : t('assembly.property.resolved')
        }</dd>
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
        {section ?? <div className="pcad-panel__empty"><EmptyBoxIcon size={28} />
          <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p></div>}
        {interferenceSection}
        <div key={propertySectionKey('bom')}><BomTable /></div>
      </div>
    </section>
  );
}
