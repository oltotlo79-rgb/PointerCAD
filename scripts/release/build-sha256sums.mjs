/**
 * Hash every file in a finished release-assets folder (installer, portable, AppImage, PDF volumes, NOTICE, SBOM, …),
 * cross-check the two desktop candidates' recorded hashes, and write one SHA256SUMS next to them.
 * Builds, downloads and publishes nothing; never overwrites an existing SHA256SUMS.
 */
import { argv } from 'node:process';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';
import { desktopPackagePlan, verifyDesktopPackageArtifacts } from './desktopPackageTargets.mjs';
import { manualPdfReleaseAssetName } from './releaseReadiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const isHex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Recursively hash every regular file under folder (skipping a prior SHA256SUMS); rejects links, empties and duplicates. */
export async function collectReleaseFileDigests(folder) {
  const base = resolve(folder);
  const rootInfo = await lstat(base);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Release folder must be a real directory');
  const entries = [], folded = new Set();
  const walk = async (directory, depth) => {
    if (depth > 8) throw new Error('Release folder nesting is excessive');
    const items = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name));
    for (const item of items) {
      const path = resolve(directory, item.name), name = relative(base, path).split(sep).join('/');
      offlineAssetUrl(name);
      if (item.isSymbolicLink()) throw new Error('Release file must not be a link: ' + name);
      if (item.isDirectory()) { await walk(path, depth + 1); continue; }
      if (name === 'SHA256SUMS') continue;
      const before = await lstat(path);
      if (!item.isFile() || !before.isFile() || before.isSymbolicLink() || before.size === 0 || folded.has(name.toLowerCase())) {
        throw new Error('Invalid release file: ' + name);
      }
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error('Release file changed while reading: ' + name);
      }
      folded.add(name.toLowerCase());
      entries.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  await walk(base, 0);
  if (entries.length === 0) throw new Error('Release folder has no files to sum');
  return entries.sort((left, right) => compare(left.name, right.name));
}

/** Read one desktop candidate.json (package-desktop.mjs's output) and return its verified per-file hashes by file name. */
export async function readDesktopCandidateAssets(stagePath) {
  const receiptPath = join(resolve(stagePath), 'candidate.json');
  if ((await lstat(receiptPath)).isSymbolicLink()) throw new Error('candidate.json must not be a link');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.format !== 'pointercad-desktop-candidate/1') {
    throw new Error('Invalid desktop candidate record: ' + stagePath);
  }
  if (receipt.platform !== 'win32' && receipt.platform !== 'linux') throw new Error('Unsupported desktop candidate platform: ' + stagePath);
  desktopPackagePlan(receipt.platform, receipt.version); // Rejects an invalid platform/version before trusting the assets below.
  verifyDesktopPackageArtifacts(receipt.platform, receipt.version, receipt.assets);
  return { platform: receipt.platform, version: receipt.version, assets: new Map(receipt.assets.map(asset => [asset.name, asset.sha256])) };
}

/** Stop when the release folder disagrees with a desktop candidate's recorded hash, or is missing one of its assets. */
export function verifyReleaseDigestsAgainstCandidates(entries, candidateAssetSets) {
  const byName = new Map(entries.map(entry => [entry.name, entry.sha256]));
  for (const { assets } of candidateAssetSets) {
    for (const [name, sha256] of assets) {
      const found = byName.get(name);
      if (found === undefined) throw new Error('Release folder is missing a desktop candidate asset: ' + name);
      if (found !== sha256) throw new Error('Release folder file differs from the desktop candidate record: ' + name);
    }
  }
}

/** `sha256sum -c` reads "<64-hex><space><space><name>\n" verbatim; keep it plain LF, sorted by name, one entry per name. */
export function formatSha256Sums(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Nothing to record in SHA256SUMS');
  const names = new Set();
  for (const { name, sha256 } of entries) {
    if (typeof name !== 'string' || name.length === 0 || name.includes('\n') || name.includes('\r') || name.startsWith('*')) {
      throw new Error('Invalid SHA256SUMS entry name: ' + name);
    }
    if (!isHex64(sha256)) throw new Error('Invalid SHA256SUMS entry hash: ' + name);
    if (names.has(name)) throw new Error('Duplicate SHA256SUMS entry: ' + name);
    names.add(name);
  }
  const sorted = [...entries].sort((left, right) => compare(left.name, right.name));
  return sorted.map(({ name, sha256 }) => sha256 + '  ' + name).join('\n') + '\n';
}

