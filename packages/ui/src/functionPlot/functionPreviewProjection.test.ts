import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@pointercad/model';
import { createFunctionPointPreviewProjection, createFunctionPreviewProjection } from './functionPreviewProjection.js';

describe('確認図の枠・軸名・候補のための余白', () => {
  it('正面のXYZ枠と原点を24pxの余白を残して配置する', () => {
    const project = createFunctionPreviewProjection([-2,-2,-2], [2,2,2], { yaw: 0, pitch: 0 });
    expect(project([0,0,0],240,240)).toEqual([120,120]);
    expect(project([2,0,2],240,240)).toEqual([216,24]);
    expect(project([-2,0,-2],240,240)).toEqual([24,216]);
  });
  it('縦横の図と全方位の回転で、境界の候補ボタンと軸名を切らない', () => {
    const minimum: Vec3 = [-2,-1,0], maximum: Vec3 = [2,3,5];
    for (const [width,height] of [[240,480],[968,240],[144,144]]) {
      for (let yaw = -6; yaw <= 6; yaw += 1) for (let pitch = -3; pitch <= 3; pitch += 1) {
        const project = createFunctionPreviewProjection(minimum, maximum, { yaw: yaw * Math.PI / 6, pitch: pitch * Math.PI / 6 });
        for (let bits = 0; bits < 8; bits += 1) {
          const corner: Vec3 = [bits & 1 ? maximum[0] : minimum[0], bits & 2 ? maximum[1] : minimum[1], bits & 4 ? maximum[2] : minimum[2]];
          const [x,y] = project(corner,width,height);
          expect(x).toBeGreaterThanOrEqual(24 - 1e-10); expect(x).toBeLessThanOrEqual(width - 24 + 1e-10);
          expect(y).toBeGreaterThanOrEqual(24 - 1e-10); expect(y).toBeLessThanOrEqual(height - 24 + 1e-10);
        }
      }
    }
  });
  it.each([5e307, Number.MIN_VALUE])('有限な半幅%sでも大きさを失わず画面へ収める', halfSpan => {
    const minimum: Vec3 = [-halfSpan,-halfSpan,-halfSpan], maximum: Vec3 = [halfSpan,halfSpan,halfSpan];
    const front = createFunctionPreviewProjection(minimum, maximum, { yaw: 0, pitch: 0 });
    expect(front([halfSpan,0,halfSpan],240,240)).toEqual([216,24]);
    expect(front([-halfSpan,0,-halfSpan],240,240)).toEqual([24,216]);
    const rotated = createFunctionPreviewProjection(minimum, maximum, { yaw: 0.4, pitch: 0.7 });
    for (let bits = 0; bits < 8; bits += 1) {
      const corner: Vec3 = [bits & 1 ? halfSpan : -halfSpan, bits & 2 ? halfSpan : -halfSpan, bits & 4 ? halfSpan : -halfSpan];
      for (const coordinate of rotated(corner,240,240)) {
        expect(Number.isFinite(coordinate)).toBe(true);
        expect(coordinate).toBeGreaterThanOrEqual(24 - 1e-10);
        expect(coordinate).toBeLessThanOrEqual(216 + 1e-10);
      }
    }
  });
  it('まだ小さい図や1点の範囲でも非有限な候補位置を作らない', () => {
    const project = createFunctionPreviewProjection([2,3,4], [2,3,4], { yaw: 0.6, pitch: 0.2 });
    expect(project([2,3,4],1,1)).toEqual([0.5,0.5]);
  });
  it('回転した境界の候補にも、軸名の専用領域との間に余白を保つ', () => {
    for (const width of [144,240,968]) for (let yaw=-6;yaw<=6;yaw+=1) for (let pitch=-3;pitch<=3;pitch+=1) {
      const project=createFunctionPointPreviewProjection([-2,-1,0],[2,3,5],{yaw:yaw*Math.PI/6,pitch:pitch*Math.PI/6});
      for(let bits=0;bits<8;bits+=1) {
        const [x,y]=project([bits&1?2:-2,bits&2?3:-1,bits&4?5:0],width,240);
        // Includes a 40px button and its selected outline, not just its centre.
        expect(x+22).toBeLessThan(width-30);
        expect(y-22).toBeGreaterThanOrEqual(2-1e-10);
        expect(y+22).toBeLessThanOrEqual(238+1e-10);
      }
    }
  });
});
