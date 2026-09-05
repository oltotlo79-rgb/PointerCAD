import { describe, expect, it } from 'vitest';
import {
  WORK_PLANES, type ResolvedSegment, type ResolvedSketch, type Vec3,
} from '@pointercad/model';

import {
  chooseTrack, closestParameterToRay, collectTrackCandidates, DEFAULT_TRACK_ANGLE_STEP,
  polarCandidate, TRACK_ANGLE_STEPS, type PointerRay, type TrackKind,
} from './trackMath.js';
import type { ProjectToScreen } from './snapMath.js';

/** ワールドの (x, y) をそのまま画面座標にする、テスト用の写し方(snapMath.test.ts と同じ)。 */
const project: ProjectToScreen = (point: Vec3): readonly [number, number] => [point[0], point[1]];

/** テストの慣例(snapMath.test.ts と同じ): ポインタの画面座標は作図面へ落とした点の (x, y)。 */
const pointerOf = (pointOnPlane: Vec3): readonly [number, number] =>
  [pointOnPlane[0], pointOnPlane[1]];

const XY = WORK_PLANES.xy;

const ALL_KINDS: ReadonlySet<TrackKind> = new Set(['polar', 'extension', 'perpendicular', 'parallel']);

function emptySketch(segments: readonly ResolvedSegment[]): ResolvedSketch {
  return {
    points: [], segments, arcs: [], ellipses: [], splines: [],
    pendingOffsets: [], pendingProjections: [], curvesByFeature: new Map(), faces: [], errors: [],
  };
}

const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

