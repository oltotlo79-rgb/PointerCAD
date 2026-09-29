import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPTURE_REGISTRY_FORMAT, CAPTURE_UNKNOWN_REASONS, CAPTURE_VIEWPORT_POLICY } from '../../../../scripts/manual/captureRegistry.mjs';
import type { CaptureRegistry, CaptureRegistryEntry } from '../../../../scripts/manual/captureRegistry.mjs';
import { verifyManualConsistency } from '../../../../scripts/manual/manualConsistency.mjs';
import { assembleDesktopDistribution, verifyDesktopDistribution } from '../../../../scripts/release/desktopDistribution.mjs';
import { desktopPackagePlan, verifyDesktopPackageArtifacts } from '../../../../scripts/release/desktopPackageTargets.mjs';
import { createReleaseManifest } from '../../../../scripts/release/releaseManifest.mjs';
import type { ReleaseCandidateInput } from '../../../../scripts/release/releaseManifest.mjs';
import {
  DESKTOP_DEFERRED_CHECK_IDS, MANUAL_CHECK_IDS, PAGES_MAX_FILE_BYTES, PAGES_MAX_FILES, POST_RELEASE_DESKTOP_CHECK_IDS, RELEASE_LINKS_END,
  RELEASE_LINKS_START, RELEASE_READINESS_CHECK_IDS, RELEASE_READINESS_EXIT, ReleaseReadinessUsageError, WEB_DEFERRED_PHRASE,
  captureFreshnessFromRegistry, checkReadmeReleaseLinks, createReleaseDownloader, evaluateReleaseReadiness, formatReleaseReadinessReport,
  manualPdfReleaseAssetName, parseReleaseReadinessArguments, runReleaseReadiness,
} from '../../../../scripts/release/releaseReadiness.mjs';
import type {
  CaptureFreshnessHook, CaptureFreshnessRequest, CurrentHelpEdition, ManualReleaseInput, PostReleaseDesktopInput, PreReleaseInput,
  ReleaseDownloadHook, ReleaseReadinessReport,
} from '../../../../scripts/release/releaseReadiness.mjs';
import { assembleSbomDocument } from '../../../../scripts/release/sbom.mjs';
import { assembleOfflineDistribution } from '../../../../scripts/vite/offlineDistribution.mjs';
import { bytes, files, hash, json } from './distributionTestFixture.js';
import { sourceFileHash } from '../../../../scripts/release/desktopFileInventory.mjs';

/** What one generated manual is made from; the candidate below is rebuilt from a state that differs in one place. */
interface HelpState {
  readonly volumes: readonly { readonly id: string; readonly title: string; readonly topics: readonly string[] }[];
  readonly titles: Readonly<Record<string, string>>;
  readonly bodies: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly features: readonly { readonly id: string; readonly topicIds: readonly string[] }[];
  readonly commands: readonly { readonly commandId: string; readonly topicId: string }[];
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const builderConfig = readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
const version = '1.0.0';
const sourceCommit = 'c'.repeat(40);
const IMAGE = 'images/start-screen.png';
const IMAGES = new Map([[IMAGE, bytes('PNG mock start screen')]]);
const FONT_NOTICE = 'font notice';
const NOTICE = bytes('MIT License (mock runtime)');
const DOWNLOAD = `https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v${version}`;
const SITE = 'https://pointercad.pages.dev';
const [INSTALLER, PORTABLE] = desktopPackagePlan('win32', version), [APP_IMAGE] = desktopPackagePlan('linux', version);
const packageJson = (name: string, value: string) => json({ name, version: value, private: true });
const packageFiles = { root: packageJson('pointercad', version), desktop: packageJson('@pointercad/desktop', version),
  web: packageJson('@pointercad/web', version) };
const manualInputs = { 'packages/ui/src/example.ts': hash('source') };
const webInputs = { ...manualInputs, 'package.json': hash(packageFiles.root), 'apps/web/package.json': hash(packageFiles.web) };
const desktopInputs = { ...manualInputs, 'package.json': hash(packageFiles.root), 'apps/desktop/package.json': hash(packageFiles.desktop),
  'apps/desktop/electron-builder.yml': sourceFileHash(bytes(builderConfig)) }; // the real file may be CRLF on Windows
const sourceInputs = { web: webInputs, desktop: desktopInputs, manual: manualInputs };
const SUPPLEMENTARY = { settings: [], outputs: [], toolDefaults: [], contentCertified: false };
const NATIVE_CONTROLS = { scope: 'native-jsx-controls', contentCertified: false, sources: ['packages/ui/src/Example.tsx'],
  controls: [{ path: 'packages/ui/src/Example.tsx', line: 1, tag: 'button', hidden: false, description: 'literal', titleSource: 'control',
    sourceExpression: '"保存"', hasSpread: false }], missing: [], requiresRenderedCheck: [] };

const BASE: HelpState = {
  volumes: [
    { id: 'getting-started', title: '導入・画面操作・ファイル', topics: ['start', 'files'] },
    { id: 'sketch-and-functions', title: 'スケッチ・座標・関数', topics: ['sketch'] },
    { id: 'solid-and-measurement', title: '立体・外観・測定', topics: ['solid'] },
    { id: 'assembly', title: 'アセンブリ・部品表', topics: ['assembly'] },
    { id: 'drawing', title: '図面・寸法・製図記号', topics: ['drawing'] },
    { id: 'sheet-and-scripting', title: '板金・自動作図・加工連携', topics: ['sheet'] },
    { id: 'settings-and-history', title: '設定・履歴・表示', topics: ['settings'] },
  ],
  titles: { start: 'はじめての作図', files: 'ファイルを保存する', sketch: 'スケッチを描く', solid: '立体を作る',
    assembly: '部品を組み立てる', drawing: '図面を作る', sheet: '板金を作る', settings: '表示を設定する' },
  bodies: {
    start: `![最初の画面](./${IMAGE})\n\n新しい部品を作ります。`,
    files: '「{{ui:file.export}}」を押して保存します。',
    sketch: '線を描きます。',
    solid: '押し出します。',
    assembly: '「{{ui:nameSearch.label}}」で部品を探します。',
    drawing: '「{{ui:file.export}}」で図面を書き出します。',
    sheet: '板を曲げます。',
    settings: '値を直して「{{ui:settings.apply}}」を押します。',
  },
  labels: { 'file.export': '書き出す', 'nameSearch.label': '名前で探す', 'settings.apply': '適用' },
  features: [
    { id: 'FR-101', topicIds: ['start'] }, { id: 'FR-102', topicIds: ['files', 'drawing'] }, { id: 'FR-103', topicIds: ['sketch'] },
    { id: 'FR-104', topicIds: ['solid'] }, { id: 'FR-105', topicIds: ['assembly'] }, { id: 'FR-106', topicIds: ['sheet'] },
    { id: 'FR-107', topicIds: ['settings'] },
  ],
  commands: [{ commandId: 'file.save', topicId: 'files' }, { commandId: 'sketch.line', topicId: 'sketch' }],
};

const escapeHtml = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const chaptersOf = (state: HelpState) => state.volumes
  .flatMap(volume => volume.topics.map(id => ({ id, title: state.titles[id], path: `docs/ja/${id}.md`, volumeId: volume.id })))
  .map((chapter, order) => ({ ...chapter, order }));
const imagesOf = (state: HelpState) => [...new Set(chaptersOf(state)
  .flatMap(chapter => [...(state.bodies[chapter.id] ?? '').matchAll(/\]\(\.\/(images\/[a-z0-9-]+\.png)\)/gu)].map(match => match[1])))];
function renderBody(state: HelpState, id: string): string {
  const resolved = (state.bodies[id] ?? '').replace(/\{\{ui:([^{}]*)\}\}/gu, (_token, key: string) => state.labels[key] ?? '');
  return resolved.split('\n\n').map(block => {
    const image = /^!\[([^\]]*)\]\(\.\/(images\/[a-z0-9-]+\.png)\)$/u.exec(block);
    return image === null ? `<p>${escapeHtml(block)}</p>` : `<p><img src="../${image[2]}" alt="${escapeHtml(image[1])}"/></p>`;
  }).join('');
}
const article = (state: HelpState, id: string, prefix: string) =>
  `<article id="chapter-${id}" lang="ja"><h1 id="${prefix}${id}">${escapeHtml(state.titles[id] ?? '')}</h1>${renderBody(state, id)}</article>`;
