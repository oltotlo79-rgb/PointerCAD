/**
 * Release gate (P12-20, P13-15, rules/05 §11.2): check one assembled release candidate before publication and
 * finish non-zero when any condition is not met. evaluateReleaseReadiness() is the judgement: it receives bytes that
 * were already read plus the "current help" edition, and touches neither files nor the network. The command line
 * (runReleaseReadiness) reads the dist/<name>/ folders exactly like build-release-manifest.mjs, loads the current
 * catalog through Vite SSR like scripts/manual/currentManualEdition.mjs, and prints a human-readable list.
 * Post-release mode (download from the real URLs and compare hashes): the Desktop part (--scope desktop) downloads
 * the three desktop packages and every manual PDF volume from the GitHub Release, compares them with release-manifest.json
 * and follows README's Desktop links; the whole (Web included) post-release mode stays an entry point until the Web
 * version is published (P13-20).
 * Desktop-first scope (--scope desktop, the owner's instruction of 2026-09-27 17:3x: release the desktop version first,
 * do not wait for the Web version): pre-release mode runs every check, but the checks that only the Web publication needs
 * (DESKTOP_DEFERRED_CHECK_IDS) are reported as deferred instead of failing, README's Web row may say WEB_DEFERRED_PHRASE,
 * and the manual is reached through the PDF volumes attached to the GitHub Release (manualPdfReleaseAssetName). The
 * default scope (all) keeps every condition, the Web ones included.
 * Manual mode (P12-20) runs only the manual checks (MANUAL_CHECK_IDS: the four NFR-MA-6 conditions and the
 * whole-edition equality) on one generated manual, dist/<name>/ from scripts/manual/generate.mjs, before any
 * release candidate exists. Pre-release mode (P13-15) runs the very same check bodies on the manual inside the Web
 * candidate, so the manual conditions are implemented once.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process, { argv } from 'node:process';
import { log } from 'node:console';
import { fileURLToPath, URL } from 'node:url';
import { verifyReleaseManifest } from './releaseManifest.mjs';
import { assertSbomMatchesReleaseManifest, assertSbomPublishable, findSbomGaps, matchSbomToReleaseManifest } from './sbom.mjs';
import { desktopPackagePlan } from './desktopPackageTargets.mjs';
import { collectDesktopFiles, sourceFileHash, sourceText } from './desktopFileInventory.mjs';
import { assertNativeControlDescriptions } from '../manual/control-inventory.mjs';
import { applicationInputDigest, assessCaptureImages, CAPTURE_IMAGE_FOLDER, readCaptureRegistry, readCaptureScripts } from '../manual/captureRegistry.mjs';
import { captureDesktopBuildSources, captureWebBuildSources } from '../vite/webBuildSources.mjs';
import { OFFLINE_MAX_FILE_BYTES, offlineAssetUrl } from '../vite/offlineProtocol.mjs';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const UI_REFERENCE = /\{\{ui:([^{}]*)\}\}/gu;
const MAX_LISTED_PROBLEMS = 20;

export const RELEASE_READINESS_FORMAT = 'pointercad-release-readiness/1';
/** 0 ready, 1 at least one failure, 2 only unconnected (pending) conditions, 3 post-release mode not implemented. */
export const RELEASE_READINESS_EXIT = Object.freeze({ ready: 0, failed: 1, pending: 2, notImplemented: 3, usage: 64, internal: 70 });
/** Cloudflare Pages direct upload from the dashboard: 1,000 files and 25 MiB per file (docs/standards/cloudflare-pages.md). */
export const PAGES_MAX_FILES = 1_000;
export const PAGES_MAX_FILE_BYTES = OFFLINE_MAX_FILE_BYTES;
export const CAPTURE_REGISTRY_PENDING = '撮影の登録簿（scripts/manual/captureRegistry.mjs）の完了後につなぐ（未接続）';
export const RELEASE_LINKS_START = '<!-- pointercad:release-links:start -->';
export const RELEASE_LINKS_END = '<!-- pointercad:release-links:end -->';
/** all: every condition (Web included). desktop: the desktop-first release; the Web-only conditions are deferred. */
export const RELEASE_READINESS_SCOPES = Object.freeze(['all', 'desktop']);
/** The only wording README's Web row may carry instead of a link, and only in the desktop scope. */
export const WEB_DEFERRED_PHRASE = '後日公開';
/** Cloudflare's limits on the Web files: they decide the Web publication only, so the desktop scope defers them. */
export const DESKTOP_DEFERRED_CHECK_IDS = Object.freeze(['asset-size', 'asset-count']);
const DEFERRED_REASON = 'Web 版の公開時に判定する（デスクトップ先行。2026-09-27 の利用者の指示）';
/** Largest single download the post-release check hashes (GitHub Releases accepts files below 2 GiB). */
export const RELEASE_DOWNLOAD_MAX_BYTES = 2 * 1024 ** 3;
/** Name of one manual PDF volume attached to the GitHub Release, next to the desktop packages of the same version. */
export function manualPdfReleaseAssetName(version, volumeId) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error(`版の形が違う: ${String(version)}`);
  if (typeof volumeId !== 'string' || !ID_PATTERN.test(volumeId)) throw new Error(`巻の名前の形が違う: ${String(volumeId)}`);
  return `PointerCAD-${version}-manual-${volumeId}.pdf`;
}
function manualPdfAssetVolume(asset, version) {
  const prefix = `PointerCAD-${version}-manual-`;
  if (!asset.startsWith(prefix) || !asset.endsWith('.pdf')) return null;
  const id = asset.slice(prefix.length, -'.pdf'.length);
  return ID_PATTERN.test(id) ? id : null;
}
function scopeOf(value) {
  const scope = value ?? 'all';
  if (!RELEASE_READINESS_SCOPES.includes(scope)) throw new TypeError(`Unknown release readiness scope: ${String(scope)}`);
  return scope;
}

const CHECKS = Object.freeze([
  { id: 'manual-chapters', group: '説明書①', title: '章と題名が今のヘルプの目録と一致する' },
  { id: 'manual-controls', group: '説明書②', title: '操作名・ボタン名が今の画面の文言と一致する' },
  { id: 'manual-features', group: '説明書③', title: '機能と章の対応に過不足が無い（双方向）' },
  { id: 'manual-images', group: '説明書④', title: '画像が今の版の撮影の生成物である' },
  { id: 'manual-current', group: '説明書', title: '説明書の出力全体が今のヘルプの生成結果と一致する' },
  { id: 'versions', group: '版', title: '3つの package.json・配布候補・公開一覧・SBOM の版が一致する' },
  { id: 'version-publishable', group: '版', title: '公開用の版番号である（0.0.0 は模擬）' },
  { id: 'volumes', group: '全巻', title: '全巻の HTML と PDF が Web・Windows・Linux の候補と公開一覧にある' },
  { id: 'asset-size', group: '資産', title: 'Web の各ファイルが 26,214,400 バイト以下' },
  { id: 'asset-count', group: '資産', title: 'Web のファイル数が 1,000 以下' },
  { id: 'sbom-notices', group: 'SBOM', title: '許諾の原文の欠けが無い' },
  { id: 'sbom-manifest', group: 'SBOM', title: 'SBOM の配布ファイル・版・commit が公開一覧と一致する' },
  { id: 'release-manifest', group: '公開一覧', title: 'release-manifest.json が候補の記録と実物からの再計算と一致する' },
  { id: 'readme-links', group: 'README', title: 'pointercad:release-links の導線の種類・版・未公開の案内' },
]);
export const RELEASE_READINESS_CHECK_IDS = Object.freeze(CHECKS.map(check => check.id));
/** The checks of manual mode (P12-20); pre-release mode runs them too, as the first five of its fourteen. */
export const MANUAL_CHECK_IDS = Object.freeze(CHECKS.filter(check => check.id.startsWith('manual-')).map(check => check.id));

const STATUS_LABELS = Object.freeze({ pass: '合格', fail: '不合格', pending: '保留', 'not-implemented': '未実装', deferred: '後回し' });
const EXIT_MEANINGS = Object.freeze({ 0: '公開前の全項目を満たす', 1: '公開できない', 2: '未接続の条件があり判定できない',
  3: '公開後モードは未実装', 64: '引数の誤り', 70: '内部の誤り' });
const MANUAL_EXIT_MEANINGS = Object.freeze({ ...EXIT_MEANINGS, 0: '説明書の整合4条件と出力全体の一致を満たす', 1: '説明書が今のヘルプ・画面・機能・撮影と合わない' });
const DESKTOP_EXIT_MEANINGS = Object.freeze({ ...EXIT_MEANINGS, 0: 'デスクトップ版の公開前の全項目を満たす（Web 版の項目は後回し）' });
const POST_RELEASE_DESKTOP_EXIT_MEANINGS = Object.freeze({ ...EXIT_MEANINGS,
  0: '公開した Release の配布物・説明書の PDF・README の Desktop の導線が公開一覧と一致する（Web 版は後回し）', 1: '公開した Release が公開一覧と合わない' });
