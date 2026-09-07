import { findComponent, type AssemblyDocument } from '@pointercad/model';
import { t } from '../../i18n/t.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  deleteSelectedComponents,
  duplicateSelectedComponent,
  startPlaceComponent,
  toggleSelectedFixed,
  toggleSelectedVisible,
} from '../../assembly/placeComponentActions.js';
import { CopyToolIcon, CubeIcon, EmptyBoxIcon, FixConstraintIcon, LayersIcon } from '../icons.js';
import type { ToolMenuItem } from '../toolbarMenus.js';
import { ToolMenu } from './ToolMenu.js';

export type AssemblyMenuActionId = 'duplicate' | 'delete' | 'toggleFixed' | 'toggleVisible';

export const ASSEMBLY_MENU_ITEMS: readonly ToolMenuItem<AssemblyMenuActionId>[] = [
  { id: 'duplicate', labelKey: 'assembly.tool.duplicate', tooltipKey: 'assembly.tool.duplicateTooltip', Icon: CopyToolIcon },
  { id: 'delete', labelKey: 'assembly.tool.delete', tooltipKey: 'assembly.tool.deleteTooltip', Icon: EmptyBoxIcon },
  { id: 'toggleFixed', labelKey: 'assembly.tool.toggleFixed', tooltipKey: 'assembly.tool.toggleFixedTooltip', Icon: FixConstraintIcon },
  { id: 'toggleVisible', labelKey: 'assembly.tool.toggleVisible', tooltipKey: 'assembly.tool.toggleVisibleTooltip', Icon: LayersIcon },
];

/** 部品1個を対象にする操作の押せる条件と、断る理由の正本。 */
export function assemblyActionReadiness(
  assembly: AssemblyDocument,
  selection: readonly string[],
): EditToolReadiness {
  const components = selection.filter((id) => findComponent(assembly, id) !== undefined);
  return components.length === 1
    ? { ready: true, reasonKey: null }
    : { ready: false, reasonKey: 'assembly.tool.selectOneComponentReason' };
}

export function AssemblyGroup(): React.JSX.Element | null {
  const assembly = useAppStore((state) => state.assembly);
  const selection = useAppStore((state) => state.selection);
  const placement = useAppStore((state) => state.assemblyPlacement);
  if (assembly === null) return null;
  const readiness = assemblyActionReadiness(assembly, selection);
  const placeReady = placement === null;

  const choose = (id: AssemblyMenuActionId): void => {
    if (!assemblyActionReadiness(assembly, useAppStore.getState().selection).ready) return;
    switch (id) {
      case 'duplicate': duplicateSelectedComponent(); return;
      case 'delete': deleteSelectedComponents(); return;
      case 'toggleFixed': toggleSelectedFixed(); return;
      case 'toggleVisible': toggleSelectedVisible(); return;
    }
  };

  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('assembly.menu.build')}>
      <span className="pcad-toolbar__group-label" title={t('assembly.menu.buildTooltip')}>
        {t('assembly.menu.build')}
      </span>
      <div className="pcad-segmented">
        <button
          type="button"
          className="pcad-button pcad-button--collapsible"
          title={t(placeReady ? 'assembly.tool.placePartTooltip' : 'assembly.tool.placementBusy')}
          aria-label={t('assembly.tool.placePart')}
          aria-disabled={!placeReady}
          onClick={() => { if (placeReady) void startPlaceComponent(); }}
        >
          <CubeIcon />
          <span className="pcad-button__label">{t('assembly.tool.placePart')}</span>
        </button>
        <ToolMenu
          items={ASSEMBLY_MENU_ITEMS}
          groupLabelKey="assembly.menu.component"
          groupTooltipKey="assembly.menu.componentTooltip"
          GroupIcon={CopyToolIcon}
          activeTool=""
          showPressed={false}
          readinessOf={() => readiness}
          onChoose={choose}
        />
      </div>
    </div>
  );
}
