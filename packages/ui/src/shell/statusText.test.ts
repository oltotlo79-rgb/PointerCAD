/**
 * ステータスバーの 1 文の組み立て(計画書 docs/plans/P2-ソリッド基礎.md タスク25 手順5)。
 *
 * 帯は 1 本しかないので、同時に言いたいことがあるときに**どれを選ぶか**が要。
 * ここでは優先順位・進み具合の文と割合・失敗のまとめ方・案内の選び方を検査する。
 * 描画そのもの(`StatusBar.tsx`)は Node では検査できないので E2E と目視に任せる。
 */

import type { PartProgress, PartRecomputeError, SketchError } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import {
  countSelectedBodies,
  countSelectedSubShapes,
  describeStatus,
  guideKeyFor,
  machiningGuideText,
  progressText,
  progressView,
  PROGRESS_DELAY_MS,
  summarizeFailures,
  type StatusInput,
} from './statusText.js';

/** 何も起きていない状態。各検査は要る欄だけを上書きする。 */
function quiet(): StatusInput {
  return {
    fileMessage: null,
    faceErrorKey: null,
    solidErrorKey: null,
    errorMessage: null,
    partErrors: [],
    sketchErrors: [],
    cancelled: false,
    progress: null,
    isComputing: false,
    // 既定は「もう読み込み終えた」。初回だけの文言(⑨)は個別の検査で false にする。
    kernelLoaded: true,
    snapKind: null,
    activeTool: 'select',
    selectedBodyCount: 0,
    // §0.a-0.6(タスク28)。既定は「立体を選ぶ」状態で、部分形状は数えない。
    selectedSubShapeCount: 0,
    selectionKind: 'body',
  };
}

function progressAt(index: number, total: number, label = '押し出し1'): PartProgress {
  return { featureId: 'extrude-1', index, total, label };
}

function partError(message: string): PartRecomputeError {
  return { featureId: 'extrude-1', code: 'kernelFailed', message };
}

function sketchError(message: string): SketchError {
  return { featureId: 'face-1', code: 'kernelFailed', message };
}