/** Same page shape as packages/ui/src/help/manualPages.tsx: one article per chapter in chapter and volume pages. */
function pagesOf(state: HelpState): Map<string, string> {
  const page = (title: string, body: string) => '<!doctype html><html lang="ja"><head><meta charSet="utf-8"/>'
    + `<title>${escapeHtml(title)} — PointerCAD 取扱説明書</title></head><body><main id="main">${body}</main></body></html>`;
  const pages = new Map<string, string>();
  for (const chapter of chaptersOf(state)) pages.set(`chapters/${chapter.id}.html`, page(chapter.title, article(state, chapter.id, 'help-')));
  for (const volume of state.volumes) {
    pages.set(`volumes/${volume.id}.html`, page(volume.title, `<section><h1>${escapeHtml(volume.title)}</h1></section>`
      + volume.topics.map(id => article(state, id, `${id}-help-`)).join('\n')));
  }
  pages.set('index.html', page('PointerCAD 取扱説明書', `<h1>PointerCAD 取扱説明書</h1><ol>${chaptersOf(state)
    .map(chapter => `<li><a href="chapters/${chapter.id}.html">${escapeHtml(chapter.title)}</a></li>`).join('')}</ol>`));
  return pages;
}
const noPending: readonly string[] = [];
const featureCoverageOf = (state: HelpState) => ({
  entries: state.features.map((feature, index) => ({ id: feature.id, sourceLine: 100 + index, description: `模擬の機能 ${feature.id}`,
    priority: 'Must', featureId: feature.id, topicIds: [...feature.topicIds] })),
  pending: noPending, contentCertified: false,
});
const commandCoverageOf = (state: HelpState) => state.commands
  .map(command => ({ commandId: command.commandId, topicId: command.topicId, chapterPath: `docs/ja/${command.topicId}.md` }));

/** A manual edition generated like scripts/manual/generate.mjs, with its HTML and PDF volumes. */
function generateManual(state: HelpState) {
  const outputs = new Map<string, Uint8Array>([...pagesOf(state)].map(([name, text]) => [name, bytes(text)] as const));
  const featureCoverage = featureCoverageOf(state), commandCoverage = commandCoverageOf(state);
  outputs.set('feature-coverage.json', bytes(JSON.stringify({ format: 'pointercad-help-coverage/1', features: featureCoverage,
    commands: commandCoverage, supplementary: SUPPLEMENTARY, nativeControls: NATIVE_CONTROLS, releaseCertified: false }, null, 2)));
  for (const name of imagesOf(state)) outputs.set(name, IMAGES.get(name) ?? bytes(name));
  outputs.set('manual.css', bytes('body{}'));
  outputs.set('manualSearch.js', bytes('/* search */'));
  outputs.set('fonts/LICENSES.txt', bytes(FONT_NOTICE));
  const outputHashes = Object.fromEntries([...outputs].map(([name, value]) => [name, hash(value)]));
  const manifest = { format: 'pointercad-manual/1', releaseCertified: false, sourceCommit, dirtySources: false, inputs: manualInputs,
    images: Object.fromEntries(imagesOf(state).map(name => [name, { sha256: hash(outputs.get(name) ?? bytes(name)), captureCertified: false }])),
    outputs: outputHashes, chapters: chaptersOf(state), volumes: state.volumes, featureCoverage, commandCoverage,
    supplementaryCoverage: SUPPLEMENTARY, nativeControlCoverage: NATIVE_CONTROLS,
    buildId: hash(JSON.stringify({ inputs: manualInputs, outputs: outputHashes })) };
  const manifestBytes = json(manifest), manual = new Map(outputs);
  manual.set('manifest.json', manifestBytes);
  const pdf = new Map<string, Uint8Array>([['LICENSES.txt', bytes(FONT_NOTICE)]]);
  for (const volume of state.volumes) pdf.set(`${volume.id}.pdf`, bytes(`%PDF-1.7 ${volume.id}`));
  pdf.set('pdf-manifest.json', json({ format: 'pointercad-manual-pdf/1', completed: true, manualBuildId: manifest.buildId,
    manualManifestSha256: hash(manifestBytes), fontNoticeSha256: hash(FONT_NOTICE), volumes: state.volumes.map(volume => {
      const printed = pdf.get(`${volume.id}.pdf`) ?? bytes(volume.id);
      return { id: volume.id, name: `${volume.id}.pdf`, title: volume.title, source: `volumes/${volume.id}.html`, bytes: printed.byteLength,
        sha256: hash(printed), content: { chapters: volume.topics.map(id => `chapter-${id}`) } };
    }) }));
  return { manual, pdf };
}

/** The current help as loadCurrentHelp returns it, with verifyManualConsistency standing in for the live renderer. */
function currentHelpOf(state: HelpState): CurrentHelpEdition {
  const expected = { chapters: chaptersOf(state), volumes: state.volumes, pages: pagesOf(state),
    images: new Map(imagesOf(state).map(name => [name, IMAGES.get(name) ?? bytes(name)] as const)),
    featureCoverage: featureCoverageOf(state), commandCoverage: commandCoverageOf(state),
    supplementaryCoverage: SUPPLEMENTARY, nativeControlCoverage: NATIVE_CONTROLS };
  return {
    chapters: chaptersOf(state), volumes: state.volumes, featureCoverage: featureCoverageOf(state), commandCoverage: commandCoverageOf(state),
    chapterSources: new Map(chaptersOf(state).map(chapter => [chapter.id, `# ${chapter.title}\n\n${state.bodies[chapter.id] ?? ''}\n`] as const)),
    uiLabels: state.labels,
    // help-content's assertDocumentedFeatureCoverage is TypeScript of another composite project; the CLI loads the real one.
    assertDocumentedFeatureCoverage: coverage => {
      if (coverage.pending.length > 0) throw new Error(`Undocumented features: ${coverage.pending.join(', ')}`);
    },
    verifyManualEdition: manualFiles => verifyManualConsistency(manualFiles, expected),
  };
}

function desktopCandidate(manual: ReturnType<typeof generateManual>, platform: 'win32' | 'linux'): ReleaseCandidateInput {
  const desktop = new Map<string, Uint8Array>([
    ['main/main.cjs', bytes("require('electron');")], ['preload/preload.cjs', bytes("require('electron');")],
    ...['renderer/index.html', 'renderer/fonts/LICENSES.txt', 'renderer/licenses/math-notices.json',
      'renderer/licenses/runtime/runtime-notices.json', 'renderer/LICENSE', 'renderer/NOTICE',
      'renderer/licenses/exact-math/manifest.json', 'renderer/exact-math/runtime/pyodide.asm.wasm',
      'renderer/assets/opencascade.full-example.wasm', 'renderer/assets/quickjs-pcad-example.wasm']
      .map(name => [name, bytes(name)] as const),
  ]);
  desktop.set('desktop-build.json', json({ format: 'pointercad-desktop-build/1', inputs: desktopInputs,
    outputs: Object.fromEntries([...desktop].map(([name, value]) => [name, hash(value)])) }));
  const result = assembleDesktopDistribution(files(desktop), files(manual.manual), files(manual.pdf),
    new Map([['LICENSE', bytes('license')], ['NOTICE', bytes('notice')]]),
    { version, sourceCommit, platform, arch: 'x64', electronVersion: '44.1.0', builderVersion: '26.15.3' });
  const packageManifestBytes = result.files.get('desktop-package.json');
  if (packageManifestBytes === undefined) throw new Error('Missing fixture package inventory');
  const stagedFiles = files(result.files);
  const artifacts = desktopPackagePlan(platform, version).map(item => ({ name: item.name, bytes: bytes(item.name).length, sha256: hash(item.name) }));
  const receipt = { format: 'pointercad-desktop-candidate/1', version, sourceCommit, platform, arch: 'x64', signed: false, assets: artifacts,
    packages: verifyDesktopPackageArtifacts(platform, version, artifacts), application: verifyDesktopDistribution(stagedFiles, packageManifestBytes),
    installed: false, releaseCertified: false };
  return { receiptBytes: json(receipt), packageManifestBytes, stagedFiles, artifacts };
}

