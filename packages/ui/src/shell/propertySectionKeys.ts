export type PropertySectionKind = 'component' | 'mate' | 'joint' | 'interference' | 'bom';

export function propertySectionKey(kind: 'interference' | 'bom'): string;
export function propertySectionKey(kind: 'component' | 'mate' | 'joint', id: string): string;
/** 種類を必ず接頭辞にし、異なる節が同じReact keyを持てないようにする。 */
export function propertySectionKey(kind: PropertySectionKind, id?: string): string {
  return kind === 'interference' || kind === 'bom' ? kind : `${kind}:${id ?? ''}`;
}

export const DRAWING_PROPERTY_KINDS = ['sheet', 'view', 'dimension', 'annotation', 'table', 'layer'] as const;
export type DrawingPropertyKind = typeof DRAWING_PROPERTY_KINDS[number];

/** 文書・要素IDに区切り文字が含まれても種類と衝突しない。 */
export function drawingPropertySectionKey(kind: DrawingPropertyKind, documentId: string, elementId = ''): string {
  return JSON.stringify(['drawing-property', kind, documentId, elementId]);
}