describe('帯に出す 1 文の優先順位(FR-905)', () => {
  it('何も起きていなければ道具の案内を出す(FR-905、NFR-UX-7)', () => {
    const line = describeStatus(quiet());
    expect(line.kind).toBe('guide');
    expect(line.text).toBe(t('statusBar.ready'));
    expect(line.progress).toBeNull();
  });

  it('ファイル操作の失敗が最優先で、頭の言葉は添えない(タスク23 の申し送り)', () => {
    const line = describeStatus({
      ...quiet(),
      fileMessage: { key: 'file.openFailed', failed: true },
      faceErrorKey: 'solidError.noFace',
      solidErrorKey: 'solidError.noBody',
      errorMessage: '計算できません',
      partErrors: [partError('立体を作れませんでした')],
      cancelled: true,
      progress: progressAt(0, 3),
      isComputing: true,
      snapKind: 'endpoint',
    });
    expect(line.kind).toBe('failure');
    expect(line.text).toBe(t('file.openFailed'));
  });

  it('面の断りはファイル以外のすべてに優先する(NFR-UX-5)', () => {
    const line = describeStatus({
      ...quiet(),
      faceErrorKey: 'solidError.noFace',
      solidErrorKey: 'solidError.noBody',
      errorMessage: '計算できません',
    });
    expect(line.kind).toBe('failure');
    expect(line.text).toBe(`${t('statusBar.faceError')} ${t('solidError.noFace')}`);
  });

  it('立体の断りは計算の失敗に優先する(NFR-UX-5)', () => {
    const line = describeStatus({
      ...quiet(),
      solidErrorKey: 'solidError.needTwoBodies',
      partErrors: [partError('立体を作れませんでした')],
    });
    expect(line.text).toBe(`${t('statusBar.solidError')} ${t('solidError.needTwoBodies')}`);
  });

  it('計算の失敗は中止の知らせにも進み具合にも優先する(FR-504)', () => {
    const line = describeStatus({
      ...quiet(),
      partErrors: [partError('回しても厚みが出ませんでした')],
      cancelled: true,
      progress: progressAt(1, 4),
    });
    expect(line.kind).toBe('failure');
    expect(line.text).toBe(`${t('statusBar.error')} 回しても厚みが出ませんでした`);
  });

  it('中止の知らせは進み具合と保存の知らせに優先する(NFR-PF-4)', () => {
    const line = describeStatus({
      ...quiet(),
      cancelled: true,
      progress: progressAt(1, 4),
      fileMessage: { key: 'file.saved', failed: false },
    });
    expect(line.kind).toBe('cancelled');
    expect(line.text).toBe(t('statusBar.cancelled'));
    // 中止は失敗ではないので、赤い帯にする印(failure)は立てない。
    expect(line.progress).toBeNull();
  });

  it('進み具合は保存の知らせと計算中の札に優先する(NFR-PF-4)', () => {
    const line = describeStatus({
      ...quiet(),
      progress: progressAt(2, 12),
      fileMessage: { key: 'file.saved', failed: false },
      isComputing: true,
    });
    expect(line.kind).toBe('progress');
    expect(line.progress).toEqual({ done: 3, total: 12, ratio: 0.25 });
    // 中止は段と段の間でしか効かないので、その旨を添える(§2.6 の限界)。
    expect(line.hint).toBe(t('statusBar.progressHint'));
  });

  it('保存の知らせは計算中の札と案内に優先する(FR-806)', () => {
    const line = describeStatus({
      ...quiet(),
      fileMessage: { key: 'file.saved', failed: false },
      isComputing: true,
      snapKind: 'endpoint',
    });
    expect(line.kind).toBe('saved');
    expect(line.text).toBe(t('file.saved'));
  });

  it('進み具合がまだ来ていない計算中は「形を計算しています…」を出す', () => {
    const line = describeStatus({ ...quiet(), isComputing: true, snapKind: 'grid' });
    expect(line.kind).toBe('computing');
    expect(line.text).toBe(t('statusBar.loading'));
  });

  it('幾何カーネルを未読み込みの計算中は「形の計算部を読み込んでいます…」を出す(§0.a-0.23 ⑨)', () => {
    const line = describeStatus({ ...quiet(), isComputing: true, kernelLoaded: false });
    expect(line.kind).toBe('computing');
    expect(line.text).toBe(t('statusBar.loadingKernel'));
  });

  it('幾何カーネルを読み込み終えていれば、2 回目以降の計算中は従来の文言に戻る', () => {
    const line = describeStatus({ ...quiet(), isComputing: true, kernelLoaded: true });
    expect(line.text).toBe(t('statusBar.loading'));
  });

  it('吸着の案内は道具の案内に優先する(FR-107)', () => {
    const line = describeStatus({ ...quiet(), snapKind: 'midpoint' });
    expect(line.kind).toBe('snap');
    expect(line.text).toBe(t('statusBar.snap.midpoint'));
  });

  it('待ち時間の前(progress が null)なら進み具合を出さない(NFR-PF-4)', () => {
    // 待ち時間の判定は StatusBar.tsx が行い、出さないあいだは null を渡す約束。
    const line = describeStatus({ ...quiet(), progress: null, isComputing: true });
    expect(line.kind).toBe('computing');
    expect(PROGRESS_DELAY_MS).toBe(300);
  });
});

describe('計算の進み具合の文(NFR-PF-4)', () => {
  it('「押し出し1 を計算しています(3/12)」の形にする', () => {
    expect(progressText(progressAt(2, 12))).toBe('押し出し1 を計算しています(3/12)');
  });

  it('段の名前をそのまま差し込む', () => {
    expect(progressText(progressAt(0, 1, '回転2'))).toBe('回転2 を計算しています(1/1)');
  });

  it('index は 0 から、画面には 1 から数えて出す', () => {
    expect(progressView(progressAt(0, 4))).toEqual({ done: 1, total: 4, ratio: 0.25 });
    expect(progressView(progressAt(3, 4))).toEqual({ done: 4, total: 4, ratio: 1 });
  });

  it('総数を超えた値が来ても帯がはみ出さない', () => {
    expect(progressView(progressAt(9, 4)).ratio).toBe(1);
    expect(progressView(progressAt(9, 4)).done).toBe(4);
  });

  it('総数が 0 なら割合は 0(0 で割らない)', () => {
    expect(progressView(progressAt(0, 0)).ratio).toBe(0);
  });
});

