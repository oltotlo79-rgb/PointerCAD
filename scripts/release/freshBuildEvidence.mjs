import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import ts from 'typescript';
import { e2eBuildTargets, e2eWebServer } from '../lib/e2eWebServer.mjs';
import { sourceText } from './desktopFileInventory.mjs';

export const FRESH_BUILD_SOURCE_ROLES = Object.freeze({
  selector: 'scripts/lib/e2eWebServer.mjs',
  marker: 'scripts/lib/e2eBuildReady.mjs',
  rootPackage: 'package.json',
  desktopPackage: 'apps/desktop/package.json',
  webPackage: 'apps/web/package.json',
  desktopBuild: 'scripts/lib/w21DesktopBuild.mjs',
  desktopMain: 'apps/desktop/vite.main.config.ts',
  desktopPreload: 'apps/desktop/vite.preload.config.ts',
  desktopRenderer: 'apps/desktop/vite.renderer.config.ts',
});

const CONFIG = 'e2e/playwright.config.ts';
const DESKTOP = 'pnpm --filter @pointercad/desktop run build';
const WEB = 'pnpm --filter @pointercad/web run build';
const PREVIEW = 'pnpm --filter @pointercad/web run preview';
const READY_LINE = 'PCAD_E2E_DESKTOP_BUILD_READY';

function requireFresh(value, problem) {
  if (!value) throw new Error(problem);
}

function parse(name, text) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  requireFresh(source.parseDiagnostics.length === 0, `Invalid executed configuration source: ${name}`);
  return source;
}

function namedImport(source, name, module) {
  return source.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === module && node.importClause?.isTypeOnly === false
    && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(binding => !binding.isTypeOnly && !binding.propertyName && binding.name.text === name));
}

function property(object, name) {
  const matches = object.properties.filter(node => propertyName(node) === name);
  if (matches.length === 1 && ts.isPropertyAssignment(matches[0])) return matches[0].initializer;
  return undefined;
}

function propertyName(node) {
  return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
}

function allowedProperties(object, names) {
  const properties = object.map(propertyName);
  return new Set(properties).size === properties.length && properties.every(name => names.includes(name));
}

function constant(source, name) {
  const matches = source.statements.filter(ts.isVariableStatement)
    .filter(statement => (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap(statement => statement.declarationList.declarations)
    .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  return matches.length === 1 ? matches[0].initializer : undefined;
}

function staticValue(node, source, names = new Set()) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, source, names);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && !names.has(node.text)) {
    return staticValue(constant(source, node.text), source, new Set([...names, node.text]));
  }
  if (!ts.isTemplateExpression(node)) return undefined;
  let value = node.head.text;
  for (const span of node.templateSpans) {
    const part = staticValue(span.expression, source, names);
    if (part === undefined) return undefined;
    value += part + span.literal.text;
  }
  return value;
}

function effectiveWebServer(source) {
  const config = source.statements.find(node => ts.isExportAssignment(node) && !node.isExportEquals)?.expression;
  requireFresh(config && ts.isCallExpression(config) && config.expression.getText() === 'defineConfig'
    && namedImport(source, 'defineConfig', '@playwright/test') && config.arguments.length === 1
    && ts.isObjectLiteralExpression(config.arguments[0]), 'Executed Playwright default configuration missing');
  const root = config.arguments[0], server = property(root, 'webServer');
  const position = root.properties.findIndex(node => ts.isPropertyAssignment(node) && node.initializer === server);
  requireFresh(server && ts.isObjectLiteralExpression(server) && root.properties.slice(position + 1).every(node =>
    !ts.isSpreadAssignment(node) && (!node.name || !ts.isComputedPropertyName(node.name))), 'Effective Playwright webServer is ambiguous');
  requireFresh(property(server, 'reuseExistingServer')?.kind === ts.SyntaxKind.FalseKeyword, 'Playwright may reuse an existing server');
  const env = property(server, 'env');
  requireFresh(env && ts.isObjectLiteralExpression(env) && env.properties.length === 1
    && staticValue(property(env, 'VITE_PCAD_E2E'), source) === '1', 'Executed Playwright build environment differs');
  requireFresh(server.properties.every(node => ts.isSpreadAssignment(node)
    || (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name))), 'Effective Playwright webServer is ambiguous');
  return server;
}