function exitMeanings(report) {
  if (report.mode === 'manual') return MANUAL_EXIT_MEANINGS;
  if (report.scope !== 'desktop') return EXIT_MEANINGS;
  return report.mode === 'post-release' ? POST_RELEASE_DESKTOP_EXIT_MEANINGS : DESKTOP_EXIT_MEANINGS;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageOf = error => error instanceof Error ? error.message : String(error);
const grouped = value => value.toLocaleString('en-US');
function same(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => same(item, right[index]));
  if (record(left) && record(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
  }
  return left === right;
}
function parseJson(bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 8_388_608) throw new Error(`${label} が無いか大きすぎる`);
  try { return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} を JSON として読めない`); }
}
function packageVersion(bytes, label) {
  const value = parseJson(bytes, label);
  if (!record(value) || typeof value.version !== 'string') throw new Error(`${label} に版が無い`);
  return value.version;
}
function platformLabel(platform) {
  return platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : `不明な対象(${String(platform)})`;
}
export class ReleaseReadinessUsageError extends Error {
  constructor(message) { super(message); this.name = 'ReleaseReadinessUsageError'; }
}

// ---------------------------------------------------------------- HTML of the generated manual

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' });
function decodeHtml(bytes) {
  try { return new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
/** Visible text of an HTML fragment as React's static renderer escapes it (tags removed, entities decoded). */
function visibleText(html) {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name) => {
      if (name.startsWith('#')) {
        const code = /^#x/iu.test(name) ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : whole;
    });
}
/** The <article id="chapter-ID"> body; both chapter pages and combined volume pages render each chapter this way. */
function chapterArticle(bytes, id) {
  if (bytes === undefined || !ID_PATTERN.test(id)) return null;
  const html = decodeHtml(bytes);
  if (html === null) return null;
  const start = new RegExp(`<article\\b[^>]*\\bid="chapter-${id}"[^>]*>`, 'u').exec(html);
  if (start === null) return null;
  const from = start.index + start[0].length, to = html.indexOf('</article>', from);
  return to < 0 ? null : html.slice(from, to);
}
function articleHeading(bytes, id) {
  const article = chapterArticle(bytes, id);
  if (article === null) return null;
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/u.exec(article);
  return heading === null ? null : visibleText(heading[1]).trim();
}
function occurrences(text, needle) {
  let count = 0, at = needle === '' ? -1 : text.indexOf(needle);
  while (at >= 0) { count += 1; at = text.indexOf(needle, at + needle.length); }
  return count;
}

// ---------------------------------------------------------------- evaluation context

/** The manual inside the Web candidate (manual/, without the PDF volumes) is the same edition as dist/<name>/. */
function readManualEdition(webFiles) {
  const manualFiles = [];
  for (const file of webFiles) {
    if (typeof file?.path !== 'string' || !(file.bytes instanceof Uint8Array)) throw new Error('Web の候補のファイルの形が違う');
    if (file.path.startsWith('manual/') && !file.path.startsWith('manual/pdf/')) manualFiles.push({ path: file.path.slice('manual/'.length), bytes: file.bytes });
  }
  return manualEditionOf(manualFiles);
}
/** One generated manual (paths relative to its root, as scripts/manual/generate.mjs writes them). */
function manualEditionOf(manualFiles) {
  const byPath = new Map();
  for (const file of manualFiles) {
    if (typeof file?.path !== 'string' || !(file.bytes instanceof Uint8Array)) throw new Error('説明書のファイルの形が違う');
    byPath.set(file.path, file.bytes);
  }
  const manifest = parseJson(byPath.get('manifest.json'), 'manual/manifest.json');
  if (!record(manifest) || manifest.format !== 'pointercad-manual/1' || !Array.isArray(manifest.chapters)
    || !Array.isArray(manifest.volumes) || !record(manifest.images) || typeof manifest.buildId !== 'string') {
    throw new Error('manual/manifest.json の形が違う');
  }
  return { manualFiles, byPath, manifest };
}
function createContext(input) {
  const cache = new Map();
  const once = (key, compute) => {
    if (!cache.has(key)) {
      try { cache.set(key, { value: compute() }); } catch (error) { cache.set(key, { error }); }
    }
    const entry = cache.get(key);
    if (Object.hasOwn(entry, 'error')) throw entry.error;
    return entry.value;
  };
  const need = (value, key, label) => {
    if (value === null || value === undefined) throw new Error(`${label}を読めない（${input.readErrors?.[key] ?? '入力が無い'}）`);
    return value;
  };
  return {
    input, need,
    help: () => need(input.currentHelp, 'currentHelp', '今のヘルプ'),
    webFiles: () => need(input.webFiles, 'web', 'Web の候補'),
    candidates: () => need(input.candidates, 'candidates', 'デスクトップの候補'),
    manual: () => once('manual', () => input.mode === 'manual'
      ? manualEditionOf(need(input.manualFiles, 'manual', '説明書'))
      : readManualEdition(need(input.webFiles, 'web', 'Web の候補'))),
    saved: () => once('saved', () => {
      const value = parseJson(need(input.releaseManifest, 'releaseManifest', 'release-manifest.json '), 'release-manifest.json');
      if (!record(value)) throw new Error('release-manifest.json の形が違う');
      return value;
    }),
    sbom: () => once('sbom', () => parseJson(need(input.sbom, 'sbom', 'sbom.json '), 'sbom.json')),
    receipts: () => once('receipts', () => need(input.candidates, 'candidates', 'デスクトップの候補')
      .map(candidate => {
        const receipt = parseJson(candidate?.receiptBytes, 'candidate.json');
        if (!record(receipt)) throw new Error('candidate.json の形が違う');
        return receipt;
      })),
  };
}
async function runCheck(definition, body) {
  const base = { id: definition.id, group: definition.group, title: definition.title };
  try {
    const outcome = await body();
    const problems = Object.freeze([...(outcome.problems ?? [])].map(String));
    const status = outcome.status ?? (problems.length > 0 ? 'fail' : 'pass');
    return Object.freeze({ ...base, status, summary: outcome.summary, problems, notes: Object.freeze([...(outcome.notes ?? [])].map(String)) });
  } catch (error) {
    return Object.freeze({ ...base, status: 'fail', summary: '判定できない', problems: Object.freeze([messageOf(error)]), notes: Object.freeze([]) });
  }
}
/**
 * Deferred checks (desktop scope only) do not block exit code 0, but a report whose checks are all deferred proves
 * nothing and fails, like an empty one.
 */
function finish(mode, checks, scope = 'all') {
  const count = status => checks.filter(check => check.status === status).length;
  const summary = Object.freeze({ pass: count('pass'), fail: count('fail'), pending: count('pending'), notImplemented: count('not-implemented'),
    deferred: count('deferred') });
  const exitCode = summary.fail > 0 || checks.length === summary.deferred ? RELEASE_READINESS_EXIT.failed
    : summary.notImplemented > 0 ? RELEASE_READINESS_EXIT.notImplemented
      : summary.pending > 0 ? RELEASE_READINESS_EXIT.pending : RELEASE_READINESS_EXIT.ready;
  return Object.freeze({ format: RELEASE_READINESS_FORMAT, mode, scope, releaseCertified: false, checks: Object.freeze(checks), summary, exitCode });
}
/** A desktop-scope check that only the Web publication needs: judged for reference, reported as deferred. */
async function deferredCheck(definition, body) {
  const judged = await runCheck(definition, body);
  const reference = judged.problems.map(problem => `Web 版の公開時に直す（今の判定）: ${problem}`);
  return Object.freeze({ ...judged, status: 'deferred', summary: `${DEFERRED_REASON}。今の判定: ${STATUS_LABELS[judged.status] ?? judged.status}・${judged.summary}`,
    problems: Object.freeze([]), notes: Object.freeze([...reference, ...judged.notes]) });
}

// ---------------------------------------------------------------- manual: the four NFR-MA-6 conditions

/** ① Every catalog topic has one chapter with the same title, in the same volume and order. */
function checkChapters(edition, help) {
  const problems = [], current = new Map(help.chapters.map(chapter => [chapter.id, chapter])), recorded = new Map();
  for (const chapter of edition.manifest.chapters) {
    if (!record(chapter) || typeof chapter.id !== 'string') problems.push('章の記録の形が違う');
    else recorded.set(chapter.id, chapter);
  }
  for (const [id, chapter] of current) {
    const page = edition.byPath.get(`chapters/${id}.html`), entry = recorded.get(id);
    if (entry === undefined || page === undefined) {
      const absent = [entry === undefined ? '章の記録' : '', page === undefined ? 'ページ' : ''].filter(Boolean).join('と');
      problems.push(`欠章: ${id}「${chapter.title}」（${absent}が無い）`);
      continue;
    }
    if (entry.title !== chapter.title) problems.push(`題名の違い（章の記録）: ${id} 説明書「${String(entry.title)}」／ヘルプ「${chapter.title}」`);
    const heading = articleHeading(page, id);
    if (heading !== chapter.title) problems.push(`題名の違い（章のページ）: chapters/${id}.html「${heading ?? '見出しが無い'}」／ヘルプ「${chapter.title}」`);
    if (entry.volumeId !== chapter.volumeId) problems.push(`章の巻の違い: ${id} 説明書 ${String(entry.volumeId)}／ヘルプ ${chapter.volumeId}`);
  }
  for (const id of recorded.keys()) if (!current.has(id)) problems.push(`今の目録に無い章: ${id}`);
  for (const path of edition.byPath.keys()) {
    const match = /^chapters\/([^/]+)\.html$/u.exec(path);
    if (match !== null && !current.has(match[1])) problems.push(`今の目録に無い章のページ: manual/${path}`);
  }
  const recordedOrder = [...recorded.keys()].filter(id => current.has(id)), currentOrder = [...current.keys()].filter(id => recorded.has(id));
  if (!same(recordedOrder, currentOrder)) problems.push('章の並びが今の目録と違う');
  const volumes = new Map(edition.manifest.volumes.filter(record).map(volume => [volume.id, volume]));
  for (const volume of help.volumes) {
    const entry = volumes.get(volume.id);
    if (entry === undefined) { problems.push(`巻の記録が無い: ${volume.id}「${volume.title}」`); continue; }
    if (entry.title !== volume.title) problems.push(`巻の題名の違い: ${volume.id} 説明書「${String(entry.title)}」／ヘルプ「${volume.title}」`);
    if (!same(entry.topics, volume.topics)) problems.push(`巻の章立ての違い: ${volume.id}`);
    const page = edition.byPath.get(`volumes/${volume.id}.html`);
    if (page === undefined) continue; // Reported by the 全巻 check.
    for (const id of volume.topics) {
      const heading = articleHeading(page, id), title = current.get(id)?.title;
      if (heading !== title) problems.push(`題名の違い（巻のページ）: volumes/${volume.id}.html の ${id}「${heading ?? '章が無い'}」／ヘルプ「${String(title)}」`);
    }
  }
  for (const id of volumes.keys()) if (!help.volumes.some(volume => volume.id === id)) problems.push(`今の目録に無い巻: ${String(id)}`);
  return { problems, summary: `${current.size}章・${help.volumes.length}巻を今の目録と照合` };
}

/** A button named directly in the text (「X」ボタン, 「X」を押す) rather than through {{ui:key}}. */
const LITERAL_CONTROL = /「([^「」\r\n]{1,40})」(?=ボタン|を押)/gu;
/**
 * ② Every {{ui:key}} of the current chapter sources appears with today's label in the chapter and volume pages, and
 * every button the pages name directly (「X」ボタン・「X」を押す) is one of today's screen labels (the ja message table).
 */
function checkControls(edition, help) {
  const problems = [];
  let references = 0, literals = 0;
  const labels = new Set(Object.values(help.uiLabels).filter(label => typeof label === 'string' && label !== ''));
  for (const chapter of help.chapters) {
    for (const name of [`chapters/${chapter.id}.html`, `volumes/${chapter.volumeId}.html`]) {
      const article = chapterArticle(edition.byPath.get(name), chapter.id);
      if (article === null) continue; // A missing page or chapter is reported by ① and 全巻.
      const unknown = new Set();
      for (const match of visibleText(article).matchAll(LITERAL_CONTROL)) {
        if (name.startsWith('chapters/')) literals += 1;
        if (!labels.has(match[1])) unknown.add(match[1]);
      }
      for (const label of unknown) problems.push(`誤った操作名・ボタン名（今の画面の文言に無い）: manual/${name} の ${chapter.id} に「${label}」`);
    }
  }
  for (const chapter of help.chapters) {
    const source = help.chapterSources.get(chapter.id);
    if (typeof source !== 'string') { problems.push(`章の原文が無い: ${chapter.id}`); continue; }
    const wanted = new Map();
    for (const match of source.matchAll(UI_REFERENCE)) {
      const key = match[1], label = Object.hasOwn(help.uiLabels, key) ? help.uiLabels[key] : undefined;
      if (typeof label !== 'string' || label === '') { problems.push(`今の画面の文言に無いキー: ${chapter.id} の {{ui:${key}}}`); continue; }
      references += 1;
      const entry = wanted.get(label) ?? { keys: new Set(), count: 0 };
      entry.keys.add(key); entry.count += 1; wanted.set(label, entry);
    }
    for (const name of [`chapters/${chapter.id}.html`, `volumes/${chapter.volumeId}.html`]) {
      const article = chapterArticle(edition.byPath.get(name), chapter.id);
      if (article === null || wanted.size === 0) continue; // A missing page or chapter is reported by ① and 全巻.
      const text = visibleText(article);
      for (const [label, { keys, count }] of wanted) {
        // resolveHelpUiReferences escapes Markdown punctuation; code spans keep that escaped spelling.
        const escaped = label.replace(/[\\`*_[\]{}()#+.!|>-]/gu, '\\$&');
        const found = occurrences(text, label) + (escaped === label ? 0 : occurrences(text, escaped));
        if (found < count) problems.push(`誤った操作名・ボタン名: manual/${name} に「${label}」（${[...keys].join('・')}）が ${count} 回必要なところ ${found} 回`);
      }
    }
  }
  try { assertNativeControlDescriptions(edition.manifest.nativeControlCoverage); }
  catch (error) { problems.push(`説明の無い画面の部品: ${messageOf(error)}`); }
  return { problems, summary: `画面の文言の参照 ${references}件・本文に直接書いたボタン名 ${literals}件（${help.chapters.length}章）と画面の部品の説明を照合` };
}

