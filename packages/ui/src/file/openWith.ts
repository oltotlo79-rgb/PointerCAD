/** 加工先の種類と固定URL。画面・Desktopが同じ表を使い、形や名前はURLへ含めない。 */
export type CamFormat = 'step' | 'stl' | '3mf';
export type CamTool = 'kiri' | 'prusa';
export type OpenWithAction = CamTool | 'default' | 'help';
export interface ExportHandoff { readonly format: CamFormat; readonly token: string | null; }
export interface ExportReceipt { readonly token: string | null; }

export const CAM_TOOL_URLS: Readonly<Record<CamTool, string>> = {
  kiri: 'https://grid.space/kiri/',
  prusa: 'https://www.prusa3d.com/p/prusaslicer/',
};
/** 同梱手順から開く公式文書も完全一致に限定する。任意クエリやパスを足せない。 */
const CAM_HELP_URLS: readonly string[] = [
  'https://docs.grid.space/kiri-moto/interface/',
  'https://help.prusa3d.com/article/first-print-with-prusaslicer-2-9_1753',
  'https://www.freecad.org/features.php',
  'https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/CAM_Profile.md',
  'https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/CAM_Post.md',
  'https://www.autodesk.com/solutions/free-cam-software',
  'https://help.autodesk.com/view/fusion360/ENU/?guid=MFG-CREATE-SETUP',
  'https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-BEC5DEA9-AC3E-4FA8-998E-4AE8CD0D0B1E',
];
export function isAllowedCamUrl(url: string): boolean {
  return Object.values(CAM_TOOL_URLS).includes(url) || CAM_HELP_URLS.includes(url);
}
export function isCamFormat(value: unknown): value is CamFormat {
  return value === 'step' || value === 'stl' || value === '3mf';
}
export function isCamTool(value: unknown): value is CamTool { return value === 'kiri' || value === 'prusa'; }
export function openWith(format: string, desktop: boolean): readonly OpenWithAction[] {
  if (!isCamFormat(format)) return [];
  const actions: readonly OpenWithAction[] = format === 'step' ? ['help'] : ['kiri', 'prusa', 'help'];
  return desktop ? ['default', ...actions] : actions;
}

/** クリックからだけ呼ぶ。引数は固定表の種類だけで、部品データを受け取らない。 */
export function openCamWebsite(tool: CamTool, open: (url: string, target: string, features: string) => unknown): void {
  open(CAM_TOOL_URLS[tool], '_blank', 'noopener,noreferrer');
}
