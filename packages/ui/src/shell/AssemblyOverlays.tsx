import { PlaceComponentPopover } from '../assembly/PlaceComponentPopover.js';
import { AssemblyMotionControls } from '../assembly/AssemblyMotionControls.js';
import { AssemblyInterferencePanel } from '../assembly/AssemblyInterferencePanel.js';
import { StandardPartPicker } from '../assembly/StandardPartPickerPanel.js';
import { ExplodePopover } from '../assembly/ExplodePopover.js';
import { ReplacementPopover } from '../assembly/ReplacementPopover.js';

/** Keep the existing overlay group together, loading it only for assembly documents. */
export function AssemblyOverlays(): React.JSX.Element {
  return <>
    <PlaceComponentPopover />
    <StandardPartPicker />
    <ExplodePopover />
    <ReplacementPopover />
    <AssemblyMotionControls />
    <AssemblyInterferencePanel />
  </>;
}
