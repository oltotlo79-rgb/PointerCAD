/**
 * 形状計算部(同梱の OCCT の WebAssembly)のメモリの量を読む(NFR-PF-6「WASM の実質上限
 * (〜4GB)内で動作。上限接近時に警告する」、計画書 P12-28)。
 *
 * **読むのは確保済みの量**(`HEAPU8.buffer.byteLength`)。Emscripten はメモリを増やすたびに
 * `Module.HEAPU8` を新しい窓へ差し替える(グルーコードの `updateGlobalBufferAndViews`)ので、
 * 計算を終えた時点で読めば、その時点の確保量になる。使用中の量(malloc の内訳)を読む口は
 * 同梱物に無い(書き出している確保の関数は `_malloc` / `_free` だけ)ため、確保量で判断する。
 * WebAssembly のメモリは縮まないので、この値は計算部を作り直すまで減らない。
 *
 * 警告を出すかどうか(上限の何割で出すか)は画面の側が決める
 * (`packages/ui/src/shell/statusText.ts` の `MEMORY_WARNING_RATIO`)。ここは測るだけにする。
 */
import type { KernelMemoryUsage, SolidRecomputeResult } from '../types.js';

/**
 * 形状計算部が確保できるメモリの上限(バイト)。同梱の opencascade.js のグルーコードの
 * `getHeapMax()` が返す値(4GiB から 1 ページ 64KiB を引いた値)と同じにしてある。
 * 同梱物を差し替えて値が変われば `kernelMemory.test.ts` が落ちる。
 */
export const OCCT_HEAP_LIMIT_BYTES = 4_294_901_760;

/**
 * 計算部の実体から、確保済みのバイト数を読む。`OpenCascadeInstance` の型は `HEAPU8` を
 * 宣言していないので、`as` で決め付けずに中身を実際に調べて絞り込む(rules/02)。
 * 読めない・値がおかしいときは undefined にする(警告を出さない側へ倒し、計算は止めない)。
 */
export function readKernelMemory(instance: object): KernelMemoryUsage | undefined {
  if (!('HEAPU8' in instance)) {
    return undefined;
  }
  const view: unknown = instance.HEAPU8;
  if (typeof view !== 'object' || view === null || !('buffer' in view)) {
    return undefined;
  }
  const buffer: unknown = view.buffer;
  if (typeof buffer !== 'object' || buffer === null || !('byteLength' in buffer)) {
    return undefined;
  }
  const bytes: unknown = buffer.byteLength;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return undefined;
  }
  return { wasmHeapBytes: bytes, wasmHeapLimitBytes: OCCT_HEAP_LIMIT_BYTES };
}

/**
 * 再計算の返信にメモリの量を足す(NFR-PF-6)。**既存の欄は変えず、足すだけ。**
 * 読めなければ返信をそのまま返す(同じ物を返すので、呼び出し側の扱いは今までと同じ)。
 */
export function withKernelMemory(
  result: SolidRecomputeResult,
  instance: object,
): SolidRecomputeResult {
  const memory = readKernelMemory(instance);
  return memory === undefined ? result : { ...result, memory };
}
