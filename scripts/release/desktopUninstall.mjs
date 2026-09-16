import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';

/** Move owned files aside first; preserve all unknown files, including drawings saved in the app folder. */
export function createDesktopUninstallScript(inputNames) {
  if (!Array.isArray(inputNames) || inputNames.length === 0 || inputNames.length > 20_000) throw new Error('Missing packaged file list');
  const names = [...inputNames].sort(), folded = new Set(), directories = new Set();
  for (const name of names) {
    offlineAssetUrl(name);
    if (name.length > 512 || /[<>"|*$]/u.test(name) || folded.has(name.toLowerCase())
      || name.split('/').some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
      throw new Error('Unsafe Windows package file name');
    }
    folded.add(name.toLowerCase());
    const parts = name.split('/'); parts.pop();
    while (parts.length > 0) { directories.add(parts.join('/')); parts.pop(); }
  }
  if (!names.includes('PointerCAD.exe') || !names.includes('resources/app/desktop-package.json')) throw new Error('Incomplete Windows package');
  const path = name => name.replaceAll('/', '\\');
  const dirs = [...directories].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  const lines = ['!macro customRemoveFiles', '  Var /GLOBAL pcadRemovalBackup',
    '  GetTempFileName $pcadRemovalBackup "$INSTDIR"', '  Delete "$pcadRemovalBackup"', '  ClearErrors',
    '  CreateDirectory "$pcadRemovalBackup"', '  IfErrors pcadRemovalFailed'];
  for (const dir of dirs) lines.push('  CreateDirectory "$pcadRemovalBackup\\' + path(dir) + '"');
  for (const name of names) lines.push('  IfFileExists "$INSTDIR\\' + path(name) + '" 0 +4', '  ClearErrors',
    '  Rename "$INSTDIR\\' + path(name) + '" "$pcadRemovalBackup\\' + path(name) + '"', '  IfErrors pcadRemovalRestore');
  for (const name of names) lines.push('  Delete "$pcadRemovalBackup\\' + path(name) + '"');
  for (const dir of [...dirs].reverse()) lines.push('  RMDir "$pcadRemovalBackup\\' + path(dir) + '"');
  lines.push('  RMDir "$pcadRemovalBackup"', '  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"',
    '  SetOutPath $TEMP');
  for (const dir of [...dirs].reverse()) lines.push('  RMDir "$INSTDIR\\' + path(dir) + '"');
  lines.push('  RMDir "$INSTDIR"', '  Goto pcadRemovalDone', 'pcadRemovalRestore:');
  for (const name of [...names].reverse()) lines.push('  IfFileExists "$pcadRemovalBackup\\' + path(name) + '" 0 +2',
    '  Rename "$pcadRemovalBackup\\' + path(name) + '" "$INSTDIR\\' + path(name) + '"');
  lines.push('pcadRemovalFailed:', '  SetErrorLevel 5',
    '  Abort "使用中のファイルを移動できなかったため、削除を中断しました。保存文書は削除していません。戻せずに残ったファイルの控え: $pcadRemovalBackup"',
    'pcadRemovalDone:', '!macroend', '');
  return lines.join('\n');
}
