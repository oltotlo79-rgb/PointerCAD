import { FILE_KIND_SPECS, type SaveFileKind } from '../file/fileContracts.js';
import { DEFAULT_DISPLAY_SETTINGS, type PersistedDisplaySettings } from '../settings/settings.js';
import { toolDefaultEntries } from '../settings/numericToolDefaults.js';
import { t } from '../i18n/t.js';

/** Keys are checked against the persisted settings type, including optional and internal flags. */
export const SETTINGS_HELP_BINDINGS = {
  theme: ['display-settings'], uiScale: ['display-settings'],
  cameraControls: ['display-settings', 'viewport'], viewControls: ['display-settings', 'viewport'],
  // マウスの戻る・進む・中ボタンのダブルクリックの命令(B-08e)と放射メニューの中身(B-08f)は、キーと同じ操作の割り当ての窓の章。
  shortcutAssignments: ['shortcuts'], mouseButtonCommands: ['shortcuts'], radialCommands: ['shortcuts'],
  numericToolDefaults: ['display-settings', 'template'],
  autoSaveIntervalMs: ['save-and-open', 'display-settings'],
  // 切断の一覧の定尺・切断代(J-01)は、規格部品の窓の切断の一覧の章。
  stockCutting: ['standard-parts'],
  selectionModifier: ['select-subshape', 'shortcuts'],
  // 吸着を一時止める修飾キー(B-09 3-2)は、吸着の章と、操作の割り当ての窓の章。
  snapPauseModifier: ['snap', 'shortcuts'],
  // 吸着の幅(配置の補助 P-D)も、吸着の章と操作の割り当ての窓の章。
  snapRadius: ['snap', 'shortcuts'],
  // 方眼の幅と数(配置の補助 P-C)は、表示の設定の章と吸着の章。
  grid: ['display-settings', 'snap'],
  trackAngleStep: ['tracking'], lengthUnit: ['units'], selectionFilter: ['select-subshape'],
  inferConstraints: ['constraints'], timelineHintSeen: ['timeline'], tutorialCompleted: ['tutorial'], screenTourSeen: ['tutorial'],
} satisfies Readonly<Record<keyof PersistedDisplaySettings, readonly string[]>>;

/** DWG is deliberately absent: its conversion instructions are not an implemented export. */
export const OUTPUT_HELP_BINDINGS = {
  pcad: ['save-and-open'], pcada: ['assembly', 'save-and-open'], pcadd: ['drawing-export'],
  csv: ['parameters'],
  pcadt: ['template'], pcadscript: ['script-tools'], zip: ['joint', 'explode'],
  // 操作の割り当ての設定ファイル(B-09 3-1)は、操作の割り当ての窓の章。
  pcadinput: ['shortcuts'],
  step: ['export', 'cam'], stl: ['export', 'print-check', 'cam'], '3mf': ['export', 'cam'],
  obj: ['export'], glb: ['export'], dxf: ['dxf', 'drawing-export', 'sheet-metal-flat'],
  svg: ['drawing-export', 'sheet-metal-flat'], pdf: ['drawing-export'],
  png: ['drawing-export', 'explode'], jpg: ['drawing-export'],
} satisfies Readonly<Record<SaveFileKind, readonly string[]>>;

export interface SupplementaryHelpEntry {
  readonly id: string;
  readonly topicIds: readonly string[];
  readonly chapterPaths: readonly string[];
}
export interface SupplementaryHelpCoverage {
  readonly settings: readonly SupplementaryHelpEntry[];
  readonly outputs: readonly (SupplementaryHelpEntry & { readonly extensions: readonly string[] })[];
  readonly toolDefaults: readonly (SupplementaryHelpEntry & {
    readonly title: string;
    readonly fields: readonly { readonly key: string; readonly label: string; readonly hint: string; readonly unit: string }[];
  })[];
  readonly contentCertified: false;
}

/** The catalog follows the same keys and field descriptions used by the real settings and save dialogs. */
export function buildSupplementaryHelpCoverage(
  topics: readonly { readonly id: string; readonly path: string }[],
): SupplementaryHelpCoverage {
  const byTopic = new Map(topics.map(topic => [topic.id, topic.path]));
  if (byTopic.size !== topics.length) throw new Error('Duplicate help topics');
  const entry = (id: string, topicIds: readonly string[]): SupplementaryHelpEntry => {
    if (topicIds.length === 0 || new Set(topicIds).size !== topicIds.length) throw new Error(`Empty or duplicate help binding: ${id}`);
    const chapterPaths = topicIds.map(topicId => {
      const path = byTopic.get(topicId);
      if (path === undefined || path.trim() === '') throw new Error(`Missing help chapter: ${id}/${topicId}`);
      return path;
    });
    return Object.freeze({ id, topicIds: Object.freeze([...topicIds]), chapterPaths: Object.freeze(chapterPaths) });
  };
  for (const key of Object.keys(DEFAULT_DISPLAY_SETTINGS)) {
    if (!Object.hasOwn(SETTINGS_HELP_BINDINGS, key)) throw new Error(`Undocumented setting: ${key}`);
  }
  const settings = Object.entries(SETTINGS_HELP_BINDINGS).map(([id, topicIds]) => entry(id, topicIds));
  const outputs = Object.entries(OUTPUT_HELP_BINDINGS).map(([id, topicIds]) => {
    const spec = FILE_KIND_SPECS[id as SaveFileKind];
    const extensions = Object.values(spec.accept).flat();
    if (extensions.length === 0) throw new Error(`Output has no file extension: ${id}`);
    return Object.freeze({ ...entry(id, topicIds), extensions: Object.freeze(extensions) });
  });
  const defaults = toolDefaultEntries(), used = new Set<string>();
  const toolDefaults = defaults.map(item => {
    if (used.has(item.id) || item.fields.length === 0) throw new Error(`Duplicate or empty tool default: ${item.id}`);
    used.add(item.id);
    const title = t(item.titleKey);
    if (typeof title !== 'string' || title.trim() === '') throw new Error(`Missing default title: ${item.id}`);
    const fields = item.fields.map(field => {
      const label = t(field.labelKey), hint = t(field.tooltipKey);
      if (typeof label !== 'string' || label.trim() === '' || typeof hint !== 'string' || hint.trim() === '') {
        throw new Error(`Missing field guidance: ${item.id}/${field.key}`);
      }
      return Object.freeze({ key: field.key, label, hint, unit: field.unit });
    });
    return Object.freeze({ ...entry(item.id, ['display-settings']), title, fields: Object.freeze(fields) });
  });
  return Object.freeze({ settings: Object.freeze(settings), outputs: Object.freeze(outputs),
    toolDefaults: Object.freeze(toolDefaults), contentCertified: false as const });
}
