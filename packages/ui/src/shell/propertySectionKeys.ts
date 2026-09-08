export type PropertySectionKind = 'component' | 'mate' | 'joint' | 'interference' | 'bom';

export function propertySectionKey(kind: 'interference' | 'bom'): string;
export function propertySectionKey(kind: 'component' | 'mate' | 'joint', id: string): string;
/** 種類を必ず接頭辞にし、異なる節が同じReact keyを持てないようにする。 */
export function propertySectionKey(kind: PropertySectionKind, id?: string): string {
  return kind === 'interference' || kind === 'bom' ? kind : `${kind}:${id ?? ''}`;
}
