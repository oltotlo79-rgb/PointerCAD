/** Read-only preparation for the CI check of the single-file Windows portable. No process is started here. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { desktopPackagePlan, verifyDesktopPackageArtifacts } from './desktopPackageTargets.mjs';

export function assertPortableLaunchEnvironment(environment, platform) {
  if (platform !== 'win32' || environment.CI !== 'true' || environment.GITHUB_ACTIONS !== 'true') {
    throw new Error('The portable executable launch check is restricted to Windows GitHub Actions.');
  }
}

export async function readPortableLaunchTarget(candidatePath) {
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  if (candidate?.format !== 'pointercad-desktop-candidate/1' || candidate.platform !== 'win32'
    || candidate.arch !== 'x64' || !Array.isArray(candidate.assets) || !Array.isArray(candidate.packages)) {
    throw new Error('Expected a Windows x64 desktop candidate.');
  }
  const packages = verifyDesktopPackageArtifacts(candidate.platform, candidate.version, candidate.assets);
  const name = desktopPackagePlan('win32', candidate.version).find(item => item.target === 'portable')?.name;
  if (name === undefined || candidate.packages.filter(item => item.target === 'portable').length !== 1
    || JSON.stringify(candidate.packages.find(item => item.target === 'portable')?.files)
      !== JSON.stringify(packages.find(item => item.target === 'portable')?.files)) {
    throw new Error('The candidate does not identify exactly one portable executable.');
  }
  const executable = join(dirname(candidatePath), 'artifacts', name);
  const info = await lstat(executable).catch(error => {
    throw new Error(`Portable executable is missing: ${executable}`, { cause: error });
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Invalid portable executable: ${executable}`);
  const asset = candidate.assets.find(item => item.name === name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  if (info.size !== asset.bytes || hash.digest('hex') !== asset.sha256) {
    throw new Error(`Portable executable differs from candidate.json: ${executable}`);
  }
  return { executable: await realpath(executable), candidate };
}

export function portableLaunchArguments(userData) {
  return ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', `--user-data-dir=${userData}`];
}

export function portableLaunchPlan(isolation, environment, platform) {
  assertPortableLaunchEnvironment(environment, platform);
  const env = { ...environment, TEMP: isolation.temporary, TMP: isolation.temporary, TMPDIR: isolation.temporary };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR',
    'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[name];
  return { executable: isolation.executable, args: portableLaunchArguments(isolation.userData),
    options: { cwd: dirname(isolation.executable), env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } };
}

export function portableDebuggerEndpoint(contents) {
  const [port, path] = contents.trim().split(/\r?\n/u);
  if (port === undefined || path === undefined) return null;
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65_535
    || !/^\/devtools\/browser\/[a-z0-9-]+$/iu.test(path)) {
    throw new Error('Invalid portable DevToolsActivePort.');
  }
  return `http://127.0.0.1:${port}`;
}

/** Accept only this run's NSIS extraction, never a globally discovered TEMP directory. */
export function portableExtractionDirectory(executable, temporary) {
  const app = win32.dirname(executable), directory = win32.dirname(app);
  if (!win32.isAbsolute(executable) || !win32.isAbsolute(temporary)
    || win32.basename(executable) !== 'PointerCAD.exe' || win32.basename(app) !== 'app'
    || !/^nsi[0-9a-f]{1,4}\.tmp$/iu.test(win32.basename(directory))
    || win32.normalize(win32.dirname(directory)).toLowerCase() !== win32.normalize(temporary).toLowerCase()) {
    throw new Error(`Portable process is outside this run's NSIS extraction: ${executable}`);
  }
  return directory;
}
