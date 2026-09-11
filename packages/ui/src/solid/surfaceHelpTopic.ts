/** 曲面の作成中と再編集中で、同じ操作説明へF1をつなぐ。 */
export function surfaceHelpTopic(kind: string): string | undefined {
  if (kind === 'loft' || kind === 'ruled') return 'ruled-loft';
  return kind === 'sweep' ? 'shape-edit' : undefined;
}
