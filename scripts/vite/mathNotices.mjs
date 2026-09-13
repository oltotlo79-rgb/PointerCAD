/** Build inputs live outside ignored build-output folders. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { mathPackageFolder as packageFolder, installedMathDependencies, verifyMathDependencyInventory } from './mathDependencyInventory.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (source) => createHash('sha256').update(source).digest('hex');

function noticeName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9.-]+\.txt$/.test(value) || value.includes('..')) {
    throw new Error('Invalid mathematics notice filename');
  }
  return value;
}

/** Canonical notices are checked against the installed versions before being emitted. */
export function collectMathNotices(root = repositoryRoot) {
  const sourceFolder = join(root, 'docs/standards/licenses');
  const manifestBytes = readFileSync(join(sourceFolder, 'math-notices.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported mathematics notice manifest');
  verifyMathDependencyInventory(installedMathDependencies(root), [...manifest.packages, ...manifest.unresolved]);
  const assets = new Map();
  const fonts = new Map();
  const addNotice = (record) => {
    const name = noticeName(record.notice);
    const source = readFileSync(join(sourceFolder, name));
    if (sha256(source) !== record.sha256) throw new Error(`Mathematics notice changed: ${name}`);
    assets.set(`licenses/${name}`, source);
    return source;
  };
  for (const record of manifest.packages) {
    const folder = packageFolder(root, record.chain);
    const installed = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    if (installed.name !== record.name || installed.version !== record.version) {
      throw new Error(`Review mathematics notices after changing ${record.name}`);
    }
    if (!/^[A-Za-z0-9.-]+$/.test(record.installedNotice)) throw new Error('Invalid installed notice');
    const source = addNotice(record);
    if (!source.equals(readFileSync(join(folder, record.installedNotice)))) {
      throw new Error(`Installed mathematics notice differs: ${record.name}`);
    }
  }
  for (const record of manifest.additionalNotices) addNotice(record);
  const fontFolder = join(packageFolder(root, ['packages/ui', 'mathlive']), 'fonts');
  const installedFonts = readdirSync(fontFolder).filter(name => name.endsWith('.woff2')).sort();
  const recordedFonts = manifest.fonts.map(record => record.file).sort();
  if (JSON.stringify(installedFonts) !== JSON.stringify(recordedFonts)) {
    throw new Error('Review notices for the changed mathematics font inventory');
  }
  for (const record of manifest.fonts) {
    const source = readFileSync(join(fontFolder, record.file));
    if (sha256(source) !== record.sha256) throw new Error(`Mathematics font changed: ${record.file}`);
    fonts.set(record.file, record.sha256);
  }
  assets.set('licenses/math-notices.json', manifestBytes);
  const links = [...assets.keys()].map(name => {
    const file = name.slice('licenses/'.length);
    return `<li><a href="./${file}">${file}</a></li>`;
  }).join('\n');
  assets.set('licenses/index.html', Buffer.from(
    '<!doctype html><html lang="ja"><meta charset="utf-8">' +
    '<title>PointerCAD 数学機能の著作権・許諾表示</title>' +
    '<h1>数学機能の著作権・許諾表示</h1>' +
    '<p>数学入力・計算ライブラリと数式用字体の原文です。字体には独自の許諾が適用されます。</p>' +
    `<ul>${links}</ul></html>`, 'utf8'));
  return { assets, fonts };
}

/** Verify the bytes actually distributed, including inventory additions and omissions. */
export function verifyMathFontAssets(bundle, expectedFonts) {
  const seen = new Set();
  const expectedHashes = new Set(expectedFonts.values());
  let count = 0;
  for (const output of Object.values(bundle)) {
    if (output.type !== 'asset' || !/(?:^|\/)KaTeX_[^/]+\.woff2$/.test(output.fileName)) continue;
    const hash = sha256(output.source);
    if (!expectedHashes.has(hash)) throw new Error(`Unreviewed mathematics font asset: ${output.fileName}`);
    seen.add(hash);
    count += 1;
  }
  if (count !== expectedFonts.size || seen.size !== expectedHashes.size) {
    throw new Error('Mathematics fonts are missing or duplicated in the build');
  }
}

/** Shared by Web and Electron renderer builds; it adds no runtime imports. */
export function mathNotices() {
  let distribution;
  return {
    name: 'pointercad-mathematics-notices',
    apply: 'build',
    buildStart() {
      distribution = collectMathNotices();
      for (const [fileName, source] of distribution.assets) {
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
    generateBundle(_options, bundle) {
      if (!distribution) throw new Error('Mathematics notice validation did not run');
      verifyMathFontAssets(bundle, distribution.fonts);
    },
  };
}
