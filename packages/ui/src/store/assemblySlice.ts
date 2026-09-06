/**
 * アセンブリのスライス(P7 §0.10、計画書タスク5)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 *
 * **1 つの窓で開く文書は 1 つだけ**(§0.a-0.10)。ここが `null` でないあいだは
 * アセンブリを開いていることになり、部品の読み出しの口(`documentKind.ts` の
 * `activePartDocument`)は `null` を返す。種類による分岐は**すべて `documentKind.ts`**
 * にあり、このスライスは「アセンブリを持っているか」だけを持つ。
 *
 * 合致を解いた結果・干渉の結果・分解のいまの位置はここに置かない(導出できるものは
 * 保存も控えもしない。`rules/04-設計の規律.md`)。それらの欄は P7 の以後の段が、
 * 必要になったところで足す。
 */

import type { AssemblyDocument } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AppState } from './appState.js';

/** アセンブリのスライスが持つ欄と操作。 */
export interface AssemblySlice {
  /**
   * 開いているアセンブリ文書(FR-601)。**開いていなければ null**(= 部品を開いている)。
   *
   * 部品を作り直す(新規)と閉じるので、初期値は `createInitialDocumentState` の側に
   * 置いてある(`documentSlice.ts` の `resetDocument` も `null` へ戻す)。
   */
  readonly assembly: AssemblyDocument | null;
  /**
   * アセンブリを開く。**部品の欄はここでは触らない**——欄そのものは起動時の空の部品を
   * 持ったまま残るが、`activePartDocument` が `null` を返すので画面には出ない
   * (§0.a-0.10「1 つの窓で 1 つの文書」)。
   */
  readonly openAssembly: (document: AssemblyDocument) => void;
  /** アセンブリを閉じて、部品の画面へ戻る。 */
  readonly closeAssembly: () => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄。実体は `initialDocumentState.ts` が 1 か所で作る。
 */
export type AssemblyInitialState = Pick<AssemblySlice, 'assembly'>;

export const createAssemblySlice: StateCreator<
  AppState,
  [],
  [],
  Omit<AssemblySlice, keyof AssemblyInitialState>
> = (set) => ({
  openAssembly: (assembly) => {
    set({ assembly });
  },
  closeAssembly: () => {
    set({ assembly: null });
  },
});
