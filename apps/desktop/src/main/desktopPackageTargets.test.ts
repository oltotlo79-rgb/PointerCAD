import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Arch, Platform } from 'electron-builder';
import { desktopPackagePlan, verifyDesktopPackageArtifacts } from '../../../../scripts/release/desktopPackageTargets.mjs';

const packagingFolder = new URL('../../packaging/', import.meta.url);
const builderConfig = readFileSync(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8');

/** Top-level section → its indented `key: value` settings (enough for the flat keys this file uses). */
function builderSections(config: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of config.split(/\r?\n/u)) {
    const top = /^([A-Za-z][\w-]*):/u.exec(line);
    if (top?.[1] !== undefined) { current = new Map(); sections.set(top[1], current); continue; }
    const setting = /^ {2}([A-Za-z][\w-]*):\s*(\S.*?)\s*$/u.exec(line);
    if (setting?.[1] !== undefined && setting[2] !== undefined) current?.set(setting[1], setting[2]);
  }
  return sections;
}

/** The arch spelling electron-builder 26.15.3 itself puts into ${arch} (builder-util getArtifactArchName). */
function builderArchName(ext: string): string {
  const requireBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
  const builderUtil: unknown = requireBuilder('builder-util');
  const name: unknown = typeof builderUtil === 'object' && builderUtil !== null ? Reflect.get(builderUtil, 'getArtifactArchName') : undefined;
  if (typeof name !== 'function') throw new Error('builder-util の getArtifactArchName が見つかりません');
  const archName: unknown = Reflect.apply(name, undefined, [Arch.x64, ext]);
  if (typeof archName !== 'string') throw new Error('getArtifactArchName が文字列を返しません');
  return archName;
}

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

describe('electron-builder.yml が配布の計画どおりの物を作る', () => {
  const sections = builderSections(builderConfig);
  it.each([
    // electron-builder は形式ごとの節の artifactName、無ければ OS の節の artifactName を使う(platformPackager の artifactPatternConfig)。
    { platform: 'win32', target: 'nsis', section: 'nsis', fallback: 'win', ext: 'exe' },
    { platform: 'win32', target: 'portable', section: 'portable', fallback: 'win', ext: 'exe' },
    // 2026-09-28 の配布CIの試走で ${arch} が AppImage では x86_64 になり、計画の -linux-x64 と食い違って止まった。
    { platform: 'linux', target: 'AppImage', section: 'appImage', fallback: 'linux', ext: 'AppImage' },
  ])('$target のファイル名を electron-builder と同じ規則で展開すると計画の名前になる', ({ platform, target, section, fallback, ext }) => {
    const pattern = sections.get(section)?.get('artifactName') ?? sections.get(fallback)?.get('artifactName');
    expect(pattern, `${section} か ${fallback} に artifactName があること`).toBeDefined();
    const expanded = (pattern ?? '').replaceAll('${version}', '1.0.0').replaceAll('${arch}', builderArchName(ext)).replaceAll('${ext}', ext);
    expect(expanded).not.toContain('${');
    expect(expanded).toBe(desktopPackagePlan(platform, '1.0.0').find(item => item.target === target)?.name);
  });
  it('既定の Electron のアイコンを使わず、製品のアイコンを渡す(Windows は 256px を含む .ico、Linux は 512px 以上の .png)', () => {
    const windowsIcon = sections.get('win')?.get('icon'), linuxIcon = sections.get('linux')?.get('icon');
    expect([windowsIcon, linuxIcon]).toEqual(['icon.ico', 'icon.png']);
    const ico = readFileSync(new URL('icon.ico', packagingFolder));
    expect([...ico.subarray(0, 4)], '.ico の見出し').toEqual([0, 0, 1, 0]);
    const count = ico.readUInt16LE(4), widths = Array.from({ length: count }, (_, index) => ico[6 + index * 16] ?? -1);
    expect(widths, '.ico の各大きさ(0 は 256px)').toEqual(expect.arrayContaining([16, 32, 48, 0]));
    const png = readFileSync(new URL('icon.png', packagingFolder));
    expect([...png.subarray(0, 8)], '.png の見出し').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], '.png の幅と高さ').toEqual([512, 512]);
  });
  it('Linux の窓を .desktop の項目へ結び付ける名前を同期する', () => {
    expect(sections.get('linux')?.get('syncDesktopName')).toBe('true');
  });
});
