// 試作(M07-0)のための読み込みの口。作業ツリーは読むだけ。
// - 計算部の .ts は './x.js' の形で互いを読むので、.ts から読まれた相対の .js が無ければ同じ名前の .ts を返す。
// - 計算部には型の取り除きだけでは読めない書き方(引数の宣言でのメンバー)があるので、.ts は typescript の
//   transpileModule で JavaScript に直してから渡す(型の検査はしない。型の検査は重ねの道具が受け持つ)。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import ts from 'typescript';

let sources = new Map();

export function initialize(data) {
  if (data instanceof Map) sources = data;
}

export async function resolve(specifier, context, nextResolve) {
  if (sources.has(specifier)) return { url: specifier, shortCircuit: true };
  const parent = context.parentURL ?? '';
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && parent.endsWith('.ts')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parent);
    if (sources.has(candidate.href)) return { url: candidate.href, shortCircuit: true };
    if (!sources.has(parent) && existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  if (sources.has(parent) && /^(?:\.{1,2}\/|file:|\/)/u.test(specifier)) {
    const url = new URL(specifier, parent).href;
    if (sources.has(url)) return { url, shortCircuit: true };
    throw new Error(`送信候補に計測の依存が無い: ${parent} → ${specifier}`);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (sources.has(url) && url.endsWith('.js')) {
    return { format: 'module', source: sources.get(url), shortCircuit: true };
  }
  if (!url.startsWith('file:') || !url.endsWith('.ts') || url.includes('/node_modules/')) return nextLoad(url, context);
  const source = sources.get(url) ?? readFileSync(fileURLToPath(url), 'utf8');
  const output = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false,
      isolatedModules: true, sourceMap: false },
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