function sameWords(left, right) {
  return left?.trim().split(/\s+/u).join(' ') === right.trim().split(/\s+/u).join(' ');
}

function hasLegacyPreview(source, server, command) {
  const url = staticValue(property(server, 'url'), source);
  const port = /^http:\/\/127\.0\.0\.1:(\d+)$/u.exec(url)?.[1];
  return port !== undefined && allowedProperties(server.properties, ['command', 'env', 'url', 'reuseExistingServer', 'timeout'])
    && sameWords(command, `${DESKTOP} && ${WEB} && ${PREVIEW} --port ${port} --strictPort --host 127.0.0.1`);
}

function call(node, name, arity) {
  return node && ts.isCallExpression(node) && node.expression.getText() === name && node.arguments.length === arity ? node.arguments : null;
}

function isMember(node, owner, name) {
  return node && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === owner && node.name.text === name;
}

function markerInput(node, source) {
  const arg = call(node, 'fileURLToPath', 1)?.[0];
  if (!arg || !ts.isNewExpression(arg) || arg.expression.getText() !== 'URL' || arg.arguments?.length !== 2) return false;
  const [path, base] = arg.arguments;
  return staticValue(path, source) === `../${FRESH_BUILD_SOURCE_ROLES.marker}` && ts.isPropertyAccessExpression(base)
    && base.name.text === 'url' && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && base.expression.name.text === 'meta';
}

export function readFreshBuildConfig(text) {
  const source = parse(CONFIG, text), server = effectiveWebServer(source);
  const spreads = server.properties.filter(ts.isSpreadAssignment);
  if (spreads.length === 0) {
    requireFresh(hasLegacyPreview(source, server, staticValue(property(server, 'command'), source)), 'Canonical legacy fresh build/preview chain missing');
    return { mode: 'legacy' };
  }
  const args = spreads.length === 1 && server.properties[0] === spreads[0] ? call(spreads[0].expression, 'e2eWebServer', 3) : null;
  const port = args && Number(staticValue(args[1], source));
  requireFresh(args && isMember(call(args[0], 'e2eBuildTargets', 1)?.[0], 'process', 'argv') && markerInput(args[2], source)
    && namedImport(source, 'fileURLToPath', 'node:url') && ['e2eBuildTargets', 'e2eWebServer'].every(name =>
      namedImport(source, name, `../${FRESH_BUILD_SOURCE_ROLES.selector}`))
    && Number.isInteger(port) && port > 0 && port <= 65535
    && allowedProperties(server.properties.slice(1), ['env', 'reuseExistingServer', 'timeout']),
  'Canonical delegated webServer selection missing');
  return { mode: 'delegated', port };
}

function verifyReadyMarker(text) {
  const source = parse(FRESH_BUILD_SOURCE_ROLES.marker, text);
  const calls = source.statements.filter(ts.isExpressionStatement).map(statement => statement.expression);
  const write = calls.find(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && isMember(node.expression.expression, 'process', 'stdout') && node.expression.name.text === 'write');
  const timer = calls.map(node => call(node, 'setInterval', 2)).find(Boolean);
  const guard = source.statements.find(ts.isIfStatement);
  const recordsBuild = guard !== undefined;
  const recordCall = guard && ts.isExpressionStatement(guard.thenStatement) && ts.isAwaitExpression(guard.thenStatement.expression)
    && call(guard.thenStatement.expression.expression, 'recordW21DesktopBuild', 0);
  const condition = guard?.expression;
  requireFresh(!recordsBuild || (recordCall && !guard.elseStatement && write && guard.end <= write.getStart(source)
    && condition && ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isPropertyAccessExpression(condition.left) && isMember(condition.left.expression, 'process', 'env')
    && condition.left.name.text === 'PCAD_DEDICATED_MEASUREMENT' && staticValue(condition.right, source) === 'w21'
    && namedImport(source, 'recordW21DesktopBuild', './w21DesktopBuild.mjs')), 'W21 receipt must be recorded before desktop readiness');
  requireFresh(source.statements.length === (recordsBuild ? 6 : 4) && calls.length === 2 && calls[0] === write && write.arguments.length === 1
    && staticValue(write.arguments[0], source) === `${READY_LINE}\n` && timer && ts.isArrowFunction(timer[0])
    && timer[0].body.kind === ts.SyntaxKind.Identifier && timer[0].body.text === 'undefined' && Number(staticValue(timer[1], source)) > 0
    && namedImport(source, 'setInterval', 'node:timers')
    && source.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === 'node:process' && node.importClause?.name?.text === 'process'),
  'Executed desktop ready marker does not signal and wait for teardown');
  return recordsBuild;
}

