/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)を読めるようにする印の口。デスクトップ版の入口だけが、React の起動の前に
 * 入れる(本体の確かめの窓・印は主プロセスが持つ)。Web 版は入れないので、画面は機器に触らず「読めません」を出す。
 */
export interface SixDofAccess {
  /** 本体が OS の確かめの窓を出し、利用者が許可した時だけ true。 */
  enable(this: void): Promise<boolean>;
  /** 確かめずに切にする。 */
  disable(this: void): Promise<boolean>;
  /** 今の印。 */
  enabled(this: void): Promise<boolean>;
}

let installed: SixDofAccess | undefined;

export function setSixDofAccess(access: SixDofAccess | undefined): void {
  installed = access;
}

export function getSixDofAccess(): SixDofAccess | undefined {
  return installed;
}

const listeners = new Set<() => void>();

/** 印や機器が変わった事を、3D の画面の読み手へ知らせる(タブで入・切にした時と、機器をつないだ時)。 */
export function notifySixDofChange(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeSixDofChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
