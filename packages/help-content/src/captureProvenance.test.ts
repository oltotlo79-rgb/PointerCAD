import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_PROVENANCE_FORMAT, CAPTURE_SCREEN_REQUIREMENTS, CaptureRegistryError, buildCaptureRegistry, formatCaptureRegistry,
  inspectAdoptableCapture, parseCaptureRegistry, type CaptureChapter, type CaptureFile, type CaptureFolder, type CaptureRecordRef,
} from '../../../scripts/manual/captureRegistry.mjs';
import {
  CaptureAdoptionError, collectCaptureRun, planCaptureAdoption, referencedSelections, type CaptureRunFile,
} from '../../../scripts/manual/captureProvenance.mjs';
import { sourceFileHash } from '../../../scripts/release/desktopFileInventory.mjs';

/**
 * 撮影の来歴の束（計画 P12-16）。Playwright の出力（captureManualDetail の *-capture.json）から、
 * 版・台本・fixture・画像の hash を1つの束にまとめて登録簿へ載せる流れと、載せてはいけない撮影の拒否。
 */
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder(), decoder = new TextDecoder();
const BUILD = 'd'.repeat(64);
const SCRIPT = 'e2e/tests/exampleFlow.ts';
const scriptBytes = encoder.encode('// the capture script\n');
const scripts = new Map([[SCRIPT, scriptBytes]]);
const ADOPTED_AT = '2026-09-27T02:00:00.000Z';
/** The smallest header readPngSize accepts; the last byte keeps each image's bytes distinct. */
const png = (width: number, height: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(34), view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[33] = seed;
  return bytes;
};
const file = (name: string, bytes: Uint8Array): CaptureFile => ({ name, bytes });
const json = (name: string, value: unknown): CaptureFile => file(name, encoder.encode(JSON.stringify(value)));

type Capture = Record<string, unknown> & { screenState: Record<string, unknown>; recompute: Record<string, unknown> };
/** The files captureManualDetail writes for one capture, in a Playwright test output folder. */
const run = (name: string, seed: number, change: (capture: Capture) => void = () => undefined,
  folder = `flow-${name}-functional`, extra: readonly string[] = []): CaptureRunFile[] => {
  const fixture = encoder.encode(JSON.stringify({ id: `part-${name}`, name: '部品1', value: seed }));
  const screen = png(1440, 900, seed), detail = png(400, 300, seed + 100);
  const capture: Capture = {
    format: 'pointercad-manual-detail/1', releaseCertified: false, capturedAt: '2026-09-27T01:00:00.000Z', applicationBuildId: BUILD,
    project: 'functional', sourceTest: '例の撮影', script: SCRIPT, scriptSha256: sha(scriptBytes),
    fixture: { filename: `${name}-fixture.json`, sha256: sha(fixture) },
    screen: { filename: `${name}-screen.png`, sha256: sha(screen) }, detail: { filename: `${name}-detail.png`, sha256: sha(detail) },
    controlDescriptions: { count: 1, controls: [{ tag: 'BUTTON', id: '', name: '新規', description: '新規' }] },
    recompute: { pendingWaiters: 0, cacheHits: 0, isComputing: false, requestedGeneration: 3, completedGeneration: 3, lastOutcome: 'success' },
    viewportRender: { completedRenders: 5, lastCompletedAtMs: 1234.5 }, dialogBounds: { x: 1, y: 2, width: 400, height: 300 },
    screenState: { width: 1440, height: 900, deviceScaleFactor: 1, fontStatus: 'loaded', url: 'http://127.0.0.1:4173/', theme: 'dark', uiScale: '100' },
    viewportClass: 'standard',
  };
  change(capture);
  return [
    { path: `${folder}/${name}-capture.json`, bytes: encoder.encode(JSON.stringify(capture, null, 2)) },
    { path: `${folder}/${name}-fixture.json`, bytes: fixture },
    { path: `${folder}/${name}-screen.png`, bytes: screen },
    { path: `${folder}/${name}-detail.png`, bytes: detail },
    ...extra.map(artifact => ({ path: `${folder}/${artifact}`, bytes: new Uint8Array(0) })),
  ];
};

