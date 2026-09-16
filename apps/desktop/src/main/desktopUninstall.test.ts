import { describe, expect, it } from 'vitest';
import { createDesktopUninstallScript } from '../../../../scripts/release/desktopUninstall.mjs';

const names = ['PointerCAD.exe', 'resources/app/desktop-package.json', 'resources/app/dist/renderer/index.html'];

describe('削除の対象を実際に導入するファイルへ限定する', () => {
  it('実在一覧のファイルを移動し、未知の文書や保存先を丸ごと削除しない', () => {
    const script = createDesktopUninstallScript(names);
    expect(script).toContain('Rename "$INSTDIR\\PointerCAD.exe" "$pcadRemovalBackup\\PointerCAD.exe"');
    expect(script).toContain('RMDir "$INSTDIR\\resources\\app\\dist\\renderer"');
    expect(script).not.toMatch(/RMDir\s+\/r/iu);
    expect(script).not.toContain('$APPDATA');
    expect(script).not.toContain('*.pcad');
    expect(script).not.toContain('KillProcess');
    expect(script.indexOf('pcadRemovalRestore:')).toBeGreaterThan(script.indexOf('Goto pcadRemovalDone'));
    expect(script).toContain('Rename "$pcadRemovalBackup\\PointerCAD.exe" "$INSTDIR\\PointerCAD.exe"');
  });
  it('列挙順が変わっても削除範囲と処理順を同じにする', () => {
    expect(createDesktopUninstallScript([...names].reverse())).toBe(createDesktopUninstallScript(names));
  });
  it.each(['../document.pcad', 'resources/../../document.pcad', 'resources/$APPDATA/file', 'resources/name".js',
    'resources/*.pcad', 'resources/CON.txt', 'resources/aux', 'resources/file:stream', 'resources/a?b',
    'resources/a\\b', 'resources/a\nb'])('削除対象へ危険な名前 %s が混ざると作成前に拒否する', name => {
    expect(() => createDesktopUninstallScript([...names, name])).toThrow();
  });
  it('大文字小文字の重複と実行ファイルの欠落を拒否する', () => {
    expect(() => createDesktopUninstallScript([...names, 'pointercad.EXE'])).toThrow();
    expect(() => createDesktopUninstallScript(names.slice(1))).toThrow();
  });
});
