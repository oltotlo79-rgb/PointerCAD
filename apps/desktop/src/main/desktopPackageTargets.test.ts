import { describe, expect, it } from 'vitest';
import { Arch, Platform } from 'electron-builder';
import { desktopPackagePlan, verifyDesktopPackageArtifacts } from '../../../../scripts/release/desktopPackageTargets.mjs';

const version = '1.0.0';
const setup = 'PointerCAD-1.0.0-windows-x64-setup.exe';
const portable = 'PointerCAD-1.0.0-windows-x64-portable.exe';
const asset = (name: string) => ({ name, bytes: 123, sha256: 'a'.repeat(64) });

describe('Windowsポータブル版を配布1ファイルに揃える', () => {
  it('採用した配布部品へインストーラーとポータブルの両方をx64で渡せる', () => {
    const plan = desktopPackagePlan('win32', version);
    const targets = Platform.WINDOWS.createTarget(plan.map(item => item.target), Arch.x64);
    expect([...targets.keys()]).toEqual([Platform.WINDOWS]);
    expect([...targets.get(Platform.WINDOWS)?.entries() ?? []]).toEqual([[Arch.x64, ['nsis', 'portable']]]);
    expect(plan.map(item => item.name)).toEqual([setup, portable]);
  });
  it('各形式の1ファイルを記録し、生成しただけでは起動確認済みにしない', () => {
    expect(verifyDesktopPackageArtifacts('win32', version, [asset(portable), asset(setup)])).toEqual([
      { target: 'nsis', files: [setup], launchVerified: false },
      { target: 'portable', files: [portable], launchVerified: false },
    ]);
  });
  it.each([
    [], [setup], [portable], [setup, setup], [setup, portable, portable],
    [setup, portable, 'runtime.dll'], [setup, portable.replace('1.0.0', '0.9.0')],
    [setup, '../' + portable], [setup, 'folder/' + portable],
  ].map(names => ({ names })))('欠落・重複・別版・余分な別添ファイルを拒否する: %j', ({ names }) => {
    expect(() => verifyDesktopPackageArtifacts('win32', version, names.map(asset))).toThrow('artifacts differ');
  });
  it.each([{ bytes: 0 }, { bytes: -1 }, { bytes: Number.NaN }, { sha256: '' }])('空や指紋未確認のファイルを拒否する: %j', change => {
    expect(() => verifyDesktopPackageArtifacts('win32', version, [asset(setup), { ...asset(portable), ...change }])).toThrow('content hash');
  });
  it('Linuxは単一AppImageを維持し、Windowsのファイルを混ぜない', () => {
    const plan = desktopPackagePlan('linux', version);
    const targets = Platform.LINUX.createTarget(plan.map(item => item.target), Arch.x64);
    expect([...targets.get(Platform.LINUX)?.entries() ?? []]).toEqual([[Arch.x64, ['AppImage']]]);
    expect(verifyDesktopPackageArtifacts('linux', version, [asset('PointerCAD-1.0.0-linux-x64.AppImage')])).toEqual([
      { target: 'AppImage', files: ['PointerCAD-1.0.0-linux-x64.AppImage'], launchVerified: false },
    ]);
    expect(() => verifyDesktopPackageArtifacts('linux', version, [asset(setup)])).toThrow();
  });
  it('未対応OSとファイル名を壊す版を作成前に拒否する', () => {
    expect(() => desktopPackagePlan('darwin', version)).toThrow('platform');
    expect(() => desktopPackagePlan('win32', '../1.0.0')).toThrow('version');
  });
});