function readmeFor(installerUrl = `${DOWNLOAD}/${INSTALLER.name}`): string {
  const pdf = BASE.volumes.map(volume => `[${volume.title}](${SITE}/manual/pdf/${volume.id}.pdf)`).join(' ・ ');
  return ['# PointerCAD', '', RELEASE_LINKS_START, '| 利用方法 | 公開先 |', '|---|---|',
    `| Windows版のインストーラーをダウンロード | [${INSTALLER.name}](${installerUrl}) |`,
    `| Windowsポータブル版をダウンロード | [${PORTABLE.name}](${DOWNLOAD}/${PORTABLE.name}) |`,
    `| Linux版のAppImageをダウンロード | [${APP_IMAGE.name}](${DOWNLOAD}/${APP_IMAGE.name}) |`,
    `| 取扱説明書を読む・ダウンロード（HTML / PDF） | [HTML の目次](${SITE}/manual/) ・ PDF: ${pdf} |`,
    `| Webアプリ版をブラウザで使う | [${SITE}/](${SITE}/) |`, RELEASE_LINKS_END, ''].join('\n');
}
/** README.md's release-links region for the desktop-first release: the Web row deferred, the manual as PDF volumes of the Release. */
function desktopReadme(): string {
  const pdf = BASE.volumes.map(volume => `[${volume.title}](${DOWNLOAD}/${manualPdfReleaseAssetName(version, volume.id)})`).join(' ・ ');
  return ['# PointerCAD', '', RELEASE_LINKS_START, '| 利用方法 | 公開先 |', '|---|---|',
    `| Windows版のインストーラーをダウンロード | [${INSTALLER.name}](${DOWNLOAD}/${INSTALLER.name}) |`,
    `| Windowsポータブル版をダウンロード | [${PORTABLE.name}](${DOWNLOAD}/${PORTABLE.name}) |`,
    `| Linux版のAppImageをダウンロード | [${APP_IMAGE.name}](${DOWNLOAD}/${APP_IMAGE.name}) |`,
    `| 取扱説明書（PDF 全7巻。アプリ内のヘルプでも読めます） | ${pdf} |`,
    `| Webアプリ版をブラウザで使う | ${WEB_DEFERRED_PHRASE}（公開したらここにリンクを掲載します） |`, RELEASE_LINKS_END, ''].join('\n');
}

const freshCaptures: CaptureFreshnessHook = () => ({ stale: [], unregistered: [] });
interface CandidateOptions {
  readonly manualState?: HelpState;
  readonly readme?: string;
  readonly unresolvedNotices?: readonly string[];
}
/** A complete, self-consistent candidate: Web, both desktop stages, release-manifest.json, sbom.json and README. */
async function buildCandidate(options: CandidateOptions = {}): Promise<PreReleaseInput> {
  const manual = generateManual(options.manualState ?? BASE);
  const web = new Map<string, Uint8Array>([['index.html', bytes('<!doctype html><title>PointerCAD</title>')],
    ['service-worker.js', bytes('self.addEventListener("fetch", () => undefined);')], ['_headers', bytes('/*\n  X-Content-Type-Options: nosniff\n')],
    ['licenses/runtime/mock-notice.txt', NOTICE]]);
  web.set('web-build.json', json({ format: 'pointercad-web-build/1', sourceCommit, dirtySources: false, inputs: webInputs,
    outputs: Object.fromEntries([...web].map(([name, value]) => [name, hash(value)])) }));
  const webFiles = files(assembleOfflineDistribution(files(web), files(manual.manual), files(manual.pdf)).files);
  const candidates = [desktopCandidate(manual, 'win32'), desktopCandidate(manual, 'linux')];
  const manifest = await createReleaseManifest({ packageFiles, builderConfig, tag: null, sourceCommit, sourceInputs, candidates, webFiles });
  const sbom = assembleSbomDocument({ components: [{ type: 'library', name: 'mock-runtime', version: '2.0.0', purl: 'pkg:npm/mock-runtime@2.0.0',
    licenses: [{ license: { id: 'MIT' } }],
    properties: [{ name: 'pointercad:distributedFile', value: `licenses/runtime/mock-notice.txt|${hash(NOTICE)}` }] }],
  unresolvedNotices: options.unresolvedNotices ?? [] }, { rootPackageVersion: version, sourceCommit });
  return { mode: 'pre-release', packageFiles, builderConfig, readme: options.readme ?? readmeFor(), sourceCommit, sourceInputs, candidates,
    webFiles, releaseManifest: json(manifest), sbom: json(sbom), currentHelp: currentHelpOf(BASE), captureFreshness: freshCaptures };
}
function required<T>(value: T | null): T {
  if (value === null) throw new Error('Missing fixture part');
  return value;
}
const statusOf = (report: ReleaseReadinessReport, id: string) => report.checks.find(check => check.id === id)?.status;
const problemsOf = (report: ReleaseReadinessReport, id: string) => report.checks.find(check => check.id === id)?.problems.join('\n') ?? '';