/** A hand-copied format 1 record (as in the help image folder today) for already registered images. */
const oldCapture = (name: string, image: Uint8Array) => ({ name, script: SCRIPT, capture: {
  format: 'pointercad-manual-detail/1', releaseCertified: false, applicationBuildId: null, project: 'functional', sourceTest: '古い撮影',
  scriptSha256: 'a'.repeat(64), fixture: { filename: `${name}-fixture.json`, sha256: 'b'.repeat(64) },
  screen: { filename: `${name}-screen.png`, sha256: 'c'.repeat(64) }, detail: { filename: `${name}-detail.png`, sha256: sha(image) },
  screenState: { width: 1440, height: 900, deviceScaleFactor: 1, fontStatus: 'loaded', url: 'http://127.0.0.1:4173/' },
} });
const baseChapter: CaptureChapter = { name: 'example.md', text: [
  '![古い画面](images/old-dialog-detail.png)', '![残す画面](images/keep-detail.png)', '![単独の記録](images/single-detail.png)',
].join('\n') };
/**
 * Chapters linking the images of the capture `fresh`, present only while those images are adopted: a
 * chapter linking a missing image is refused, as `register` refuses it.
 */
const freshChapters = { detail: { name: 'fresh.md', text: '![新しい画面](images/fresh-detail.png)' },
  screen: { name: 'screen.md', text: '![全体](./images/fresh-screen.png)' } } as const satisfies Record<string, CaptureChapter>;
const chapters = [baseChapter, freshChapters.detail, freshChapters.screen];
/** The help image folder before adopting: three images with older records and the registry built from them. */
const baseFolder = (fresh: readonly ('detail' | 'screen')[] = ['detail']): CaptureFolder => {
  const oldDialog = png(500, 300, 1), keep = png(500, 300, 2), single = png(500, 300, 3);
  const files = [file('old-dialog-detail.png', oldDialog), file('keep-detail.png', keep), file('single-detail.png', single),
    json('old-capture-details.json', { format: 1, releaseCertified: false, captures: [oldCapture('keep', keep), oldCapture('old-dialog', oldDialog)] }),
    json('single-capture-details.json', { format: 1, releaseCertified: false, captures: [oldCapture('single', single)] })];
  const registry = formatCaptureRegistry(buildCaptureRegistry(files));
  return { files: [...files, file('capture-manifest.json', encoder.encode(registry))], chapters: [baseChapter, ...fresh.map(part => freshChapters[part])] };
};
const plan = (files: CaptureRunFile[], selections: readonly string[], options: { readonly bundle?: string;
  readonly folder?: CaptureFolder; readonly applicationBuildId?: string; readonly scripts?: ReadonlyMap<string, Uint8Array> } = {}) =>
  planCaptureAdoption({ captures: collectCaptureRun(files), selections, bundle: options.bundle ?? 'trial', applicationBuildId: options.applicationBuildId ?? BUILD,
    scripts: options.scripts ?? scripts, folder: options.folder ?? baseFolder(), adoptedAt: ADOPTED_AT });
const problemsOf = (action: () => unknown): readonly string[] => {
  try {
    action();
  } catch (error) {
    if (error instanceof CaptureAdoptionError || error instanceof CaptureRegistryError) return error.problems;
    throw error;
  }
  throw new Error('expected the adoption to be refused');
};
const textOf = (bytes: Uint8Array | null) => (bytes === null ? null : decoder.decode(bytes));

