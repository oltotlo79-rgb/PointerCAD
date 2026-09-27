import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_REGISTRY_FORMAT, CaptureRegistryError, applicationInputDigest, assessCaptureImages, auditCaptureRegistry, buildCaptureRegistry,
  classifyCaptureViewport, collectChapterImageReferences, formatCaptureRegistry, parseCaptureRegistry, readCaptureFolder,
  readCaptureRegistry, readCaptureScripts, readPngSize, validateCaptureRegistry, type CaptureFile, type CaptureRegistry,
} from '../../../scripts/manual/captureRegistry.mjs';
import { localGitEnvironment } from '../../../scripts/lib/gitEnvironment.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
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
  readonly scriptSha256?: string } = {}) => json(`${name}-capture-details.json`, {
  format: 1, releaseCertified: false,
  captures: [{ name, script: 'e2e/tests/exampleFlow.ts', capture: {
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
    expect(report).toMatchObject({ checked: images.length, unregistered: [], mismatched: [], buildMismatch: [] });
    // An image without a recorded build is not confirmed as the current version.
    expect(report.buildUnknown).toEqual(registry.images.filter(entry => entry.applicationBuildId === null).map(entry => entry.file));
    // Compare the recorded script hashes with the current scripts independently.
    const scripts = new Set(readdirSync(new URL('../../../e2e/tests/', import.meta.url)).map(name => `e2e/tests/${name}`));
    const hashed = registry.images.flatMap(entry => (entry.script !== null && entry.scriptSha256 !== null
      ? [{ file: entry.file, script: entry.script, scriptSha256: entry.scriptSha256 }] : []));
    expect(report.scriptMissing).toEqual(hashed.filter(entry => !scripts.has(entry.script)).map(entry => entry.file));
    expect(report.scriptChanged).toEqual(hashed.filter(entry => scripts.has(entry.script)
      && sha(readFileSync(new URL(`../../../${entry.script}`, import.meta.url))) !== entry.scriptSha256).map(entry => entry.file));
    expect(report.current).toBe(report.buildUnknown.length === 0 && report.scriptChanged.length === 0 && report.scriptMissing.length === 0);
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
});

describe('アプリの入力の指紋（applicationInputDigest）', () => {
  const digestWorkspace = (): string => execFileSync('python',
    ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'application-input-digest-test'],
    { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
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
});
