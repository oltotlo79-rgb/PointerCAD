import type { AppState } from '../../store/appState.js';
import { MeasureIcon } from '../icons.js';
import type { ToolMenuItem } from './menuItem.js';

interface AnalysisDescriptor extends ToolMenuItem<string> {
  readonly documentKinds: readonly ('part' | 'assembly')[];
  readonly isOpen: (state: AppState) => boolean;
  readonly open: (state: AppState) => void;
}

/** The menu, command catalog and activation share these existing panel entry points. */
export const ANALYSIS_MENU_ITEMS = [
  { id: 'beam', labelKey: 'beam.open', tooltipKey: 'beam.openHelp', Icon: MeasureIcon,
    documentKinds: ['assembly'], isOpen: state => state.beamSession !== null, open: state => state.openBeam() },
  { id: 'plasticBar', labelKey: 'plasticBar.open', tooltipKey: 'plasticBar.openHelp', Icon: MeasureIcon,
    documentKinds: ['part', 'assembly'], isOpen: state => state.plasticBarSession !== null, open: state => state.openPlasticBar() },
  { id: 'fatigue', labelKey: 'fatigue.open', tooltipKey: 'fatigue.openHelp', Icon: MeasureIcon,
    documentKinds: ['part', 'assembly'], isOpen: state => state.fatigueSession !== null, open: state => state.openFatigue() },
  { id: 'fatigueStrain', labelKey: 'fatigueStrain.open', tooltipKey: 'fatigueStrain.openHelp', Icon: MeasureIcon,
    documentKinds: ['part', 'assembly'], isOpen: state => state.fatigueStrainSession !== null, open: state => state.openFatigueStrain() },
  { id: 'fatigueLocalCycle', labelKey: 'fatigueLocalCycle.open', tooltipKey: 'fatigueLocalCycle.openHelp', Icon: MeasureIcon,
    documentKinds: ['part', 'assembly'], isOpen: state => state.fatigueLocalCycleSession !== null, open: state => state.openFatigueLocalCycle() },
  { id: 'solidAnalysis', labelKey: 'solidAnalysis.open', tooltipKey: 'solidAnalysis.openHelp', Icon: MeasureIcon,
    documentKinds: ['part'], isOpen: state => state.solidAnalysisSession !== null, open: state => state.openSolidAnalysis() },
  { id: 'solidPlastic', labelKey: 'solidPlastic.open', tooltipKey: 'solidPlastic.openHelp', Icon: MeasureIcon,
    documentKinds: ['part'], isOpen: state => state.solidPlasticSession !== null, open: state => state.openSolidPlastic() },
] as const satisfies readonly AnalysisDescriptor[];

export type AnalysisToolId = (typeof ANALYSIS_MENU_ITEMS)[number]['id'];

export function analysisMenuItemsFor(documentKind: 'part' | 'assembly' | 'drawing') {
  return ANALYSIS_MENU_ITEMS.filter(item => item.documentKinds.some(kind => kind === documentKind));
}
