import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ToolMenu } from '../shell/menus/ToolMenu.js';
import type { ToolMenuItem } from '../shell/menus/menuItem.js';
import { openScriptPanel, runScript } from './scriptActions.js';
import { scriptCommandId } from './scriptLibrary.js';
import { ScriptCodeIcon, SCRIPT_ICON_COMPONENTS } from './ScriptIcons.js';

export function ScriptToolsMenu(): React.JSX.Element {
  const tools = useAppStore(state => state.scriptLibrary);
  const items: readonly ToolMenuItem<string>[] = [
    { id: 'script-editor', labelKey: 'script.title', tooltipKey: 'script.tooltip', Icon: ScriptCodeIcon },
    ...tools.map(tool => ({ id: scriptCommandId(tool.scriptId), label: tool.name, labelKey: 'script.tools', tooltipKey: 'script.runTooltip', Icon: SCRIPT_ICON_COMPONENTS[tool.icon] } satisfies ToolMenuItem<string>)),
  ];
  return <span data-help-topic="scripts" title={t('script.tooltip')}><ToolMenu items={items} groupLabelKey="script.title" groupTooltipKey="script.tooltip"
    GroupIcon={ScriptCodeIcon} activeTool="" showPressed={false} onChoose={id => {
      if (id === 'script-editor') { openScriptPanel(); return; }
      const tool = tools.find(item => scriptCommandId(item.scriptId) === id); if (tool !== undefined) void runScript(tool);
    }} /></span>;
}