function coverageEntries(value, label) {
  if (!record(value) || !Array.isArray(value.entries) || !Array.isArray(value.pending)) throw new Error(`${label}の機能の対応表の形が違う`);
  return new Map(value.entries.filter(record).map(entry => [entry.id, entry]));
}
/** ③ Features and commands in the manual and in the current help map to the same existing chapters, both ways. */
function checkFeatures(edition, help) {
  const problems = [], manifest = edition.manifest;
  const chapterIds = new Set(manifest.chapters.filter(record).map(chapter => chapter.id));
  const manualFeatures = coverageEntries(manifest.featureCoverage, '説明書'), currentFeatures = coverageEntries(help.featureCoverage, 'ヘルプ');
  const topics = entry => (Array.isArray(entry.topicIds) ? entry.topicIds : []).join('・');
  for (const [id, entry] of manualFeatures) {
    if (!currentFeatures.has(id)) problems.push(`孤立した機能（説明書だけにあり、今のヘルプに項目が無い）: ${String(id)}`);
    for (const topic of Array.isArray(entry.topicIds) ? entry.topicIds : []) {
      if (!chapterIds.has(topic)) problems.push(`孤立した機能（説明先の章が説明書に無い）: ${String(id)} → ${String(topic)}`);
    }
  }
  for (const [id, entry] of currentFeatures) {
    const recorded = manualFeatures.get(id);
    if (recorded === undefined) problems.push(`説明書に無い機能（今のヘルプだけにある）: ${id}`);
    else if (!same(recorded.topicIds, entry.topicIds) || recorded.mergedInto !== entry.mergedInto || recorded.pending !== entry.pending) {
      problems.push(`機能の説明先の違い: ${id} 説明書 [${topics(recorded)}]／ヘルプ [${topics(entry)}]`);
    }
  }
  try { help.assertDocumentedFeatureCoverage(manifest.featureCoverage); }
  catch (error) { problems.push(`説明の無い機能（未完）: ${messageOf(error)}`); }
  if (!Array.isArray(manifest.commandCoverage) || !Array.isArray(help.commandCoverage)) throw new Error('操作の対応表の形が違う');
  const manualCommands = new Map(manifest.commandCoverage.filter(record).map(entry => [entry.commandId, entry]));
  const currentCommands = new Map(help.commandCoverage.map(entry => [entry.commandId, entry]));
  for (const [id, entry] of manualCommands) {
    if (!currentCommands.has(id)) problems.push(`孤立した操作（説明書だけにある）: ${String(id)}`);
    if (!chapterIds.has(entry.topicId)) problems.push(`孤立した操作（説明先の章が説明書に無い）: ${String(id)} → ${String(entry.topicId)}`);
  }
  for (const [id, entry] of currentCommands) {
    const recorded = manualCommands.get(id);
    if (recorded === undefined) problems.push(`説明書に無い操作（今のヘルプだけにある）: ${id}`);
    else if (recorded.topicId !== entry.topicId) problems.push(`操作の説明先の違い: ${id} 説明書 ${String(recorded.topicId)}／ヘルプ ${entry.topicId}`);
  }
  const coverage = parseJson(edition.byPath.get('feature-coverage.json'), 'manual/feature-coverage.json');
  if (!record(coverage) || !same(coverage.features, manifest.featureCoverage) || !same(coverage.commands, manifest.commandCoverage)) {
    problems.push('manual/feature-coverage.json が manifest.json の対応表と違う');
  }
  return { problems, summary: `機能 ${currentFeatures.size}件・操作 ${currentCommands.size}件を双方向に照合` };
}

/** ④ Connect point for the capture registry: without a hook the condition stays pending (exit code 2). */
async function checkImages(edition, hook) {
  const images = Object.keys(edition.manifest.images).sort().map(path => {
    const bytes = edition.byPath.get(path), info = edition.manifest.images[path];
    return { path, sha256: bytes === undefined ? null : sha256(bytes), recorded: record(info) ? info.sha256 : null };
  });
  const problems = [
    ...images.filter(image => image.sha256 === null).map(image => `画像が無い: manual/${image.path}`),
    ...images.filter(image => image.sha256 !== null && image.sha256 !== image.recorded).map(image => `記録と違う画像: manual/${image.path}`),
  ];
  if (hook === null || hook === undefined) {
    return { status: problems.length > 0 ? 'fail' : 'pending', summary: CAPTURE_REGISTRY_PENDING, problems,
      notes: [`対象の画像 ${images.length}枚（撮影の登録簿との照合は未接続）`] };
  }
  const result = await hook({ manualBuildId: edition.manifest.buildId,
    sourceCommit: typeof edition.manifest.sourceCommit === 'string' ? edition.manifest.sourceCommit : null,
    images: images.filter(image => image.sha256 !== null).map(image => ({ path: image.path, sha256: image.sha256 })) });
  if (!record(result) || !Array.isArray(result.stale) || !Array.isArray(result.unregistered)) throw new Error('撮影の登録簿の照合結果の形が違う');
  problems.push(...result.stale.map(path => `古い画像（今の版の撮影でない）: ${String(path)}`),
    ...result.unregistered.map(path => `撮影の登録簿に無い画像: ${String(path)}`));
  return { problems, summary: `画像 ${images.length}枚を撮影の登録簿と照合`, notes: Array.isArray(result.notes) ? result.notes : [] };
}

/** The whole edition against the current help (source fingerprints, every page, image and coverage record). */
async function checkCurrentEdition(edition, help) {
  if (typeof help.verifyManualEdition !== 'function') throw new Error('今のヘルプとの照合の処理が無い');
  try {
    const result = await help.verifyManualEdition(edition.manualFiles);
    return { problems: [], summary: `説明書 ${String(result?.manualBuildId).slice(0, 12)}（${String(result?.chapters)}章・画像 ${String(result?.images)}枚）は今のヘルプの生成結果と一致` };
  } catch (error) {
    return { problems: [`今のヘルプの生成結果と違う: ${messageOf(error)}`], summary: '不一致' };
  }
}

// ---------------------------------------------------------------- versions, volumes, assets

function checkVersions(context) {
  const { input } = context, sources = [];
  const add = (label, read) => {
    try { sources.push({ label, version: read() }); } catch (error) { sources.push({ label, error: messageOf(error) }); }
  };
  add('ルートの package.json', () => packageVersion(input.packageFiles?.root, 'ルートの package.json'));
  add('apps/desktop/package.json', () => packageVersion(input.packageFiles?.desktop, 'apps/desktop/package.json'));
  add('apps/web/package.json', () => packageVersion(input.packageFiles?.web, 'apps/web/package.json'));
  add('release-manifest.json', () => context.saved().version);
  add('sbom.json', () => context.sbom()?.metadata?.component?.version);
  try {
    for (const receipt of context.receipts()) add(`${platformLabel(receipt.platform)} の候補（candidate.json）`, () => receipt.version);
  } catch (error) { sources.push({ label: 'デスクトップの候補（candidate.json）', error: messageOf(error) }); }
  const problems = [];
  for (const source of sources) {
    if (source.error !== undefined) problems.push(`${source.label}: ${source.error}`);
    else if (typeof source.version !== 'string' || !VERSION_PATTERN.test(source.version)) problems.push(`${source.label} の版の形が違う: ${String(source.version)}`);
  }
  const versions = sources.filter(source => source.error === undefined);
  if (new Set(versions.map(source => source.version)).size > 1) {
    problems.push(`版の違い: ${versions.map(source => `${source.label} ${String(source.version)}`).join(' ／ ')}`);
  }
  const release = versions[0]?.version;
  try {
    const { tag } = context.saved();
    if (tag !== null && tag !== undefined && tag !== `v${String(release)}`) problems.push(`タグと版の違い: ${String(tag)} ／ v${String(release)}`);
  } catch { /* An unreadable release-manifest.json is already listed above. */ }
  return { problems, summary: problems.length === 0 ? `版 ${String(release)}（${sources.length}か所で一致）` : '版の違い・読めない記録がある' };
}

function checkPublishableVersion(context) {
  const version = packageVersion(context.input.packageFiles?.root, 'ルートの package.json');
  const problems = [];
  if (!VERSION_PATTERN.test(version)) problems.push(`版の形が違う: ${version}`);
  else if (/^0\.0\.0(?:[-+]|$)/u.test(version)) {
    problems.push(`版 ${version} は模擬の版（3つの package.json を公開する版へ更新してから候補を作り直す。scripts/release/README.md）`);
  }
  return { problems, summary: `版 ${version}` };
}

const isPdf = bytes => bytes instanceof Uint8Array && bytes.length > 5
  && new globalThis.TextDecoder('latin1').decode(bytes.subarray(0, 5)) === '%PDF-';
