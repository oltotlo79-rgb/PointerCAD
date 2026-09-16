export interface NativeControlSite {
  readonly path: string;
  readonly line: number;
  readonly tag: 'input' | 'select' | 'textarea' | 'button';
  readonly hidden: boolean;
  readonly description: 'literal' | 'expression' | 'missing';
  readonly titleSource: 'control' | 'label' | null;
  readonly sourceExpression: string | null;
  readonly hasSpread: boolean;
}
export interface NativeControlInventory {
  readonly scope: 'native-jsx-controls';
  readonly contentCertified: false;
  readonly sources: readonly string[];
  readonly controls: readonly NativeControlSite[];
  readonly missing: readonly NativeControlSite[];
  readonly requiresRenderedCheck: readonly NativeControlSite[];
}
export function buildNativeControlInventory(sources: readonly { readonly path: string; readonly source: string }[]): NativeControlInventory;
export function assertNativeControlDescriptions(inventory: NativeControlInventory): void;
