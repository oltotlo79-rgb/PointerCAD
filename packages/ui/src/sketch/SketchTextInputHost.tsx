import { useAppStore } from '../store/useAppStore.js';
import { SketchTextPopover } from './SketchTextPopover.js';

export function SketchTextInputHost(): React.JSX.Element | null {
  const input = useAppStore((state) => state.numericInput);
  const anchor = useAppStore((state) => state.numericInputAnchor);
  const plane = useAppStore((state) => state.workPlane);
  if (input?.toolId !== 'text' || input.textOrigin === undefined || anchor === null || plane === null) return null;
  return <SketchTextPopover origin={input.textOrigin} plane={plane} anchor={anchor} />;
}
