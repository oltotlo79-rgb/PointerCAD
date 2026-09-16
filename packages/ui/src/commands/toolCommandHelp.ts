import { TOOLBAR_COMMAND_CATALOG } from './toolbarCommandCatalog.js';

const TOOL_GROUPS = new Set(['sketch', 'shape', 'edit', 'solidCreate', 'solidMachining', 'look', 'reference']);

/** Use the command's chapter for both new input and editing an existing feature. */
export function toolCommandHelpTopic(toolId: string): string | undefined {
  return TOOLBAR_COMMAND_CATALOG.find(item => TOOL_GROUPS.has(item.group) && item.sourceId === toolId)?.helpTopic;
}
