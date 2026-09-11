import type { QuickJS } from 'quickjs-wasi';
import { scriptFailure } from './runtimeErrors.js';
import type { ScriptFailure } from './scriptTypes.js';
import { locateScriptError } from './scriptLocation.js';

interface NativeLimitExport {
  pointercad_resource_failure(): number;
  pointercad_resource_line(): number;
  pointercad_resource_column(): number;
  pointercad_resource_file_byte(index: number): number;
}
function hasNativeLimitExport(value: unknown): value is NativeLimitExport {
  return typeof value === 'object' && value !== null && 'pointercad_resource_failure' in value
    && typeof value.pointercad_resource_failure === 'function'
    && 'pointercad_resource_line' in value && typeof value.pointercad_resource_line === 'function'
    && 'pointercad_resource_column' in value && typeof value.pointercad_resource_column === 'function'
    && 'pointercad_resource_file_byte' in value && typeof value.pointercad_resource_file_byte === 'function';
}
/** One isolated VM per transaction. Fail closed if the unpatched npm binary is supplied. */
export function nativeResourceLimit(vm: QuickJS, sources: ReadonlyMap<string, string>): () => ScriptFailure | null {
  const native: unknown = vm._getExports();
  if (!hasNativeLimitExport(native)) throw new Error('必要な資源制限付き実行器がありません。');
  return () => {
    const code = native.pointercad_resource_failure();
    if (code === 0) return null;
    let file = '';
    for (let index = 0; index < 128; index++) {
      const byte = native.pointercad_resource_file_byte(index);
      if (!Number.isInteger(byte) || byte < 1 || byte > 127) break;
      file += String.fromCharCode(byte);
    }
    const location = locateScriptError(`at (${file}:${native.pointercad_resource_line()}:${native.pointercad_resource_column()})`, sources);
    if (code === 1) return { ...scriptFailure('memory', '処理に使えるメモリ64MiBの上限を超えました。'), location };
    if (code === 2) return { ...scriptFailure('stack', '関数を呼び出す深さの上限を超えました。再帰を浅くしてください。'), location };
    if (code === 3) return { ...scriptFailure('timeout', '処理時間の上限5秒を超えました。'), location };
    return scriptFailure('worker', '実行器の資源制限を確認できません。');
  };
}
