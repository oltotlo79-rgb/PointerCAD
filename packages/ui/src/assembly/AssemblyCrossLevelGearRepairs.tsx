import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { crossLevelGearReason } from './AssemblyCrossLevelGearForm.js';

/**
 * What the last document edit did to saved cross-level gears: each one it suspended (kept, inactive) or removed, with
 * the reason. The edit and these changes are one Undo step, so Undo brings the gears back with the edit. It also says
 * why the last ordinary motion (a drive of another joint, a presentation step, a drag) was refused because of a
 * cross-level gear: nothing moved then.
 */
export function AssemblyCrossLevelGearRepairs(): React.JSX.Element | null {
  const repairs = useAppStore(state => state.assemblyCrossLevelGearRepairs);
  const motion = useAppStore(state => state.assemblyCrossLevelMotionNotice);
  if (repairs.length === 0 && motion === null) return null;
  return (
    <section aria-label={t('assembly.crossGear.repairTitle')} data-testid="assembly-cross-gear-repairs" className="pcad-section">
      <h3 className="pcad-section__title">{t('assembly.crossGear.repairTitle')}</h3>
      {motion === null ? null : (
        <p role="alert">{t('assembly.crossGear.motionRefused').replace('{id}', motion.couplingId)
          .replace('{reason}', crossLevelGearReason(motion.code))}</p>)}
      {repairs.length === 0 ? null : (
        <ul role="status">
          {repairs.map(repair => (
            <li key={`${repair.action}:${repair.couplingId}`}>
              {t(repair.action === 'removed' ? 'assembly.crossGear.repairRemoved' : 'assembly.crossGear.repairSuspended')
                .replace('{id}', repair.couplingId).replace('{reason}', crossLevelGearReason(repair.code))}
            </li>
          ))}
        </ul>)}
    </section>
  );
}