function verifyPackageScripts(read, targets) {
  const scripts = role => JSON.parse(read(role)).scripts;
  requireFresh(sameWords(scripts('rootPackage')?.['test:e2e'], `playwright test --config ${CONFIG}`), 'Root Playwright package script differs');
  if (targets === 'desktop') {
    requireFresh(sameWords(scripts('desktopPackage')?.build, 'vite build --config vite.main.config.ts && vite build --config vite.preload.config.ts && vite build --config vite.renderer.config.ts'),
      'Desktop package does not freshly build main, preload and renderer');
  } else {
    const web = scripts('webPackage');
    requireFresh(sameWords(web?.build, 'vite build') && sameWords(web?.preview, 'vite preview'), 'Web package does not build and preview the same product');
  }
}

export function checkDelegatedFreshBuild(read, config, argv, project, checkout) {
  const selector = read('selector');
  const canonical = readFileSync(new URL('../lib/e2eWebServer.mjs', import.meta.url), 'utf8');
  requireFresh(selector === sourceText(canonical), 'Executed build selector differs from the verifier implementation');
  const projectTokens = Array.isArray(argv) ? argv.filter(arg => /^--project(?:=|$)/u.test(arg)) : [];
  requireFresh(Array.isArray(argv) && argv.every(arg => typeof arg === 'string')
    && argv[2] === 'run' && argv[3] === 'test:e2e' && argv.includes('--no-deps')
    && projectTokens.length === 1 && projectTokens[0] === `--project=${project}`
    && !argv.slice(4).some(arg => /^(?:--config(?:=|$)|-c|--list|--ui|--shard(?:=|$))/u.test(arg)),
  'Executed Playwright arguments do not select the dedicated project and config');
  const target = project === 'electron' ? 'desktop' : 'web';
  const ready = resolve(checkout, FRESH_BUILD_SOURCE_ROLES.marker), selection = e2eBuildTargets(argv);
  const server = e2eWebServer(selection, config.port, ready);
  requireFresh(selection === target, 'Executed Playwright fresh build selected a foreign target');
  verifyPackageScripts(read, target);
  if (target === 'desktop') {
    const recordsBuild = verifyReadyMarker(read('marker'));
    const stdout = server.wait?.stdout;
    requireFresh(sameWords(server.command, `${DESKTOP} && node "${ready}"`) && !server.url && stdout instanceof RegExp
      && stdout.test(READY_LINE) && stdout.test(`build output\n${READY_LINE}\n`) && !stdout.test(`prefix${READY_LINE}suffix`),
    'Electron fresh build did not select the desktop ready wait');
    if (recordsBuild) {
      read('desktopBuild');
      verifyDesktopOutputPaths(read);
    }
    return recordsBuild;
  } else {
    requireFresh(sameWords(server.command, `${WEB} && ${PREVIEW} --port ${config.port} --strictPort --host 127.0.0.1`)
      && server.url === `http://127.0.0.1:${config.port}` && !server.wait, 'Browser fresh build did not select the Web preview');
    return false;
  }
}

function verifyDesktopOutputPaths(read) {
  const pkg = JSON.parse(read('desktopPackage'));
  requireFresh(pkg.main === './dist/main/main.cjs', 'Desktop runtime entry is outside the fresh main output');
  for (const [role, output] of [['desktopMain', 'main'], ['desktopPreload', 'preload'], ['desktopRenderer', 'renderer']]) {
    const source = parse(`vite.${output}.config.ts`, read(role));
    const config = source.statements.find(ts.isExportAssignment)?.expression;
    const options = call(config, 'defineConfig', 1)?.[0];
    const build = options && ts.isObjectLiteralExpression(options) && property(options, 'build');
    requireFresh(build && ts.isObjectLiteralExpression(build)
      && build.properties.every(node => ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name))
      && staticValue(property(build, 'outDir'), source) === `dist/${output}`
      && property(build, 'emptyOutDir')?.kind === ts.SyntaxKind.TrueKeyword,
    `Desktop ${output} does not replace its output in the measured build`);
  }
}
