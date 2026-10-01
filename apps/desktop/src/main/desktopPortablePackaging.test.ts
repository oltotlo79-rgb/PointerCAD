import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch } from 'electron-builder';
import { describe, expect, it, vi } from 'vitest';

const requireBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
const requireAppBuilder = createRequire(requireBuilder.resolve('app-builder-lib/package.json'));
const builderFolder = dirname(requireBuilder.resolve('app-builder-lib/package.json'));
const projectDir = fileURLToPath(new URL('../../', import.meta.url));

function objectValue(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('Expected a builder object');
  return value;
}

function member(value: unknown, name: string): unknown {
  return Reflect.get(objectValue(value), name);
}

function invoke(receiver: unknown, name: string, args: readonly unknown[]): unknown {
  const method = member(receiver, name);
  if (typeof method !== 'function') throw new Error(`Missing builder method: ${name}`);
  return Reflect.apply(method, receiver, args);
}

/** Exercise the pinned builder up to its effectiveOptionComputed hook, before compilation or app execution. */
function packagingFixture(targetName: 'nsis' | 'portable') {
  const config = objectValue(invoke(requireAppBuilder('js-yaml'), 'load', [readFileSync(join(projectDir, 'electron-builder.yml'), 'utf8')]));
  const packArch = vi.fn(() => Promise.resolve({
    fileInfo: { path: join(projectDir, 'cached-setup.nsis.zip'), sha512: 'AA==' }, unpackedSize: 123,
  }));
  const effectiveOptionComputed = vi.fn((options: readonly unknown[]) => {
    expect(options).toHaveLength(2);
    return true;
  });
  const packager = {
    config, projectDir, compression: 'normal', platformSpecificBuildOptions: member(config, 'win'),
    info: { metadata: {}, buildResourcesDir: join(projectDir, 'packaging'), emitArtifactBuildStarted: () => Promise.resolve() },
    packagerOptions: { effectiveOptionComputed },
    appInfo: {
      id: 'org.pointercad.desktop', name: 'pointercad', sanitizedName: 'pointercad', productName: 'PointerCAD',
      productFilename: 'PointerCAD', version: '1.0.0', buildVersion: '1.0.0', copyright: '', description: 'PointerCAD',
      updaterCacheDirName: 'pointercad-updater', getVersionInWeirdWindowsForm: () => '1.0.0.0',
    },
    expandArtifactNamePattern: () => 'portable.exe', getIconPath: () => Promise.resolve(null),
  };
  const targetConstructor = member(requireAppBuilder('./out/targets/nsis/NsisTarget.js'), 'NsisTarget');
  if (typeof targetConstructor !== 'function') throw new Error('Missing NsisTarget');
  const target: unknown = Reflect.construct(targetConstructor, [packager, projectDir, targetName, { refCount: 0, packArch }]);
  return { target, packArch, effectiveOptionComputed };
}

describe('ポータブル版に導入版のZIPを7zとして埋め込まない', () => {
  it('実ビルダーがportable専用の設定を選び、導入版の設定と独自includeを保つ', () => {
    const portableOptions = member(packagingFixture('portable').target, 'options');
    const installerOptions = member(packagingFixture('nsis').target, 'options');
    expect(member(portableOptions, 'useZip')).toBe(true);
    expect(member(portableOptions, 'include')).toBeUndefined();
    expect(member(portableOptions, 'requestExecutionLevel')).toBe('user');
    expect(member(portableOptions, 'unpackDirName')).toBe(true);
    expect(member(installerOptions, 'include')).toBe('installer.nsh');
    expect(member(installerOptions, 'useZip')).toBe(true);
    expect(member(installerOptions, 'differentialPackage')).toBe(false);
    expect(member(installerOptions, 'deleteAppDataOnUninstall')).toBe(false);
  });

  it('実際のNSIS定義は展開済みのx64フォルダーを指し、共有されたZIPを要求しない', async () => {
    const { target, packArch, effectiveOptionComputed } = packagingFixture('portable');
    const appFolder = join(projectDir, 'win-unpacked');
    await invoke(target, 'buildInstaller', [new Map([[Arch.x64, appFolder]])]);
    expect(effectiveOptionComputed).toHaveBeenCalledOnce();
    const definitions = effectiveOptionComputed.mock.calls[0]?.[0][0];
    expect(member(definitions, 'APP_DIR_64')).toBe(appFolder);
    expect(member(definitions, 'APP_64')).toBeUndefined();
    expect(member(definitions, 'REQUEST_EXECUTION_LEVEL')).toBe('user');
    // The shutdown cleanup checks the environment value emitted by portable.nsi, not productName.
    expect(member(definitions, 'APP_FILENAME')).toBe('pointercad');
    expect(member(definitions, 'UNPACK_DIR_NAME')).toBeUndefined();
    expect(packArch).not.toHaveBeenCalled();
    const template = readFileSync(join(builderFolder, 'templates/nsis/portable.nsi'), 'utf8');
    expect(template).toContain('File /r "${APP_DIR_64}\\*.*"');
    expect(template).toContain('StrCpy $INSTDIR "$PLUGINSDIR\\app"');
    expect(template).toContain('SetErrorLevel $0');
  });
});