function checkVolumes(context) {
  const volumes = context.help().volumes;
  if (!Array.isArray(volumes) || volumes.length === 0) throw new Error('今の目録に巻が無い');
  const problems = [], places = [{ label: 'Web', prefix: 'manual/', files: new Map(context.webFiles().map(file => [file.path, file.bytes])) }];
  try {
    const receipts = context.receipts();
    context.candidates().forEach((candidate, index) => places.push({ label: platformLabel(receipts[index].platform), prefix: 'dist/renderer/manual/',
      files: new Map(candidate.stagedFiles.map(file => [file.path, file.bytes])) }));
  } catch (error) { problems.push(`デスクトップの候補を照合できない: ${messageOf(error)}`); }
  for (const volume of volumes) {
    for (const place of places) {
      const html = place.files.get(`${place.prefix}volumes/${volume.id}.html`), pdf = place.files.get(`${place.prefix}pdf/${volume.id}.pdf`);
      if (!(html instanceof Uint8Array) || html.length === 0) problems.push(`1巻の欠落: ${place.label} に「${volume.title}」（${volume.id}）の HTML が無い`);
      if (!isPdf(pdf)) problems.push(`1巻の欠落: ${place.label} に「${volume.title}」（${volume.id}）の PDF が無い`);
    }
  }
  try {
    const manual = context.saved().manual, listed = Array.isArray(manual?.volumes) ? manual.volumes : [];
    const ids = volumes.map(volume => volume.id), listedIds = listed.map(entry => entry?.id);
    if (!same(listedIds, ids)) problems.push(`公開一覧の巻が今の目録と違う: ${listedIds.join('・')} ／ ${ids.join('・')}`);
    for (const entry of listed) {
      if (entry?.html !== `manual/volumes/${String(entry?.id)}.html` || entry?.pdf !== `manual/pdf/${String(entry?.id)}.pdf`) {
        problems.push(`公開一覧の巻の置き場が違う: ${String(entry?.id)}`);
      }
    }
    if (manual?.pdfVolumes !== volumes.length) problems.push(`公開一覧の PDF の巻数 ${String(manual?.pdfVolumes)} ／ 今の目録 ${volumes.length}`);
  } catch (error) { problems.push(`公開一覧を照合できない: ${messageOf(error)}`); }
  return { problems, summary: `全${volumes.length}巻 × ${places.map(place => place.label).join('・')}と公開一覧` };
}

function checkAssetSize(webFiles) {
  const problems = webFiles.filter(file => file.bytes.length > PAGES_MAX_FILE_BYTES).sort((a, b) => b.bytes.length - a.bytes.length)
    .map(file => `大きさの超過: ${file.path} ${grouped(file.bytes.length)} バイト（上限 ${grouped(PAGES_MAX_FILE_BYTES)}）`);
  const largest = webFiles.reduce((best, file) => best === null || file.bytes.length > best.bytes.length ? file : best, null);
  return { problems, summary: largest === null ? 'ファイルが無い' : `最大 ${largest.path} ${grouped(largest.bytes.length)} バイト` };
}
function checkAssetCount(webFiles) {
  const problems = webFiles.length > PAGES_MAX_FILES ? [`数の超過: ${grouped(webFiles.length)} ファイル（上限 ${grouped(PAGES_MAX_FILES)}）`] : [];
  if (webFiles.length === 0) problems.push('Web の候補にファイルが無い');
  return { problems, summary: `${grouped(webFiles.length)} ファイル` };
}

// ---------------------------------------------------------------- SBOM and release manifest

function checkSbomNotices(sbom) {
  const gaps = findSbomGaps(sbom);
  const problems = [...gaps.unresolvedNotices.map(name => `原文の欠け: ${String(name)}`),
    ...gaps.noLicenseInformation.map(name => `許諾の情報が無い部品: ${String(name)}`)];
  try { assertSbomPublishable(sbom); } catch (error) { if (problems.length === 0) problems.push(messageOf(error)); }
  return { problems, summary: `部品 ${sbom.components.length}件・原文の欠け ${gaps.unresolvedNotices.length}件`,
    notes: gaps.unclassifiedLicenses.length > 0 ? [`SPDX 識別子が未分類の部品 ${gaps.unclassifiedLicenses.length}件（原文はある。参考）: ${gaps.unclassifiedLicenses.join('・')}`] : [] };
}
function checkSbomManifest(sbom, saved) {
  const match = matchSbomToReleaseManifest(sbom, saved);
  const problems = [...match.missing.map(item => `公開一覧に無い SBOM のファイル: ${item.path}（${item.component}）`),
    ...match.mismatched.map(item => `SBOM と hash が違うファイル: ${item.path}（${item.component}）`)];
  try { assertSbomMatchesReleaseManifest(sbom, saved); } catch (error) { if (problems.length === 0) problems.push(messageOf(error)); }
  const version = sbom.metadata?.component?.version;
  if (version !== saved.version) problems.push(`SBOM の版 ${String(version)} ／ 公開一覧 ${String(saved.version)}`);
  const commit = (Array.isArray(sbom.metadata?.properties) ? sbom.metadata.properties : [])
    .find(property => property?.name === 'pointercad:sourceCommit')?.value;
  if (commit === undefined) problems.push('SBOM に commit の記録が無い');
  else if (commit !== saved.sourceCommit) problems.push(`SBOM の commit ${String(commit)} ／ 公開一覧 ${String(saved.sourceCommit)}`);
  return { problems, summary: `配布ファイル ${match.checked}件を照合` };
}
async function checkReleaseManifest(context) {
  const { input, need } = context, saved = context.saved();
  const sourceCommit = need(input.sourceCommit, 'sourceCommit', '今の commit');
  if (!COMMIT_PATTERN.test(sourceCommit)) throw new Error(`今の commit の形が違う: ${sourceCommit}`);
  try {
    await verifyReleaseManifest(saved, { packageFiles: input.packageFiles, builderConfig: input.builderConfig, tag: saved.tag ?? null, sourceCommit,
      sourceInputs: need(input.sourceInputs, 'sourceInputs', '今の入力の指紋'), candidates: context.candidates(), webFiles: context.webFiles() });
  } catch (error) {
    return { problems: [`記録または実物と一致しない: ${messageOf(error)}`], summary: '不一致' };
  }
  const assets = ['windows', 'linux'].reduce((sum, name) => sum + (saved.desktop?.[name]?.assets?.length ?? 0), 0);
  return { problems: [], summary: `版 ${String(saved.version)}・commit ${String(saved.sourceCommit).slice(0, 12)}・Web ${grouped(saved.web?.files?.length ?? 0)}ファイル・配布物 ${assets}件` };
}

// ---------------------------------------------------------------- README release links

/** Rows are recognised by their label; each link's kind is recognised by its URL. One place for the whole contract. */
export const README_LINK_ROWS = Object.freeze([
  { kind: 'windows-installer', label: 'Windows のインストーラー', keywords: ['インストーラ'] },
  { kind: 'windows-portable', label: 'Windows のポータブル版', keywords: ['ポータブル'] },
  { kind: 'linux-appimage', label: 'Linux の AppImage', keywords: ['AppImage'] },
  { kind: 'manual', label: '取扱説明書（HTML と PDF 全巻）', keywords: ['説明書'] },
  { kind: 'web-app', label: 'Web アプリ版', keywords: ['Webアプリ', 'ブラウザ'] },
]);
/** WEB_DEFERRED_PHRASE is a placeholder too, except on the Web row in the desktop scope. */
const PLACEHOLDER_PHRASES = Object.freeze(['初回リリース時', '準備中', '予定', '未公開', 'TODO', 'TBD', 'coming soon', WEB_DEFERRED_PHRASE]);
const KIND_LABELS = Object.freeze({ 'windows-installer': 'Windows のインストーラー', 'windows-portable': 'Windows のポータブル版',
  'linux-appimage': 'Linux の AppImage', 'manual-html': '取扱説明書の HTML（目次）', 'manual-volume-html': '取扱説明書の巻の HTML',
  'manual-pdf': '取扱説明書の PDF', 'web-app': 'Web アプリ版' });
function placeholderHost(host) {
  return /(?:^|\.)(?:example\.(?:com|net|org)|example|localhost|invalid|test|local)$/u.test(host)
    || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':') || host.startsWith('[');
}
function classifyReleaseUrl(target, expected) {
  let url;
  try { url = new URL(target); } catch { return { problem: `URL の形が違う: ${target}` }; }
  if (url.protocol !== 'https:') return { problem: `https の公開 URL でない導線: ${target}` };
  if (url.username !== '' || url.password !== '' || url.search !== '') return { problem: `認証情報や問い合わせを含む URL: ${target}` };
  const host = url.hostname.toLowerCase();
  if (placeholderHost(host)) return { problem: `仮の公開先: ${target}` };
  if (host === 'github.com') {
    if (/\/releases\/latest\//u.test(url.pathname)) return { problem: `版を固定しない latest の URL: ${target}` };
    const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (match === null) return { problem: `GitHub の配布物のダウンロード URL でない: ${target}` };
    const [, owner, repository, tag, rawAsset] = match;
    let asset;
    try { asset = decodeURIComponent(rawAsset); } catch { return { problem: `URL の形が違う: ${target}` }; }
    if (tag !== `v${expected.version}`) return { problem: `配布対象版と違うタグ: ${target}（期待 v${expected.version}）` };
    const kind = Object.keys(expected.assets).find(name => expected.assets[name] === asset);
    // The desktop scope reaches the manual through the PDF volumes attached to the same GitHub Release.
    const manualVolume = kind === undefined && expected.scope === 'desktop' ? manualPdfAssetVolume(asset, expected.version) : null;
    if (manualVolume !== null) {
      if (expected.volumeIds !== null && !expected.volumeIds.includes(manualVolume)) return { problem: `今の目録に無い巻への導線: ${target}` };
      return { kind: 'manual-pdf', volume: manualVolume, asset, repository: `${owner}/${repository}`.toLowerCase() };
    }
    if (kind === undefined) {
      const names = [...Object.values(expected.assets), ...(expected.scope === 'desktop' ? [`PointerCAD-${expected.version}-manual-<巻>.pdf`] : [])];
      return { problem: `配布対象版の配布物でない: ${asset}（期待 ${names.join('・')}）` };
    }
    return { kind, asset, repository: `${owner}/${repository}`.toLowerCase() };
  }
  const path = url.pathname, origin = url.origin;
  if (path === '/') return { kind: 'web-app', origin };
  if (path === '/manual/' || path === '/manual/index.html') return { kind: 'manual-html', origin };
  const volume = /^\/manual\/volumes\/([a-z][a-z0-9-]*)\.html$/u.exec(path), pdf = /^\/manual\/pdf\/([a-z][a-z0-9-]*)\.pdf$/u.exec(path);
  const id = (volume ?? pdf)?.[1];
  if (id !== undefined && expected.volumeIds !== null && !expected.volumeIds.includes(id)) return { problem: `今の目録に無い巻への導線: ${target}` };
  if (volume !== null) return { kind: 'manual-volume-html', origin, volume: id };
  if (pdf !== null) return { kind: 'manual-pdf', origin, volume: id };
  return { problem: `種類の分からない導線: ${target}` };
}
function readmeLine(line) {
  const targets = [];
  let rest = line.replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu, (_whole, text, target) => { targets.push(target); return ` ${text} `; });
  rest = rest.replace(/<a\s[^>]*href="([^"]+)"[^>]*>/giu, (_whole, target) => { targets.push(target); return ' '; });
  rest = rest.replace(/<(https?:\/\/[^>\s]+)>/gu, (_whole, target) => { targets.push(target); return ' '; });
  const label = line.startsWith('|') ? (rest.replace(/^\|/u, '').split('|')[0] ?? '').trim() : rest.trim();
  for (const match of rest.matchAll(/\bhttps?:\/\/[^\s|)<>）」』。、]+/gu)) targets.push(match[0]);
  return { label, targets: [...new Set(targets)] };
}
/**
 * Pre-release contract of README.md's release-links region: every kind once, pinned to the release version, no placeholders.
 * volumeIds null means the volume list is unknown: PDF links are then only required to exist, not to cover every volume.
 * scope all (default) requires the Web app and the Web manual (HTML contents and every PDF volume). scope desktop
 * (desktop-first release) requires the three desktop packages and every manual PDF volume attached to the same GitHub
 * Release (manualPdfReleaseAssetName); the Web row carries either its link or WEB_DEFERRED_PHRASE without a link, and
 * while it is deferred no link may point at a Web site. Every link found is returned with its kind (and the release
 * asset name for GitHub links), so the post-release check can follow the same links.
 */
