import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_PROVENANCE_FORMAT, CAPTURE_REGISTRY_FORMAT, CaptureRegistryError, applicationInputDigest, assessCaptureImages,
  auditCaptureRegistry, buildCaptureRegistry, classifyCaptureViewport, collectChapterImageReferences, formatCaptureRegistry,
  inspectAdoptableCapture, parseCaptureRegistry, readCaptureFolder, readCaptureRegistry, readCaptureScripts, readPngSize,
  validateCaptureRegistry, type CaptureFile, type CaptureRegistry,
} from '../../../scripts/manual/captureRegistry.mjs';
import { localGitEnvironment } from '../../../scripts/lib/gitEnvironment.mjs';
import { sourceFileHash } from '../../../scripts/release/desktopFileInventory.mjs';
import { captureWebBuildSources } from '../../../scripts/vite/webBuildSources.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/** A new folder inside the project's scratchpad (scripts/lib/task_workspace.py refuses places outside the project). */
const taskWorkspace = (task: string): string => execFileSync('python',
  ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), task],
  { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const chapterFolder = new URL('../docs/ja/', import.meta.url);
const imageFolder = new URL('../docs/ja/images/', import.meta.url);
const REGISTER = 'node scripts/manual/captureRegistry.mjs register で登録し直す';

/**
 * 理由付きの既知の一覧。実物がこの一覧を超えたら落ちる（直して一覧から減るのはよい）。
 * 撮り直しは後の撮影の作業（計画 P12-16・P12-17）で行う。
 */
const KNOWN_UNREFERENCED: Readonly<Record<string, string>> = {
  'sheet-edit-flange-preview.png': 'フランジの編集中の見た目を撮った画像だが、どの章も参照していない。章へ載せるか削除するかを後の撮影の作業で決める（2026-09-24 棚卸し PLAN-01）。',
};
const KNOWN_OUTSIDE_VIEWPORT_POLICY: Readonly<Record<string, string>> = {
  'sketch-text-outlines.png': '旧形式の撮影記録で 1280×720（画面検査の既定の大きさ。p8-drawing.spec.ts の該当の検査は大きさを指定していない）。1440×900 で撮り直しが要る。',
  'offline-prepared.png': '撮影の記録が無く、画像の画素数が 1280×720。1440×900 で撮り直しが要る。',
};
const noRecord = (script: string) => `撮影の記録が無い。${script} が同じ名前の画像を書き出すので、後の撮影の作業で記録付きで撮り直す。`;
const KNOWN_WITHOUT_CAPTURE_RECORD: Readonly<Record<string, string>> = {
  'function-axis-math.png': noRecord('e2e/tests/functionPlotFlow.ts'),
  'function-closed-sphere.png': noRecord('e2e/tests/functionClosedSurfaceFlow.ts'),
  'function-cut-sphere.png': noRecord('e2e/tests/functionClosedSurfaceFlow.ts'),
  'function-implicit-circle.png': noRecord('e2e/tests/functionImplicitCurveFlow.ts'),
  'function-implicit-cut-sphere.png': noRecord('e2e/tests/functionClosedSurfaceFlow.ts'),
  'function-implicit-open-arc.png': noRecord('e2e/tests/functionImplicitCurveFlow.ts'),
  'function-implicit-sphere.png': noRecord('e2e/tests/functionClosedSurfaceFlow.ts'),
  'function-surface-parametric.png': noRecord('e2e/tests/functionSurfaceFlow.ts'),
  'function-surface-xyz-preview.png': noRecord('e2e/tests/functionSurfaceFlow.ts'),
  'function-xyz-preview.png': noRecord('e2e/tests/functionPlotFlow.ts'),
  'offline-prepared.png': '撮影の記録が無く、同じ名前の画像を書き出す台本も無い（通信なし利用の準備の画面）。後の撮影の作業で台本を作って撮り直す。',
};
const beyond = (found: readonly string[], known: Readonly<Record<string, string>>) => found.filter(name => !Object.hasOwn(known, name));

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/**
 * SHA-256 of a script as Git stores it: every CRLF read as LF. Computed here without sourceFileHash
 * (scripts/release/desktopFileInventory.mjs) so the registry functions do not check themselves; latin1 keeps every byte.
 */
const lfSha = (bytes: Uint8Array) => sha(Buffer.from(Buffer.from(bytes).toString('latin1').replaceAll('\r\n', '\n'), 'latin1'));
const encoder = new TextEncoder();
const file = (name: string, bytes: Uint8Array): CaptureFile => ({ name, bytes });
const json = (name: string, value: unknown): CaptureFile => ({ name, bytes: encoder.encode(JSON.stringify(value)) });
const text = (name: string, value: string): CaptureFile => ({ name, bytes: encoder.encode(value) });
/** The smallest header readPngSize accepts; the last byte keeps each image's bytes distinct. */
const png = (width: number, height: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(34), view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[33] = seed;
  return bytes;
};
const legacy = (name: string, image: Uint8Array, viewport: readonly [number, number] = [1440, 900]) => ({
  file: name, testRun: 'run-1', testSource: 'e2e/tests/example.spec.ts', viewport, sha256: sha(image),
  kind: 'actual-application-screenshot', edited: false,
});
const details = (name: string, image: Uint8Array, options: { readonly height?: number; readonly buildId?: string;
  readonly scriptSha256?: string; readonly script?: string } = {}) => json(`${name}-capture-details.json`, {
  format: 1, releaseCertified: false,
  captures: [{ name, script: options.script ?? 'e2e/tests/exampleFlow.ts', capture: {
    format: 'pointercad-manual-detail/1', releaseCertified: false, applicationBuildId: options.buildId ?? null,
    project: 'functional', sourceTest: '例の撮影', scriptSha256: options.scriptSha256 ?? 'a'.repeat(64),
    fixture: { filename: `${name}-fixture.json`, sha256: 'b'.repeat(64) },
    screen: { filename: `${name}-screen.png`, sha256: 'c'.repeat(64) }, detail: { filename: `${name}-detail.png`, sha256: sha(image) },
    screenState: { width: 1440, height: options.height ?? 900, deviceScaleFactor: 1, fontStatus: 'loaded', url: 'http://127.0.0.1:4173/' },
  } }],
});
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const editable = (registry: CaptureRegistry) => structuredClone(registry) as Mutable<CaptureRegistry>;

describe('撮影の登録簿（capture-manifest.json）と実際の画像・章', () => {
  it('章の画像の参照・登録簿・実ファイルの SHA-256 を照合し、全件に画面の大きさがある', async () => {
    const registry = parseCaptureRegistry(readFileSync(new URL('capture-manifest.json', imageFolder), 'utf8'));
    // List, hash and read the links independently so the registry functions do not check themselves.
    const pngs = readdirSync(imageFolder).filter(name => name.endsWith('.png')).sort();
    const actual = new Map(pngs.map(name => [name, sha(readFileSync(new URL(name, imageFolder)))]));
    const referenced = new Set<string>();
    for (const chapter of readdirSync(chapterFolder).filter(name => name.endsWith('.md'))) {
      for (const match of readFileSync(new URL(chapter, chapterFolder), 'utf8').matchAll(/!\[[^\]]*\]\((?:\.\/)?images\/([^\s)]+)\)/gu)) {
        referenced.add(match[1]);
      }
    }
    expect(pngs.length).toBeGreaterThan(0);
    expect(registry.images.map(entry => entry.file), REGISTER).toEqual(pngs);
    for (const entry of registry.images) {
      expect(entry.sha256, `${entry.file}: ${REGISTER}`).toBe(actual.get(entry.file));
      expect(entry.viewport, entry.file).toHaveLength(2);
      expect(entry.viewportClass, entry.file).toBe(classifyCaptureViewport(entry.viewport));
    }
    expect([...referenced].filter(image => !actual.has(image))).toEqual([]);

    const audit = auditCaptureRegistry(registry, await readCaptureFolder(root));
    expect(audit).toMatchObject({ images: pngs.length, registered: pngs.length, referenced: referenced.size,
      unregistered: [], missingImages: [], shaMismatches: [], pixelConflicts: [], missingReferencedImages: [] });
    expect(audit.unreferenced).toEqual(pngs.filter(name => !referenced.has(name)));
  });

  it('登録簿は撮影の記録と画像から作り直した内容と一致する（登録の実行漏れ・手での書き換えを拒否）', async () => {
    const folder = await readCaptureFolder(root);
    const stored = parseCaptureRegistry(readFileSync(new URL('capture-manifest.json', imageFolder), 'utf8'));
    expect(buildCaptureRegistry(folder.files), REGISTER).toEqual(stored);
  });

  it('未参照・画面の大きさの例外外・撮影の記録なしは、理由付きの既知の一覧を超えない', async () => {
    const registry = parseCaptureRegistry(readFileSync(new URL('capture-manifest.json', imageFolder), 'utf8'));
    const audit = auditCaptureRegistry(registry, await readCaptureFolder(root));
    expect(beyond(audit.unreferenced, KNOWN_UNREFERENCED)).toEqual([]);
    expect(beyond(audit.viewportOutsidePolicy, KNOWN_OUTSIDE_VIEWPORT_POLICY)).toEqual([]);
    expect(beyond(audit.withoutCaptureRecord, KNOWN_WITHOUT_CAPTURE_RECORD)).toEqual([]);
    for (const reason of [KNOWN_UNREFERENCED, KNOWN_OUTSIDE_VIEWPORT_POLICY, KNOWN_WITHOUT_CAPTURE_RECORD].flatMap(list => Object.values(list))) {
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  it('今の版の画像の判定は、登録の SHA-256・版の識別子・撮影後の台本の変化を分けて報告する', async () => {
    const registry = await readCaptureRegistry(root);
    const images = (await readCaptureFolder(root)).files.filter(entry => entry.name.endsWith('.png'));
    const report = assessCaptureImages(registry, images, { applicationBuildId: 'build-under-test',
      scripts: await readCaptureScripts(root, registry) });
    expect(report).toMatchObject({ checked: images.length, unregistered: [], mismatched: [] });
    // An image without a recorded build is not confirmed as the current version.
    expect(report.buildUnknown).toEqual(registry.images.filter(entry => entry.applicationBuildId === null).map(entry => entry.file));
    // An image recorded from another build is reported as such, whether or not adopted images exist yet
    // (after adopting, every adopted image records its real build, never the placeholder of this test).
    expect(report.buildMismatch).toEqual(registry.images.filter(entry => entry.applicationBuildId !== null
      && entry.applicationBuildId !== 'build-under-test').map(entry => entry.file));
    // No image has the placeholder build, so every checked image is either of unknown or of another build.
    expect([...report.buildUnknown, ...report.buildMismatch].sort()).toEqual(images.map(entry => entry.name).sort());
    // Compare the recorded script hashes with the current scripts independently. A recorded script may sit in a
    // subfolder of e2e/tests/ (e.g. e2e/tests/flows/), so look up each recorded path instead of listing one folder.
    const exists = (script: string) => existsSync(new URL(`../../../${script}`, import.meta.url));
    const hashed = registry.images.flatMap(entry => (entry.script !== null && entry.scriptSha256 !== null
      ? [{ file: entry.file, script: entry.script, scriptSha256: entry.scriptSha256 }] : []));
    expect(report.scriptMissing).toEqual(hashed.filter(entry => !exists(entry.script)).map(entry => entry.file));
    expect(report.scriptChanged).toEqual(hashed.filter(entry => exists(entry.script)
      && lfSha(readFileSync(new URL(`../../../${entry.script}`, import.meta.url))) !== entry.scriptSha256).map(entry => entry.file));
    // "current" needs every image to be of the given build; an image of another build is not current either
    // (once every image is adopted, buildUnknown is empty but buildMismatch still lists all of them here).
    expect(report.current).toBe(report.buildUnknown.length === 0 && report.buildMismatch.length === 0
      && report.scriptChanged.length === 0 && report.scriptMissing.length === 0);
  });
});

describe('撮影の登録簿の作成と照合の誤りを見つける', () => {
  it('未登録・画像の無い登録・SHA-256 の違い・参照先の欠け・未参照を見つける', () => {
    const a = png(1440, 900, 1), b = png(720, 540, 2), c = png(1440, 900, 3);
    const registry = buildCaptureRegistry([file('a.png', a), file('b.png', b), json('capture-manifest.json', [legacy('a.png', a), legacy('b.png', b)])]);
    const audit = auditCaptureRegistry(registry, { files: [file('b.png', png(720, 540, 9)), file('c.png', c)],
      chapters: [{ name: 'x.md', text: '![例](images/b.png)\n![例](./images/missing.png)' }] });
    expect(audit.unregistered).toEqual(['c.png']);
    expect(audit.missingImages).toEqual(['a.png']);
    expect(audit.shaMismatches).toEqual([{ file: 'b.png', registered: sha(b), actual: sha(png(720, 540, 9)) }]);
    expect(audit.missingReferencedImages).toEqual([{ image: 'missing.png', chapters: ['x.md'] }]);
    expect(audit.unreferenced).toEqual(['c.png']);
  });

  it('撮影の記録が無い画像は「撮影の記録なし」と明記して登録し、画素数を画面の大きさとする', () => {
    const registry = buildCaptureRegistry([file('new.png', png(1440, 900, 4))]);
    expect(registry.format).toBe(CAPTURE_REGISTRY_FORMAT);
    expect(registry.images).toEqual([{ file: 'new.png', sha256: sha(png(1440, 900, 4)), viewport: [1440, 900],
      viewportClass: 'standard', viewportSource: 'png-size', script: null, scriptSha256: null, fixtureSha256: null,
      capturedAt: null, applicationBuildId: null, records: [], unknown: { script: 'no-capture-record',
        scriptSha256: 'no-capture-record', fixtureSha256: 'no-capture-record', capturedAt: 'no-capture-record',
        applicationBuildId: 'no-capture-record' } }]);
    expect(registry.unknownReasons['no-capture-record']).toContain('撮影の記録なし');
  });

  it('撮影の記録から台本・fixture・画面の大きさを取り、日時と版の null に理由を付ける', () => {
    const image = png(720, 540, 5);
    const registry = buildCaptureRegistry([file('m-detail.png', image), details('m', image, { height: 1100 })]);
    expect(registry.images[0]).toMatchObject({ viewport: [1440, 1100], viewportClass: 'tall-exception',
      viewportSource: 'capture-details', script: 'e2e/tests/exampleFlow.ts', scriptSha256: 'a'.repeat(64),
      fixtureSha256: 'b'.repeat(64), capturedAt: null, applicationBuildId: null,
      unknown: { capturedAt: 'no-capture-time', applicationBuildId: 'build-id-null' },
      records: [{ kind: 'capture-details', file: 'm-capture-details.json', name: 'm', image: 'detail' }] });
  });

  it('旧形式の配列の項目を records にそのまま残し、作り直しても変わらない', () => {
    const a = png(1440, 900, 6);
    const first = buildCaptureRegistry([file('a.png', a), json('capture-manifest.json', [legacy('a.png', a)])]);
    expect(first.images[0]).toMatchObject({ script: 'e2e/tests/example.spec.ts', viewportSource: 'capture-manifest',
      records: [{ kind: 'capture-manifest', entry: legacy('a.png', a) }],
      unknown: { scriptSha256: 'legacy-no-hash', fixtureSha256: 'legacy-no-hash', capturedAt: 'no-capture-time',
        applicationBuildId: 'legacy-no-build-id' } });
    expect(buildCaptureRegistry([file('a.png', a), text('capture-manifest.json', formatCaptureRegistry(first))])).toEqual(first);
    expect(parseCaptureRegistry(formatCaptureRegistry(first))).toEqual(first);
    expect(formatCaptureRegistry(first, encoder.encode('[\r\n]\r\n'))).toContain('\r\n');
  });

  it('撮り直した画像は新しい撮影の記録で更新し、中身の違う旧形式の項目を外す', () => {
    const old = png(1440, 900, 10), recaptured = png(1440, 900, 11);
    const first = buildCaptureRegistry([file('m-detail.png', old), json('capture-manifest.json', [legacy('m-detail.png', old)])]);
    const next = buildCaptureRegistry([file('m-detail.png', recaptured), details('m', recaptured),
      text('capture-manifest.json', formatCaptureRegistry(first))]);
    expect(next.images[0].sha256).toBe(sha(recaptured));
    expect(next.images[0].records.map(ref => ref.kind)).toEqual(['capture-details']);
  });

  it('記録の無い差し替え・記録と画像の食い違い・画像の無い登録・重複した記録・未対応のファイルを登録で拒否する', () => {
    const a = png(1440, 900, 7), b = png(1440, 900, 8);
    const registered = formatCaptureRegistry(buildCaptureRegistry([file('a.png', a)]));
    expect(() => buildCaptureRegistry([file('a.png', b), text('capture-manifest.json', registered)])).toThrow('changed after registration');
    expect(() => buildCaptureRegistry([file('m-detail.png', a), details('m', b)])).toThrow('does not match the bytes');
    expect(() => buildCaptureRegistry([text('capture-manifest.json', registered)])).toThrow('Registered image is missing');
    expect(() => buildCaptureRegistry([file('m-detail.png', a), details('m', a), { ...details('m', a), name: 'n-capture-details.json' }]))
      .toThrow('Several capture records');
    expect(() => buildCaptureRegistry([file('notes.txt', new Uint8Array(1))])).toThrow('Unexpected file');
    expect(() => buildCaptureRegistry([file('a.png', a), json('capture-manifest.json', [{ ...legacy('a.png', a), viewport: [0, 900] }])]))
      .toThrow('invalid capture-manifest entry');
    // Every problem is listed at once instead of stopping at the first one.
    let caught: unknown = null;
    try {
      buildCaptureRegistry([file('m-detail.png', a), details('m', b), file('notes.txt', new Uint8Array(1))]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CaptureRegistryError);
    expect(caught instanceof CaptureRegistryError ? caught.problems : []).toHaveLength(2);
  });

  it('画面の大きさを 1440×900・1440×1100・それ以外に分け、画素と記録の食い違いを見つける', () => {
    expect(classifyCaptureViewport([1440, 900])).toBe('standard');
    expect(classifyCaptureViewport([1440, 1100])).toBe('tall-exception');
    expect(classifyCaptureViewport([1280, 720])).toBe('needs-recapture');
    const small = png(1280, 720, 12), wide = png(1500, 900, 13);
    const registry = buildCaptureRegistry([file('small.png', small), file('w-detail.png', wide), details('w', wide)]);
    const audit = auditCaptureRegistry(registry, { files: [file('small.png', small), file('w-detail.png', wide)], chapters: [] });
    expect(audit.viewportOutsidePolicy).toEqual(['small.png']);
    expect(audit.pixelConflicts).toEqual([{ file: 'w-detail.png', pixels: [1500, 900], viewport: [1440, 900] }]);
    expect(audit.viewportClasses).toEqual({ 'needs-recapture': 1, standard: 1 });
  });

  it('理由の無い null・誤った理由・並び順の乱れ・方針や分類の書き換え・旧形式の配列を登録簿として受け付けない', () => {
    const base = buildCaptureRegistry([file('a.png', png(1440, 900, 14)), file('b.png', png(1440, 900, 15))]);
    const missingReason = editable(base);
    delete missingReason.images[0].unknown.script;
    expect(() => validateCaptureRegistry(missingReason)).toThrow('reason');
    const wrongReason = editable(base);
    wrongReason.images[0].unknown.script = 'no-capture-time';
    expect(() => validateCaptureRegistry(wrongReason)).toThrow('no-capture-record');
    const unsorted = editable(base);
    unsorted.images.reverse();
    expect(() => validateCaptureRegistry(unsorted)).toThrow('sorted');
    const policy = editable(base);
    policy.viewportPolicy.standard = [1280, 720];
    expect(() => validateCaptureRegistry(policy)).toThrow('viewportPolicy');
    const reclassified = editable(base);
    reclassified.images[0].viewportClass = 'tall-exception';
    expect(() => validateCaptureRegistry(reclassified)).toThrow('viewportClass');
    expect(() => parseCaptureRegistry(formatCaptureRegistry(base).replace('"script": "no-capture-record"', '"script": "guess"')))
      .toThrow('reason');
    expect(() => parseCaptureRegistry('[]')).toThrow(CAPTURE_REGISTRY_FORMAT);
  });

  it('章の画像リンクは images/ と ./images/ を受け付け、ほかの形は拒否する', () => {
    const references = collectChapterImageReferences([{ name: 'a.md', text: '![x](images/a.png)\n![y](./images/a.png) ![z](./images/b.png)' },
      { name: 'b.md', text: '![w](images/a.png)' }]);
    expect([...references]).toEqual([['a.png', ['a.md', 'b.md']], ['b.png', ['a.md']]]);
    expect(() => collectChapterImageReferences([{ name: 'c.md', text: '![x](https://example.com/a.png)' }])).toThrow('Unsupported');
    expect(() => collectChapterImageReferences([{ name: 'c.md', text: '![x](images/sub/a.png)' }])).toThrow('Unsupported');
    expect(readPngSize(png(720, 540, 16))).toEqual([720, 540]);
    expect(() => readPngSize(new Uint8Array(40))).toThrow('Not a PNG');
  });

  it('公開前の判定は、中身・未登録・版・台本の変化を分けて報告する', () => {
    const image = png(720, 540, 20), script = encoder.encode('撮影の台本');
    const registry = buildCaptureRegistry([file('m-detail.png', image), details('m', image, { buildId: 'build-1', scriptSha256: sha(script) })]);
    const scripts = new Map([['e2e/tests/exampleFlow.ts', script]]);
    expect(assessCaptureImages(registry, [file('m-detail.png', image)], { applicationBuildId: 'build-1', scripts }))
      .toEqual({ checked: 1, unregistered: [], mismatched: [], buildUnknown: [], buildMismatch: [], scriptChanged: [],
        scriptMissing: [], current: true });
    const stale = assessCaptureImages(registry, [file('m-detail.png', png(720, 540, 21)), file('x.png', image)],
      { applicationBuildId: 'build-2', scripts: new Map([['e2e/tests/exampleFlow.ts', encoder.encode('変わった台本')]]) });
    expect(stale).toMatchObject({ checked: 2, unregistered: ['x.png'], mismatched: ['m-detail.png'], buildMismatch: ['m-detail.png'],
      scriptChanged: ['m-detail.png'], current: false });
    expect(assessCaptureImages(registry, [file('m-detail.png', image)], { applicationBuildId: 'build-1', scripts: new Map() }))
      .toMatchObject({ scriptMissing: ['m-detail.png'], current: false });
    const unknownBuild = buildCaptureRegistry([file('u.png', image)]);
    expect(assessCaptureImages(unknownBuild, [file('u.png', image)], { applicationBuildId: 'build-1' }))
      .toMatchObject({ buildUnknown: ['u.png'], current: false });
    expect(() => assessCaptureImages(registry, [], { applicationBuildId: ' ' })).toThrow('applicationBuildId');
  });

  it('撮影の台本は LF と CRLF の写しで同じ値になり、どちらの取り出しで判定しても変わらず、中身の違いだけを見つける', async () => {
    // The real recorder script, as the Windows checkout (CRLF) and the CI checkout (LF) write it.
    const real = readFileSync(new URL('../../../e2e/tests/captureManualDetail.ts', import.meta.url)).toString('latin1');
    const lfText = real.replaceAll('\r\n', '\n'), crlfText = lfText.replaceAll('\n', '\r\n');
    const lf = Buffer.from(lfText, 'latin1'), crlf = Buffer.from(crlfText, 'latin1');
    expect(crlf.length).toBeGreaterThan(lf.length);
    expect(sha(crlf)).not.toBe(sha(lf));
    expect(sourceFileHash(crlf)).toBe(sourceFileHash(lf));
    expect(sourceFileHash(lf)).toBe(lfSha(crlf));
    const edited = Buffer.from(crlfText.replace('captureManualDetail', 'captureManualDetailEdited'), 'latin1');
    expect(sourceFileHash(edited)).not.toBe(sourceFileHash(lf));

    // Recorded in either checkout, judged from the files of either checkout read by readCaptureScripts.
    const folder = taskWorkspace('capture-script-line-ends-test');
    try {
      const image = png(720, 540, 23), script = join(folder, 'e2e/tests/exampleFlow.ts');
      mkdirSync(join(folder, 'e2e/tests'), { recursive: true });
      for (const recorded of [lf, crlf]) {
        const registry = buildCaptureRegistry([file('m-detail.png', image),
          details('m', image, { buildId: 'build-1', scriptSha256: sourceFileHash(recorded) })]);
        expect(registry.images[0].scriptSha256).toBe(lfSha(lf));
        for (const [checkout, changed] of [[lf, []], [crlf, []], [edited, ['m-detail.png']]] as const) {
          writeFileSync(script, checkout);
          const report = assessCaptureImages(registry, [file('m-detail.png', image)],
            { applicationBuildId: 'build-1', scripts: await readCaptureScripts(folder, registry) });
          expect(report).toMatchObject({ scriptChanged: changed, scriptMissing: [], current: changed.length === 0 });
        }
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('アプリの入力の指紋（applicationInputDigest）', () => {
  const digestWorkspace = (): string => taskWorkspace('application-input-digest-test');
  const git = (folder: string, ...args: string[]): string => execFileSync('git', ['--no-optional-locks', ...args],
    { cwd: folder, env: localGitEnvironment(), encoding: 'utf8', windowsHide: true });

  it('説明書の章・画像・登録簿を足す/書き換えても値は変わらず、アプリのソースを1バイト変えると値が変わる', async () => {
    const folder = digestWorkspace();
    git(folder, 'init', '--quiet');
    mkdirSync(join(folder, 'packages/example/src'), { recursive: true });
    mkdirSync(join(folder, 'packages/help-content/docs/ja/images'), { recursive: true });
    const source = join(folder, 'packages/example/src/main.ts');
    writeFileSync(source, 'export const value = 1;\n');
    const chapter = join(folder, 'packages/help-content/docs/ja/example.md');
    writeFileSync(chapter, '# 例\n');
    const image = join(folder, 'packages/help-content/docs/ja/images/example.png');
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    git(folder, 'add', '.');

    const before = await applicationInputDigest(folder);
    expect(before).toMatch(/^[0-9a-f]{64}$/u);
    // 同じ入力なら常に同じ値(結合の区切りがOS依存でないことも含む)。
    expect(await applicationInputDigest(folder)).toBe(before);

    // 説明書の章を書き換え、既存の画像を差し替え、新しい画像・登録簿を足しても値は変わらない。
    writeFileSync(chapter, '# 例(書き換え)\n');
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    writeFileSync(join(folder, 'packages/help-content/docs/ja/images/new-capture.png'), Buffer.from([1, 2, 3]));
    writeFileSync(join(folder, 'packages/help-content/docs/ja/images/capture-manifest.json'), '{}');
    expect(await applicationInputDigest(folder)).toBe(before);

    // アプリのソース(説明書の外)を1バイトでも変えると値が変わる。
    writeFileSync(source, 'export const value = 2;\n');
    expect(await applicationInputDigest(folder)).not.toBe(before);
  });

  const runtimePrefix = 'packages/fem/runtime/';
  const runtimeManifest = runtimePrefix + 'manifest.json';
  const archive = 'sources/pointercad-beam-application-source.zip';
  const index = 'evidence/application-source-index.json';
  const record = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected fixture object');
    return value as Record<string, unknown>;
  };
  const runtimeFixture = () => {
    const folder = digestWorkspace();
    git(folder, 'init', '--quiet');
    const write = (path: string, bytes: string | Uint8Array) => {
      const absolute = join(folder, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
    };
    // Use the current runtime manifest, preserving all fields outside the two regenerated pins.
    const manifest = record(JSON.parse(readFileSync(join(root, runtimeManifest), 'utf8')));
    const files = record(manifest.files);
    const regenerate = (capture: string) => {
      const capturePath = 'packages/help-content/docs/ja/images/example-capture-details.json';
      write(capturePath, capture);
      mkdirSync(join(folder, runtimePrefix, 'sources'), { recursive: true });
      execFileSync('python', ['-B', '-X', 'utf8', '-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], "w"); z.writestr(sys.argv[2], sys.argv[3]); z.close()',
        join(folder, runtimePrefix, archive), capturePath, capture], { cwd: folder, windowsHide: true });
      const archiveBytes = readFileSync(join(folder, runtimePrefix, archive));
      write(runtimePrefix + index, JSON.stringify({ files: [{ path: capturePath, sha256: sha(Buffer.from(capture)) }],
        archiveSha256: sha(archiveBytes) }) + '\n');
      for (const path of [archive, index]) {
        const bytes = readFileSync(join(folder, runtimePrefix, path));
        files[path] = { ...record(files[path]), sha256: sha(bytes), bytes: bytes.length };
      }
      write(runtimeManifest, JSON.stringify(manifest, null, 2) + '\n');
    };
    const appInputs = {
      'packages/example/src/main.ts': 'export const value = 1;\n',
      'packages/example/src/view.tsx': 'export const view = <div />;\n',
      'packages/example/src/style.css': 'body { color: red; }\n',
      'packages/example/src/i18n/ja.json': '{"label":"first"}\n',
      'packages/fem/runtime/assets/runtime.py': 'value = 1\n',
      'packages/fem/runtime/assets/runtime.wasm': Buffer.from([0, 97, 115, 109]),
      'packages/fem/runtime/assets/runtime.whl': Buffer.from([0, 80, 75, 1]),
      'packages/fem/runtime/assets/runtime.js': 'export const runtime = 1;\n',
      'packages/fem/runtime/evidence/other.json': '{"evidence":1}\n',
      'packages/fem/runtime/sources/other.zip': Buffer.from([0, 80, 75, 2]),
      'packages/fem/runtime/notices/example.txt': 'notice\n',
      'packages/fem/runtime/evidence/application-source-index.json.extra': 'nearby index\n',
      'packages/fem/runtime/sources/pointercad-beam-application-source.zip.extra': 'nearby archive\n',
    };
    for (const [path, bytes] of Object.entries(appInputs)) write(path, bytes);
    regenerate('{"capture":1}');
    git(folder, 'add', '.');
    return { folder, manifest, files, write, regenerate, appInputs,
      saveManifest: () => write(runtimeManifest, JSON.stringify(manifest, null, 2) + '\n') };
  };

  it('撮影JSONからソース控えと2 pinを再生成しても撮影版は一定で、完全なWeb入力は変わる', async () => {
    const fixture = runtimeFixture();
    try {
      const before = await applicationInputDigest(fixture.folder);
      const completeBefore = await captureWebBuildSources(fixture.folder);
      fixture.regenerate('{"capture":2,"image":"new.png"}');
      expect(await applicationInputDigest(fixture.folder)).toBe(before);
      expect(await captureWebBuildSources(fixture.folder)).not.toEqual(completeBefore);
      fixture.regenerate('{"capture":3,"image":"new.png"}');
      expect(await applicationInputDigest(fixture.folder)).toBe(before);
      // JSON and ordinary sources have the same identity in LF and CRLF checkouts.
      for (const path of [runtimeManifest, runtimePrefix + index, 'packages/example/src/main.ts']) {
        const text = readFileSync(join(fixture.folder, path), 'utf8');
        fixture.write(path, text.replaceAll('\n', '\r\n'));
      }
      expect(await applicationInputDigest(fixture.folder)).toBe(before);
    } finally { rmSync(fixture.folder, { recursive: true, force: true }); }
  });

  it('実行ソース・資産・他の証拠と近似名の変更、追加、削除を引き続き検出する', async () => {
    const fixture = runtimeFixture();
    try {
      const before = await applicationInputDigest(fixture.folder);
      for (const [path, original] of Object.entries(fixture.appInputs)) {
        fixture.write(path, Buffer.concat([typeof original === 'string' ? Buffer.from(original) : original, Buffer.from('changed')]));
        expect(await applicationInputDigest(fixture.folder), path).not.toBe(before);
        fixture.write(path, original);
        rmSync(join(fixture.folder, path));
        expect(await applicationInputDigest(fixture.folder), path).not.toBe(before);
        fixture.write(path, original);
      }
      fixture.write('packages/fem/runtime/evidence/added.json', '{}');
      expect(await applicationInputDigest(fixture.folder)).not.toBe(before);
    } finally { rmSync(fixture.folder, { recursive: true, force: true }); }
  });

  it('manifestの他field、他pin、2 pinの追加属性を射影から落とさない', async () => {
    const fixture = runtimeFixture();
    try {
      const before = await applicationInputDigest(fixture.folder);
      const otherPath = Object.keys(fixture.files).find(path => path !== archive && path !== index);
      if (otherPath === undefined) throw new Error('Current manifest needs another runtime pin');
      const mutations = [
        () => { fixture.manifest.extraCaptureRegression = true; },
        () => { record(fixture.manifest.applicationSource).completeRuntimeCorrespondingSourceClaim = true; },
        () => { record(record(fixture.manifest.files)[otherPath]).sha256 = 'a'.repeat(64); },
        () => { record(record(fixture.manifest.files)[archive]).extraCaptureRegression = true; },
        () => { delete fixture.manifest.applicationSource; },
      ];
      for (const mutate of mutations) {
        const original = JSON.stringify(fixture.manifest);
        mutate(); fixture.saveManifest();
        try { expect(await applicationInputDigest(fixture.folder)).not.toBe(before); }
        catch (error) { expect(String(error)).toContain('Invalid capture application source:'); }
        for (const key of Object.keys(fixture.manifest)) delete fixture.manifest[key];
        Object.assign(fixture.manifest, record(JSON.parse(original)));
        fixture.saveManifest();
      }
    } finally { rmSync(fixture.folder, { recursive: true, force: true }); }
  });

  it.each(['manifest', 'archive', 'index', 'archive-pin', 'index-pin', 'manifest-json', 'index-json',
    'sha-string', 'sha-type', 'sha-missing', 'bytes-string', 'bytes-negative', 'bytes-zero', 'bytes-fraction', 'bytes-unsafe', 'bytes-missing',
    'archive-reference', 'index-reference'].flatMap(invalid => [archive, index].map(pinPath => [invalid, pinPath] as const)))(
    'ソース控えの欠落や不正な入力を隠さない: %s (%s)', async (invalid, pinPath) => {
    const fixture = runtimeFixture();
    try {
      if (invalid === 'manifest') rmSync(join(fixture.folder, runtimeManifest));
      else if (invalid === 'archive' || invalid === 'index') rmSync(join(fixture.folder, runtimePrefix, invalid === 'archive' ? archive : index));
      else if (invalid === 'manifest-json' || invalid === 'index-json') fixture.write(invalid === 'manifest-json' ? runtimeManifest : runtimePrefix + index, '{');
      else {
        if (invalid === 'archive-pin' || invalid === 'index-pin') delete fixture.files[invalid === 'archive-pin' ? archive : index];
        else if (invalid.endsWith('-reference')) record(fixture.manifest.applicationSource)[invalid === 'archive-reference' ? 'archive' : 'index'] = 'evidence/other.json';
        else {
          const pin = record(fixture.files[pinPath]);
          if (invalid === 'sha-string') pin.sha256 = 'invalid';
          if (invalid === 'sha-type') pin.sha256 = 64;
          if (invalid === 'sha-missing') delete pin.sha256;
          if (invalid === 'bytes-string') pin.bytes = '1';
          if (invalid === 'bytes-negative') pin.bytes = -1;
          if (invalid === 'bytes-zero') pin.bytes = 0;
          if (invalid === 'bytes-fraction') pin.bytes = 1.5;
          if (invalid === 'bytes-unsafe') pin.bytes = Number.MAX_SAFE_INTEGER + 1;
          if (invalid === 'bytes-missing') delete pin.bytes;
        }
        fixture.saveManifest();
      }
      await expect(applicationInputDigest(fixture.folder)).rejects.toThrow('Invalid capture application source:');
    } finally { rmSync(fixture.folder, { recursive: true, force: true }); }
  });
});

describe('Current capture script provenance must exist when scripts are checked', () => {
  it.each(['script', 'scriptSha256', 'both'])('rejects a valid partial registry with missing %s', missing => {
    const image = png(720, 540, 24), script = encoder.encode('capture script');
    const registry = buildCaptureRegistry([file('m-detail.png', image),
      details('m', image, { buildId: 'build-1', scriptSha256: sha(script) })]);
    const entry = registry.images[0];
    const missingPath = missing !== 'scriptSha256', missingHash = missing !== 'script';
    const partial = validateCaptureRegistry({ ...registry, images: [{ ...entry,
      script: missingPath ? null : entry.script,
      scriptSha256: missingHash ? null : entry.scriptSha256,
      unknown: { ...entry.unknown,
        ...(missingPath ? { script: 'no-script-path' } : {}),
        ...(missingHash ? { scriptSha256: 'image-source-no-hash' } : {}) },
    }] });
    const scripts = new Map([['e2e/tests/exampleFlow.ts', script]]);
    expect(assessCaptureImages(registry, [file('m-detail.png', image)],
      { applicationBuildId: 'build-1', scripts })).toMatchObject({ scriptMissing: [], current: true });
    expect(assessCaptureImages(partial, [file('m-detail.png', image)],
      { applicationBuildId: 'build-1', scripts })).toMatchObject({
      checked: 1, mismatched: [], buildUnknown: [], buildMismatch: [],
      scriptMissing: ['m-detail.png'], current: false,
    });
  });
});

describe('撮影の台本のパスは e2e/tests/ の下のフォルダーを受け付け、不正なパスを拒否する', () => {
  /** The real producer: e2e/tests/flows/extrudeOperationFlow.ts passes its own module URL to captureManualDetail. */
  const FLOW = 'e2e/tests/flows/extrudeOperationFlow.ts';
  const backslash = String.fromCharCode(0x5c);
  const accepted = ['e2e/tests/exampleFlow.ts', FLOW, 'e2e/tests/flows/nested/exampleFlow.ts'];
  const rejected = [
    '/e2e/tests/exampleFlow.ts', 'C:/e2e/tests/exampleFlow.ts', `C:${backslash}e2e${backslash}tests${backslash}exampleFlow.ts`,
    'e2e/tests/../exampleFlow.ts', 'e2e/tests/flows/../../../package.ts', 'e2e/tests/flows/../exampleFlow.ts',
    'e2e/tests/./exampleFlow.ts', 'e2e/tests/.hidden/exampleFlow.ts', 'e2e/tests//exampleFlow.ts', 'e2e/tests/flows//exampleFlow.ts',
    `e2e/tests/flows${backslash}exampleFlow.ts`, `e2e${backslash}tests${backslash}exampleFlow.ts`, 'e2e/tests/flows/exampleFlow.js',
    'e2e/tests/flows/', 'e2e/tests/flows/.ts', 'e2e/testsx/exampleFlow.ts', 'scripts/other.ts', `${FLOW}\n`, '',
    // A trailing line terminator of any kind: the end of the path has to be the true end of the string.
    `${FLOW}\r\n`, `${FLOW}${String.fromCharCode(0x2028)}`, `${FLOW}${String.fromCharCode(0x2029)}`,
  ];

  it.each(accepted)('受け付けて登録簿に残す: %s', script => {
    const image = png(720, 540, 26);
    const registry = buildCaptureRegistry([file('m-detail.png', image), details('m', image, { script })]);
    expect(registry.images[0]).toMatchObject({ script, viewportSource: 'capture-details',
      records: [{ kind: 'capture-details', file: 'm-capture-details.json', name: 'm', image: 'detail' }] });
    expect(parseCaptureRegistry(formatCaptureRegistry(registry))).toEqual(registry);
  });

  it.each(rejected)('撮影の記録からも登録簿からも拒否する: %j', script => {
    const image = png(720, 540, 27);
    expect(() => buildCaptureRegistry([file('m-detail.png', image), details('m', image, { script })]))
      .toThrow('the capture name or script is not recorded');
    const edited = editable(buildCaptureRegistry([file('m-detail.png', image), details('m', image)]));
    edited.images[0].script = script;
    expect(() => validateCaptureRegistry(edited)).toThrow('invalid script');
  });

  it('flows/ の台本で撮った押し出しの画面を採用でき、来歴の束から登録する。不正なパスの撮影は採用も登録もしない', () => {
    const name = 'solid-basics-cut-preview', build = 'e'.repeat(64);
    const scriptSha256 = sha(encoder.encode('// the extrude flow\n'));
    const fixture = { operation: 'cut', before: 1 };
    const screen = png(1440, 900, 28), detail = png(260, 576, 29);
    // The fields captureManualDetail writes, with the screen, recompute and script values of the real cut preview record.
    const capture = {
      format: 'pointercad-manual-detail/1', releaseCertified: false, capturedAt: '2026-11-09T19:56:06.272Z', applicationBuildId: build,
      project: 'functional', sourceTest: 'Extrude cut: real preview cancel atomic Undo and saved geometry', script: FLOW, scriptSha256,
      fixture: { filename: `${name}-fixture.json`, sha256: sha(encoder.encode(JSON.stringify(fixture))) },
      screen: { filename: `${name}-screen.png`, sha256: sha(screen) }, detail: { filename: `${name}-detail.png`, sha256: sha(detail) },
      recompute: { pendingWaiters: 0, activeDocumentKind: 'part', cacheHits: 1, isComputing: false, requestedGeneration: 15,
        completedGeneration: 15, lastOutcome: 'success' },
      viewportRender: { completedRenders: 102, lastCompletedAtMs: 18511.66 },
      screenState: { width: 1440, height: 900, deviceScaleFactor: 1, fontStatus: 'loaded', url: 'http://127.0.0.1:4173/',
        theme: 'dark', uiScale: '100' },
      viewportClass: 'standard',
    };
    expect(inspectAdoptableCapture(capture, name)).toEqual([]);
    const bundle = { format: CAPTURE_PROVENANCE_FORMAT, releaseCertified: false, applicationBuildId: build,
      adoptedAt: '2026-11-10T06:00:00.000Z', scripts: { [FLOW]: scriptSha256 },
      captures: [{ name, selectedImage: 'screen', script: FLOW, capture, fixture }] };
    const registry = buildCaptureRegistry([file(`${name}-screen.png`, screen), json('example-capture-details.json', bundle)]);
    expect(registry.images[0]).toMatchObject({ file: `${name}-screen.png`, sha256: sha(screen), script: FLOW, scriptSha256,
      applicationBuildId: build, records: [{ kind: 'capture-details', file: 'example-capture-details.json', name, image: 'screen' }] });
    for (const script of rejected) {
      expect(inspectAdoptableCapture({ ...capture, script }, name), script).toEqual(['the capture script path is not recorded']);
      const invalid = { ...bundle, scripts: { [script]: scriptSha256 },
        captures: [{ ...bundle.captures[0], script, capture: { ...capture, script } }] };
      expect(() => buildCaptureRegistry([file(`${name}-screen.png`, screen), json('example-capture-details.json', invalid)]), script)
        .toThrow('scripts must map sorted script paths to their SHA-256');
    }
  });
});
