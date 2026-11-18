import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)を読めるようにする印。主プロセスだけが持ち、userData の小さな JSON に残す。
 * 画面の側から「入」を直接書く口は無い(入にするのは sixDofIpc.ts が OS の確かめの窓で利用者の許可を得た時だけ)。
 * 読めない・壊れた・未来の版の JSON は「切」として扱う(読めない方へ倒す)。
 */
const FILE_NAME = 'input-devices.json';
const FILE_VERSION = 1;

/** 保存の中身を読む。版 1 で `sixDofEnabled: true` の時だけ入。 */
function readSixDofEnabled(text: string | null): boolean {
  if (text === null) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && 'version' in parsed && parsed.version === FILE_VERSION && 'sixDofEnabled' in parsed && parsed.sixDofEnabled === true;
  } catch {
    return false;
  }
}

/** 読み書きに使う口(単体で差し替える)。 */
interface SixDofGateFiles {
  readonly read: (path: string) => string;
  readonly write: (path: string, text: string) => void;
  readonly rename: (from: string, to: string) => void;
}

const NODE_FILES: SixDofGateFiles = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => { writeFileSync(path, text, 'utf8'); },
  rename: (from, to) => { renameSync(from, to); },
};

export interface SixDofGate {
  readonly enabled: () => boolean;
  /** 印を変えて残す。入にする時は、残せた時だけ入になる(残せなければ切のまま false)。切は残せなくても切にする。 */
  readonly set: (enabled: boolean) => boolean;
}

/** 起動の時に 1 回だけ読み、以後は覚えた値を使う(機器の許可の照会のたびにファイルを読まない)。 */
export function createSixDofGate(directory: string, files: SixDofGateFiles = NODE_FILES): SixDofGate {
  const path = join(directory, FILE_NAME);
  let enabled = false;
  try { enabled = readSixDofEnabled(files.read(path)); } catch { enabled = false; }
  return {
    enabled: () => enabled,
    set: (next) => {
      try {
        // 書きかけのファイルを読まないよう、隣に書いてから置き換える。
        const temporary = `${path}.tmp`;
        files.write(temporary, `${JSON.stringify({ version: FILE_VERSION, sixDofEnabled: next })}\n`);
        files.rename(temporary, path);
        enabled = next;
        return true;
      } catch {
        if (!next) enabled = false;
        return !next;
      }
    },
  };
}