describe('撮影の来歴の束（captureProvenance.mjs）', () => {
  it('合格した撮影を1つの束にまとめ、登録簿へ版・台本・fixture・撮影日時を記録する', () => {
    const adoption = plan([...run('fresh', 10), ...run('other', 20)], ['fresh', 'fresh:screen'], { folder: baseFolder(['detail', 'screen']) });
    const bundle = JSON.parse(decoder.decode(adoption.bundle.bytes)) as Record<string, unknown> & { captures: Record<string, unknown>[] };
    expect(adoption.bundle.name).toBe('trial-capture-details.json');
    expect(bundle).toMatchObject({ format: CAPTURE_PROVENANCE_FORMAT, releaseCertified: false, applicationBuildId: BUILD, adoptedAt: ADOPTED_AT,
      scripts: { [SCRIPT]: sha(scriptBytes) } });
    expect(bundle.captures.map(entry => [entry.name, entry.selectedImage])).toEqual([['fresh', 'detail'], ['fresh', 'screen']]);
    // The fixture document itself is kept; the control descriptions (a test check) are not.
    expect(bundle.captures[0]).toMatchObject({ script: SCRIPT, fixture: { id: 'part-fresh', name: '部品1', value: 10 } });
    expect(bundle.captures[0].capture).not.toHaveProperty('controlDescriptions');
    expect(adoption.images.map(image => [image.name, image.replaced, sha(image.bytes)]))
      .toEqual([['fresh-detail.png', false, sha(png(400, 300, 110))], ['fresh-screen.png', false, sha(png(1440, 900, 10))]]);
    expect(adoption.rewrites).toEqual([]);
    const registry = parseCaptureRegistry(decoder.decode(adoption.registry.bytes));
    const fresh = registry.images.find(entry => entry.file === 'fresh-detail.png');
    expect(fresh).toEqual({ file: 'fresh-detail.png', sha256: sha(png(400, 300, 110)), viewport: [1440, 900], viewportClass: 'standard',
      viewportSource: 'capture-details', script: SCRIPT, scriptSha256: sha(scriptBytes),
      fixtureSha256: sha(encoder.encode(JSON.stringify({ id: 'part-fresh', name: '部品1', value: 10 }))), capturedAt: '2026-09-27T01:00:00.000Z',
      applicationBuildId: BUILD, unknown: {}, records: [{ kind: 'capture-details', file: 'trial-capture-details.json', name: 'fresh', image: 'detail' }] });
    // The untouched images keep their older records and unknown build.
    expect(registry.images.find(entry => entry.file === 'keep-detail.png')).toMatchObject({ applicationBuildId: null, unknown: { applicationBuildId: 'build-id-null' } });
    // Rebuilding from the written folder gives the same registry (register/check agree with adopt).
    const written = [...baseFolder().files.filter(item => item.name !== 'capture-manifest.json'), file(adoption.bundle.name, adoption.bundle.bytes),
      ...adoption.images.map(image => file(image.name, image.bytes)), file('capture-manifest.json', adoption.registry.bytes)];
    expect(buildCaptureRegistry(written)).toEqual(registry);
  });

  it('撮り直した画像は古い記録から外し、空になった記録のファイルは消す（他の画像の記録は残す）', () => {
    const adoption = plan([...run('old-dialog', 30), ...run('single', 40)], ['old-dialog', 'single'], { folder: baseFolder([]) });
    expect(adoption.images.map(image => [image.name, image.replaced])).toEqual([['old-dialog-detail.png', true], ['single-detail.png', true]]);
    expect(adoption.rewrites.map(item => [item.name, item.removed, item.bytes === null])).toEqual([
      ['old-capture-details.json', ['old-dialog-detail.png'], false], ['single-capture-details.json', ['single-detail.png'], true]]);
    const kept = JSON.parse(textOf(adoption.rewrites[0].bytes) ?? '') as { captures: { name: string }[] };
    expect(kept.captures.map(entry => entry.name)).toEqual(['keep']);
    expect(adoption.summary).toMatchObject({ rewritten: ['old-capture-details.json'], removedRecords: ['single-capture-details.json'] });
    const registry = parseCaptureRegistry(decoder.decode(adoption.registry.bytes));
    const recordFile = (ref: CaptureRecordRef | undefined) => (ref?.kind === 'capture-details' ? ref.file : null);
    expect(registry.images.map(entry => [entry.file, entry.applicationBuildId, recordFile(entry.records[0])])).toEqual([
      ['keep-detail.png', null, 'old-capture-details.json'], ['old-dialog-detail.png', BUILD, 'trial-capture-details.json'],
      ['single-detail.png', BUILD, 'trial-capture-details.json']]);
  });

  it('未完了の再計算・落ち着いていない3D描画の撮影は束ねない', () => {
    const cases: [string, (capture: Capture) => void, RegExp][] = [
      ['computing', capture => { capture.recompute.isComputing = true; }, /recompute of the latest generation had not finished/u],
      ['older-generation', capture => { capture.recompute.completedGeneration = 2; }, /recompute of the latest generation had not finished/u],
      ['failed-recompute', capture => { capture.recompute.lastOutcome = 'failed'; }, /recompute of the latest generation had not finished/u],
      ['no-render', capture => { capture.viewportRender = { completedRenders: 0, lastCompletedAtMs: 0 }; }, /3D drawing had not settled/u],
      ['render-unrecorded', capture => { delete capture.viewportRender; }, /viewportRender\) is not recorded/u],
    ];
    for (const [name, change, message] of cases) {
      expect(problemsOf(() => plan(run('fresh', 50, change), ['fresh'])).join('\n'), name).toMatch(message);
    }
    // A screen without the 3D view records null and is accepted.
    expect(plan(run('fresh', 50, capture => { capture.viewportRender = null; }), ['fresh']).summary.adopted).toEqual(['fresh-detail.png']);
  });

  it('記録と違う fixture・画像のバイト、束の中で差し替えた fixture は登録しない', () => {
    const swapped = run('fresh', 60).map(item => (item.path.endsWith('-fixture.json') ? { ...item, bytes: encoder.encode('{"id":"another"}') } : item));
    expect(problemsOf(() => plan(swapped, ['fresh'])).join('\n')).toMatch(/fresh-fixture\.json differs from the recorded SHA-256/u);
    const edited = run('fresh', 60).map(item => (item.path.endsWith('-detail.png') ? { ...item, bytes: png(400, 300, 99) } : item));
    expect(problemsOf(() => plan(edited, ['fresh'])).join('\n')).toMatch(/fresh-detail\.png differs from the recorded SHA-256/u);
    // Rebuilding the registry recomputes the fixture hash from the bundle's own document.
    const adoption = plan(run('fresh', 60), ['fresh']);
    const bundle = JSON.parse(decoder.decode(adoption.bundle.bytes)) as { captures: { fixture: Record<string, unknown> }[] };
    bundle.captures[0].fixture.value = 61;
    const files = [...baseFolder().files, json(adoption.bundle.name, bundle), ...adoption.images.map(image => file(image.name, image.bytes))];
    expect(problemsOf(() => buildCaptureRegistry(files)).join('\n')).toMatch(/fixture document differs from the recorded fixture SHA-256/u);
  });

  it('失敗した検査・別の版・撮影後に変わった台本・別の project の撮影は束ねない', () => {
    expect(problemsOf(() => plan(run('fresh', 70, undefined, undefined, ['test-failed-1.png']), ['fresh'])).join('\n'))
      .toMatch(/the test that took it failed \(test-failed-1\.png\)/u);
    expect(problemsOf(() => plan(run('fresh', 70), ['fresh'], { applicationBuildId: 'e'.repeat(64) })).join('\n'))
      .toMatch(/captured from another application build/u);
    expect(problemsOf(() => plan(run('fresh', 70), ['fresh'], { scripts: new Map([[SCRIPT, encoder.encode('// edited\n')]]) })).join('\n'))
      .toMatch(/exampleFlow\.ts changed after the capture/u);
    expect(problemsOf(() => plan(run('fresh', 70), ['fresh'], { scripts: new Map() })).join('\n')).toMatch(/capture script .* is missing/u);
    // A line-end change is not a change: the CRLF checkout of the same script is accepted (and its edit is not).
    const crlf = encoder.encode(decoder.decode(scriptBytes).replaceAll('\n', '\r\n'));
    expect(sha(crlf)).not.toBe(sha(scriptBytes));
    expect(plan(run('fresh', 70), ['fresh'], { scripts: new Map([[SCRIPT, crlf]]) }).summary.adopted).toEqual(['fresh-detail.png']);
    // Captured in the CRLF checkout (as captureManualDetail records it) and adopted in the LF checkout.
    const fromCrlf = run('fresh', 70, capture => { capture.scriptSha256 = sourceFileHash(crlf); });
    expect(plan(fromCrlf, ['fresh']).summary.adopted).toEqual(['fresh-detail.png']);
    expect(problemsOf(() => plan(run('fresh', 70), ['fresh'], { scripts: new Map([[SCRIPT, encoder.encode('// edited\r\n')]]) })).join('\n'))
      .toMatch(/exampleFlow\.ts changed after the capture/u);
    expect(problemsOf(() => plan(run('fresh', 70, capture => { capture.applicationBuildId = null; }), ['fresh'])).join('\n'))
      .toMatch(/applicationBuildId\) is not recorded/u);
    const electron = run('fresh', 70, capture => { capture.project = 'electron'; }, 'flow-fresh-electron');
    expect(problemsOf(() => plan(electron, ['fresh'])).join('\n')).toMatch(/no capture fresh of project functional/u);
    expect(problemsOf(() => planCaptureAdoption({ captures: collectCaptureRun(electron), selections: ['fresh'], bundle: 'trial', project: 'electron',
      applicationBuildId: BUILD, scripts, folder: baseFolder(), adoptedAt: ADOPTED_AT })).join('\n')).toMatch(/unsupported project: electron/u);
    // The same capture from two runs is ambiguous.
    expect(problemsOf(() => plan([...run('fresh', 70), ...run('fresh', 71, undefined, 'flow-fresh-functional-retry1')], ['fresh'])).join('\n'))
      .toMatch(/several captures fresh of project functional/u);
  });

  it('暗色・UI倍率100%・scale1・字体の読込済み・決めた画面の大きさ以外の撮影は束ねない', () => {
    expect(CAPTURE_SCREEN_REQUIREMENTS).toEqual({ theme: 'dark', uiScale: '100', deviceScaleFactor: 1, fontStatus: 'loaded' });
    const cases: [string, (capture: Capture) => void, RegExp][] = [
      ['light', capture => { capture.screenState.theme = 'light'; }, /screenState\.theme is "light", not "dark"/u],
      ['scale-150', capture => { capture.screenState.uiScale = '150'; }, /screenState\.uiScale is "150", not "100"/u],
      ['dpr-2', capture => { capture.screenState.deviceScaleFactor = 2; }, /screenState\.deviceScaleFactor is 2, not 1/u],
      ['fonts', capture => { capture.screenState.fontStatus = 'loading'; }, /screenState\.fontStatus is "loading", not "loaded"/u],
      ['1280x720', capture => { capture.screenState.width = 1280; capture.screenState.height = 720; }, /unsupported screen size 1280x720/u],
    ];
    for (const [name, change, message] of cases) {
      expect(problemsOf(() => plan(run('fresh', 80, change), ['fresh'])).join('\n'), name).toMatch(message);
    }
    // The tall-dialog exception of the registry's policy is accepted.
    const tall = run('fresh', 80, capture => { capture.screenState.height = 1100; });
    const registry = parseCaptureRegistry(decoder.decode(plan(tall, ['fresh']).registry.bytes));
    expect(registry.images.find(entry => entry.file === 'fresh-detail.png')).toMatchObject({ viewport: [1440, 1100], viewportClass: 'tall-exception' });
  });

  it('章が参照しない画像・既存の束の名前・二重の指定・不正な指定は拒否し、一部だけを書く計画を作らない', () => {
    const problems = problemsOf(() => plan(run('other', 90), ['other', 'other', 'Bad:thing']));
    expect(problems).toEqual(expect.arrayContaining(['other-detail.png is selected twice', 'invalid selection Bad:thing (use name or name:screen)',
      'other-detail.png is not shown by any chapter; link it from its chapter first']));
    expect(problemsOf(() => plan(run('fresh', 90), ['fresh'], { bundle: 'old' })).join('\n')).toMatch(/old-capture-details\.json already exists/u);
    expect(problemsOf(() => plan(run('fresh', 90), ['fresh'], { bundle: 'Trial' }))).toEqual(['invalid bundle name: Trial']);
    expect(problemsOf(() => plan(run('fresh', 90), []))).toEqual(['nothing selected']);
  });

  it('--referenced は章が表示する detail・screen だけを選び、残りの撮影を skipped に出す', () => {
    const captures = collectCaptureRun([...run('fresh', 100), ...run('other', 101), ...run('keep', 102, capture => { capture.project = 'firefox'; }, 'flow-keep-firefox')]);
    expect(referencedSelections(captures, 'functional', chapters)).toEqual({ selections: ['fresh', 'fresh:screen'], skipped: ['other'] });
    expect(referencedSelections(captures, 'firefox', chapters)).toEqual({ selections: ['keep'], skipped: [] });
  });

  it('登録簿の側でも来歴の束を検査し、別の版の撮影・台本の表の食い違い・並び順の乱れを拒否する', () => {
    const adoption = plan([...run('fresh', 110)], ['fresh', 'fresh:screen'], { folder: baseFolder(['detail', 'screen']) });
    const bundle = JSON.parse(decoder.decode(adoption.bundle.bytes)) as { applicationBuildId: string; scripts: Record<string, string>;
      captures: { capture: Record<string, unknown> }[] };
    const rebuild = (value: unknown) => buildCaptureRegistry([...baseFolder().files, json(adoption.bundle.name, value),
      ...adoption.images.map(image => file(image.name, image.bytes))]);
    expect(rebuild(bundle).images.filter(entry => entry.applicationBuildId === BUILD)).toHaveLength(2);
    expect(problemsOf(() => rebuild({ ...bundle, applicationBuildId: 'f'.repeat(64) })).join('\n')).toMatch(/captured from another application build/u);
    expect(problemsOf(() => rebuild({ ...bundle, scripts: { [SCRIPT]: '0'.repeat(64) } })).join('\n')).toMatch(/differs from the bundle's scripts/u);
    expect(problemsOf(() => rebuild({ ...bundle, scripts: { ...bundle.scripts, 'e2e/tests/unused.ts': '0'.repeat(64) } })).join('\n'))
      .toMatch(/script e2e\/tests\/unused\.ts is not used by any capture/u);
    expect(problemsOf(() => rebuild({ ...bundle, captures: [...bundle.captures].reverse() })).join('\n')).toMatch(/sorted by image without duplicates/u);
    expect(problemsOf(() => rebuild({ ...bundle, releaseCertified: true })).join('\n')).toMatch(/invalid pointercad-capture-provenance\/1 bundle/u);
    expect(problemsOf(() => rebuild({ ...bundle, adoptedAt: '2026-09-27T00:00:00.000Z' })).join('\n')).toMatch(/captured after the bundle was adopted/u);
  });

  it('inspectAdoptableCapture は captureManualDetail の記録の全項目を要求する', () => {
    const [record] = run('fresh', 120);
    const capture = JSON.parse(decoder.decode(record.bytes)) as Record<string, unknown>;
    expect(inspectAdoptableCapture(capture, 'fresh')).toEqual([]);
    // Another name does not match the recorded files.
    expect(inspectAdoptableCapture(capture, 'other')).toEqual(['the fixture SHA-256 is not recorded', 'the screen image is not recorded',
      'the detail image is not recorded']);
    expect(inspectAdoptableCapture({ ...capture, script: 'scripts/other.ts', capturedAt: 'yesterday', sourceTest: '' }, 'fresh')).toEqual([
      'the capture time is not recorded', 'the source test is not recorded', 'the capture script path is not recorded']);
    expect(inspectAdoptableCapture({ format: 1 }, 'fresh')).toEqual(['not a pointercad-manual-detail/1 capture']);
  });
});
