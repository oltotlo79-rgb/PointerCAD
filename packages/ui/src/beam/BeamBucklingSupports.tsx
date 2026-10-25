import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { BeamMemberDraft, BucklingAxis } from './beamSession.js';

const axes: readonly { readonly axis: BucklingAxis; readonly label: MessageKey }[] = [
  { axis: 0, label: 'beam.support.ux' }, { axis: 1, label: 'beam.support.uy' },
  { axis: 2, label: 'beam.support.uz' }, { axis: 3, label: 'beam.support.rx' },
  { axis: 4, label: 'beam.support.ry' }, { axis: 5, label: 'beam.support.rz' },
];

export function BeamBucklingSupports({ member, end }: {
  readonly member: BeamMemberDraft; readonly end: 'start' | 'end';
}): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam);
  const mask = end === 'start' ? member.startRestraints : member.endRestraints;
  return <fieldset data-beam-buckling-supports={end}>
    <legend>{t('beam.bucklingSupports')}</legend>
    {axes.map(({ axis, label }) => <label key={axis}>
      <input type="checkbox" data-beam-restraint={axis} checked={mask[axis]}
        onChange={event => edit({ kind: 'buckling-support', id: member.id, end, axis, restrained: event.target.checked })} title={t('beam.guide.bucklingRestraint')} />
      {t(label)}
    </label>)}
  </fieldset>;
}