export function checkReadmeReleaseLinks(readme, { version, volumeIds, scope = 'all' }) {
  const problems = [], links = [], releaseScope = scopeOf(scope);
  const count = marker => readme.split(marker).length - 1;
  if (count(RELEASE_LINKS_START) !== 1 || count(RELEASE_LINKS_END) !== 1) {
    return { problems: [`区間の印が1組でない（開始 ${count(RELEASE_LINKS_START)}・終了 ${count(RELEASE_LINKS_END)}）`], summary: '区間が無い', links };
  }
  const from = readme.indexOf(RELEASE_LINKS_START) + RELEASE_LINKS_START.length, to = readme.indexOf(RELEASE_LINKS_END);
  if (to < from) return { problems: ['区間の終了の印が開始より前にある'], summary: '区間が壊れている', links };
  const region = readme.slice(from, to);
  for (const phrase of PLACEHOLDER_PHRASES) {
    if (releaseScope === 'desktop' && phrase === WEB_DEFERRED_PHRASE) continue; // Judged row by row below.
    if (region.toLowerCase().includes(phrase.toLowerCase())) problems.push(`未公開の案内が残っている: 「${phrase}」`);
  }
  const [installer, portable] = desktopPackagePlan('win32', version), [appImage] = desktopPackagePlan('linux', version);
  const expected = { version, volumeIds, scope: releaseScope,
    assets: { 'windows-installer': installer.name, 'windows-portable': portable.name, 'linux-appimage': appImage.name } };
  const found = new Map(), origins = new Set(), repositories = new Set();
  let webDeferred = 0;
  for (const raw of region.split(/\r?\n/u)) {
    const line = raw.trim(), deferredHere = releaseScope === 'desktop' && line.includes(WEB_DEFERRED_PHRASE);
    if (line === '' || line.startsWith('<!--') || /^\|?[\s:|-]+\|?$/u.test(line)) {
      if (deferredHere) problems.push(`「${WEB_DEFERRED_PHRASE}」は Web アプリ版の行だけに書ける: 「${line}」`);
      continue;
    }
    const { label, targets } = readmeLine(line);
    const rows = README_LINK_ROWS.filter(row => row.keywords.some(keyword => label.includes(keyword)));
    if (rows.length > 1) { problems.push(`行の種類が曖昧: 「${label}」`); continue; }
    const row = rows[0];
    if (deferredHere) {
      if (row?.kind !== 'web-app') problems.push(`「${WEB_DEFERRED_PHRASE}」は Web アプリ版の行だけに書ける: 「${label}」`);
      else if (targets.length > 0) problems.push(`「${WEB_DEFERRED_PHRASE}」の行に導線がある（公開したなら「${WEB_DEFERRED_PHRASE}」を消す）: 「${label}」`);
      else { webDeferred += 1; continue; }
    }
    if (row === undefined) {
      if (targets.length > 0) problems.push(`種類の分からない行の導線: 「${label}」`);
      continue;
    }
    if (targets.length === 0) { problems.push(`導線の無い行: 「${label}」`); continue; }
    for (const target of targets) {
      const link = classifyReleaseUrl(target, expected);
      if (link.problem !== undefined) { problems.push(link.problem); continue; }
      const allowed = row.kind === 'manual' ? link.kind.startsWith('manual-') : link.kind === row.kind;
      if (!allowed) { problems.push(`誤った導線の種類: 「${label}」の行に${KIND_LABELS[link.kind]}の URL（${target}）`); continue; }
      const key = link.kind === 'manual-pdf' || link.kind === 'manual-volume-html' ? `${link.kind}:${link.volume}` : link.kind;
      found.set(key, new Set([...(found.get(key) ?? []), target]));
      if (link.origin !== undefined) origins.add(link.origin);
      if (link.repository !== undefined) repositories.add(link.repository);
      links.push(link.asset === undefined ? { kind: link.kind, url: target } : { kind: link.kind, url: target, asset: link.asset });
    }
  }
  const required = [['windows-installer', KIND_LABELS['windows-installer']], ['windows-portable', KIND_LABELS['windows-portable']],
    ['linux-appimage', KIND_LABELS['linux-appimage']],
    ...(releaseScope === 'all' ? [['manual-html', KIND_LABELS['manual-html']], ['web-app', KIND_LABELS['web-app']]] : []),
    ...(volumeIds ?? []).map(id => [`manual-pdf:${id}`, `${KIND_LABELS['manual-pdf']}（${id}）`])];
  for (const [key, label] of required) {
    const urls = found.get(key);
    if (urls === undefined) problems.push(`導線が無い: ${label}`);
    else if (urls.size > 1) problems.push(`同じ種類の導線が複数: ${label}（${[...urls].join('・')}）`);
  }
  if (volumeIds === null && ![...found.keys()].some(key => key.startsWith('manual-pdf:'))) problems.push(`導線が無い: ${KIND_LABELS['manual-pdf']}`);
  if (releaseScope === 'desktop') {
    const webLinks = found.get('web-app')?.size ?? 0;
    if (webDeferred === 0 && webLinks === 0) problems.push(`導線が無い: ${KIND_LABELS['web-app']}（公開前は Web アプリ版の行に「${WEB_DEFERRED_PHRASE}」と書く）`);
    else if (webDeferred + webLinks > 1) problems.push(`Web アプリ版の行が複数ある（「${WEB_DEFERRED_PHRASE}」${webDeferred}行・導線 ${webLinks}件）`);
    if (webDeferred > 0 && origins.size > 0) problems.push(`Web 版を「${WEB_DEFERRED_PHRASE}」とした区間に Web の公開先への導線がある: ${[...origins].join('・')}`);
    else if (webLinks > 0 && found.get('manual-html') === undefined) problems.push(`導線が無い: ${KIND_LABELS['manual-html']}（Web 版を公開したなら説明書の目次も載せる）`);
  }
  if (origins.size > 1) problems.push(`Web の公開先が複数ある: ${[...origins].join('・')}`);
  if (repositories.size > 1) problems.push(`配布物の置き場が複数のリポジトリにある: ${[...repositories].join('・')}`);
  const kinds = required.length + (releaseScope === 'desktop' ? 1 : 0);
  return { problems, summary: `導線 ${links.length}件（必要な種類 ${kinds}件${webDeferred > 0 ? `・Web アプリ版は${WEB_DEFERRED_PHRASE}` : ''}）`, links };
}
function checkReadme(context) {
  const { input } = context;
  if (typeof input.readme !== 'string') throw new Error('README.md を読めない');
  const version = packageVersion(input.packageFiles?.root, 'ルートの package.json');
  if (!VERSION_PATTERN.test(version)) throw new Error(`版の形が違う: ${version}`);
  let volumeIds = null, unknownVolumes = null;
  try { volumeIds = context.help().volumes.map(volume => volume.id); }
  catch (helpError) { unknownVolumes = messageOf(helpError); }
  if (volumeIds === null) {
    let listed = null;
    try { listed = context.saved().manual?.volumes ?? []; }
    catch (savedError) { unknownVolumes = `${String(unknownVolumes)}／${messageOf(savedError)}`; }
    if (Array.isArray(listed) && listed.length > 0) { volumeIds = listed.map(volume => String(volume?.id)); unknownVolumes = null; }
    else if (listed !== null) unknownVolumes = `${String(unknownVolumes)}／公開一覧に巻が無い`;
  }
  const result = checkReadmeReleaseLinks(input.readme, { version, volumeIds, scope: scopeOf(input.scope) });
  const problems = unknownVolumes === null ? [...result.problems]
    : [...result.problems, `巻の一覧を読めないため PDF 全巻の導線を照合できない（${unknownVolumes}）`];
  return { problems, summary: result.summary };
}

// ---------------------------------------------------------------- post-release entry (P13-20)

function webOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ReleaseReadinessUsageError(`--web-url の形が違う: ${value}`); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== ''
    || placeholderHost(url.hostname.toLowerCase())) throw new ReleaseReadinessUsageError(`--web-url は公開先の https の根（例 https://<名前>.pages.dev/）: ${value}`);
  return url.href;
}
function downloadBase(value) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/$/u.test(value)) {
    throw new ReleaseReadinessUsageError(`--download-url は https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/ の形: ${value}`);
  }
  return value;
}
function postReleaseCheck(input) {
  const base = { id: 'post-release', group: '公開後', title: '公開先から取得した配布物・説明書・Web の hash が公開一覧と一致する' };
  const problems = [];
  for (const [label, validate, value] of [['--web-url', webOrigin, input.webUrl], ['--download-url', downloadBase, input.downloadUrl]]) {
    try { validate(String(value)); } catch (error) { problems.push(`${label}: ${messageOf(error)}`); }
  }
  const notes = [`Web: ${String(input.webUrl)}`, `配布物: ${String(input.downloadUrl)}`,
    `公開一覧: ${input.releaseManifest instanceof Uint8Array ? '読めた' : `読めない（${input.readErrors?.releaseManifest ?? '入力が無い'}）`}`];
  return Object.freeze({ ...base, status: problems.length > 0 ? 'fail' : 'not-implemented',
    summary: 'P13-20 で実装する（実 URL からの取得と hash の照合）', problems: Object.freeze(problems), notes: Object.freeze(notes) });
}

