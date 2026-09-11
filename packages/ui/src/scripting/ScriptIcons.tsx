import { CubeIcon, GearIcon, PlotPointIcon, type IconComponent, type IconProps } from '../shell/icons.js';
import type { ScriptIcon } from '@pointercad/model/scripting';
export function ScriptCodeIcon({ size = 16, className }: IconProps): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 4-4 4 4 4M11 4l4 4-4 4M9 2 7 14" /></svg>;
}
function ScriptLineIcon({ size = 16, className }: IconProps): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 13 10-10" /><circle cx="3" cy="13" r="1.5" /><circle cx="13" cy="3" r="1.5" /></svg>;
}
export const SCRIPT_ICON_COMPONENTS: Readonly<Record<ScriptIcon, IconComponent>> = { code: ScriptCodeIcon, point: PlotPointIcon, line: ScriptLineIcon, box: CubeIcon, gear: GearIcon };
