import { PlaceComponentPopover } from '../assembly/PlaceComponentPopover.js';
import { AssemblyMotionControls } from '../assembly/AssemblyMotionControls.js';
import { AssemblyInterferencePanel } from '../assembly/AssemblyInterferencePanel.js';
import { FrameJointCheckPanel } from '../assembly/FrameJointCheckPanel.js';
import { FrameJointBracketPopover } from '../assembly/FrameJointBracketPopover.js';
import { MemberStretchPopover } from '../assembly/MemberStretchPopover.js';
import { StandardPartPicker } from '../assembly/StandardPartPickerPanel.js';
import { ExplodePopover } from '../assembly/ExplodePopover.js';
import { ReplacementPopover } from '../assembly/ReplacementPopover.js';
import { BoltedJointPopover, BoltedJointRebuildPanel } from '../assembly/BoltedJointPopover.js';
import { FrameSlotFasteningPopover } from '../assembly/FrameSlotFasteningPopover.js';
import { FilletWeldPopover } from '../assembly/FilletWeldPopover.js';
import { CircularFilletWeldPopover } from '../assembly/CircularFilletWeldPopover.js';
import { useAppStore } from '../store/useAppStore.js';

function CircularWeldOverlay(): React.JSX.Element {
  const draft = useAppStore(state => state.assemblyCircularWeldDraft);
  const preview = useAppStore(state => state.assemblyCircularWeldPreview);
  const state = useAppStore.getState();
  return <CircularFilletWeldPopover draft={draft} preview={preview} onChange={state.updateCircularWeldDraft}
    onCommit={state.commitCircularWeld} onCancel={state.cancelCircularWeld} onReselect={state.reselectCircularWeld} />;
}

/** Keep the existing overlay group together, loading it only for assembly documents. */
export function AssemblyOverlays(): React.JSX.Element {
  return <>
    <PlaceComponentPopover />
    <StandardPartPicker />
    <ExplodePopover />
    <ReplacementPopover />
    <BoltedJointPopover />
    <FrameSlotFasteningPopover />
    <BoltedJointRebuildPanel />
    <FilletWeldPopover />
    <CircularWeldOverlay />
    <AssemblyMotionControls />
    <AssemblyInterferencePanel />
    <FrameJointCheckPanel />
    <FrameJointBracketPopover />
    <MemberStretchPopover />
  </>;
}
