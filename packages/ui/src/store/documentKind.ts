/**
 * いま開いている文書の種類の判定(P7 §0.10、計画書タスク5)。
 *
 * 要件§7.1 の「モデリング / アセンブリ / 図面」の切替は、**タブを増やさずに開いている
 * 文書の種類で自動に切り替える**(§0.a-0.10)。その判定を**この 1 か所に集める**ので、
 * `kind` を見る `if` が `.tsx` の中に散らない。画面(`AppShell.tsx`)も木もプロパティも、
 * 「いまどちらか」はここへ訊く。
 *
 * **1 つの窓で開く文書は 1 つだけ**(§0.a-0.10)。アセンブリを開いているあいだ、部品の
 * 読み出しの口(`activePartDocument`)は `null` を返す——ストアの `document` の欄には
 * 起動時の空の部品が残っているが、それは**画面に出ていない**ので、部品として読ませない。
 *
 * ここはストアに触れず、渡された欄だけを見る純関数にしてある(Node の検査で素の値を
 * 渡せる。`documentDerived.ts` と同じ流儀)。
 */
import type { AssemblyDocument, PartDocument } from '@pointercad/model';

/**
 * 文書の種類。`empty` は**部品もアセンブリも開いていない**状態で、いまのストアは常に
 * 部品を 1 つ持つ(`createInitialDocumentState` が空の部品から始める)ので起きない。
 * それでも定義して検査で固定しておくのは、部品を閉じる操作(P8 以降)を足したときに
 * **直す場所をここ 1 か所に閉じ込める**ため。
 */
export type DocumentKind = 'part' | 'assembly' | 'empty';

/**
 * 種類の判定に要る欄だけ。ストア全体(`AppState`)を要求しないので、検査からは
 * この 2 欄だけの素の値を渡せる。
 */
export interface DocumentKindState {
  /** 部品文書(`documentSlice.ts`)。いまのストアでは常にあるが、型の上では無くてもよい。 */
  readonly document: PartDocument | null;
  /** アセンブリ文書(`assemblySlice.ts`)。開いていなければ null。 */
  readonly assembly: AssemblyDocument | null;
}

/**
 * いま開いている文書の種類。**アセンブリが開いていれば必ず `'assembly'`**
 * (同時に 2 つ開かないので、部品の欄に何が残っていても見ない)。
 */
export function activeDocumentKind(state: DocumentKindState): DocumentKind {
  if (state.assembly !== null) {
    return 'assembly';
  }
  return state.document === null ? 'empty' : 'part';
}

/** いま画面に出ている部品文書。アセンブリを開いているあいだは null。 */
export function activePartDocument(state: DocumentKindState): PartDocument | null {
  return activeDocumentKind(state) === 'part' ? state.document : null;
}

/** いま画面に出ているアセンブリ文書。部品を開いているあいだは null。 */
export function activeAssemblyDocument(state: DocumentKindState): AssemblyDocument | null {
  return state.assembly;
}

/**
 * 文書の種類ごとの節・行の `key` に付ける接頭辞(`rules/06` 10.9)。
 *
 * P7 は部品の節とアセンブリの節を**同じ親**(プロパティ区画の `.pcad-panel__body`、
 * 木の一覧)に並べる段が来る。そのとき id をそのまま `key` にすると、部品のフィーチャーの
 * id とアセンブリの部品の id が偶然一致した瞬間に兄弟の鍵が重なり、古い節が消えずに
 * 残る(10.9 で外観の節が起こした事故とまったく同じ)。**節を足す前に付け方を決めておく。**
 *
 * `PropertyPanel.tsx` の既にある接頭辞(`appearance:` / `primitive:` / `ruled:` / `cut:` /
 * `sphereGrid:` / `measure:` / `mass:`)とも重ならない語を選んである。
 */
const DOCUMENT_KIND_KEY_PREFIXES: Readonly<Record<DocumentKind, string>> = {
  part: 'part:',
  assembly: 'assembly:',
  empty: 'empty:',
};

/**
 * 文書の種類つきの `key`。**種類が違えば必ず食い違う**ことが満たすべき性質で、
 * それを `documentKind.test.ts` が固定する。
 */
export function documentSectionKey(kind: DocumentKind, id: string): string {
  return `${DOCUMENT_KIND_KEY_PREFIXES[kind]}${id}`;
}