describe('公開前の整合検査は組み立て済みの候補を1つの入口で判定する', () => {
  it('正しい模擬の一式では全14項目が合格し、終了コード0', async () => {
    const report = await evaluateReleaseReadiness(await buildCandidate());
    expect(report.checks.map(check => check.id)).toEqual(RELEASE_READINESS_CHECK_IDS);
    expect(report.checks.filter(check => check.status !== 'pass').map(check => `${check.id}: ${check.problems.join(' / ')}`)).toEqual([]);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.ready);
    expect(report.releaseCertified).toBe(false);
  });

  // The candidate is regenerated from a manual that differs in one place, so every hash-level record stays
  // self-consistent (release-manifest passes) and only the meaning check of that condition can notice.
  it.each([
    { name: '欠章', id: 'manual-chapters', message: '欠章: files',
      state: { ...BASE, volumes: BASE.volumes.map(volume => volume.id === 'getting-started' ? { ...volume, topics: ['start'] } : volume) } },
    { name: '題名の違い', id: 'manual-chapters', message: '題名の違い（章の記録）: sketch',
      state: { ...BASE, titles: { ...BASE.titles, sketch: 'スケッチを書く' } } },
    { name: '誤ったボタン名', id: 'manual-controls', message: '誤った操作名・ボタン名: manual/chapters/files.html に「書き出す」',
      state: { ...BASE, labels: { ...BASE.labels, 'file.export': '出力する' } } },
    { name: '孤立した機能', id: 'manual-features', message: '孤立した機能（説明書だけにあり、今のヘルプに項目が無い）: FR-999',
      state: { ...BASE, features: [...BASE.features, { id: 'FR-999', topicIds: ['ghost'] }] } },
  ])('$name を1つ入れると0以外', async ({ id, message, state }) => {
    const report = await evaluateReleaseReadiness(await buildCandidate({ manualState: state }));
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, id)).toBe('fail');
    expect(problemsOf(report, id)).toContain(message);
    expect(statusOf(report, 'manual-current')).toBe('fail');
    expect(statusOf(report, 'release-manifest')).toBe('pass');
  });

  it('版の違いを1つ入れると0以外', async () => {
    const input = await buildCandidate();
    const report = await evaluateReleaseReadiness({ ...input, packageFiles: { ...input.packageFiles, web: packageJson('@pointercad/web', '1.0.1') } });
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'versions')).toBe('fail');
    expect(problemsOf(report, 'versions')).toContain('版の違い');
  });

  it('1巻の欠落を1つ入れると0以外', async () => {
    const input = await buildCandidate();
    const webFiles = required(input.webFiles).filter(file => file.path !== 'manual/pdf/drawing.pdf');
    const report = await evaluateReleaseReadiness({ ...input, webFiles });
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'volumes')).toBe('fail');
    expect(problemsOf(report, 'volumes')).toContain('1巻の欠落: Web に「図面・寸法・製図記号」（drawing）の PDF が無い');
  });

  it('誤った導線の種類を1つ入れると0以外', async () => {
    const report = await evaluateReleaseReadiness(await buildCandidate({ readme: readmeFor(`${DOWNLOAD}/${PORTABLE.name}`) }));
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'readme-links')).toBe('fail');
    expect(problemsOf(report, 'readme-links')).toContain('誤った導線の種類: 「Windows版のインストーラーをダウンロード」の行にWindows のポータブル版');
    expect(problemsOf(report, 'readme-links')).toContain('導線が無い: Windows のインストーラー');
  });

  it('大きさの超過を1つ入れると0以外', async () => {
    const input = await buildCandidate();
    const webFiles = [...required(input.webFiles), { path: 'assets/huge.bin', bytes: new Uint8Array(PAGES_MAX_FILE_BYTES + 1) }];
    const report = await evaluateReleaseReadiness({ ...input, webFiles });
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'asset-size')).toBe('fail');
    expect(problemsOf(report, 'asset-size')).toContain('大きさの超過: assets/huge.bin 26,214,401 バイト');
  });

  it('数の超過を1つ入れると0以外', async () => {
    const input = await buildCandidate(), original = required(input.webFiles);
    const extra = Array.from({ length: PAGES_MAX_FILES + 1 - original.length }, (_, index) => ({ path: `assets/extra-${String(index)}.js`, bytes: bytes('x') }));
    const report = await evaluateReleaseReadiness({ ...input, webFiles: [...original, ...extra] });
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'asset-count')).toBe('fail');
    expect(problemsOf(report, 'asset-count')).toContain('数の超過: 1,001 ファイル');
    expect(statusOf(report, 'asset-size')).toBe('pass');
  });

  it('SBOM の原文の欠けを1つ入れると0以外', async () => {
    const report = await evaluateReleaseReadiness(await buildCandidate({ unresolvedNotices: ['missing-package@1.0.0'] }));
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'sbom-notices')).toBe('fail');
    expect(problemsOf(report, 'sbom-notices')).toContain('原文の欠け: missing-package@1.0.0');
    expect(statusOf(report, 'sbom-manifest')).toBe('pass');
  });

  it('撮影の登録簿が未接続なら今の版の画像は保留にし、終了コード2（ほかの13項目は合格）', async () => {
    const report = await evaluateReleaseReadiness({ ...await buildCandidate(), captureFreshness: null });
    expect(statusOf(report, 'manual-images')).toBe('pending');
    expect(report.checks.filter(check => check.id !== 'manual-images' && check.status !== 'pass')).toEqual([]);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.pending);
  });

  it('つなぐ口: 登録簿が古い画像を返すと0以外（登録簿の完成後に古い画像の検査へ使う）', async () => {
    const requests: CaptureFreshnessRequest[] = [];
    const report = await evaluateReleaseReadiness({ ...await buildCandidate(), captureFreshness: request => {
      requests.push(request);
      return { stale: request.images.map(image => image.path), unregistered: [] };
    } });
    expect(requests.map(request => request.images)).toEqual([[{ path: IMAGE, sha256: hash(IMAGES.get(IMAGE) ?? IMAGE) }]]);
    expect(statusOf(report, 'manual-images')).toBe('fail');
    expect(problemsOf(report, 'manual-images')).toContain(`古い画像（今の版の撮影でない）: ${IMAGE}`);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
  });

  it('読めない部分があっても他の項目を判定し、読めない理由を示して0以外', async () => {
    const report = await evaluateReleaseReadiness({ ...await buildCandidate(), sbom: null, readErrors: { sbom: 'ENOENT: sbom.json' } });
    expect(statusOf(report, 'sbom-notices')).toBe('fail');
    expect(problemsOf(report, 'sbom-notices')).toContain('ENOENT: sbom.json');
    expect(statusOf(report, 'manual-chapters')).toBe('pass');
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
  });

  it('README の導線: 全種類・配布対象版・未公開の案内・仮の公開先・巻・区間の印を確かめる', () => {
    const volumeIds = BASE.volumes.map(volume => volume.id);
    expect(checkReadmeReleaseLinks(readmeFor(), { version, volumeIds }).problems).toEqual([]);
    const variants: readonly (readonly [string, string])[] = [
      [readmeFor().replace(`[${PORTABLE.name}](${DOWNLOAD}/${PORTABLE.name})`, '1つの.exeで配布する方式を準備中'), '未公開の案内が残っている: 「準備中」'],
      [readmeFor(`https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v0.9.0/${INSTALLER.name}`), '配布対象版と違うタグ'],
      [readmeFor(`https://github.com/oltotlo79-rgb/PointerCAD/releases/latest/download/${INSTALLER.name}`), '版を固定しない latest の URL'],
      [readmeFor().replaceAll(SITE, 'https://example.com'), '仮の公開先'],
      [readmeFor().replace(`${SITE}/manual/pdf/drawing.pdf`, `${SITE}/manual/pdf/ghost.pdf`), '今の目録に無い巻への導線'],
      [readmeFor().replace(RELEASE_LINKS_END, ''), '区間の印が1組でない'],
    ];
    for (const [readme, message] of variants) {
      expect(checkReadmeReleaseLinks(readme, { version, volumeIds }).problems.join('\n')).toContain(message);
    }
    // An unknown volume list still checks every other kind and requires at least one PDF link.
    expect(checkReadmeReleaseLinks(readmeFor(), { version, volumeIds: null }).problems).toEqual([]);
    const withoutPdf = readmeFor().replace(/ ・ PDF: .*? \|/u, ' |');
    expect(checkReadmeReleaseLinks(withoutPdf, { version, volumeIds: null }).problems).toEqual(['導線が無い: 取扱説明書の PDF']);
  });

  it('公開後モードは引数の形だけを受け、未実装として終了コード3', async () => {
    const options = parseReleaseReadinessArguments(['--mode', 'post-release', '--release', 'release-output',
      '--web-url', `${SITE}/`, '--download-url', `${DOWNLOAD}/`]);
    expect(options).toMatchObject({ mode: 'post-release', release: 'release-output', webUrl: `${SITE}/`, downloadUrl: `${DOWNLOAD}/` });
    const report = await evaluateReleaseReadiness({ mode: 'post-release', releaseManifest: (await buildCandidate()).releaseManifest,
      webUrl: options.webUrl ?? '', downloadUrl: options.downloadUrl ?? '' });
    expect(report.checks.map(check => check.status)).toEqual(['not-implemented']);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.notImplemented);
  });

  it('引数: 公開前は dist/ 直下の5つの名前を受け、誤りは使い方の誤り(64)で止める', async () => {
    const names = ['--windows', 'desktop-stage-windows', '--linux', 'desktop-stage-linux', '--web', 'web-candidate',
      '--release', 'release-output', '--sbom', 'sbom-output'];
    expect(parseReleaseReadinessArguments(names)).toMatchObject({ mode: 'pre-release', windows: 'desktop-stage-windows', sbom: 'sbom-output' });
    for (const args of [[], names.slice(0, 8), [...names.slice(0, 9), '../outside'], [...names.slice(0, 9), 'web-candidate'],
      [...names, '--web-url', `${SITE}/`], ['--unknown', 'x'],
      ['--mode', 'post-release', '--release', 'release-output', '--web-url', 'http://pointercad.pages.dev/', '--download-url', `${DOWNLOAD}/`],
      ['--mode', 'post-release', '--release', 'release-output', '--web-url', `${SITE}/`, '--download-url', 'https://github.com/o/r/releases/latest/']]) {
      expect(() => parseReleaseReadinessArguments(args)).toThrow(ReleaseReadinessUsageError);
    }
    const lines: string[] = [];
    await expect(runReleaseReadiness(['--unknown', 'x'], { write: text => { lines.push(text); } })).resolves.toBe(RELEASE_READINESS_EXIT.usage);
    expect(lines.join('\n')).toContain('使い方');
  });

  it('人が読める一覧に全項目の判定・問題・合計と終了コードを出す', async () => {
    const input = await buildCandidate();
    const report = await evaluateReleaseReadiness({ ...input, captureFreshness: null,
      packageFiles: { ...input.packageFiles, web: packageJson('@pointercad/web', '1.0.1') } });
    const text = formatReleaseReadinessReport(report, { targets: ['dist/web-candidate'] });
    for (const check of report.checks) expect(text).toContain(`${check.group} ${check.title}`);
    expect(text).toContain('[不合格] 版 3つの package.json');
    expect(text).toContain('    ・版の違い: ');
    expect(text).toContain('[保留] 説明書④');
    expect(text).toContain('終了コード 1（公開できない）');
  });
});

