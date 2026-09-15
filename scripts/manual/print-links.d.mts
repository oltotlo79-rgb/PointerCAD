export interface ManualPrintManifest {
  readonly volumes: readonly { readonly id: string; readonly title: string }[];
  readonly chapters: readonly { readonly id: string; readonly title: string; readonly volumeId: string }[];
}
export type ManualPrintLink =
  | { readonly kind: 'anchor' | 'external'; readonly href: string }
  | { readonly kind: 'reference'; readonly text: string };
export function createManualPrintLinkResolver(manifest: ManualPrintManifest, volumeId: string): (href: string) => ManualPrintLink;