// ---------------------------------------------------------------- post-release, Desktop part (P13-20, desktop-first)

const POST_RELEASE_DESKTOP_CHECKS = Object.freeze([
  { id: 'post-release-assets', group: '公開後', title: 'GitHub Release の配布物3種と説明書の PDF 全巻を取得し、大きさと hash が公開一覧と一致する' },
  { id: 'post-release-readme', group: '公開後', title: 'README の Desktop の導線（配布物3種・説明書の PDF 全巻）が公開した Release の同じ実物に届く' },
  { id: 'post-release-web', group: '公開後', title: 'Web 版と説明書の HTML を公開先から取得して照合する' },
]);
export const POST_RELEASE_DESKTOP_CHECK_IDS = Object.freeze(POST_RELEASE_DESKTOP_CHECKS.map(check => check.id));
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** What the GitHub Release of this version must carry, read from release-manifest.json alone. */
function expectedReleaseAssets(saved) {
  const version = saved.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error(`公開一覧の版の形が違う: ${String(version)}`);
  const assets = [], problems = [];
  const add = (entry, label, kind) => {
    if (!record(entry) || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      problems.push(`公開一覧の${label}の記録の形が違う: ${String(entry?.name)}`);
      return;
    }
    assets.push({ kind, name: entry.name, bytes: entry.bytes, sha256: entry.sha256 });
  };
  for (const [platform, key] of [['win32', 'windows'], ['linux', 'linux']]) {
    const listed = Array.isArray(saved.desktop?.[key]?.assets) ? saved.desktop[key].assets : [];
    const names = listed.map(entry => String(entry?.name)).sort(), planned = desktopPackagePlan(platform, version).map(item => item.name).sort();
    if (!same(names, planned)) problems.push(`公開一覧の ${platformLabel(platform)} の配布物が計画と違う: ${names.join('・')} ／ ${planned.join('・')}`);
    for (const entry of listed) add(entry, ` ${platformLabel(platform)} の配布物`, 'package');
  }
  const files = new Map((Array.isArray(saved.web?.files) ? saved.web.files : []).filter(record).map(file => [file.path, file]));
  const volumes = Array.isArray(saved.manual?.volumes) ? saved.manual.volumes : [];
  if (volumes.length === 0) problems.push('公開一覧に説明書の巻が無い');
  for (const volume of volumes) {
    const id = String(volume?.id), file = files.get(volume?.pdf);
    if (file === undefined) { problems.push(`公開一覧に説明書の PDF の記録が無い: ${String(volume?.pdf)}（${id}）`); continue; }
    add({ ...file, name: manualPdfReleaseAssetName(version, id) }, '説明書の PDF', 'manual-pdf');
  }
  return { version, volumeIds: volumes.map(volume => String(volume?.id)), assets, problems };
}
async function compareDownload(fetchOnce, url, asset) {
  const outcome = await fetchOnce(url);
  if (Object.hasOwn(outcome, 'error')) return [`取得できない: ${asset.name}（${url}）: ${messageOf(outcome.error)}`];
  const result = outcome.value;
  if (!record(result) || !Number.isSafeInteger(result.status)) return [`取得の結果の形が違う: ${url}`];
  if (result.status !== 200) return [`取得できない: ${asset.name}（${url}）: HTTP ${String(result.status)}`];
  const problems = [];
  if (result.bytes !== asset.bytes) problems.push(`大きさの違い: ${asset.name} 取得 ${grouped(Number(result.bytes))} バイト ／ 公開一覧 ${grouped(asset.bytes)} バイト`);
  if (result.sha256 !== asset.sha256) problems.push(`hash の違い: ${asset.name}（${url}）`);
  return problems;
}
/**
 * Post-release mode for the desktop-first release: download every desktop package and manual PDF volume from the GitHub
 * Release (input.download, one request per URL), compare size and SHA-256 with release-manifest.json, and follow README's
 * Desktop links to the same assets. The Web part stays deferred until the Web version is published.
 */
async function evaluatePostReleaseDesktop(input) {
  const downloads = new Map();
  const fetchOnce = url => {
    if (!downloads.has(url)) {
      downloads.set(url, Promise.resolve().then(() => {
        if (typeof input.download !== 'function') throw new Error('取得の処理が無い');
        return input.download(url);
      }).then(value => ({ value }), error => ({ error })));
    }
    return downloads.get(url);
  };
  let cached = null;
  const saved = () => {
    if (cached === null) {
      if (!(input.releaseManifest instanceof Uint8Array)) throw new Error(`release-manifest.json を読めない（${input.readErrors?.releaseManifest ?? '入力が無い'}）`);
      const value = parseJson(input.releaseManifest, 'release-manifest.json');
      if (!record(value)) throw new Error('release-manifest.json の形が違う');
      cached = { value, expected: expectedReleaseAssets(value) };
    }
    return cached;
  };
  const releaseBase = () => {
    try { return downloadBase(String(input.downloadUrl)); } catch (error) { throw new Error(`--download-url: ${messageOf(error)}`, { cause: error }); }
  };
  const bodies = {
    'post-release-assets': async () => {
      const base = releaseBase(), { value, expected } = saved(), problems = [...expected.problems];
      if (!base.endsWith(`/v${expected.version}/`)) problems.push(`公開一覧の版 v${expected.version} と違う Release: ${base}`);
      if (value.tag !== null && value.tag !== undefined && value.tag !== `v${expected.version}`) problems.push(`公開一覧のタグ ${String(value.tag)} ／ 版 v${expected.version}`);
      for (const asset of expected.assets) problems.push(...await compareDownload(fetchOnce, `${base}${encodeURIComponent(asset.name)}`, asset));
      const packages = expected.assets.filter(asset => asset.kind === 'package').length, pdfs = expected.assets.length - packages;
      return { problems, summary: `配布物 ${packages}件・説明書の PDF ${pdfs}巻を ${base} から取得して照合` };
    },
    'post-release-readme': async () => {
      if (typeof input.readme !== 'string') throw new Error(`README.md を読めない（${input.readErrors?.readme ?? '入力が無い'}）`);
      const base = releaseBase(), { expected } = saved();
      const result = checkReadmeReleaseLinks(input.readme, { version: expected.version, volumeIds: expected.volumeIds, scope: 'desktop' });
      const problems = [...result.problems], byName = new Map(expected.assets.map(asset => [asset.name, asset]));
      let followed = 0;
      for (const link of result.links) {
        if (link.asset === undefined) continue; // A Web link: judged when the Web version is published.
        const asset = byName.get(link.asset);
        if (!link.url.startsWith(base)) { problems.push(`公開した Release と違う置き場への導線: ${link.url}（期待 ${base}…）`); continue; }
        if (asset === undefined) { problems.push(`公開一覧に無い配布物への導線: ${link.url}`); continue; }
        followed += 1;
        problems.push(...(await compareDownload(fetchOnce, link.url, asset)).map(problem => `README の導線: ${problem}`));
      }
      return { problems, summary: `README の Desktop の導線 ${followed}件を取得して照合（${result.summary}）` };
    },
    'post-release-web': () => ({ status: 'deferred', problems: [],
      summary: `${DEFERRED_REASON}（全体の公開後モード --scope all で実装する）` }),
  };
  const checks = [];
  for (const check of POST_RELEASE_DESKTOP_CHECKS) checks.push(await runCheck(check, bodies[check.id]));
  return finish('post-release', checks, 'desktop');
}

/**
 * The real download behind post-release mode: follows GitHub's redirect to the file store and hashes the body while it
 * streams, so a 2 GiB package never sits in memory. Anything but HTTP 200 is returned as its status (no body read).
 */
export function createReleaseDownloader({ fetch: fetchImpl = globalThis.fetch, timeoutMs = 1_800_000, maxBytes = RELEASE_DOWNLOAD_MAX_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch が無い（Node.js 18 以降で実行する）');
  return async url => {
    const response = await fetchImpl(url, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'PointerCAD-release-check' } });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      return { status: response.status, bytes: 0, sha256: null };
    }
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`大きすぎる（${grouped(maxBytes)} バイトを超えた）: ${url}`);
      hash.update(chunk);
    }
    return { status: 200, bytes: total, sha256: hash.digest('hex') };
  };
}

// ---------------------------------------------------------------- judgement and report

const CHECK_BODIES = Object.freeze({
  'manual-chapters': context => checkChapters(context.manual(), context.help()),
  'manual-controls': context => checkControls(context.manual(), context.help()),
  'manual-features': context => checkFeatures(context.manual(), context.help()),
  'manual-images': context => checkImages(context.manual(), context.input.captureFreshness),
  'manual-current': context => checkCurrentEdition(context.manual(), context.help()),
  versions: context => checkVersions(context),
  'version-publishable': context => checkPublishableVersion(context),
  volumes: context => checkVolumes(context),
  'asset-size': context => checkAssetSize(context.webFiles()),
  'asset-count': context => checkAssetCount(context.webFiles()),
  'sbom-notices': context => checkSbomNotices(context.sbom()),
  'sbom-manifest': context => checkSbomManifest(context.sbom(), context.saved()),
  'release-manifest': context => checkReleaseManifest(context),
  'readme-links': context => checkReadme(context),
});

/**
 * Judge one candidate (pre-release) or one generated manual (manual: only MANUAL_CHECK_IDS, with the same bodies).
 * Every check runs independently, so one unreadable part does not hide the other results.
 */
export async function evaluateReleaseReadiness(input) {
  if (!record(input)) throw new TypeError('Release readiness input must be an object');
  const scope = scopeOf(input.scope);
  if (input.mode === 'post-release') return scope === 'desktop' ? evaluatePostReleaseDesktop(input) : finish('post-release', [postReleaseCheck(input)]);
  if (input.mode !== 'pre-release' && input.mode !== 'manual') throw new TypeError(`Unknown release readiness mode: ${String(input.mode)}`);
  if (input.mode === 'manual' && scope !== 'all') throw new TypeError('Manual mode has no desktop scope');
  const context = createContext(input), checks = [];
  for (const check of CHECKS) {
    if (input.mode === 'manual' && !MANUAL_CHECK_IDS.includes(check.id)) continue;
    const body = () => CHECK_BODIES[check.id](context);
    checks.push(scope === 'desktop' && DESKTOP_DEFERRED_CHECK_IDS.includes(check.id) ? await deferredCheck(check, body) : await runCheck(check, body));
  }
  return finish(input.mode, checks, scope);
}