describe('説明書④: 画像が今の版の撮影の生成物であること（captureFreshnessFromRegistry で撮影の登録簿と照合する）', () => {
  const CURRENT_DIGEST = 'a'.repeat(64), OLD_DIGEST = 'b'.repeat(64);
  const imageFile = (name: string) => ({ path: `images/${name}`, bytes: bytes(`png:${name}`) });
  const registryEntry = (name: string, applicationBuildId: string | null, sha256Value: string): CaptureRegistryEntry => ({
    file: name, sha256: sha256Value, viewport: [1440, 900], viewportClass: 'standard', viewportSource: 'png-size',
    script: null, scriptSha256: null, fixtureSha256: null, capturedAt: null, applicationBuildId, unknown: {}, records: [],
  });
  const registryOf = (entries: readonly CaptureRegistryEntry[]): CaptureRegistry =>
    ({ format: CAPTURE_REGISTRY_FORMAT, viewportPolicy: CAPTURE_VIEWPORT_POLICY, unknownReasons: CAPTURE_UNKNOWN_REASONS, images: entries });
  const startImage = imageFile('start-screen.png'), sketchImage = imageFile('sketch-screen.png');

  it('登録簿の全件が今の版（同じアプリの入力の指紋）の撮影なら合格（stale も unregistered も空）', () => {
    const registry = registryOf([
      registryEntry('start-screen.png', CURRENT_DIGEST, hash(startImage.bytes)),
      registryEntry('sketch-screen.png', CURRENT_DIGEST, hash(sketchImage.bytes)),
    ]);
    const result = captureFreshnessFromRegistry(registry, [startImage, sketchImage], { applicationBuildId: CURRENT_DIGEST });
    expect(result.stale).toEqual([]);
    expect(result.unregistered).toEqual([]);
  });

  it('1件が古い版（別の指紋）の撮影なら不合格（その画像だけ stale）', () => {
    const registry = registryOf([
      registryEntry('start-screen.png', CURRENT_DIGEST, hash(startImage.bytes)),
      registryEntry('sketch-screen.png', OLD_DIGEST, hash(sketchImage.bytes)),
    ]);
    const result = captureFreshnessFromRegistry(registry, [startImage, sketchImage], { applicationBuildId: CURRENT_DIGEST });
    expect(result.stale).toEqual([sketchImage.path]);
    expect(result.unregistered).toEqual([]);
  });

  it('登録簿に無い画像が1件あれば不合格（その画像だけ unregistered）', () => {
    const registry = registryOf([registryEntry('start-screen.png', CURRENT_DIGEST, hash(startImage.bytes))]);
    const result = captureFreshnessFromRegistry(registry, [startImage, sketchImage], { applicationBuildId: CURRENT_DIGEST });
    expect(result.stale).toEqual([]);
    expect(result.unregistered).toEqual([sketchImage.path]);
  });

  it('版が不明（applicationBuildId が null）な画像は不合格（stale）', () => {
    const registry = registryOf([
      registryEntry('start-screen.png', CURRENT_DIGEST, hash(startImage.bytes)),
      registryEntry('sketch-screen.png', null, hash(sketchImage.bytes)),
    ]);
    const result = captureFreshnessFromRegistry(registry, [startImage, sketchImage], { applicationBuildId: CURRENT_DIGEST });
    expect(result.stale).toEqual([sketchImage.path]);
    expect(result.unregistered).toEqual([]);
  });

  it('checkImages のつなぎ口として使うと、登録簿の古い画像で説明書④の検査が不合格になる', async () => {
    const registry = registryOf([registryEntry('start-screen.png', OLD_DIGEST, hash(IMAGES.get(IMAGE) ?? bytes(IMAGE)))]);
    const report = await evaluateReleaseReadiness({ ...await buildCandidate(), captureFreshness: request => captureFreshnessFromRegistry(
      registry, request.images.map(image => ({ path: image.path, bytes: IMAGES.get(image.path) ?? bytes(image.path) })),
      { applicationBuildId: CURRENT_DIGEST }) });
    expect(statusOf(report, 'manual-images')).toBe('fail');
    expect(problemsOf(report, 'manual-images')).toContain(`古い画像（今の版の撮影でない）: ${IMAGE}`);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
  });
});

describe('説明書モード（P12-20）: 生成した説明書だけを、公開前モードと同じ説明書の5項目で判定する', () => {
  const CURRENT_DIGEST = 'a'.repeat(64);
  /** The capture folder holds today's image and its registry entry is this build's capture (fresh). */
  const freshRegistry: CaptureRegistry = { format: CAPTURE_REGISTRY_FORMAT, viewportPolicy: CAPTURE_VIEWPORT_POLICY, unknownReasons: CAPTURE_UNKNOWN_REASONS,
    images: [{ file: 'start-screen.png', sha256: hash(IMAGES.get(IMAGE) ?? IMAGE), viewport: [1440, 900], viewportClass: 'standard',
      viewportSource: 'png-size', script: null, scriptSha256: null, fixtureSha256: null, capturedAt: null, applicationBuildId: CURRENT_DIGEST,
      unknown: {}, records: [] }] };
  /** Same comparison as loadCaptureFreshness: the capture folder's bytes and the manual's own copies. */
  const captureFolder: CaptureFreshnessHook = request => captureFreshnessFromRegistry(freshRegistry,
    request.images.map(image => ({ path: image.path, bytes: IMAGES.get(image.path) ?? bytes(image.path) })),
    { applicationBuildId: CURRENT_DIGEST, manualImages: request.images });
  const manualOf = (state: HelpState) => files(generateManual(state).manual);
  const manualInput = (manualFiles: ManualReleaseInput['manualFiles'], captureFreshness: CaptureFreshnessHook | null = captureFolder): ManualReleaseInput =>
    ({ mode: 'manual', manualFiles, currentHelp: currentHelpOf(BASE), captureFreshness });
  /** A temporary copy of the correct manual with one file changed; every other file, manifest.json included, stays as generated. */
  const injected = (path: string, change: (text: string) => string) => manualOf(BASE)
    .map(file => file.path === path ? { path, bytes: bytes(change(new TextDecoder().decode(file.bytes))) } : file);
  const replace = (from: string, to: string) => (text: string) => {
    if (!text.includes(from)) throw new Error(`Missing fixture text: ${from}`);
    return text.replace(from, to);
  };

  it('正しい一式だけが0: 説明書の5項目が全て合格し、公開前モードの説明書の項目と同じ並び', async () => {
    const report = await evaluateReleaseReadiness(manualInput(manualOf(BASE)));
    expect(report.mode).toBe('manual');
    expect(report.checks.map(check => check.id)).toEqual(MANUAL_CHECK_IDS);
    expect(MANUAL_CHECK_IDS).toEqual(RELEASE_READINESS_CHECK_IDS.filter(id => id.startsWith('manual-')));
    expect(report.checks.filter(check => check.status !== 'pass').map(check => `${check.id}: ${check.problems.join(' / ')}`)).toEqual([]);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.ready);
    expect(report.releaseCertified).toBe(false);
  });

  it.each([
    { name: '欠章', id: 'manual-chapters', message: '欠章: files「ファイルを保存する」（ページが無い）',
      manual: () => manualOf(BASE).filter(file => file.path !== 'chapters/files.html') },
    { name: '異なる題', id: 'manual-chapters', message: '題名の違い（章のページ）: chapters/sketch.html「スケッチを書く」／ヘルプ「スケッチを描く」',
      manual: () => injected('chapters/sketch.html', replace('>スケッチを描く</h1>', '>スケッチを書く</h1>')) },
    { name: '誤ボタン名（{{ui:キー}} の文言を書き換え）', id: 'manual-controls',
      message: '誤った操作名・ボタン名（今の画面の文言に無い）: manual/chapters/settings.html の settings に「適用する」',
      manual: () => injected('chapters/settings.html', replace('「適用」を押します', '「適用する」を押します')) },
    { name: '誤ボタン名（本文に直接書いた名前）', id: 'manual-controls',
      message: '誤った操作名・ボタン名（今の画面の文言に無い）: manual/chapters/sketch.html の sketch に「線を引く」',
      manual: () => injected('chapters/sketch.html', replace('線を描きます。', '「線を引く」ボタンを押して線を描きます。')) },
    { name: '旧画像', id: 'manual-images', message: `古い画像（今の版の撮影でない）: ${IMAGE}`,
      manual: () => manualOf(BASE).map(file => file.path === IMAGE ? { path: IMAGE, bytes: bytes('PNG older start screen') } : file) },
    { name: '孤立機能', id: 'manual-features', message: '孤立した機能（説明書だけにあり、今のヘルプに項目が無い）: FR-999',
      manual: () => injected('manifest.json', text => {
        const manifest = JSON.parse(text) as { featureCoverage: { entries: unknown[] } };
        manifest.featureCoverage.entries.push({ id: 'FR-999', sourceLine: 999, description: '模擬の孤立した機能', priority: 'Must',
          featureId: 'FR-999', topicIds: ['ghost'] });
        return JSON.stringify(manifest);
      }) },
  ])('$name を1つ注入すると0以外で、理由を示す', async ({ id, message, manual }) => {
    const report = await evaluateReleaseReadiness(manualInput(manual()));
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, id)).toBe('fail');
    expect(problemsOf(report, id)).toContain(message);
    expect(statusOf(report, 'manual-current')).toBe('fail');
  });

  it('{{ui:キー}} の文言を含む別の名前（「適用」→「適用する」）は回数の照合では通るため、直接の名前の照合で落とす', async () => {
    const report = await evaluateReleaseReadiness(manualInput(injected('chapters/settings.html', replace('「適用」を押します', '「適用する」を押します'))));
    expect(problemsOf(report, 'manual-controls')).not.toContain('が 1 回必要なところ 0 回');
    expect(report.checks.find(check => check.id === 'manual-controls')?.problems).toHaveLength(1);
  });

  it('公開前モード（P13-15）は同じ判定処理を呼ぶ: 同じ説明書なら説明書の5項目の結果が一致する', async () => {
    const state: HelpState = { ...BASE, bodies: { ...BASE.bodies, sketch: '「線を引く」ボタンを押して線を描きます。' } };
    const preRelease = await evaluateReleaseReadiness(await buildCandidate({ manualState: state }));
    const manual = await evaluateReleaseReadiness(manualInput(manualOf(state), freshCaptures));
    expect(preRelease.checks.filter(check => MANUAL_CHECK_IDS.includes(check.id))).toEqual(manual.checks);
    expect(problemsOf(manual, 'manual-controls')).toContain('誤った操作名・ボタン名（今の画面の文言に無い）: manual/chapters/sketch.html の sketch に「線を引く」');
    expect(problemsOf(manual, 'manual-controls')).toContain('誤った操作名・ボタン名（今の画面の文言に無い）: manual/volumes/sketch-and-functions.html の sketch に「線を引く」');
  });

  it('説明書を読めないときは5項目とも理由付きで不合格、撮影の登録簿が未接続なら④だけ保留で終了コード2', async () => {
    const unreadable = await evaluateReleaseReadiness({ ...manualInput(null), readErrors: { manual: 'ENOENT: dist/manual-missing' } });
    expect(unreadable.checks.map(check => check.status)).toEqual(MANUAL_CHECK_IDS.map(() => 'fail'));
    expect(problemsOf(unreadable, 'manual-chapters')).toContain('ENOENT: dist/manual-missing');
    expect(unreadable.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    const pending = await evaluateReleaseReadiness(manualInput(manualOf(BASE), null));
    expect(statusOf(pending, 'manual-images')).toBe('pending');
    expect(pending.exitCode).toBe(RELEASE_READINESS_EXIT.pending);
  });

  it('引数: --mode manual は dist/ 直下の説明書の名前1つだけを受け、一覧は説明書モードの見出しと意味を出す', async () => {
    expect(parseReleaseReadinessArguments(['--mode', 'manual', '--manual', 'manual-preview-20260927']))
      .toMatchObject({ mode: 'manual', manual: 'manual-preview-20260927' });
    for (const args of [['--mode', 'manual'], ['--mode', 'manual', '--manual', '../outside'],
      ['--mode', 'manual', '--manual', 'manual-preview', '--web', 'web-candidate'], ['--mode', 'pre-release', '--manual', 'manual-preview']]) {
      expect(() => parseReleaseReadinessArguments(args)).toThrow(ReleaseReadinessUsageError);
    }
    const text = formatReleaseReadinessReport(await evaluateReleaseReadiness(manualInput(manualOf(BASE))), { targets: ['dist/manual-preview'] });
    expect(text).toContain('PointerCAD 説明書の整合検査（説明書モード・P12-20）');
    expect(text).toContain('[合格] 説明書② 操作名・ボタン名が今の画面の文言と一致する — 画面の文言の参照 4件・本文に直接書いたボタン名 2件');
    expect(text).toContain('終了コード 0（説明書の整合4条件と出力全体の一致を満たす）');
  });
});