describe('失敗のまとめ(FR-504)', () => {
  it('失敗が無ければ null', () => {
    expect(summarizeFailures([], [])).toBeNull();
  });

  it('1 件なら件数を出さず、理由だけを出す', () => {
    expect(summarizeFailures([partError('縫えませんでした')], [])).toBe(
      `${t('statusBar.error')} 縫えませんでした`,
    );
  });

  it('2 件以上は件数と先頭の理由をまとめて出す', () => {
    const text = summarizeFailures(
      [partError('縫えませんでした'), partError('回しても厚みが出ませんでした')],
      [],
    );
    expect(text).toBe('計算に失敗しました(2 件): 縫えませんでした');
  });

  it('スケッチの失敗も同じ帯にまとめる(P1 の出し方を引き継ぐ)', () => {
    expect(summarizeFailures([], [sketchError('面を作れませんでした: 閉じていません')])).toBe(
      `${t('statusBar.error')} 面を作れませんでした: 閉じていません`,
    );
  });

  it('部品の失敗にスケッチの失敗が含まれているので二重に数えない', () => {
    // applyRecompute は partErrors へ両方を入れ、sketchErrors はその写し(FR-504)。
    const shared = sketchError('面を作れませんでした: 閉じていません');
    const text = summarizeFailures([shared], [shared]);
    expect(text).toBe(`${t('statusBar.error')} 面を作れませんでした: 閉じていません`);
  });
});

describe('立体が選ばれているときの案内(FR-404、statusBar.guide.boolean)', () => {
  it('選択のうち画面にある立体だけを数える', () => {
    expect(countSelectedBodies(['face-1', 'extrude-1', 'extrude-2'], ['extrude-1', 'extrude-2'])).toBe(
      2,
    );
    expect(countSelectedBodies(['face-1'], ['extrude-1'])).toBe(0);
    // 消費済み(liveBodyIds に無い)立体は数えない。
    expect(countSelectedBodies(['extrude-1'], [])).toBe(0);
  });

  it('立体を 1 つ選んだら「組み合わせる立体を選んでください」', () => {
    expect(guideKeyFor('select', 1)).toBe('statusBar.guide.boolean');
  });

  it('ちょうど 2 つ選べたら和・差・積が押せると伝える', () => {
    expect(guideKeyFor('select', 2)).toBe('statusBar.guide.booleanReady');
  });

  it('3 つ以上は 2 つに絞ってもらう案内へ戻す(§0.a-0.6 のちょうど 2 つ)', () => {
    expect(guideKeyFor('select', 3)).toBe('statusBar.guide.boolean');
  });

  it('立体を選んでいなければこれまでの案内のまま', () => {
    expect(guideKeyFor('select', 0)).toBe('statusBar.ready');
  });

  it('立体の道具を選んでいるときは道具の案内が優先する', () => {
    expect(guideKeyFor('extrude', 1)).toBe('statusBar.guide.extrude');
    expect(guideKeyFor('line', 2)).toBe('statusBar.guide.line');
  });

  it('案内の選び方は describeStatus からも効く', () => {
    const line = describeStatus({ ...quiet(), selectedBodyCount: 1 });
    expect(line.text).toBe(t('statusBar.guide.boolean'));
  });
});