export function formatReleaseReadinessReport(report, { targets = [] } = {}) {
  const desktop = report.scope === 'desktop' ? '・デスクトップ先行（Web 版の項目は後回し）' : '';
  const lines = [report.mode === 'pre-release' ? `PointerCAD 公開前の整合検査（公開前モード${desktop}）`
    : report.mode === 'manual' ? 'PointerCAD 説明書の整合検査（説明書モード・P12-20）' : `PointerCAD 公開後の確認（公開後モード${desktop}）`];
  if (targets.length > 0) lines.push(`対象: ${targets.join(' ・ ')}`);
  for (const check of report.checks) {
    lines.push(`[${STATUS_LABELS[check.status] ?? check.status}] ${check.group} ${check.title} — ${check.summary}`);
    for (const problem of check.problems.slice(0, MAX_LISTED_PROBLEMS)) lines.push(`    ・${problem}`);
    if (check.problems.length > MAX_LISTED_PROBLEMS) lines.push(`    ・…ほか ${check.problems.length - MAX_LISTED_PROBLEMS}件`);
    for (const note of check.notes) lines.push(`    （参考）${note}`);
  }
  const { summary } = report;
  lines.push(`合計: 合格 ${summary.pass}・不合格 ${summary.fail}・保留 ${summary.pending}・未実装 ${summary.notImplemented}`
    + (summary.deferred > 0 ? `・後回し ${summary.deferred}` : '')
    + ` → 終了コード ${report.exitCode}（${exitMeanings(report)[report.exitCode] ?? '不明'}）`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- command line

const USAGE = [
  '使い方（<名前> は dist/ 直下のフォルダー名。英小文字・数字・-）:',
  '  公開前: node scripts/release/releaseReadiness.mjs --mode pre-release [--scope desktop] --windows <名前> --linux <名前> --web <名前> --release <名前> --sbom <名前> [--report <JSON の保存先>]',
  '  公開後: node scripts/release/releaseReadiness.mjs --mode post-release --release <名前> --web-url https://<公開先>/ --download-url https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/ [--report <JSON の保存先>]',
  '  公開後（デスクトップ先行）: node scripts/release/releaseReadiness.mjs --mode post-release --scope desktop --release <名前> --download-url https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/ [--report <JSON の保存先>]',
  '  --scope: all（既定。Web 版を含む全条件）・desktop（デスクトップ先行。Web 版だけの条件は後回し）',
  '  説明書: node scripts/release/releaseReadiness.mjs --mode manual --manual <名前（scripts/manual/generate.mjs の出力名）> [--report <JSON の保存先>]',
].join('\n');
const FLAGS = Object.freeze({ '--mode': 'mode', '--windows': 'windows', '--linux': 'linux', '--web': 'web', '--release': 'release', '--sbom': 'sbom',
  '--web-url': 'webUrl', '--download-url': 'downloadUrl', '--manual': 'manual', '--report': 'report', '--scope': 'scope' });
const MODE_KEYS = Object.freeze({ 'pre-release': ['windows', 'linux', 'web', 'release', 'sbom'], 'post-release': ['release', 'webUrl', 'downloadUrl'],
  manual: ['manual'] });
/** The desktop-first post-release check has no Web site to visit, so it takes no --web-url. */
const POST_RELEASE_DESKTOP_KEYS = Object.freeze(['release', 'downloadUrl']);
const modeKeys = options => options.mode === 'post-release' && options.scope === 'desktop' ? POST_RELEASE_DESKTOP_KEYS : MODE_KEYS[options.mode];

export function parseReleaseReadinessArguments(args) {
  const options = { mode: 'pre-release' }, seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!Object.hasOwn(FLAGS, flag)) throw new ReleaseReadinessUsageError(`知らない引数: ${String(flag)}`);
    if (seen.has(flag)) throw new ReleaseReadinessUsageError(`同じ引数が2回ある: ${flag}`);
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw new ReleaseReadinessUsageError(`値が無い: ${flag}`);
    seen.add(flag); options[FLAGS[flag]] = value;
  }
  if (!Object.hasOwn(MODE_KEYS, options.mode)) throw new ReleaseReadinessUsageError(`--mode は pre-release・post-release・manual のどれか: ${options.mode}`);
  if (options.scope !== undefined && !RELEASE_READINESS_SCOPES.includes(options.scope)) {
    throw new ReleaseReadinessUsageError(`--scope は ${RELEASE_READINESS_SCOPES.join('・')} のどれか: ${options.scope}`);
  }
  if (options.mode === 'manual' && options.scope !== undefined) throw new ReleaseReadinessUsageError('manual では使わない引数: --scope');
  options.scope ??= 'all';
  const keys = modeKeys(options);
  for (const key of Object.values(FLAGS)) {
    if (key !== 'mode' && key !== 'report' && key !== 'scope' && options[key] !== undefined && !keys.includes(key)) {
      const where = options.mode === 'post-release' && options.scope === 'desktop' ? 'post-release --scope desktop' : options.mode;
      throw new ReleaseReadinessUsageError(`${where} では使わない引数: --${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`);
    }
  }
  for (const key of keys) {
    const flag = `--${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`;
    if (options[key] === undefined) throw new ReleaseReadinessUsageError(`${flag} が必要`);
    if (key !== 'webUrl' && key !== 'downloadUrl' && !NAME_PATTERN.test(options[key])) {
      throw new ReleaseReadinessUsageError(`${flag} は dist/ 直下のフォルダー名（英小文字・数字・-）: ${options[key]}`);
    }
  }
  if (options.mode === 'pre-release') {
    const names = MODE_KEYS['pre-release'].map(key => options[key]);
    if (new Set(names).size !== names.length) throw new ReleaseReadinessUsageError('5つのフォルダー名は互いに違う名前にする');
  } else if (options.mode === 'post-release') {
    if (options.scope !== 'desktop') options.webUrl = webOrigin(options.webUrl);
    options.downloadUrl = downloadBase(options.downloadUrl);
  }
  return Object.freeze(options);
}

