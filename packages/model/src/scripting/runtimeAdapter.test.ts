import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeScriptVm } from './runtimeAdapter.js';
import { sha256ScriptSource } from './scriptModules.js';
import type { ScriptExecutionInput, ScriptModule } from './scriptTypes.js';

let wasm: Uint8Array<ArrayBuffer>;
beforeAll(async () => { wasm = new Uint8Array(await readFile(new URL('../vendor/script-runtime/quickjs-pcad.wasm', import.meta.url))); });
async function input(source: string, modules: readonly ScriptModule[] = []): Promise<ScriptExecutionInput> {
  return { executionId: 'test-run', commandNamespace: 'a'.repeat(64), program: { apiVersion: 1, source, sha256: await sha256ScriptSource(source), modules },
    snapshot: '{"name":"試験部品","solids":[]}', seed: 123, timeMs: 1800000000000 };
}
async function run(source: string) { return executeScriptVm(await input(source), wasm); }
describe('隔離VMの実バイナリによる実行境界', () => {
  it('資源超過の保持を持たない配布元バイナリでは成功を返さない', async () => {
    const unpatched = new Uint8Array(await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm'))));
    expect(await executeScriptVm(await input('console.log(42);'), unpatched)).toMatchObject({ ok: false, error: { kind: 'worker' } });
  });
  it('式のまま命令を返し、readの値を変更させない', async () => {
    const result = await run('console.log(cad.document.read().name); cad.solid.box({x:"厚み*2",y:"20",z:"30"});');
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ kind: 'solid.box', resultId: `${'a'.repeat(64)}:1`, fields: { x: '厚み*2' } });
    expect(result.console).toEqual([{ level: 'info', text: '試験部品' }]);
    expect((await run('cad.document.read().name="改名";')).ok).toBe(false);
  });
  it('本体・DOM・通信・OS・別Workerへの口を持たずFunctionもVM内に留まる', async () => {
    const result = await run(`console.log(['fetch','XMLHttpRequest','WebSocket','importScripts','Worker','window','document','process','require','electron']
      .map(key=>typeof globalThis[key]).join(',')); console.log((()=>{}).constructor('return typeof process')());`);
    expect(result.ok).toBe(true);
    expect(result.console).toEqual([{ level: 'info', text: Array.from({length:10},()=>'undefined').join(',') },{level:'info',text:'undefined'}]);
  });
  it('元の行列をずらさず、通常エラーの場所を返す', async () => {
    const result = await run('const a=1;\nconst b=2;\nthrow new Error("入力例のエラー");');
    expect(result).toMatchObject({ ok: false, error: { message: '入力例のエラー', location: { file: 'user-script.js', line: 3, column: 11 } } });
  });
  it('構文エラー、時間超過、catchされた命令上限も元の行を返す', async () => {
    expect(await run('// syntax\nconst = 1;')).toMatchObject({ ok: false, error: { kind: 'syntax', location: { file: 'user-script.js', line: 2 } } });
    expect(await run('// timeout\nwhile(true){}')).toMatchObject({ ok: false, error: { kind: 'timeout', location: { file: 'user-script.js', line: 2 } } });
    expect(await run('// count\ntry{for(let i=0;i<1001;i++)cad.solid.box({x:"1",y:"1",z:"1"});}catch{}'))
      .toMatchObject({ ok: false, error: { kind: 'command', location: { file: 'user-script.js', line: 2 } } });
  }, 15000);
  it.each([
    ['for', '// first\n// second\nfor(;;){}', 3],
    ['function', 'export function loop(){\nwhile(true){}\n}', 2],
  ])('%sの分岐で時間超過した場所をmodule内でも保持する', async (_kind, source, line) => {
    const module = { name: 'limit.js', source, sha256: await sha256ScriptSource(source) };
    const result = await executeScriptVm(await input('import * as item from "limit.js"; item.loop?.();', [module]), wasm);
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout', location: { file: module.name, line } } });
  }, 10000);
  it('catchで消された資源超過でも元のmoduleと行を保持する', async () => {
    const source = 'export function recurse(){\n  return recurse()+1;\n}';
    const module = { name: 'helpers/deep.js', source, sha256: await sha256ScriptSource(source) };
    const result = await executeScriptVm(await input('import {recurse} from "helpers/deep.js"; try{recurse();}catch{}', [module]), wasm);
    expect(result).toMatchObject({ ok: false, error: { kind: 'stack', location: { file: module.name, line: 2 } } });
    const memory = await run('// 領域を使い切る\ntry{const a=[];while(true)a.push(new Array(100000).fill(3));}catch{}');
    expect(memory).toMatchObject({ ok: false, error: { kind: 'memory', location: { file: 'user-script.js', line: 2 } } });
  });
  it.each([
    ['再帰', 'function f(){return f()+1;} f();', 'stack'],
    ['メモリ', 'const a=[];while(true)a.push(new Array(100000).fill(1.25));', 'memory'],
    ['捕捉したメモリ超過', 'try{const a=[];while(true)a.push(new Array(100000).fill(1.25));}catch{} console.log("再開");', 'memory'],
    ['捕捉した再帰超過', 'function f(){return f()+1;}try{f();}catch{}console.log("再開");', 'stack'],
    ['無限ループ', 'while(true){}', 'timeout'],
    ['Promise連鎖', 'function f(){void Promise.resolve().then(f);} f();', 'timeout'],
    ['Promiseを保持する連鎖', 'function f(){return Promise.resolve().then(f);} f();', 'memory'],
    ['未完了await', 'await new Promise(()=>{});', 'runtime'],
    ['未処理reject', 'void Promise.reject(new Error("捨てたエラー"));', 'runtime'],
    ['未処理async', 'void (async()=>{throw new Error("捨てたasync");})();', 'runtime'],
    ['未処理reject大量', 'for(let i=0;i<100;i++)Promise.reject(i);', 'runtime'],
    ['命令件数', 'try{for(let i=0;i<1001;i++)cad.solid.box({x:"1",y:"1",z:"1"});}catch{}', 'command'],
    ['console件数', 'try{for(let i=0;i<1001;i++)console.log(i);}catch{}', 'console'],
  ])('%sを止め、次の実行は成功する', async (_label, source, kind) => {
    expect(await run(source)).toMatchObject({ ok: false, error: { kind } });
    expect((await run('console.log(42);')).ok).toBe(true);
  }, 15000);
  it('Promise.prototypeを改変してもホストの完了観測を欺けない', async () => {
    const result = await run('Promise.prototype.then=()=>42; throw new Error("元のエラー");');
    expect(result).toMatchObject({ ok: false, error: { message: '元のエラー' } });
  });
  it.each([
    ['ログ容量', 'try{console.log("x".repeat(1024*1024+1))}catch{}', 'console', '上限1MiB'],
    ['命令容量', 'const x="1"+" ".repeat(4095);try{for(let i=0;i<1000;i++)cad.solid.box({x,y:x,z:x})}catch{}', 'command', '上限8MiB'],
  ])('%s超過を正しい種類と具体的な上限で表示する', async (_name, source, kind, message) => {
    const result = await run(source);
    expect(result.ok).toBe(false); if (result.ok) return;
    expect(result.error.kind).toBe(kind); expect(result.error.message).toContain(message);
  });
  it.each([
    'throw {get message(){while(true){}}, get stack(){while(true){}}};',
    'throw new Error("x".repeat(20000000));',
    'throw new Proxy({}, {getOwnPropertyDescriptor(){while(true){}}});',
  ])('敵対的なエラーの説明でも戻り、巨大値をコピーしない %#', async (source) => {
    const started = performance.now(), result = await run(source);
    expect(result.ok).toBe(false); if (result.ok) return;
    expect(result.error.message.length).toBeLessThanOrEqual(4096);
    expect(performance.now() - started).toBeLessThan(5000);
    expect((await run('export const ok=true;')).ok).toBe(true);
  });
  it('同じsnapshot・seed・時刻で10回同じ命令とログになる', async () => {
    const sample = await input('console.log(Date.now(),new Date().getTimezoneOffset(),Math.random()); cad.solid.sphere({radius:String(1+Math.random())});');
    const first = await executeScriptVm(sample, wasm); expect(first.ok).toBe(true); if (!first.ok) return;
    for (let i = 0; i < 9; i++) {
      const result = await executeScriptVm(sample, wasm); expect(result.ok).toBe(true); if (!result.ok) return;
      expect(result.commands).toEqual(first.commands); expect(result.console).toEqual(first.console);
    }
    expect(first.console[0]?.text).toMatch(/^1800000000000 0 /u);
  });
  it('static/dynamic importは同梱された照合済みsourceだけを許す', async () => {
    const source = 'export const length="12";', module = { name: 'local.js', source, sha256: await sha256ScriptSource(source) };
    for (const main of ['import {length} from "./local.js"; console.log(length);', 'const {length}=await import("local.js");console.log(length);']) {
      expect(await executeScriptVm(await input(main, [module]), wasm)).toMatchObject({ ok: true, console: [{ level: 'info', text: '12' }] });
    }
    for (const name of ['../local.js', 'https://example.com/x.js', 'file:///x.js', 'missing.js']) {
      expect(await executeScriptVm(await input(`await import(${JSON.stringify(name)});`, [module]), wasm)).toMatchObject({ ok: false, error: { kind: 'module' } });
    }
    expect(await executeScriptVm(await input('import "local.js";', [{ ...module, source: 'console.log("改変");' }]), wasm))
      .toMatchObject({ ok: false, error: { kind: 'source' } });
  });
});