describe('選択の種類の札と加工の案内(§0.a-0.6、タスク28)', () => {
  it('部分形状の種類ごとに数える(面2・辺3の選択)', () => {
    const selection = [
      'extrude-1#face:0',
      'extrude-1#face:1',
      'extrude-1#edge:0',
      'extrude-1#edge:1',
      'extrude-1#edge:2',
    ];
    expect(countSelectedSubShapes(selection, 'edge')).toBe(3);
    expect(countSelectedSubShapes(selection, 'face')).toBe(2);
    expect(countSelectedSubShapes(selection, 'vertex')).toBe(0);
    // 部分形状でない id(立体そのもの、スケッチの点列の1点)は数えない。
    expect(countSelectedSubShapes(['extrude-1', 'point-1#3'], 'face')).toBe(0);
  });

  it('6 つの加工の道具はそれぞれの基本案内を返す(guideKeyFor)', () => {
    expect(guideKeyFor('hole', 0)).toBe('statusBar.guide.hole');
    expect(guideKeyFor('threadHole', 0)).toBe('statusBar.guide.threadHole');
    expect(guideKeyFor('fillet', 0)).toBe('statusBar.guide.fillet');
    expect(guideKeyFor('chamfer', 0)).toBe('statusBar.guide.chamfer');
    expect(guideKeyFor('linearPattern', 0)).toBe('statusBar.guide.linearPattern');
    expect(guideKeyFor('circularPattern', 0)).toBe('statusBar.guide.circularPattern');
  });

  it('穴・ねじ穴は面を選ぶまでは基本案内、面を選んだら「中心にする点を選んでください」', () => {
    expect(machiningGuideText('hole', 0)).toBeNull();
    expect(machiningGuideText('hole', 1)).toBe(t('statusBar.guide.centerPoint'));
    expect(machiningGuideText('threadHole', 1)).toBe(t('statusBar.guide.centerPoint'));
  });

  it('R/C 面取りは辺を選ぶたびに選んだ本数を伝える', () => {
    expect(machiningGuideText('fillet', 0)).toBeNull();
    expect(machiningGuideText('fillet', 4)).toBe('辺を 4 本選んでいます。');
    expect(machiningGuideText('chamfer', 1)).toBe('辺を 1 本選んでいます。');
  });

  it('立体を選ぶ道具(パターン等)は選択の数で案内を変えない', () => {
    expect(machiningGuideText('linearPattern', 3)).toBeNull();
    expect(machiningGuideText('select', 3)).toBeNull();
  });

  it('describeStatus は選んでいる面の数に応じて案内を進める', () => {
    const noFace = describeStatus({
      ...quiet(),
      activeTool: 'hole',
      selectionKind: 'face',
      selectedSubShapeCount: 0,
    });
    expect(noFace.text).toBe(t('statusBar.guide.hole'));
    const withFace = describeStatus({
      ...quiet(),
      activeTool: 'hole',
      selectionKind: 'face',
      selectedSubShapeCount: 1,
    });
    expect(withFace.text).toBe(t('statusBar.guide.centerPoint'));
  });

  it('describeStatus(selectionKind を渡す) は札の文言が種類に応じて変わる', () => {
    const vertex = describeStatus({ ...quiet(), selectionKind: 'vertex' });
    const edge = describeStatus({ ...quiet(), selectionKind: 'edge' });
    const face = describeStatus({ ...quiet(), selectionKind: 'face' });
    const body = describeStatus({ ...quiet(), selectionKind: 'body' });
    expect(vertex.selectionKindLabel).toBe(`${t('selection.kindLabel')} ${t('selection.kind.vertex')}`);
    expect(edge.selectionKindLabel).toBe(`${t('selection.kindLabel')} ${t('selection.kind.edge')}`);
    expect(face.selectionKindLabel).toBe(`${t('selection.kindLabel')} ${t('selection.kind.face')}`);
    expect(body.selectionKindLabel).toBe(`${t('selection.kindLabel')} ${t('selection.kind.body')}`);
    // 4 種とも文言が異なる(札が種類に応じて変わることの確認)。
    expect(new Set([vertex, edge, face, body].map((line) => line.selectionKindLabel)).size).toBe(4);
  });

  it('失敗があれば、案内より札より失敗が勝つ(優先順位は変わらない)', () => {
    const line = describeStatus({
      ...quiet(),
      activeTool: 'fillet',
      selectionKind: 'edge',
      selectedSubShapeCount: 2,
      errorMessage: '丸められませんでした',
    });
    expect(line.kind).toBe('failure');
    expect(line.text).toBe(`${t('statusBar.error')} 丸められませんでした`);
    // 失敗のときも札(selectionKindLabel)は出ている(状況の1文とは独立)。
    expect(line.selectionKindLabel).toBe(`${t('selection.kindLabel')} ${t('selection.kind.edge')}`);
  });
});