describe('デスクトップ先行（--scope desktop。2026-09-27 の利用者の指示）: Web 版の公開を待たずにデスクトップ版を判定する', () => {
  const WEB_ROW = `| Webアプリ版をブラウザで使う | ${WEB_DEFERRED_PHRASE}（公開したらここにリンクを掲載します） |`;
  const change = (readme: string, from: string, to: string) => {
    if (!readme.includes(from)) throw new Error(`Missing fixture text: ${from}`);
    return readme.replace(from, to);
  };
  const desktopCandidateInput = async (readme = desktopReadme()): Promise<PreReleaseInput> => ({ ...await buildCandidate({ readme }), scope: 'desktop' });

  it('正しい一式と Desktop 先行の README なら、Web のファイルの上限の2項目だけ後回しにして全14項目を判定し、終了コード0', async () => {
    const report = await evaluateReleaseReadiness(await desktopCandidateInput());
    expect(report.scope).toBe('desktop');
    expect(report.checks.map(check => check.id)).toEqual(RELEASE_READINESS_CHECK_IDS);
    expect(report.checks.filter(check => check.status === 'deferred').map(check => check.id)).toEqual([...DESKTOP_DEFERRED_CHECK_IDS]);
    expect(report.checks.filter(check => check.status !== 'pass' && check.status !== 'deferred')
      .map(check => `${check.id}: ${check.problems.join(' / ')}`)).toEqual([]);
    expect(report.summary).toEqual({ pass: 12, fail: 0, pending: 0, notImplemented: 0, deferred: 2 });
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.ready);
    expect(report.releaseCertified).toBe(false);
    const text = formatReleaseReadinessReport(report);
    expect(text).toContain('PointerCAD 公開前の整合検査（公開前モード・デスクトップ先行（Web 版の項目は後回し））');
    expect(text).toContain('[後回し] 資産 Web の各ファイルが 26,214,400 バイト以下 — Web 版の公開時に判定する');
    expect(text).toContain('・後回し 2 → 終了コード 0（デスクトップ版の公開前の全項目を満たす（Web 版の項目は後回し））');
  });

  it('全体モード（既定と --scope all）は同じ README を今までどおり落とす: Web アプリ版と説明書の HTML を要求し、「後日公開」と Release の PDF を拒否する', async () => {
    for (const scope of [undefined, 'all'] as const) {
      const input = await buildCandidate({ readme: desktopReadme() });
      const report = await evaluateReleaseReadiness(scope === undefined ? input : { ...input, scope });
      expect(report.scope).toBe('all');
      expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
      expect(statusOf(report, 'readme-links')).toBe('fail');
      for (const message of [`未公開の案内が残っている: 「${WEB_DEFERRED_PHRASE}」`, '導線が無い: Web アプリ版', '導線が無い: 取扱説明書の HTML（目次）',
        `配布対象版の配布物でない: ${manualPdfReleaseAssetName(version, 'getting-started')}`]) expect(problemsOf(report, 'readme-links')).toContain(message);
      expect(DESKTOP_DEFERRED_CHECK_IDS.map(id => statusOf(report, id))).toEqual(['pass', 'pass']);
    }
    const volumeIds = BASE.volumes.map(volume => volume.id);
    expect(checkReadmeReleaseLinks(desktopReadme(), { version, volumeIds }).problems).not.toEqual([]);
    expect(checkReadmeReleaseLinks(desktopReadme(), { version, volumeIds, scope: 'desktop' }).problems).toEqual([]);
  });

  it('Web のファイルの上限の超過は、Desktop 先行では後回し（今の判定を参考に残す）、全体モードでは今までどおり不合格', async () => {
    const input = await desktopCandidateInput();
    const webFiles = [...required(input.webFiles), { path: 'assets/huge.bin', bytes: new Uint8Array(PAGES_MAX_FILE_BYTES + 1) }];
    const desktop = await evaluateReleaseReadiness({ ...input, webFiles });
    expect(statusOf(desktop, 'asset-size')).toBe('deferred');
    expect(problemsOf(desktop, 'asset-size')).toBe('');
    expect(desktop.checks.find(check => check.id === 'asset-size')?.notes.join('\n'))
      .toContain('Web 版の公開時に直す（今の判定）: 大きさの超過: assets/huge.bin 26,214,401 バイト');
    const all = await evaluateReleaseReadiness({ ...input, scope: 'all', webFiles });
    expect(statusOf(all, 'asset-size')).toBe('fail');
    expect(problemsOf(all, 'asset-size')).toContain('大きさの超過: assets/huge.bin 26,214,401 バイト');
  });

  it.each([
    { name: '説明書の PDF の1巻の欠け', message: '導線が無い: 取扱説明書の PDF（drawing）',
      readme: () => change(desktopReadme(), ` ・ [図面・寸法・製図記号](${DOWNLOAD}/${manualPdfReleaseAssetName(version, 'drawing')})`, '') },
    { name: 'インストーラーの未公開の案内', message: '導線が無い: Windows のインストーラー',
      readme: () => change(desktopReadme(), `[${INSTALLER.name}](${DOWNLOAD}/${INSTALLER.name})`, '初回リリース時にダウンロードリンクを掲載') },
    { name: 'Web アプリ版以外の行の「後日公開」', message: `「${WEB_DEFERRED_PHRASE}」は Web アプリ版の行だけに書ける: 「Linux版のAppImageをダウンロード」`,
      readme: () => change(desktopReadme(), `[${APP_IMAGE.name}](${DOWNLOAD}/${APP_IMAGE.name})`, WEB_DEFERRED_PHRASE) },
    { name: 'Web アプリ版の行に導線も「後日公開」も無い', message: `導線が無い: Web アプリ版（公開前は Web アプリ版の行に「${WEB_DEFERRED_PHRASE}」と書く）`,
      readme: () => change(desktopReadme(), WEB_ROW, '| Webアプリ版をブラウザで使う | Web版は別の機会に |') },
    { name: '後日公開とした区間の Web の公開先への導線', message: `Web 版を「${WEB_DEFERRED_PHRASE}」とした区間に Web の公開先への導線がある: ${SITE}`,
      readme: () => change(desktopReadme(), '| 取扱説明書（PDF 全7巻。アプリ内のヘルプでも読めます） | ',
        `| 取扱説明書（PDF 全7巻。アプリ内のヘルプでも読めます） | [HTML の目次](${SITE}/manual/) ・ `) },
    { name: '後日公開の行の導線', message: `「${WEB_DEFERRED_PHRASE}」の行に導線がある`,
      readme: () => change(desktopReadme(), WEB_ROW, `| Webアプリ版をブラウザで使う | ${WEB_DEFERRED_PHRASE}（[${SITE}/](${SITE}/)） |`) },
    { name: '別の版の Release の PDF', message: '配布対象版と違うタグ',
      readme: () => change(desktopReadme(), `${DOWNLOAD}/${manualPdfReleaseAssetName(version, 'assembly')}`,
        `https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v0.9.0/${manualPdfReleaseAssetName(version, 'assembly')}`) },
    { name: '今の目録に無い巻の PDF', message: '今の目録に無い巻への導線',
      readme: () => change(desktopReadme(), manualPdfReleaseAssetName(version, 'sheet-and-scripting'), manualPdfReleaseAssetName(version, 'ghost')) },
  ])('Desktop の条件の欠け（$name）は Desktop 先行でも0以外', async ({ message, readme }) => {
    const report = await evaluateReleaseReadiness(await desktopCandidateInput(readme()));
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, 'readme-links')).toBe('fail');
    expect(problemsOf(report, 'readme-links')).toContain(message);
  });

  it('Desktop 先行でも Web の上限以外は緩めない: 版の違い・Web 候補の巻の欠け・SBOM の原文の欠け・撮影の登録簿の未接続は今までどおり', async () => {
    const input = await desktopCandidateInput();
    const versions = await evaluateReleaseReadiness({ ...input, packageFiles: { ...input.packageFiles, web: packageJson('@pointercad/web', '1.0.1') } });
    expect([statusOf(versions, 'versions'), versions.exitCode]).toEqual(['fail', RELEASE_READINESS_EXIT.failed]);
    const volumes = await evaluateReleaseReadiness({ ...input, webFiles: required(input.webFiles).filter(file => file.path !== 'manual/pdf/drawing.pdf') });
    expect(problemsOf(volumes, 'volumes')).toContain('1巻の欠落: Web に「図面・寸法・製図記号」（drawing）の PDF が無い');
    expect(volumes.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    const sbom = await evaluateReleaseReadiness({ ...await buildCandidate({ readme: desktopReadme(), unresolvedNotices: ['missing-package@1.0.0'] }), scope: 'desktop' });
    expect([statusOf(sbom, 'sbom-notices'), sbom.exitCode]).toEqual(['fail', RELEASE_READINESS_EXIT.failed]);
    const pending = await evaluateReleaseReadiness({ ...input, captureFreshness: null });
    expect([statusOf(pending, 'manual-images'), pending.exitCode]).toEqual(['pending', RELEASE_READINESS_EXIT.pending]);
  });

  it('Web 版を公開した後の README（全体モードの一式）も Desktop 先行で合格する（Web の導線と説明書の目次を今までどおり照合する）', async () => {
    const report = await evaluateReleaseReadiness(await desktopCandidateInput(readmeFor()));
    expect(statusOf(report, 'readme-links')).toBe('pass');
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.ready);
    const withoutContents = change(readmeFor(), `[HTML の目次](${SITE}/manual/) ・ `, '');
    expect(checkReadmeReleaseLinks(withoutContents, { version, volumeIds: BASE.volumes.map(volume => volume.id), scope: 'desktop' }).problems)
      .toEqual(['導線が無い: 取扱説明書の HTML（目次）（Web 版を公開したなら説明書の目次も載せる）']);
  });

  it('説明書の PDF を Release に置く名前は版と巻から1通りに決まり、形の違う版・巻を拒否する。説明書モードに Desktop 先行は無い', async () => {
    expect(manualPdfReleaseAssetName('1.0.0', 'drawing')).toBe('PointerCAD-1.0.0-manual-drawing.pdf');
    expect(() => manualPdfReleaseAssetName('v1.0.0', 'drawing')).toThrow('版の形が違う');
    expect(() => manualPdfReleaseAssetName('1.0.0', '../drawing')).toThrow('巻の名前の形が違う');
    const manual = { mode: 'manual', scope: 'desktop', manualFiles: files(generateManual(BASE).manual), currentHelp: currentHelpOf(BASE),
      captureFreshness: freshCaptures } as const;
    // The type has no scope for manual mode; a caller written in JavaScript can still pass one, and it is refused.
    await expect(evaluateReleaseReadiness(manual as ManualReleaseInput)).rejects.toThrow('Manual mode has no desktop scope');
  });

  it('引数: --scope は all・desktop だけ。公開後の desktop は --web-url を取らず --download-url を要し、全体の公開後は今までどおり --web-url を要する', () => {
    const names = ['--windows', 'desktop-stage-windows', '--linux', 'desktop-stage-linux', '--web', 'web-candidate',
      '--release', 'release-output', '--sbom', 'sbom-output'];
    expect(parseReleaseReadinessArguments(names).scope).toBe('all');
    expect(parseReleaseReadinessArguments(['--scope', 'desktop', ...names])).toMatchObject({ mode: 'pre-release', scope: 'desktop', web: 'web-candidate' });
    const post = ['--mode', 'post-release', '--scope', 'desktop', '--release', 'release-output', '--download-url', `${DOWNLOAD}/`];
    const options = parseReleaseReadinessArguments(post);
    expect(options).toMatchObject({ mode: 'post-release', scope: 'desktop', release: 'release-output', downloadUrl: `${DOWNLOAD}/` });
    expect(options.webUrl).toBeUndefined();
    for (const args of [['--scope', 'web', ...names], ['--mode', 'manual', '--scope', 'desktop', '--manual', 'manual-preview'],
      ['--mode', 'manual', '--scope', 'all', '--manual', 'manual-preview'], [...post, '--web-url', `${SITE}/`], post.slice(0, 6),
      ['--mode', 'post-release', '--scope', 'desktop', '--release', 'release-output', '--download-url', 'https://github.com/o/r/releases/latest/'],
      ['--mode', 'post-release', '--release', 'release-output', '--download-url', `${DOWNLOAD}/`]]) {
      expect(() => parseReleaseReadinessArguments(args)).toThrow(ReleaseReadinessUsageError);
    }
  });
});