describe('向きの吸着(FR-110、トラッキング)', () => {
  it('刻み角度の候補は 5/10/15/30/45/90、既定は15°(§0.12)', () => {
    expect(TRACK_ANGLE_STEPS).toEqual([5, 10, 15, 30, 45, 90]);
    expect(DEFAULT_TRACK_ANGLE_STEP).toBe(15);
  });

  describe('極(polar)', () => {
    it('20∠17°、刻み15° → 20∠15°(角度は15、位置は距離を保ったまま丸めた向きへ載る)', () => {
      const pointOnPlane: Vec3 = [20 * Math.cos(degToRad(17)), 20 * Math.sin(degToRad(17)), 0];
      const candidate = polarCandidate(XY, [0, 0, 0], pointOnPlane, 15);
      expect(candidate).not.toBeNull();
      expect(candidate?.angleDegrees).toBe(15);

      const result = chooseTrack([candidate!], project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      const [x, y, z] = result!.position;
      expect(x).toBeCloseTo(20 * Math.cos(degToRad(15)), 9);
      expect(y).toBeCloseTo(20 * Math.sin(degToRad(15)), 9);
      expect(z).toBe(0);
    });

    it('刻み15°、角度7.4° → 0(7.5°未満は0側)', () => {
      const pointOnPlane: Vec3 = [10 * Math.cos(degToRad(7.4)), 10 * Math.sin(degToRad(7.4)), 0];
      expect(polarCandidate(XY, [0, 0, 0], pointOnPlane, 15)?.angleDegrees).toBe(0);
    });

    it('刻み15°、角度7.6° → 15', () => {
      const pointOnPlane: Vec3 = [10 * Math.cos(degToRad(7.6)), 10 * Math.sin(degToRad(7.6)), 0];
      expect(polarCandidate(XY, [0, 0, 0], pointOnPlane, 15)?.angleDegrees).toBe(15);
    });

    it('刻み15°、角度88°、距離20 → 位置(0,20,0)、角度90(90は15の倍数)', () => {
      const pointOnPlane: Vec3 = [20 * Math.cos(degToRad(88)), 20 * Math.sin(degToRad(88)), 0];
      const candidate = polarCandidate(XY, [0, 0, 0], pointOnPlane, 15);
      expect(candidate?.angleDegrees).toBe(90);
      const result = chooseTrack([candidate!], project, pointerOf(pointOnPlane), 12, pointOnPlane);
      const [x, y, z] = result!.position;
      expect(x).toBeCloseTo(0, 9);
      expect(y).toBeCloseTo(20, 9);
      expect(z).toBe(0);
    });

    it('刻み90°(直交モード)、角度44° → 0、角度46° → 90', () => {
      const p44: Vec3 = [Math.cos(degToRad(44)), Math.sin(degToRad(44)), 0];
      const p46: Vec3 = [Math.cos(degToRad(46)), Math.sin(degToRad(46)), 0];
      expect(polarCandidate(XY, [0, 0, 0], p44, 90)?.angleDegrees).toBe(0);
      expect(polarCandidate(XY, [0, 0, 0], p46, 90)?.angleDegrees).toBe(90);
    });

    it('起点が無い(origin === null)ときは極の候補を作らない', () => {
      const candidates = collectTrackCandidates(
        emptySketch([]), XY, null, [10, 5, 0], 15, ALL_KINDS,
      );
      expect(candidates).toEqual([]);
    });

    it('負の角(−17° = 343°)も0〜360へ正規化してから丸める → 345', () => {
      const pointOnPlane: Vec3 = [10 * Math.cos(degToRad(-17)), 10 * Math.sin(degToRad(-17)), 0];
      expect(polarCandidate(XY, [0, 0, 0], pointOnPlane, 15)?.angleDegrees).toBe(345);
    });

    it('enabledから\'polar\'を外すと極の候補が作られない', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'l1', from: [0, 0, 0], to: [10, 0, 0] };
      const withoutPolar = new Set<TrackKind>(['extension', 'perpendicular', 'parallel']);
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, [0, 0, 0], [10, 0.1, 0], 15, withoutPolar,
      );
      expect(candidates.some((candidate) => candidate.kind === 'polar')).toBe(false);
      expect(candidates.length).toBeGreaterThan(0);
    });
  });

  describe('延長線(extension)', () => {
    const HORIZONTAL: ResolvedSegment = { kind: 'segment', featureId: 'l1', from: [0, 0, 0], to: [10, 0, 0] };

    it('線分(0,0)-(10,0)、ポインタ(14,0.3) → 位置(14,0,0)、kind: extension', () => {
      const pointOnPlane: Vec3 = [14, 0.3, 0];
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, null, pointOnPlane, 15, new Set<TrackKind>(['extension']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      expect(result?.position).toEqual([14, 0, 0]);
      expect(result?.candidates).toHaveLength(1);
      expect(result?.candidates[0]?.kind).toBe('extension');
    });

    it('ポインタ(14,20)は判定半径(12画素)の外なので null', () => {
      const pointOnPlane: Vec3 = [14, 20, 0];
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, null, pointOnPlane, 15, new Set<TrackKind>(['extension']),
      );
      expect(candidates.length).toBeGreaterThan(0);
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).toBeNull();
    });
  });

  describe('垂線(perpendicular)', () => {
    it('線分(0,0)-(10,0)の終点(10,0)を通る垂線、ポインタ(10.2,7) → 位置(10,7,0)', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'l1', from: [0, 0, 0], to: [10, 0, 0] };
      const pointOnPlane: Vec3 = [10.2, 7, 0];
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, null, pointOnPlane, 15, new Set<TrackKind>(['perpendicular']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result?.position).toEqual([10, 7, 0]);
      expect(result?.candidates[0]?.kind).toBe('perpendicular');
    });
  });

  describe('平行線(parallel)', () => {
    it('線分(0,0)-(10,10)、起点(0,5)、ポインタ(6.2,11) → 位置(6.1,11.1,0)', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'l1', from: [0, 0, 0], to: [10, 10, 0] };
      const origin: Vec3 = [0, 5, 0];
      const pointOnPlane: Vec3 = [6.2, 11, 0];
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, origin, pointOnPlane, 15, new Set<TrackKind>(['parallel']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      const [x, y, z] = result!.position;
      expect(x).toBeCloseTo(6.1, 9);
      expect(y).toBeCloseTo(11.1, 9);
      expect(z).toBe(0);
      expect(result?.candidates[0]?.kind).toBe('parallel');
    });
  });

  describe('交点(2本の案内線)', () => {
    it('極0°(起点(0,0))と線分(5,-10)-(5,10)の延長線、ポインタ(5.1,0.2) → 位置(5,0,0)、candidatesが2本', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'l2', from: [5, -10, 0], to: [5, 10, 0] };
      const origin: Vec3 = [0, 0, 0];
      const pointOnPlane: Vec3 = [5.1, 0.2, 0];
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, origin, pointOnPlane, 15, new Set<TrackKind>(['polar', 'extension']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      const [x, y, z] = result!.position;
      expect(x).toBeCloseTo(5, 9);
      expect(y).toBeCloseTo(0, 9);
      expect(z).toBe(0);
      expect(result?.candidates).toHaveLength(2);
      expect(result?.candidates[0]?.kind).toBe('polar');
      expect(result?.candidates[1]?.kind).toBe('extension');
    });

    it('優先順位: 極と延長線が両方半径内なら極を1本目に採る', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'l2', from: [5, -10, 0], to: [5, 10, 0] };
      const origin: Vec3 = [0, 0, 0];
      const pointOnPlane: Vec3 = [5.1, 0.2, 0];
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, origin, pointOnPlane, 15, new Set<TrackKind>(['polar', 'extension']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result?.candidates[0]?.kind).toBe('polar');
    });

    it('ほぼ平行な2本の交点が判定半径(12px)の外なら、近い方の1本に落とす(タスク22b (e))', () => {
      /*
        t16 の懸念(`docs/報告記録.md` 2026-09-05 実時計 01:10)の再現。1 本ずつの候補は
        「ポインタに最も近い点」で決まるので必ず判定半径の中に入るが、**ほぼ平行な 2 本の
        交点はポインタから遠くに決まる**(実測で最大 51.57px)。ここでは 330° の極と、
        それと 5° だけ違う向きの延長線を作り、交点が 28px 余り離れることを固定する。
      */
      const origin: Vec3 = [0, 0, 0];
      // 極は 330°(= −30°)。ポインタはその線上に置く(極の候補との距離は 0)。
      const pointOnPlane: Vec3 = [8 * Math.cos(degToRad(-30)), 8 * Math.sin(degToRad(-30)), 0];
      // 延長線は −25°、原点から 2mm ずらした線。ポインタからは 2.5mm ほどしか離れない。
      const segment: ResolvedSegment = {
        kind: 'segment',
        featureId: 'l4',
        from: [0, 2, 0],
        to: [10 * Math.cos(degToRad(-25)), 2 + 10 * Math.sin(degToRad(-25)), 0],
      };
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, origin, pointOnPlane, 15,
        new Set<TrackKind>(['polar', 'extension']),
      );
      // 2 本とも判定半径(12px)の中にある(この前提が崩れると検査の意味が無くなる)。
      const inside = candidates.filter((candidate) => {
        const kind = candidate.kind;
        return kind === 'polar' || kind === 'extension';
      });
      expect(inside.length).toBeGreaterThanOrEqual(2);

      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      // 交点(実測 28.8px 先)は採らず、極の 1 本だけに落ちる。
      expect(result?.candidates).toHaveLength(1);
      expect(result?.candidates[0]?.kind).toBe('polar');
      const [x, y] = result!.position;
      expect(Math.hypot(x - pointOnPlane[0], y - pointOnPlane[1])).toBeLessThanOrEqual(12);
    });

    it('平行な2本(極0°と水平な延長線)は1本目だけを採り、交点を作らない', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'l3', from: [0, 0.4, 0], to: [10, 0.4, 0] };
      const origin: Vec3 = [0, 0, 0];
      const pointOnPlane: Vec3 = [10, 0, 0];
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, origin, pointOnPlane, 15, new Set<TrackKind>(['polar', 'extension']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      expect(result?.position).toEqual([10, 0, 0]);
      expect(result?.candidates).toHaveLength(1);
      expect(result?.candidates[0]?.kind).toBe('polar');
    });
  });

  describe('円弧・楕円・スプラインからは向きの候補を作らない(§2.4 の落とし穴)', () => {
    it('線分が無いスケッチでは延長線・垂線・平行線の候補が0件', () => {
      const candidates = collectTrackCandidates(
        emptySketch([]), XY, [0, 0, 0], [10, 0, 0], 15,
        new Set<TrackKind>(['extension', 'perpendicular', 'parallel']),
      );
      expect(candidates).toEqual([]);
    });
  });

  describe('角度の丸めの境界(落とし穴)', () => {
    it('刻み15°、角度がちょうど7.5°(半分)は15°側へ丸める(Math.round が0.5を上へ丸めるため)', () => {
      const pointOnPlane: Vec3 = [10 * Math.cos(degToRad(7.5)), 10 * Math.sin(degToRad(7.5)), 0];
      expect(polarCandidate(XY, [0, 0, 0], pointOnPlane, 15)?.angleDegrees).toBe(15);
    });

    it('刻み15°、角度358° → 丸めると360だが0へ正規化される', () => {
      const pointOnPlane: Vec3 = [10 * Math.cos(degToRad(358)), 10 * Math.sin(degToRad(358)), 0];
      expect(polarCandidate(XY, [0, 0, 0], pointOnPlane, 15)?.angleDegrees).toBe(0);
    });
  });

  describe('polarCandidate の退化(§2.4)', () => {
    it('刻み角度が0以下なら候補を作らない', () => {
      expect(polarCandidate(XY, [0, 0, 0], [10, 0, 0], 0)).toBeNull();
      expect(polarCandidate(XY, [0, 0, 0], [10, 0, 0], -5)).toBeNull();
    });

    it('起点とポインタが同じ位置なら向きが決まらないので候補を作らない', () => {
      expect(polarCandidate(XY, [3, 3, 0], [3, 3, 0], 15)).toBeNull();
    });
  });

  describe('候補の構造(件数・向き・要素id)', () => {
    const HORIZONTAL: ResolvedSegment = { kind: 'segment', featureId: 'lh', from: [0, 0, 0], to: [10, 0, 0] };

    it('延長線は線分1本につき2件、向きが互いに逆で、要素idを持つ', () => {
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, null, [5, 0.1, 0], 15, new Set<TrackKind>(['extension']),
      );
      expect(candidates).toHaveLength(2);
      expect(candidates.every((candidate) => candidate.sourceFeatureId === 'lh')).toBe(true);
      expect(candidates.every((candidate) => candidate.angleDegrees === null)).toBe(true);
      const [first, second] = candidates;
      expect(first.direction).toEqual([-second.direction[0], -second.direction[1], -second.direction[2]]);
    });

    it('垂線は線分1本につき2件、向きはどちらも同じ(端点が違うだけ)', () => {
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, null, [5, 5, 0], 15, new Set<TrackKind>(['perpendicular']),
      );
      expect(candidates).toHaveLength(2);
      expect(candidates.every((candidate) => candidate.kind === 'perpendicular')).toBe(true);
      const [first, second] = candidates;
      expect(first.direction).toEqual(second.direction);
      expect(first.origin).not.toEqual(second.origin);
    });

    it('平行線は起点を通る1件だけ(半直線ではないので両端は作らない)', () => {
      const origin: Vec3 = [0, 5, 0];
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, origin, [5, 5, 0], 15, new Set<TrackKind>(['parallel']),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe('parallel');
      expect(candidates[0]?.origin).toEqual(origin);
      expect(candidates[0]?.direction).toEqual([1, 0, 0]);
    });

    it('起点(origin)が無ければ平行線の候補も作らない(極と同じ扱い)', () => {
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, null, [5, 5, 0], 15, new Set<TrackKind>(['parallel']),
      );
      expect(candidates).toEqual([]);
    });

    it('長さ0の線分からは候補を作らない(向きが決まらない縮退)', () => {
      const degenerate: ResolvedSegment = { kind: 'segment', featureId: 'zero', from: [1, 1, 0], to: [1, 1, 0] };
      const candidates = collectTrackCandidates(
        emptySketch([degenerate]), XY, [0, 0, 0], [1, 1, 0], 15,
        new Set<TrackKind>(['extension', 'perpendicular', 'parallel']),
      );
      expect(candidates).toEqual([]);
    });

    it('ポインタから200mmを超えて離れた線分は粗い当たり判定で除外される(§2.9)', () => {
      const farSegment: ResolvedSegment = {
        kind: 'segment', featureId: 'far', from: [10000, 10000, 0], to: [10010, 10000, 0],
      };
      const candidates = collectTrackCandidates(
        emptySketch([farSegment]), XY, null, [0, 0, 0], 15,
        new Set<TrackKind>(['extension', 'perpendicular', 'parallel']),
      );
      expect(candidates).toEqual([]);
    });

    it('集めた候補の向きはすべて単位ベクトル(長さ1)', () => {
      const candidates = collectTrackCandidates(
        emptySketch([HORIZONTAL]), XY, [0, 5, 0], [5, 0.1, 0], 15,
        new Set<TrackKind>(['extension', 'perpendicular', 'parallel']),
      );
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        const length = Math.hypot(...candidate.direction);
        expect(length).toBeCloseTo(1, 9);
      }
    });
  });

  describe('chooseTrack の境界', () => {
    it('候補が1件も無ければ null', () => {
      expect(chooseTrack([], project, [0, 0], 12, [0, 0, 0])).toBeNull();
    });

    it('優先順位: 垂線(perpendicular)は平行線(parallel)より先に採る(距離が同着でも)', () => {
      const segment: ResolvedSegment = { kind: 'segment', featureId: 'lp', from: [0, 0, 0], to: [10, 0, 0] };
      const origin: Vec3 = [5, 5, 0];
      const pointOnPlane: Vec3 = [10, 5, 0];
      const candidates = collectTrackCandidates(
        emptySketch([segment]), XY, origin, pointOnPlane, 15,
        new Set<TrackKind>(['perpendicular', 'parallel']),
      );
      const result = chooseTrack(candidates, project, pointerOf(pointOnPlane), 12, pointOnPlane);
      expect(result).not.toBeNull();
      expect(result?.candidates[0]?.kind).toBe('perpendicular');
    });
  });

  describe('性能(§2.9、1フレーム16msの1/4 = 4ms以内)', () => {
    it('線分200本(うちポインタ近傍10本)から候補を集める', () => {
      const nearby: ResolvedSegment[] = [];
      for (let i = 0; i < 10; i += 1) {
        nearby.push({
          kind: 'segment', featureId: `near-${i}`,
          from: [i, 0, 0], to: [i, 10, 0],
        });
      }
      const far: ResolvedSegment[] = [];
      for (let i = 0; i < 190; i += 1) {
        far.push({
          kind: 'segment', featureId: `far-${i}`,
          from: [100000 + i, 0, 0], to: [100000 + i, 10, 0],
        });
      }
      const sketch = emptySketch([...nearby, ...far]);
      const origin: Vec3 = [0, 0, 0];
      const pointOnPlane: Vec3 = [5, 5, 0];

      const started = performance.now();
      const candidates = collectTrackCandidates(
        sketch, XY, origin, pointOnPlane, 15,
        new Set<TrackKind>(['extension', 'perpendicular', 'parallel']),
      );
      const elapsedMs = performance.now() - started;

      console.log(`[参考] トラッキング候補集め(線分200本、近傍10本): ${elapsedMs.toFixed(3)}ms`);

      // 近傍10本だけが残る: 1本あたり 延長線2 + 垂線2 + 平行線1 = 5件 → 50件。
      expect(candidates).toHaveLength(50);
      expect(elapsedMs).toBeLessThan(4);
    });
  });

  describe('ポインタの光線に最も近い点(P4b 仕上げ (a))', () => {
    /*
     * 視点が斜めのときの検証に使う、平行投影のカメラの向き(視線 v、画面の右 right、
     * 画面の上 up の正規直交系)。v = (1,1,2)/√6 は作図面の法線(Z軸)から傾いた向きで、
     * right = (1,-1,0)/√2、up = (1,1,-1)/√3 はどちらも v と直交し、互いにも直交する
     * (手計算で確認済み: v・right = v・up = right・up = 0、いずれも単位ベクトル)。
     * 平行投影なので、画面座標は「視線方向の深さを捨てて right・up 成分だけを読む」写像
     * になる(このカメラのもとでは、この写像が worldToScreen の役を果たす)。
     */
    const VIEW_DIRECTION: Vec3 = [1 / Math.sqrt(6), 1 / Math.sqrt(6), 2 / Math.sqrt(6)];
    const SCREEN_RIGHT: Vec3 = [1 / Math.sqrt(2), -1 / Math.sqrt(2), 0];
    const SCREEN_UP: Vec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), -1 / Math.sqrt(3)];

    const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    /*
     * 斜めの平行投影(検証専用): ワールド座標を (point・right, point・up) へ写す。
     * ブルートフォースの数値探索(下のテスト)でだけ使うので、`ProjectToScreen` の
     * `| null` は持たず、常に画面座標を返す形にしておく(この写像は画面の外という
     * 概念を持たないため)。
     */
    const obliqueProject = (point: Vec3): readonly [number, number] => [
      dot3(point, SCREEN_RIGHT), dot3(point, SCREEN_UP),
    ];

    /** 画面座標 (px, py) を通る光線。平行投影なのでどの画素でも向きは同じ(視線の向き)。 */
    function obliqueRay(px: number, py: number): PointerRay {
      return {
        origin: [
          px * SCREEN_RIGHT[0] + py * SCREEN_UP[0],
          px * SCREEN_RIGHT[1] + py * SCREEN_UP[1],
          px * SCREEN_RIGHT[2] + py * SCREEN_UP[2],
        ],
        direction: VIEW_DIRECTION,
      };
    }

    it('斜めの光線では、作図面上の点への垂直射影(従来の方法)と異なる t を返す(自分で計算した例)', () => {
      // 直線 L: 起点 (2,0,0)、向き (0,1,0)(作図面 z=0 の上、Y 軸に平行)。
      const line = { origin: [2, 0, 0] as Vec3, direction: [0, 1, 0] as Vec3 };
      // 画面 (0,0) を通る光線(斜め視点)。原点 C=(0,0,0)、向き v=(1,1,2)/√6。
      const ray = obliqueRay(0, 0);

      const t = closestParameterToRay(line, ray);
      expect(t).not.toBeNull();
      /*
       * 手計算(報告に記す導出): d=(0,1,0)、v=(1,1,2)/√6、C-P0=(0,0,0)-(2,0,0)=(-2,0,0)。
       *   a = d・d = 1
       *   b = d・v = 1/√6
       *   c = v・v = 1
       *   e = d・(C-P0) = 0
       *   f = v・(C-P0) = -2/√6
       *   分母 = a・c - b・b = 1 - 1/6 = 5/6
       *   t = (c・e - b・f) / 分母 = (0 - (1/√6)・(-2/√6)) / (5/6) = (2/6) / (5/6) = 2/5 = 0.4
       */
      expect(t!).toBeCloseTo(0.4, 9);

      // 従来の方法(光線と作図面 z=0 の交点(0,0,0)への垂直射影)は 0 を返す。
      // 2つの方法が異なる値を返すことが、この修正の理由そのものになる。
      const pointOnPlane: Vec3 = [0, 0, 0];
      const originDelta: Vec3 = [
        pointOnPlane[0] - line.origin[0], pointOnPlane[1] - line.origin[1],
        pointOnPlane[2] - line.origin[2],
      ];
      const oldT = dot3(originDelta, line.direction);
      expect(oldT).toBeCloseTo(0, 9);
      expect(t!).not.toBeCloseTo(oldT, 6);
    });

    it('その t で決めた点は、この斜め視点でポインタに最も近い(ブルートフォースの数値探索と一致)', () => {
      const line = { origin: [2, 0, 0] as Vec3, direction: [0, 1, 0] as Vec3 };
      const ray = obliqueRay(0, 0);
      const t = closestParameterToRay(line, ray)!;

      const pointAt = (parameter: number): Vec3 => [
        line.origin[0] + parameter * line.direction[0],
        line.origin[1] + parameter * line.direction[1],
        line.origin[2] + parameter * line.direction[2],
      ];
      const screenDistanceAt = (parameter: number): number => {
        const [x, y] = obliqueProject(pointAt(parameter));
        return Math.hypot(x, y);
      };

      const distanceAtT = screenDistanceAt(t);
      // 実装とは独立に、t を細かく振って総当たりで最小点を探る。
      // (理論上の最小点は上のテストの手計算どおり t=0.4。)
      for (let candidate = 0; candidate <= 1; candidate += 0.001) {
        expect(distanceAtT).toBeLessThanOrEqual(screenDistanceAt(candidate) + 1e-9);
      }
    });

    it('視線に垂直な光線(正面から見た視点)では、光線なし(従来の方法)と同じ点になる(退行なし)', () => {
      // 正面視点: 光線は作図面(z=0)に垂直、向きは (0,0,-1)。この場合、光線と作図面の
      // 交点(pointOnPlane)への垂直射影(従来の方法)と、光線への最近点(新しい方法)は
      // 一致する(§2.4、`closestParameterToRay` の注釈「なぜ画面座標の最近点と一致するか」)。
      const pointer: readonly [number, number] = [4, 7];
      const pointOnPlane: Vec3 = [pointer[0], pointer[1], 0];
      const ray: PointerRay = { origin: [pointer[0], pointer[1], 100], direction: [0, 0, -1] };
      const candidates = [{
        kind: 'extension' as const, origin: [0, 0, 0] as Vec3, direction: [1, 0, 0] as Vec3,
        sourceFeatureId: 'l1', angleDegrees: null,
      }];

      const withoutRay = chooseTrack(candidates, project, pointer, 12, pointOnPlane);
      const withRay = chooseTrack(candidates, project, pointer, 12, pointOnPlane, ray);
      expect(withoutRay).not.toBeNull();
      expect(withRay).not.toBeNull();
      expect(withRay!.position).toEqual(withoutRay!.position);
    });

    it('案内線が視線とちょうど平行(退化)なら null を返す', () => {
      const line = { origin: [0, 0, 0] as Vec3, direction: [0, 0, 1] as Vec3 };
      const ray: PointerRay = { origin: [5, 5, 5], direction: [0, 0, 1] };
      expect(closestParameterToRay(line, ray)).toBeNull();
    });

    it('退化(案内線が視線と平行)のとき、chooseTrack は光線なしと同じ結果へ後退する', () => {
      const candidates = [{
        kind: 'extension' as const, origin: [0, 0, 0] as Vec3, direction: [0, 0, 1] as Vec3,
        sourceFeatureId: 'l9', angleDegrees: null,
      }];
      const pointOnPlane: Vec3 = [0, 0, 5];
      const pointer: readonly [number, number] = [0, 0];
      const ray: PointerRay = { origin: [3, 3, 3], direction: [0, 0, 1] };

      const withoutRay = chooseTrack(candidates, project, pointer, 12, pointOnPlane);
      const withRay = chooseTrack(candidates, project, pointer, 12, pointOnPlane, ray);
      expect(withoutRay).not.toBeNull();
      expect(withRay).not.toBeNull();
      expect(withRay!.position).toEqual(withoutRay!.position);
    });

    it('極(polar)は光線を渡しても位置が変わらない(距離を保つ意図的な挙動、§2.4)', () => {
      const origin: Vec3 = [0, 0, 0];
      const pointOnPlane: Vec3 = [20 * Math.cos(degToRad(17)), 20 * Math.sin(degToRad(17)), 0];
      const candidate = polarCandidate(XY, origin, pointOnPlane, 15)!;
      const pointer = pointerOf(pointOnPlane);
      const ray = obliqueRay(pointer[0], pointer[1]);

      const withoutRay = chooseTrack([candidate], project, pointer, 12, pointOnPlane);
      const withRay = chooseTrack([candidate], project, pointer, 12, pointOnPlane, ray);
      expect(withoutRay).not.toBeNull();
      expect(withRay).not.toBeNull();
      expect(withRay!.position).toEqual(withoutRay!.position);
    });
  });
});
