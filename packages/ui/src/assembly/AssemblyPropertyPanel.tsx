import { findComponent } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { EmptyBoxIcon } from '../shell/icons.js';
import { JointSliderControls } from './AssemblyMotionControls.js';

export function assemblyPropertyKey(kind: 'component' | 'mate' | 'joint' | 'step', id: string): string {
  return `${kind}:${id}`;
}

const JOINT_KIND_LABELS: Readonly<Record<'revolute' | 'slider' | 'cylindrical' | 'ball', MessageKey>> = {
  revolute: 'assembly.tool.jointRevolute', slider: 'assembly.tool.jointSlider',
  cylindrical: 'assembly.tool.jointCylindrical', ball: 'assembly.tool.jointBall',
};

/** アセンブリを開いたとき、右の既存区画へ選択内容を表示する。 */
export function AssemblyPropertyPanel(): React.JSX.Element {
  const document = useAppStore((state) => state.assembly);
  const selection = useAppStore((state) => state.selection);
  const id = selection.length === 1 ? selection[0] : undefined;
  const component = document === null || id === undefined ? undefined : findComponent(document, id);
  const mate = document?.mates.find((item) => item.id === id);
  const joint = document?.joints.find((item) => item.id === id);
  const step = document?.presentation.find((item) => item.id === id);
  const section = component === undefined ? mate === undefined ? joint === undefined ? step === undefined ? null : (
    <dl key={assemblyPropertyKey('step', step.id)} className="pcad-property-list">
      <dt>{t('assembly.property.name')}</dt><dd>{step.name}</dd>
      <dt>{t('assembly.property.interval')}</dt><dd>{String(step.start)}–{String(step.end)}</dd>
      {step.body.kind === 'explode' ? <><dt>{t('assembly.explode.distance')}</dt><dd>{step.body.distance.source}</dd></> : null}
    </dl>
  ) : (
    <div key={assemblyPropertyKey('joint', joint.id)}>
      <dl className="pcad-property-list">
        <dt>{t('assembly.property.name')}</dt><dd>{joint.name}</dd>
        <dt>{t('assembly.property.kind')}</dt><dd>{t(JOINT_KIND_LABELS[joint.kind])}</dd>
      </dl>
      <JointSliderControls joint={joint} idPrefix="property" />
    </div>
  ) : (
    <dl key={assemblyPropertyKey('mate', mate.id)} className="pcad-property-list">
      <dt>{t('assembly.property.name')}</dt><dd>{mate.name}</dd>
      <dt>{t('assembly.property.kind')}</dt><dd>{mate.kind}</dd>
    </dl>
  ) : (
    <dl key={assemblyPropertyKey('component', component.id)} className="pcad-property-list">
      <dt>{t('assembly.property.name')}</dt><dd>{component.name}</dd>
      <dt>{t('assembly.property.fixed')}</dt><dd>{t(component.fixed ? 'assembly.property.yes' : 'assembly.property.no')}</dd>
      <dt>{t('assembly.property.visible')}</dt><dd>{t(component.visible ? 'assembly.property.yes' : 'assembly.property.no')}</dd>
    </dl>
  );
  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__body">
        {section ?? <div className="pcad-panel__empty"><EmptyBoxIcon size={28} />
          <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p></div>}
      </div>
    </section>
  );
}
