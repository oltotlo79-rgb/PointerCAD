/** Chapter routing only. Neither a route nor a chapter proves implementation or release readiness. */
export interface FeatureHelpBinding {
  readonly featureId: string;
  readonly topicIds: readonly string[];
  /** Explicitly retain missing documentation instead of assigning an unrelated existing chapter. */
  readonly pending?: string;
  /** An explicit requirement merger, not a second implementation counted as complete. */
  readonly mergedInto?: string;
}

function chapters(ids: readonly number[], ...topicIds: readonly string[]): readonly FeatureHelpBinding[] {
  return ids.map(id => ({ featureId: `FR-${id}`, topicIds }));
}

export const FEATURE_HELP_BINDINGS: readonly FeatureHelpBinding[] = [
  ...chapters([101, 102, 103, 104, 105, 108], 'viewport'),
  ...chapters([106, 112], 'selection', 'select-subshape'),
  ...chapters([107], 'snap'), ...chapters([109, 111], 'section-view'),
  ...chapters([110], 'tracking'), ...chapters([113], 'named-view', 'drawing-views'),
  ...chapters([201, 202, 203, 204], 'numeric-input', 'math-input'),
  ...chapters([205], 'numeric-input', 'math-input', 'units'),
  ...chapters([206, 207, 209], 'parameters'), ...chapters([208], 'command-line'),
  ...chapters([210, 211], 'math-input', 'function-curve', 'function-surface', 'function-point'),
  ...chapters([301, 302, 303, 304, 305, 306, 307, 308], 'sketch-tools', 'numeric-input'),
  ...chapters([309, 310], 'face-and-color'), ...chapters([311], 'edit-sketch'),
  ...chapters([312], 'face-and-color', 'shape-edit'), ...chapters([313, 333], 'constraints'),
  ...chapters([314, 315, 316, 326, 327], 'shapes'), ...chapters([317], 'spline'),
  ...chapters([318], 'ellipse'), ...chapters([319], 'text-sketch', 'text-outline'),
  ...chapters([320], 'sketch-tools'), ...chapters([321, 322], 'edit-curves'),
  ...chapters([323], 'sketch-fillet'), ...chapters([324], 'copy-array'),
  ...chapters([325], 'project-intersect'), ...chapters([328], 'work-plane-custom'),
  ...chapters([329], 'reference-geometry'), ...chapters([330], 'work-plane', 'sketch-tools'),
  ...chapters([331], 'origin'), ...chapters([332], 'canvas'),
  ...chapters([334], 'function-curve'), ...chapters([335], 'function-point'),
  ...chapters([336], 'sketch-intersections'),
  ...chapters([401, 402, 403, 415, 416], 'solid-basics'),
  ...chapters([404], 'solid-combine'), ...chapters([405, 422], 'hole'),
  ...chapters([406, 423], 'thread'), ...chapters([407, 408, 426], 'fillet-chamfer'),
  ...chapters([409, 413, 417, 418, 419, 420, 421, 424, 428, 433], 'shape-edit'),
  ...chapters([410, 430], 'ruled-loft'), ...chapters([411, 412, 425], 'pattern'),
  ...chapters([414], 'spring'), ...chapters([427], 'solid-basics', 'export'),
  ...chapters([429], 'primitive'), ...chapters([431], 'sphere-grid'), ...chapters([432], 'cut'),
  ...chapters([434], 'sheet-metal', 'sheet-metal-flange', 'sheet-metal-bend-relief', 'sheet-metal-flat'),
  ...chapters([435], 'ruled-loft', 'shape-edit'), ...chapters([436], 'function-surface'),
  ...chapters([501, 502, 503, 504, 505], 'feature-tree'), ...chapters([506, 507], 'timeline'),
  ...chapters([508], 'history-notes'), ...chapters([509], 'document-diff'),
  ...chapters([601], 'assembly', 'assembly-place'), ...chapters([602, 606], 'assembly-place'),
  ...chapters([603, 604, 609], 'mate'), ...chapters([605], 'assembly', 'appearance-color'),
  ...chapters([607, 615], 'interference'), ...chapters([608, 618], 'joint'),
  ...chapters([610, 617], 'explode'), ...chapters([611], 'bom', 'drawing-bom'),
  ...chapters([612, 616], 'standard-parts'), ...chapters([613, 614], 'replace-subassembly'),
  ...chapters([701, 703], 'drawing-scale'), ...chapters([702, 704, 708, 714, 715], 'drawing-views'),
  ...chapters([705], 'dimension-auto'), ...chapters([706, 707, 717, 722], 'dimension'),
  ...chapters([709], 'drawing-export'), ...chapters([710], 'drawing'),
  ...chapters([711], 'drawing-note'), ...chapters([712], 'drawing-section', 'drawing-views'),
  ...chapters([713], 'drawing-section'), ...chapters([716], 'dimension', 'dimension-series'),
  ...chapters([718], 'dimension', 'surface-finish'), ...chapters([719], 'dimension-tolerance'),
  ...chapters([720], 'gdt'), ...chapters([721], 'surface-finish'),
  ...chapters([723], 'drawing-scale', 'dimension-tolerance'),
  ...chapters([724], 'dimension', 'dimension-arrange'),
  ...chapters([725], 'drawing-table', 'template'), ...chapters([726, 728], 'drawing-bom'),
  ...chapters([727], 'welding'), ...chapters([729], 'drawing-table'),
  ...chapters([730], 'drawing-layer', 'edit-sketch'),
  ...chapters([801, 805, 806, 807], 'save-and-open'), ...chapters([802], 'import'),
  ...chapters([803, 804], 'export'), ...chapters([808, 809, 813], 'dxf', 'import', 'drawing-export'),
  ...chapters([810, 812], 'print-save-as', 'drawing-export'), ...chapters([811], 'units'),
  ...chapters([814], 'template', 'units'), ...chapters([815], 'print-check'),
  ...chapters([816], 'cam'), ...chapters([817], 'dxf'),
  ...chapters([901, 902, 903, 910], 'help-reader'),
  ...chapters([904, 905], 'help-reader', 'sketch-tools', 'numeric-input'),
  ...chapters([906], 'tutorial'), ...chapters([907], 'shortcuts'),
  ...chapters([908, 909], 'display-settings'), ...chapters([911], 'radial-menu'),
  { featureId: 'FR-1001', topicIds: [], pending: 'P13: 公開版の導入先と対応環境の説明が未作成' },
  ...chapters([1002], 'local-data'),
  ...chapters([1003], 'startup-checks'),
  ...chapters([1004], 'offline-use'),
  ...chapters([1101], 'mass-properties'), ...chapters([1102], 'measure'),
  { featureId: 'FR-1103', topicIds: ['appearance-color', 'appearance-pattern', 'appearance-glass'], mergedInto: 'FR-1107' },
  ...chapters([1104], 'display-settings', 'shortcuts', 'template', 'save-and-open'),
  ...chapters([1105], 'feature-tree', 'assembly'), ...chapters([1106, 1110], 'appearance-color'),
  ...chapters([1107, 1109], 'appearance-color', 'appearance-pattern', 'appearance-glass'),
  ...chapters([1108], 'appearance-pattern'), ...chapters([1111], 'scripts', 'script-api', 'script-tools'),
  ...chapters([1112], 'strength'),
];