describe('公開後モードの Desktop 部分（P13-20 の Desktop 側）: GitHub Release から取得して公開一覧と README を照合する', () => {
  const RELEASE_BASE = `${DOWNLOAD}/`;
  /** The GitHub Release as the coordinator publishes it: the three packages and the Web candidate's PDF volumes, renamed. */
  async function publishedRelease() {
    const input = await buildCandidate();
    const releaseManifest = required(input.releaseManifest);
    const manifest = JSON.parse(new TextDecoder().decode(releaseManifest)) as { manual: { volumes: { id: string; pdf: string }[] } };
    const web = new Map(required(input.webFiles).map(file => [file.path, file.bytes] as const));
    const assets = new Map<string, Uint8Array>();
    for (const item of [...desktopPackagePlan('win32', version), ...desktopPackagePlan('linux', version)]) assets.set(item.name, bytes(item.name));
    for (const volume of manifest.manual.volumes) assets.set(manualPdfReleaseAssetName(version, volume.id), required(web.get(volume.pdf) ?? null));
    return { releaseManifest, assets };
  }
  /** A fake GitHub Release: 200 with the asset's size and SHA-256, 404 for anything else; records every request. */
  const fakeRelease = (assets: ReadonlyMap<string, Uint8Array>, requested: string[] = []): ReleaseDownloadHook => url => {
    requested.push(url);
    const body = url.startsWith(RELEASE_BASE) ? assets.get(decodeURIComponent(url.slice(RELEASE_BASE.length))) : undefined;
    return body === undefined ? { status: 404, bytes: 0, sha256: null } : { status: 200, bytes: body.length, sha256: hash(body) };
  };
  const postInput = (release: Awaited<ReturnType<typeof publishedRelease>>, overrides: Partial<PostReleaseDesktopInput> = {}): PostReleaseDesktopInput => ({
    mode: 'post-release', scope: 'desktop', releaseManifest: release.releaseManifest, downloadUrl: RELEASE_BASE, readme: desktopReadme(),
    download: fakeRelease(release.assets), ...overrides });

  it('公開した Release が公開一覧と一致すれば、配布物3種と PDF 7巻を1回ずつ取得し、README の導線も合格、Web は後回しで終了コード0', async () => {
    const release = await publishedRelease(), requested: string[] = [];
    const report = await evaluateReleaseReadiness(postInput(release, { download: fakeRelease(release.assets, requested) }));
    expect(report.checks.map(check => check.id)).toEqual(POST_RELEASE_DESKTOP_CHECK_IDS);
    expect(report.checks.map(check => `${check.id}:${check.status}:${check.problems.join(' / ')}`))
      .toEqual(['post-release-assets:pass:', 'post-release-readme:pass:', 'post-release-web:deferred:']);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.ready);
    expect(report.scope).toBe('desktop');
    expect(requested).toHaveLength(10);
    expect(new Set(requested).size).toBe(10);
    expect(report.checks[0]?.summary).toBe(`配布物 3件・説明書の PDF 7巻を ${RELEASE_BASE} から取得して照合`);
    expect(report.checks[1]?.summary).toContain('README の Desktop の導線 10件を取得して照合');
    expect(formatReleaseReadinessReport(report))
      .toContain('終了コード 0（公開した Release の配布物・説明書の PDF・README の Desktop の導線が公開一覧と一致する（Web 版は後回し））');
  });

  it.each([
    { name: '差し替わった PDF', id: 'post-release-assets', message: `hash の違い: ${manualPdfReleaseAssetName(version, 'drawing')}`,
      change: (assets: Map<string, Uint8Array>) => { assets.set(manualPdfReleaseAssetName(version, 'drawing'), bytes('%PDF-1.7 drawing (older)')); } },
    { name: '置き忘れたポータブル版', id: 'post-release-assets', message: `取得できない: ${PORTABLE.name}（${DOWNLOAD}/${PORTABLE.name}）: HTTP 404`,
      change: (assets: Map<string, Uint8Array>) => { assets.delete(PORTABLE.name); } },
    { name: '差し替わったインストーラー（README の導線でも）', id: 'post-release-readme', message: `README の導線: hash の違い: ${INSTALLER.name}`,
      change: (assets: Map<string, Uint8Array>) => { assets.set(INSTALLER.name, bytes(`${INSTALLER.name} rebuilt`)); } },
  ])('$name は0以外で理由を示す', async ({ id, message, change }) => {
    const release = await publishedRelease();
    const assets = new Map(release.assets);
    change(assets);
    const report = await evaluateReleaseReadiness(postInput(release, { download: fakeRelease(assets) }));
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
    expect(statusOf(report, id)).toBe('fail');
    expect(problemsOf(report, id)).toContain(message);
  });

  it('別の版の Release・別の置き場への README の導線・通信の失敗・読めない入力は0以外', async () => {
    const release = await publishedRelease();
    const otherBase = 'https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v1.0.1/';
    const otherTag = await evaluateReleaseReadiness(postInput(release, { downloadUrl: otherBase }));
    expect(problemsOf(otherTag, 'post-release-assets')).toContain(`公開一覧の版 v1.0.0 と違う Release: ${otherBase}`);
    expect(problemsOf(otherTag, 'post-release-readme')).toContain(`公開した Release と違う置き場への導線: ${DOWNLOAD}/${INSTALLER.name}`);
    const fork = `https://github.com/someone-else/PointerCAD/releases/download/v${version}/${INSTALLER.name}`;
    const moved = await evaluateReleaseReadiness(postInput(release, { readme: desktopReadme().replace(`(${DOWNLOAD}/${INSTALLER.name})`, `(${fork})`) }));
    expect(statusOf(moved, 'post-release-assets')).toBe('pass');
    expect(problemsOf(moved, 'post-release-readme')).toContain(`公開した Release と違う置き場への導線: ${fork}`);
    expect(problemsOf(moved, 'post-release-readme')).toContain('配布物の置き場が複数のリポジトリにある');
    const offline = await evaluateReleaseReadiness(postInput(release, { download: () => { throw new Error('ECONNRESET'); } }));
    expect(problemsOf(offline, 'post-release-assets')).toContain(`取得できない: ${INSTALLER.name}（${DOWNLOAD}/${INSTALLER.name}）: ECONNRESET`);
    const unreadable = await evaluateReleaseReadiness(postInput(release, { releaseManifest: null, readme: null,
      readErrors: { releaseManifest: 'ENOENT: dist/release-output', readme: 'ENOENT: README.md' } }));
    expect(unreadable.checks.map(check => check.status)).toEqual(['fail', 'fail', 'deferred']);
    expect(problemsOf(unreadable, 'post-release-assets')).toContain('ENOENT: dist/release-output');
    expect(problemsOf(unreadable, 'post-release-readme')).toContain('ENOENT: README.md');
    for (const report of [otherTag, moved, offline, unreadable]) expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.failed);
  });

  it('入口: dist/<名前>/release-manifest.json と README.md を読み、注入した取得で判定して一覧を出す', async () => {
    const release = await publishedRelease();
    const temporaryRoot = mkdtempSync(join(resolve(tmpdir()), 'pointercad-post-release-'));
    try {
      mkdirSync(join(temporaryRoot, 'dist', 'release-output'), { recursive: true });
      writeFileSync(join(temporaryRoot, 'dist', 'release-output', 'release-manifest.json'), release.releaseManifest);
      writeFileSync(join(temporaryRoot, 'README.md'), desktopReadme());
      const lines: string[] = [];
      const code = await runReleaseReadiness(['--mode', 'post-release', '--scope', 'desktop', '--release', 'release-output', '--download-url', RELEASE_BASE],
        { root: temporaryRoot, write: text => { lines.push(text); }, download: fakeRelease(release.assets) });
      expect(code).toBe(RELEASE_READINESS_EXIT.ready);
      const text = lines.join('\n');
      expect(text).toContain('PointerCAD 公開後の確認（公開後モード・デスクトップ先行（Web 版の項目は後回し））');
      expect(text).toContain(`対象: dist/release-output ・ ${RELEASE_BASE}`);
      expect(text).toContain('[後回し] 公開後 Web 版と説明書の HTML を公開先から取得して照合する');
    } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
  });

  it('実際の取得: 転送先へ進んで本文を流しながら hash を取り、200 以外は本文を読まずに状態だけ返し、上限を超えたら止める', async () => {
    const requests: { url: string; redirect: RequestRedirect | undefined }[] = [];
    const download = createReleaseDownloader({ fetch: (url, init) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      requests.push({ url: target, redirect: init?.redirect });
      return Promise.resolve(target.endsWith('missing.pdf') ? new Response('not found', { status: 404 }) : new Response(bytes('PointerCAD package')));
    } });
    await expect(Promise.resolve(download(`${DOWNLOAD}/${INSTALLER.name}`))).resolves.toEqual({ status: 200, bytes: 18, sha256: hash('PointerCAD package') });
    await expect(Promise.resolve(download(`${DOWNLOAD}/missing.pdf`))).resolves.toEqual({ status: 404, bytes: 0, sha256: null });
    expect(requests).toEqual([{ url: `${DOWNLOAD}/${INSTALLER.name}`, redirect: 'follow' }, { url: `${DOWNLOAD}/missing.pdf`, redirect: 'follow' }]);
    const small = createReleaseDownloader({ maxBytes: 4, fetch: () => Promise.resolve(new Response(bytes('too large'))) });
    await expect(Promise.resolve(small(`${DOWNLOAD}/${INSTALLER.name}`))).rejects.toThrow('大きすぎる');
  });

  it('全体の公開後モード（Web を含む）は今までどおり未実装で終了コード3', async () => {
    const release = await publishedRelease();
    const report = await evaluateReleaseReadiness({ mode: 'post-release', releaseManifest: release.releaseManifest, webUrl: `${SITE}/`, downloadUrl: RELEASE_BASE });
    expect(report.checks.map(check => `${check.id}:${check.status}`)).toEqual(['post-release:not-implemented']);
    expect(report.exitCode).toBe(RELEASE_READINESS_EXIT.notImplemented);
  });
});
