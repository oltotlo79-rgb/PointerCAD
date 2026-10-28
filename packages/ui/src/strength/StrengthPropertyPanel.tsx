import { BoltPreloadPanel } from '../beam/BoltPreloadPanel.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { StrengthPanel } from './StrengthPanel.js';
import { BeamPanel } from '../beam/BeamPanel.js';
import { PlasticBarPanel } from '../plasticBar/PlasticBarPanel.js';
import { FatiguePanel } from '../fatigue/FatiguePanel.js';
import { FatigueStrainPanel } from '../fatigueStrain/FatigueStrainPanel.js';
import { FatigueLocalCyclePanel } from '../fatigueLocalCycle/FatigueLocalCyclePanel.js';
import { SolidAnalysisPanel } from '../solidAnalysis/SolidAnalysisPanel.js';
import { SolidPlasticPanel } from '../solidPlastic/SolidPlasticPanel.js';

/** 部品・アセンブリのどちらから開いても同じ右欄を使う。入力の更新はこの区画内に留める。 */
export function StrengthPropertyPanel(): React.JSX.Element | null {
  const preload = useAppStore(state => state.boltPreloadDraft !== null || state.boltPreloadAuthor !== null);
  const session = useAppStore(state => state.strengthSession);
  const beam = useAppStore(state => state.beamSession);
  const plasticBar = useAppStore(state => state.plasticBarSession);
  const fatigue = useAppStore(state => state.fatigueSession);
  const fatigueStrain = useAppStore(state => state.fatigueStrainSession);
  const fatigueLocalCycle = useAppStore(state => state.fatigueLocalCycleSession);
  const solid = useAppStore(state => state.solidAnalysisSession);
  const solidPlastic = useAppStore(state => state.solidPlasticSession);
  if (session === null) return null;
  return <section className="pcad-panel pcad-panel--right">
    <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
    <BoltPreloadPanel />
    {preload ? null : solid !== null && fatigue !== null ? <FatiguePanel session={fatigue} /> : solid !== null ? <SolidAnalysisPanel session={solid} /> : solidPlastic !== null ? <SolidPlasticPanel session={solidPlastic} />
      : beam !== null ? <BeamPanel session={beam} />
      : plasticBar !== null ? <PlasticBarPanel session={plasticBar} />
        : fatigueLocalCycle !== null ? <FatigueLocalCyclePanel session={fatigueLocalCycle} /> : fatigueStrain !== null ? <FatigueStrainPanel session={fatigueStrain} /> : fatigue !== null ? <FatiguePanel session={fatigue} /> : <StrengthPanel session={session} />}
  </section>;
}
