import { HELP_TOPICS, type HelpTopic } from './topics.js';

export interface ManualVolume {
  readonly id: string;
  readonly title: string;
  readonly topics: readonly string[];
}
export interface ManualChapter extends HelpTopic { readonly volumeId: string; readonly order: number }

/** Ordering only: chapter titles and sources remain in the single help catalog. */
export const MANUAL_VOLUMES: readonly ManualVolume[] = [
  { id: 'getting-started', title: '導入・画面操作・ファイル', topics: [
    'help-reader', 'offline-use', 'local-data', 'startup-checks', 'tutorial', 'shortcuts', 'viewport', 'units', 'save-and-open', 'template', 'import', 'export', 'dxf', 'print-save-as',
  ] },
  { id: 'sketch-and-functions', title: 'スケッチ・座標・関数', topics: [
    'numeric-input', 'math-input', 'parameters', 'work-plane', 'work-plane-custom', 'reference-geometry', 'origin',
    'sketch-tools', 'sketch-intersections', 'shapes', 'ellipse', 'spline', 'text-sketch', 'function-curve', 'function-surface',
    'function-point', 'snap', 'tracking', 'command-line', 'face-and-color', 'edit-sketch', 'edit-curves', 'constraints',
    'sketch-fillet', 'copy-array', 'project-intersect', 'canvas',
  ] },
  { id: 'solid-and-measurement', title: '立体・外観・測定', topics: [
    'solid-basics', 'solid-combine', 'select-subshape', 'primitive', 'hole', 'thread', 'fillet-chamfer', 'pattern', 'spring',
    'sphere-grid', 'ruled-loft', 'shape-edit', 'cut', 'appearance-color', 'appearance-pattern', 'appearance-glass',
    'measure', 'mass-properties', 'strength', 'print-check',
  ] },
  { id: 'assembly', title: 'アセンブリ・部品表', topics: [
    'assembly', 'assembly-place', 'standard-parts', 'mate', 'joint', 'interference', 'replace-subassembly', 'explode', 'bom',
  ] },
  { id: 'drawing', title: '図面・寸法・製図記号', topics: [
    'drawing', 'drawing-scale', 'drawing-views', 'drawing-section', 'dimension', 'dimension-auto', 'dimension-series',
    'dimension-arrange', 'dimension-tolerance', 'gdt', 'surface-finish', 'welding', 'drawing-note', 'drawing-bom',
    'drawing-table', 'drawing-layer', 'text-outline', 'drawing-export',
  ] },
  { id: 'sheet-and-scripting', title: '板金・自動作図・加工連携', topics: [
    'sheet-metal', 'sheet-metal-flange', 'sheet-metal-bend-relief', 'sheet-metal-flat', 'scripts', 'script-api', 'script-tools', 'cam',
  ] },
  { id: 'settings-and-history', title: '設定・履歴・表示', topics: [
    'feature-tree', 'history-notes', 'document-diff', 'timeline', 'display-settings', 'radial-menu', 'selection', 'named-view', 'section-view', 'font-licenses',
  ] },
];

/** Missing, duplicate, unsafe or unassigned chapters fail instead of silently disappearing from a volume. */
export function buildManualManifest(topics: readonly HelpTopic[], volumes: readonly ManualVolume[]): readonly ManualChapter[] {
  const byId = new Map<string, HelpTopic>(), used = new Set<string>(), volumeIds = new Set<string>();
  const chapters: ManualChapter[] = [];
  for (const topic of topics) {
    if (!/^[a-z][a-z0-9-]*$/u.test(topic.id) || byId.has(topic.id) || topic.title.trim() === ''
      || topic.path !== `docs/ja/${topic.id}.md`) throw new Error(`Invalid help chapter: ${topic.id}`);
    byId.set(topic.id, topic);
  }
  for (const volume of volumes) {
    if (!/^[a-z][a-z0-9-]*$/u.test(volume.id) || volumeIds.has(volume.id) || volume.title.trim() === '' || volume.topics.length === 0) {
      throw new Error(`Invalid manual volume: ${volume.id}`);
    }
    volumeIds.add(volume.id);
    for (const id of volume.topics) {
      const topic = byId.get(id);
      if (!topic || used.has(id)) throw new Error(`Missing or duplicate manual chapter: ${id}`);
      used.add(id); chapters.push(Object.freeze({ ...topic, volumeId: volume.id, order: chapters.length }));
    }
  }
  const missing = topics.filter(topic => !used.has(topic.id));
  if (missing.length) throw new Error(`Unassigned manual chapters: ${missing.map(topic => topic.id).join(', ')}`);
  return Object.freeze(chapters);
}

export const MANUAL_CHAPTERS = buildManualManifest(HELP_TOPICS, MANUAL_VOLUMES);
