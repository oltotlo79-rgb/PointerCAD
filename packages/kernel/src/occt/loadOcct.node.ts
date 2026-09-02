import initOpenCascade from 'opencascade.js/dist/node.js';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

/**
 * Node(Vitest)で OCCT を読み込む。
 * opencascade.js/dist/node.js は __dirname と require を補ってから
 * dist/opencascade.full.wasm を絶対パスで読むため、バンドラなしで動く。
 * 初期化に数秒〜十数秒かかるので、プロセス内で1回だけ実行して使い回す。
 */
let cached: Promise<OpenCascadeInstance> | undefined;

export function loadOcctForNode(): Promise<OpenCascadeInstance> {
  cached ??= initOpenCascade();
  return cached;
}