/**
 * Copy every manual PDF volume out of the Web candidate (`<webStage>/manual/pdf/<id>.pdf`, one file per volume, as
 * `assemble-web-offline.mjs` lays it out) into the release folder, renamed to its GitHub Release asset name
 * (`manualPdfReleaseAssetName`, e.g. `PointerCAD-1.0.0-manual-getting-started.pdf`). The generator
 * (`scripts/manual/generate-pdf.mjs`) and the Web candidate both name the file by volume id alone; README.md's
 * release-links region, `checkReadmeReleaseLinks` and the post-release download check all expect the renamed form.
 * Without this step a human has to rename each volume by hand before attaching it to the Release (see
 * docs/releases/release-checklist.md「Releaseに添付するもの」), which is where the naming mismatch used to come from.
 * Never overwrites an existing file in the release folder and rejects a link, an empty volume, or a folder with no
 * PDF volumes at all.
 */
export async function stageManualPdfVolumes({ folder, webStage, version }) {
  const pdfDir = join(resolve(webStage), 'manual', 'pdf');
  const items = (await readdir(pdfDir, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.pdf'));
  if (items.length === 0) throw new Error('Web candidate has no manual PDF volumes: ' + pdfDir);
  const names = [];
  for (const item of items.sort((left, right) => compare(left.name, right.name))) {
    const id = item.name.slice(0, -'.pdf'.length);
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) throw new Error('Invalid manual PDF volume name: ' + item.name);
    const source = join(pdfDir, item.name);
    const before = await lstat(source);
    if (before.isSymbolicLink() || !before.isFile() || before.size === 0) throw new Error('Invalid manual PDF source: ' + source);
    const bytes = await readFile(source);
    const after = await lstat(source);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error('Manual PDF source changed while reading: ' + source);
    }
    const name = manualPdfReleaseAssetName(version, id);
    const target = join(resolve(folder), name);
    await writeFile(target, bytes, { flag: 'wx' });
    if (!(await readFile(target)).equals(bytes)) throw new Error('Staged manual PDF differs: ' + name);
    names.push(name);
  }
  return names;
}

/**
 * Hash every file in the finished release folder, cross-check the Windows and Linux candidates, and write SHA256SUMS
 * once. Pass `webStage` (the assembled Web candidate folder) to also stage the manual PDF volumes into `folder` under
 * their Release asset names (`stageManualPdfVolumes`) before hashing, so SHA256SUMS and the folder attached to the
 * GitHub Release already use the same names README.md and the post-release check require.
 */
export async function buildSha256Sums({ folder, windowsStage, linuxStage, webStage }) {
  const windows = await readDesktopCandidateAssets(windowsStage);
  const linux = await readDesktopCandidateAssets(linuxStage);
  if (windows.platform !== 'win32' || linux.platform !== 'linux') throw new Error('Desktop candidate platforms are swapped or duplicated');
  if (windows.version !== linux.version) throw new Error('Desktop candidate versions differ');
  if (webStage !== undefined) await stageManualPdfVolumes({ folder, webStage, version: windows.version });
  const entries = await collectReleaseFileDigests(folder);
  verifyReleaseDigestsAgainstCandidates(entries, [windows, linux]);
  const content = formatSha256Sums(entries);
  const path = join(resolve(folder), 'SHA256SUMS');
  await writeFile(path, content, { flag: 'wx' });
  return { path, entries, content };
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  const pattern = /^[a-z0-9][a-z0-9-]*$/u;
  const [folderName, windowsName, linuxName, webName] = argv.slice(2);
  if (!folderName || !windowsName || !linuxName || ![folderName, windowsName, linuxName].every(name => pattern.test(name))
    || (webName !== undefined && !pattern.test(webName))) {
    throw new Error('Usage: node scripts/release/build-sha256sums.mjs <release-folder> <windows-stage> <linux-stage> [web-candidate]');
  }
  const dist = join(root, 'dist');
  const result = await buildSha256Sums({ folder: join(dist, folderName), windowsStage: join(dist, windowsName), linuxStage: join(dist, linuxName),
    webStage: webName === undefined ? undefined : join(dist, webName) });
  log(JSON.stringify({ path: result.path, files: result.entries.length }));
}
