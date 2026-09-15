import { NewFileIcon, OpenFileIcon, SaveIcon } from '../icons.js';
import type { ButtonEntry } from './toolbarShared.js';

/**
 * ファイルの操作(FR-806)。図柄だけのボタンで、名前は読み上げ名とツールチップが担う。
 *
 * ボタンは 3 つのまま増やさない(§0.a-0.15)。「名前を付けて保存」は保存ボタンを
 * Shift を押しながら押すか、Ctrl+Shift+S で行う。その旨はツールチップに書く(NFR-UX-7)。
 */
export const FILE_ACTIONS = [
  {
    id: 'new',
    labelKey: 'toolbar.file.new',
    tooltipKey: 'toolbar.file.newTooltip',
    Icon: NewFileIcon,
  },
  {
    id: 'open',
    labelKey: 'toolbar.file.open',
    tooltipKey: 'toolbar.file.openTooltip',
    Icon: OpenFileIcon,
  },
  {
    id: 'save',
    labelKey: 'toolbar.file.save',
    tooltipKey: 'toolbar.file.saveTooltip',
    Icon: SaveIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly id: FileActionId })[];

/** ファイルのボタン 3 つ。 */
export type FileActionId = 'new' | 'open' | 'save';
