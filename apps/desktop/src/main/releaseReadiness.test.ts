import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  PAGES_MAX_FILE_BYTES, PAGES_MAX_FILES, RELEASE_LINKS_END, RELEASE_LINKS_START, RELEASE_READINESS_CHECK_IDS, RELEASE_READINESS_EXIT,
  ReleaseReadinessUsageError, captureFreshnessFromRegistry, checkReadmeReleaseLinks, evaluateReleaseReadiness, formatReleaseReadinessReport,
  parseReleaseReadinessArguments, runReleaseReadiness,
} from '../../../../scripts/release/releaseReadiness.mjs';
import type {
  CaptureFreshnessHook, CaptureFreshnessRequest, CurrentHelpEdition, PreReleaseInput, ReleaseReadinessReport,
} from '../../../../scripts/release/releaseReadiness.mjs';
import { assembleSbomDocument } from '../../../../scripts/release/sbom.mjs';
import { assembleOfflineDistribution } from '../../../../scripts/vite/offlineDistribution.mjs';
import { bytes, files, hash, json } from './distributionTestFixture.js';

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
  'apps/desktop/electron-builder.yml': hash(builderConfig) };
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