async function streamDigest(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size === 0) throw new Error(`配布物が無いか空: ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error(`読んでいる間に配布物が変わった: ${path}`);
  return { bytes: before.size, sha256: hash.digest('hex') };
}
/** Same reading as scripts/release/build-release-manifest.mjs, so the saved manifest can be recomputed from the same inputs. */
async function readDesktopStage(root, stage) {
  const stagedFiles = await collectDesktopFiles(root, join(stage, 'app'));
  const packageManifestBytes = stagedFiles.find(file => file.path === 'desktop-package.json')?.bytes;
  if (packageManifestBytes === undefined) throw new Error(`desktop-package.json が無い: ${stage}`);
  const receiptPath = join(stage, 'candidate.json'), receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error(`candidate.json が通常のファイルでない: ${stage}`);
  const artifactsFolder = join(stage, 'artifacts'), artifacts = [];
  for (const entry of await readdir(artifactsFolder, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`配布物の置き場に想定外の項目: ${entry.name}`);
    artifacts.push({ name: entry.name, ...await streamDigest(join(artifactsFolder, entry.name)) });
  }
  return { receiptBytes: await readFile(receiptPath), packageManifestBytes, stagedFiles, artifacts };
}
async function manualSourceInputs(root, webFiles) {
  const manifest = parseJson(webFiles.find(file => file.path === 'manual/manifest.json')?.bytes, 'manual/manifest.json');
  if (!record(manifest) || !record(manifest.inputs)) throw new Error('説明書の入力の記録が無い');
  const inputs = {};
  for (const name of Object.keys(manifest.inputs)) {
    offlineAssetUrl(name);
    let cursor = root;
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`説明書の入力がリンク: ${name}`);
    }
    if (!(await lstat(cursor)).isFile()) throw new Error(`説明書の入力が通常のファイルでない: ${name}`);
    inputs[name] = sourceFileHash(await readFile(cursor)); // scripts/manual/generate.mjs と同じ読み方（改行の形に依らない）
  }
  return inputs;
}
async function readCandidateFile(folder, name) {
  for (const path of [folder, join(folder, name)]) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`リンクは読まない: ${path}`);
  }
  return readFile(join(folder, name));
}
function gitHead(root) {
  return execFileSync('git', ['--no-optional-locks', '-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'],
    { cwd: root, env: localGitEnvironment(), encoding: 'utf8', windowsHide: true }).trim();
}

/** The live catalog, coverage and labels from the same sources the application and the manual generator use. */
export async function loadCurrentHelp(root) {
  const [{ createServer }, { verifyCurrentManualEdition }] = await Promise.all([import('vite'), import('../manual/currentManualEdition.mjs')]);
  const server = await createServer({ configFile: false, root, logLevel: 'warn', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false }, ssr: { noExternal: ['@pointercad/help-content'] } });
  try {
    const { MANUAL_CHAPTERS: chapters, MANUAL_VOLUMES: volumes } = await server.ssrLoadModule('/packages/help-content/src/manualManifest.ts');
    const { FEATURE_HELP_BINDINGS } = await server.ssrLoadModule('/packages/help-content/src/featureHelpBindings.ts');
    const coverage = await server.ssrLoadModule('/packages/help-content/src/helpFeatureCoverage.ts');
    const { COMMAND_DEFINITIONS } = await server.ssrLoadModule('/packages/ui/src/commands/commandDefinitions.ts');
    const { ja } = await server.ssrLoadModule('/packages/ui/src/i18n/ja.ts');
    const requirements = coverage.parseHelpRequirements(sourceText(await readFile(join(root, 'docs/requirements.md'), 'utf8')));
    const chapterSources = new Map();
    for (const chapter of chapters) {
      if (chapter.path !== `docs/ja/${chapter.id}.md`) throw new Error(`章の原文の置き場が違う: ${chapter.id}`);
      chapterSources.set(chapter.id, sourceText(await readFile(join(root, 'packages/help-content', chapter.path), 'utf8')));
    }
    return Object.freeze({ chapters, volumes, chapterSources, uiLabels: ja,
      featureCoverage: coverage.buildHelpFeatureCoverage(requirements, chapters, FEATURE_HELP_BINDINGS),
      commandCoverage: coverage.buildCommandHelpCoverage(COMMAND_DEFINITIONS, chapters),
      assertDocumentedFeatureCoverage: value => coverage.assertDocumentedFeatureCoverage(value),
      verifyManualEdition: files => verifyCurrentManualEdition(root, files) });
  } finally { await server.close(); }
}

const MANUAL_IMAGE_NAME = /^images\/([a-zA-Z0-9_-]+\.png)$/u;
const APPLICATION_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * The registry comparison behind loadCaptureFreshness(), split out so a test can supply a fabricated
 * CaptureRegistry and image bytes without touching the file system or applicationInputDigest(). `files` are
 * the manual images to check, each with its actual current bytes (loadCaptureFreshness reads them from
 * packages/help-content/docs/ja/images/, the same folder the registry itself is built from); a path this
 * function is not given is simply not reported here (the caller folds an unreadable path into unregistered).
 * assessCaptureImages()'s six categories become CaptureFreshnessResult's two: images the registry does not
 * list at all stay unregistered; every other way a capture record fails to vouch for this exact, current
 * build — wrong content, an unknown or different application build, or a changed/missing script — becomes
 * stale, since none of them confirm the image is this build's capture output.
 * `manualImages` (optional) are the manual's own copies (path and SHA-256, as CaptureFreshnessRequest.images carries
 * them): a copy whose SHA-256 differs from the capture folder's current bytes is an older image under a current
 * name, so it is stale too even when the folder and its registry are fresh (P12-20 旧画像).
 */
export function captureFreshnessFromRegistry(registry, files, { applicationBuildId, scripts, manualImages = [] } = {}) {
  const named = [], pathOf = new Map(), current = new Map();
  for (const file of files) {
    const match = MANUAL_IMAGE_NAME.exec(file.path);
    if (match === null) throw new Error(`説明書の画像の置き場が違う: ${file.path}`);
    named.push({ name: match[1], bytes: file.bytes });
    pathOf.set(match[1], file.path); current.set(file.path, sha256(file.bytes));
  }
  const assessment = assessCaptureImages(registry, named, { applicationBuildId, scripts });
  const toPaths = names => names.map(name => pathOf.get(name) ?? name);
  const replaced = manualImages.filter(image => current.has(image.path) && current.get(image.path) !== image.sha256).map(image => image.path);
  return {
    stale: [...new Set([...toPaths(assessment.mismatched), ...toPaths(assessment.buildUnknown),
      ...toPaths(assessment.buildMismatch), ...toPaths(assessment.scriptChanged), ...toPaths(assessment.scriptMissing), ...replaced])],
    unregistered: toPaths(assessment.unregistered),
    notes: [`登録簿の画像 ${grouped(registry.images.length)}枚のうち ${grouped(assessment.checked)}枚を今のアプリの入力の指紋と照合`,
      ...(replaced.length > 0 ? [`説明書の中の画像が撮影の置き場（${CAPTURE_IMAGE_FOLDER}）の今の画像と違う ${grouped(replaced.length)}枚`] : [])],
  };
}

/**
 * Connect point for condition ④ (images from the current build's capture scripts). "The current build" is
 * decided by applicationInputDigest() (scripts/manual/captureRegistry.mjs): a digest of the application's
 * own build inputs that excludes the manual's text and images, not the git commit. Committing a fresh
 * capture (or any manual-only edit) changes HEAD without changing the application; using the commit would
 * then mark every already-current image stale on the very commit that registers it (coordinator decision
 * 2026-09-24, w35a-t1b). readCaptureRegistry()/readCaptureScripts() read the same registry and script
 * sources scripts/manual/captureRegistry.mjs itself is built from; the actual current image bytes are read
 * fresh from packages/help-content/docs/ja/images/ (not from request.images, which carries only path +
 * SHA-256 already computed from the release candidate's own bytes) so assessCaptureImages() hashes real
 * content instead of a value that would need to be fabricated to match a known digest. That SHA-256 of the
 * manual's own copy must still equal the capture folder's image: a manual that carries an older image under a
 * current name is stale even when the folder itself is fresh (P12-20 旧画像).
 */
export function loadCaptureFreshness() {
  return async request => {
    const registry = await readCaptureRegistry(repositoryRoot);
    const scripts = await readCaptureScripts(repositoryRoot, registry);
    const applicationBuildId = await applicationInputDigest(repositoryRoot);
    if (typeof applicationBuildId !== 'string' || !APPLICATION_DIGEST_PATTERN.test(applicationBuildId)) {
      throw new Error(`アプリの入力の指紋（applicationInputDigest）の形が違う: ${String(applicationBuildId)}`);
    }
    const files = [], unreadable = [];
    for (const image of request.images) {
      const match = MANUAL_IMAGE_NAME.exec(image.path);
      if (match === null) { unreadable.push(image.path); continue; }
      try { files.push({ path: image.path, bytes: await readFile(join(repositoryRoot, CAPTURE_IMAGE_FOLDER, match[1])) }); }
      catch { unreadable.push(image.path); }
    }
    const result = captureFreshnessFromRegistry(registry, files, { applicationBuildId, scripts, manualImages: request.images });
    return unreadable.length === 0 ? result : { ...result, unregistered: [...new Set([...result.unregistered, ...unreadable])] };
  };
}

export async function readPreReleaseInput(root, options) {
  const readErrors = {};
  const attempt = async (key, action) => {
    try { return await action(); } catch (error) { readErrors[key] = messageOf(error); return null; }
  };
  const dist = join(root, 'dist');
  const distInfo = await lstat(dist).catch(() => null);
  if (distInfo === null || distInfo.isSymbolicLink() || !distInfo.isDirectory()) readErrors.dist = 'dist/ が無いかリンク';
  const folder = name => {
    if (readErrors.dist !== undefined) throw new Error(readErrors.dist);
    return join(dist, name);
  };
  const packageFiles = { root: await readFile(join(root, 'package.json')), desktop: await readFile(join(root, 'apps/desktop/package.json')),
    web: await readFile(join(root, 'apps/web/package.json')) };
  const builderConfig = await readFile(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const releaseManifest = await attempt('releaseManifest', () => readCandidateFile(folder(options.release), 'release-manifest.json'));
  const sbom = await attempt('sbom', () => readCandidateFile(folder(options.sbom), 'sbom.json'));
  const webFiles = await attempt('web', () => collectDesktopFiles(root, folder(options.web)));
  const candidates = await attempt('candidates', async () => [await readDesktopStage(root, folder(options.windows)),
    await readDesktopStage(root, folder(options.linux))]);
  const sourceCommit = await attempt('sourceCommit', () => gitHead(root));
  let sourceInputs = null, currentHelp = null;
  if (webFiles === null || candidates === null) readErrors.sourceInputs = '候補を読めないため計算しない';
  else {
    sourceInputs = await attempt('sourceInputs', async () => ({ web: await captureWebBuildSources(root),
      desktop: await captureDesktopBuildSources(root), manual: await manualSourceInputs(root, webFiles) }));
  }
  if (webFiles === null) readErrors.currentHelp = 'Web の候補を読めないため読み込まない';
  else currentHelp = await attempt('currentHelp', () => loadCurrentHelp(root));
  return { mode: 'pre-release', scope: scopeOf(options.scope), packageFiles, builderConfig, readme, releaseManifest, sbom, webFiles, candidates,
    sourceCommit, sourceInputs, currentHelp, captureFreshness: loadCaptureFreshness(), readErrors: Object.freeze(readErrors) };
}
/** Manual mode: one generated manual, dist/<name>/, read like scripts/manual/verify.mjs, against the current help. */
export async function readManualInput(root, options) {
  const readErrors = {};
  let manualFiles = null, currentHelp = null;
  try {
    const dist = join(root, 'dist'), info = await lstat(dist).catch(() => null);
    if (info === null || info.isSymbolicLink() || !info.isDirectory()) throw new Error('dist/ が無いかリンク');
    manualFiles = await collectDesktopFiles(root, join(dist, options.manual));
  } catch (error) { readErrors.manual = messageOf(error); }
  if (manualFiles === null) readErrors.currentHelp = '説明書を読めないため読み込まない';
  else {
    try { currentHelp = await loadCurrentHelp(root); } catch (error) { readErrors.currentHelp = messageOf(error); }
  }
  return { mode: 'manual', manualFiles, currentHelp, captureFreshness: loadCaptureFreshness(), readErrors: Object.freeze(readErrors) };
}
/** Post-release input; the desktop scope also reads README.md and downloads from the GitHub Release (createReleaseDownloader). */
export async function readPostReleaseInput(root, options, { download = null } = {}) {
  const readErrors = {};
  let releaseManifest = null;
  try { releaseManifest = await readCandidateFile(join(root, 'dist', options.release), 'release-manifest.json'); }
  catch (error) { readErrors.releaseManifest = messageOf(error); }
  if (scopeOf(options.scope) !== 'desktop') {
    return { mode: 'post-release', releaseManifest, webUrl: options.webUrl, downloadUrl: options.downloadUrl, readErrors: Object.freeze(readErrors) };
  }
  let readme = null;
  try { readme = await readFile(join(root, 'README.md'), 'utf8'); } catch (error) { readErrors.readme = messageOf(error); }
  return { mode: 'post-release', scope: 'desktop', releaseManifest, downloadUrl: options.downloadUrl, readme,
    download: download ?? createReleaseDownloader(), readErrors: Object.freeze(readErrors) };
}
function reportTarget(root, path) {
  const target = resolve(root, path), local = relative(root, target);
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
    throw new ReleaseReadinessUsageError(`--report はプロジェクトの中を指定する: ${path}`);
  }
  if (local === 'dist' || local.startsWith(`dist${sep}`)) throw new ReleaseReadinessUsageError(`--report を dist/（候補の置き場）の中に置かない: ${path}`);
  return target;
}

export async function runReleaseReadiness(args, { root = repositoryRoot, write = text => log(text), download = null } = {}) {
  let options, reportPath = null;
  try {
    options = parseReleaseReadinessArguments(args);
    if (options.report !== undefined) {
      reportPath = reportTarget(root, options.report);
      if (await lstat(reportPath).then(() => true, () => false)) throw new ReleaseReadinessUsageError(`--report の保存先が既にある: ${options.report}`);
    }
  } catch (error) {
    if (!(error instanceof ReleaseReadinessUsageError)) throw error;
    write(`check-release-ready: 引数の誤り: ${error.message}\n${USAGE}`);
    return RELEASE_READINESS_EXIT.usage;
  }
  const targets = modeKeys(options).filter(key => key !== 'webUrl' && key !== 'downloadUrl').map(key => `dist/${options[key]}`);
  if (options.mode === 'post-release') targets.push(...[options.webUrl, options.downloadUrl].filter(value => value !== undefined));
  const input = options.mode === 'pre-release' ? await readPreReleaseInput(root, options)
    : options.mode === 'manual' ? await readManualInput(root, options) : await readPostReleaseInput(root, options, { download });
  const report = await evaluateReleaseReadiness(input);
  write(formatReleaseReadinessReport(report, { targets }));
  if (reportPath !== null) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ ...report, targets }, null, 2)}\n`, { flag: 'wx' });
    write(`結果の JSON: ${relative(root, reportPath).split(sep).join('/')}`);
  }
  return report.exitCode;
}

function invokedDirectly() {
  if (typeof argv[1] !== 'string') return false;
  try {
    const script = realpathSync.native(argv[1]), entry = realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? script.toLowerCase() === entry.toLowerCase() : script === entry;
  } catch { return false; }
}
if (invokedDirectly()) {
  try { process.exitCode = await runReleaseReadiness(argv.slice(2)); }
  catch (error) {
    log(`check-release-ready: 内部の誤り: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = RELEASE_READINESS_EXIT.internal;
  }
}
