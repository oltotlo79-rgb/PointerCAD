import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertPortableLaunchEnvironment, portableDebuggerEndpoint, portableExtractionDirectory, portableLaunchArguments,
  portableLaunchPlan, readPortableLaunchTarget } from '../../../../scripts/release/portableLaunch.mjs';

const portableName = 'PointerCAD-1.0.0-windows-x64-portable.exe';
const setupName = 'PointerCAD-1.0.0-windows-x64-setup.exe';
const root = fileURLToPath(new URL('../../../../', import.meta.url));

function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error(`Missing record: ${key}`);
  return Reflect.get(value, key);
}

function readWorkflow(): unknown {
  // Reuse the pinned builder's YAML reader; no new dependency or app execution.
  const builder = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
  const appBuilder = createRequire(builder.resolve('app-builder-lib/package.json'));
  const load = member(appBuilder('js-yaml'), 'load');
  if (typeof load !== 'function') throw new Error('YAML loader is missing.');
  return Reflect.apply(load, undefined, [readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')]);
}

async function fixture(body: (folder: string, candidatePath: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'pcad-portable-check-'));
  try {
    await mkdir(join(folder, 'artifacts'));
    const bytes = Buffer.from('single-file portable fixture, never executed');
    const assets = [setupName, portableName].map(name => ({ name, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }));
    for (const asset of assets) await writeFile(join(folder, 'artifacts', asset.name), bytes);
    const candidatePath = join(folder, 'candidate.json');
    await writeFile(candidatePath, JSON.stringify({ format: 'pointercad-desktop-candidate/1', version: '1.0.0',
      platform: 'win32', arch: 'x64', assets,
      packages: [{ target: 'nsis', files: [setupName] }, { target: 'portable', files: [portableName] }] }));
    await body(folder, candidatePath);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

describe('単一ポータブル exe の起動検査の準備（実行ファイルは起動しない）', () => {
  it('導入版や win-unpacked があっても配布する単一 portable exe だけを選ぶ', async () => {
    await fixture(async (folder, candidatePath) => {
      await mkdir(join(folder, 'builder', 'win-unpacked'), { recursive: true });
      await writeFile(join(folder, 'builder', 'win-unpacked', 'PointerCAD.exe'), 'unpacked');
      const target = await readPortableLaunchTarget(candidatePath);
      expect(target.executable).toBe(await realpath(join(folder, 'artifacts', portableName)));
    });
  });

  it('単一 exe が無ければ展開済み本体へ戻らず失敗する', async () => {
    await fixture(async (folder, candidatePath) => {
      await mkdir(join(folder, 'builder', 'win-unpacked'), { recursive: true });
      await writeFile(join(folder, 'builder', 'win-unpacked', 'PointerCAD.exe'), 'unpacked');
      await rm(join(folder, 'artifacts', portableName));
      await expect(readPortableLaunchTarget(candidatePath)).rejects.toThrow('Portable executable is missing');
    });
  });

  it('記録と違う中身の exe は拒否する', async () => {
    await fixture(async (folder, candidatePath) => {
      await writeFile(join(folder, 'artifacts', portableName), 'corrupted');
      await expect(readPortableLaunchTarget(candidatePath)).rejects.toThrow('differs from candidate.json');
    });
  });

  it('候補が導入版を portable として指したら拒否する', async () => {
    await fixture(async (_folder, candidatePath) => {
      const source = await readFile(candidatePath, 'utf8');
      await writeFile(candidatePath, source.replace(`"files":["${portableName}"]`, `"files":["${setupName}"]`));
      await expect(readPortableLaunchTarget(candidatePath)).rejects.toThrow('exactly one portable');
    });
  });

  it('同じ長さの改変もハッシュで拒否する', async () => {
    await fixture(async (folder, candidatePath) => {
      const executable = join(folder, 'artifacts', portableName);
      const bytes = await readFile(executable);
      bytes[0] = 0;
      await writeFile(executable, bytes);
      await expect(readPortableLaunchTarget(candidatePath)).rejects.toThrow('differs from candidate.json');
    });
  });

  it('exeと同名のディレクトリを拒否する', async () => {
    await fixture(async (folder, candidatePath) => {
      const executable = join(folder, 'artifacts', portableName);
      await rm(executable);
      await mkdir(executable);
      await expect(readPortableLaunchTarget(candidatePath)).rejects.toThrow('Invalid portable executable');
    });
  });

  it('ローカル・CIの印だけ・Linuxは実起動の前に拒否する', () => {
    expect(() => assertPortableLaunchEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 'win32')).not.toThrow();
    for (const environment of [{}, { CI: 'true' }, { CI: 'false', GITHUB_ACTIONS: 'true' }]) {
      expect(() => assertPortableLaunchEnvironment(environment, 'win32')).toThrow('restricted');
    }
    expect(() => assertPortableLaunchEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' }, 'linux')).toThrow('restricted');
  });

  it('空白を含む userData と loopback の接続・既存の描画指定を渡す', () => {
    const userData = 'D:/a/space here/u';
    expect(portableLaunchArguments(userData)).toEqual(['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', `--user-data-dir=${userData}`]);
  });

  it('実際のspawnへ単一exe・隔離したTEMPとuserData・shellなしの計画を渡す', () => {
    const environment = { CI: 'true', GITHUB_ACTIONS: 'true', NODE_OPTIONS: '--require unexpected', ELECTRON_RUN_AS_NODE: '1',
      PORTABLE_EXECUTABLE_FILE: 'old.exe', PORTABLE_EXECUTABLE_DIR: 'old', PORTABLE_EXECUTABLE_APP_FILENAME: 'old', TEMP: 'old' };
    const isolation = { executable: join(root, 'single exe', portableName), temporary: join(root, 'temporary'), userData: join(root, 'u') };
    const plan = portableLaunchPlan(isolation, environment, 'win32');
    expect(plan.executable).toBe(isolation.executable);
    expect(plan.args).toEqual(portableLaunchArguments(isolation.userData));
    expect(plan.options).toEqual({ cwd: join(root, 'single exe'), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { CI: 'true', GITHUB_ACTIONS: 'true', TEMP: isolation.temporary, TMP: isolation.temporary, TMPDIR: isolation.temporary } });
    expect(environment.TEMP).toBe('old'); expect(environment.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(() => portableLaunchPlan(isolation, {}, 'win32')).toThrow('restricted');
  });

  it('根・独立コピー・Windows CIのuserDataが既存の90文字以内に収まる', () => {
    // Fixed deployment shapes, independent of the folder in which this unit test is run.
    for (const project of ['C:/Users/oltot/Documents/git-projects/PointerCAD',
      'C:/Users/oltot/Documents/git-projects/PointerCAD/scratchpad/c3', 'D:/a/PointerCAD/PointerCAD']) {
      expect(win32.join(project, 'scratchpad/temp/p/123456/u').length).toBeLessThanOrEqual(90);
    }
  });

  it('当該TEMPの直接のNSIS展開先だけを後片付けの観測対象にする', () => {
    const temporary = 'D:/a/PointerCAD/scratchpad/temp/p/123456/t';
    const directory = win32.join(temporary, 'nsi123A.tmp');
    expect(portableExtractionDirectory(win32.join(directory, 'app', 'PointerCAD.exe'), temporary)).toBe(directory);
    // NSIS picks the third letter at random (CI run 36818570903: nsy3217.tmp); "ns" without a letter is not its name.
    const actual = win32.join(temporary, 'nsy3217.tmp');
    expect(portableExtractionDirectory(win32.join(actual, 'app', 'PointerCAD.exe'), temporary)).toBe(actual);
    for (const path of ['C:/Windows/PointerCAD.exe', `${temporary}/other/app/PointerCAD.exe`, `${temporary}/nsz.tmp/app/PointerCAD.exe`,
      `${temporary}/nsi123A.tmp/PointerCAD.exe`, `${temporary}/nested/nsi123A.tmp/app/PointerCAD.exe`,
      `${temporary}/nsi123A.tmp/app/Other.exe`, `${temporary}-other/nsi123A.tmp/app/PointerCAD.exe`]) {
      expect(() => portableExtractionDirectory(path, temporary)).toThrow('outside');
    }
  });

  it('専用プロファイルの接続記録からloopbackだけへ接続する', () => {
    expect(portableDebuggerEndpoint('')).toBeNull();
    expect(portableDebuggerEndpoint('54321')).toBeNull();
    expect(portableDebuggerEndpoint('54321\r\n/devtools/browser/123abc-456\r\n')).toBe('http://127.0.0.1:54321');
    for (const contents of ['0\n/devtools/browser/abc', '65536\n/devtools/browser/abc', 'x\n/devtools/browser/abc',
      '54321\nhttp://elsewhere', '54321\n/devtools/browser/../abc']) {
      expect(() => portableDebuggerEndpoint(contents)).toThrow('Invalid portable DevToolsActivePort');
    }
  });

  it('実workflowのWindows段が単一exe専用検査を成果物保存より前に必ず通す', () => {
    const workflow = readWorkflow();
    const steps: unknown = member(member(member(workflow, 'jobs'), 'desktop'), 'steps');
    if (!Array.isArray(steps)) throw new Error('Desktop workflow steps are missing.');
    const portable = steps.filter((step: unknown) => member(step, 'env') !== undefined
      && member(member(step, 'env'), 'PCAD_PACKAGED_VARIANT') === 'portable');
    expect(portable).toHaveLength(1);
    const step: unknown = portable[0];
    expect(member(step, 'if')).toBe("matrix.os == 'windows-latest'");
    expect(member(step, 'timeout-minutes')).toBe(25);
    expect(member(step, 'continue-on-error')).toBeUndefined();
    expect(member(step, 'env')).toEqual({ PCAD_PACKAGED_CANDIDATE: 'dist/desktop-stage/candidate.json', PCAD_PACKAGED_VARIANT: 'portable' });
    const run = member(step, 'run');
    expect(run).toContain('pnpm exec playwright test --config e2e/packaged-desktop.config.ts');
    expect(run).toContain('if ($LASTEXITCODE -ne 0) { throw');
    expect(run).not.toContain('PCAD_PACKAGED_EXECUTABLE');
    const index = steps.indexOf(step);
    expect(steps.findIndex((entry: unknown) => member(entry, 'name') === '配布物を起動して確かめる(Windowsはwin-unpacked)')).toBeLessThan(index);
    expect(steps.findIndex((entry: unknown) => member(entry, 'name') === 'Desktop候補をartifactへ保存')).toBeGreaterThan(index);
    const config = readFileSync(join(root, 'e2e', 'packaged-desktop.config.ts'), 'utf8');
    expect(config).toContain("variant === 'portable' ? 'portableDesktop.spec.ts' : 'packagedDesktop.spec.ts'");
    expect(config).toContain('assertPortableLaunchEnvironment(process.env, process.platform)');
    expect(config).toContain('workers: 1'); expect(config).toContain('retries: 0'); expect(config).toContain('timeout: 900_000');
    const spec = readFileSync(join(root, 'e2e', 'release', 'portableDesktop.spec.ts'), 'utf8');
    expect(spec).toContain('readPortableLaunchTarget(resolve(root, candidatePath))');
    expect(spec).toContain('verifyPackagedStartup(first, info)');
    expect(readFileSync(join(root, 'e2e', 'release', 'packagedDesktop.spec.ts'), 'utf8')).toContain('verifyPackagedStartup(page, info)');
  });
});
