/** Bootstrap for the isolated VM. No host objects cross this boundary.
 * Host callbacks receive serialized commands/logs and validate them independently.
 * This source is evaluated separately from user source, preserving user line numbers.
 */
export const SCRIPT_GUEST_BOOTSTRAP = `(() => {
  'use strict';
  const send = globalThis.__pointercadCommand;
  const sendLog = globalThis.__pointercadConsole;
  const sendLimit = globalThis.__pointercadLimit;
  const snapshotText = globalThis.__pointercadSnapshot;
  const executionPrefix = globalThis.__pointercadExecutionPrefix;
  const seed = globalThis.__pointercadSeed;
  delete globalThis.__pointercadCommand;
  delete globalThis.__pointercadConsole;
  delete globalThis.__pointercadLimit;
  delete globalThis.__pointercadSnapshot;
  delete globalThis.__pointercadExecutionPrefix;
  delete globalThis.__pointercadSeed;
  const freeze = Object.freeze, keys = Object.keys;
  const create = Object.create, define = Object.defineProperty;
  const parse = JSON.parse, stringify = JSON.stringify;
  const isArray = Array.isArray, isFiniteNumber = Number.isFinite;
  const ErrorType = Error, StringType = String;
  const stackOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Error.prototype, 'stack').get);
  function callStack() { return stackOf(new ErrorType()); }
  function limit(kind) { sendLimit(kind, callStack()); }
  const stringAt = Function.prototype.call.bind(String.prototype.charCodeAt);
  const trim = Function.prototype.call.bind(String.prototype.trim);
  const includes = Function.prototype.call.bind(Array.prototype.includes);
  const map = Function.prototype.call.bind(Array.prototype.map);
  const snapshot = parse(snapshotText);
  let nextId = 0, count = 0, commandBytes = 0, logCount = 0, logBytes = 0;

  function byteLength(value, maximum, limitKind = 'bytes') {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const code = stringAt(value, i);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
        && stringAt(value, i + 1) >= 0xdc00 && stringAt(value, i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
      if (bytes > maximum) { limit(limitKind); throw new ErrorType('送る内容が大きすぎます。'); }
    }
    return bytes;
  }
  function immutable(value) {
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      for (const key of keys(value)) immutable(value[key]);
      freeze(value);
    }
    return value;
  }
  immutable(snapshot);
  function source(value) {
    if (typeof value !== 'string' || value.length > 4096 || !trim(value)) {
      throw new ErrorType('寸法や式は4096文字以内の文字列で指定してください。');
    }
    return value;
  }
  function identifier(value) {
    if (typeof value !== 'string' || !value || value.length > 256) throw new ErrorType('参照する名前を指定してください。');
    return value;
  }
  function vector(value) {
    if (!isArray(value) || value.length !== 3) throw new ErrorType('座標には3つの式を指定してください。');
    return [source(value[0]), source(value[1]), source(value[2])];
  }
  function object(value, names) {
    if (value === null || typeof value !== 'object' || isArray(value)) throw new ErrorType('入力の組を指定してください。');
    for (const key of keys(value)) if (!includes(names, key)) throw new ErrorType('使えない入力欄です: ' + key);
    return value;
  }
  function record(kind, fields, returnsId = true) {
    if (++count > 1000) { limit('commands'); throw new ErrorType('1回の実行で作れる操作は1000件までです。'); }
    const resultId = returnsId ? executionPrefix + ':' + (++nextId) : null;
    const command = { kind, resultId, fields, callStack: callStack() };
    const serialized = stringify(command);
    commandBytes += byteLength(serialized, 8 * 1024 * 1024 - commandBytes);
    send(serialized);
    return resultId;
  }
  function primitive(kind, value, dimensions) {
    const input = object(value, ['origin', 'axis', ...dimensions]);
    const fields = create(null);
    fields.origin = input.origin === undefined ? ['0', '0', '0'] : vector(input.origin);
    fields.axis = input.axis === undefined ? 'z' : input.axis;
    if (!includes(['x', 'y', 'z'], fields.axis)) throw new ErrorType('軸はx・y・zから指定してください。');
    for (const name of dimensions) fields[name] = source(input[name]);
    return record(kind, fields);
  }
  const cad = immutable({
    apiVersion: 1,
    document: { read: () => snapshot },
    parameters: {
      set(name, value, unit) {
        if (unit !== undefined && !includes(['mm', 'degree', 'none'], unit)) throw new ErrorType('使えない単位です。');
        record('parameter.set', { name: identifier(name), source: source(value), unit: unit ?? null }, false);
      },
    },
    sketch: {
      create(name, plane = 'xy') {
        if (!includes(['xy', 'xz', 'yz'], plane)) throw new ErrorType('作図面をxy・xz・yzから指定してください。');
        return record('sketch.create', { name: identifier(name), plane });
      },
      point(sketch, coordinates) { return record('sketch.point', { sketch: identifier(sketch), coordinates: vector(coordinates) }); },
      line(sketch, start, end) { return record('sketch.line', { sketch: identifier(sketch), start: identifier(start), end: identifier(end) }); },
      face(sketch, edges) {
        if (!isArray(edges) || edges.length < 3 || edges.length > 1000) throw new ErrorType('面には閉じた3本以上の線を指定してください。');
        return record('sketch.face', { sketch: identifier(sketch), edges: map(edges, identifier) });
      },
    },
    solid: {
      box: input => primitive('solid.box', input, ['x', 'y', 'z']),
      sphere: input => primitive('solid.sphere', input, ['radius']),
      cylinder: input => primitive('solid.cylinder', input, ['radius', 'height']),
      cone: input => primitive('solid.cone', input, ['bottomRadius', 'topRadius', 'height']),
      torus: input => primitive('solid.torus', input, ['majorRadius', 'minorRadius']),
      extrude(face, distance) { return record('solid.extrude', { face: identifier(face), distance: source(distance) }); },
      hole(target, input) {
        const fields = object(input, ['origin', 'diameter', 'depth', 'axis']);
        const axis = fields.axis ?? 'z';
        if (!includes(['x', 'y', 'z'], axis)) throw new ErrorType('軸はx・y・zから指定してください。');
        return record('solid.hole', { target: identifier(target), origin: vector(fields.origin), axis,
          diameter: source(fields.diameter), depth: source(fields.depth) });
      },
    },
  });
  function log(level, values) {
    if (++logCount > 1000) { limit('console'); throw new ErrorType('1回の実行で表示できる記録は1000行までです。'); }
    let text = '';
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      const part = typeof value === 'string' ? value : typeof value === 'object' ? stringify(value) : StringType(value);
      if (i) text += ' ';
      text += part;
      byteLength(text, 1024 * 1024 - logBytes, 'console-bytes');
    }
    logBytes += byteLength(text, 1024 * 1024 - logBytes, 'console-bytes');
    sendLog(stringify({ level, text }));
  }
  let state = isFiniteNumber(seed) ? seed >>> 0 : 1;
  if (!state) state = 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  define(Math, 'random', { value: random, writable: false, configurable: false });
  define(globalThis, 'cad', { value: cad, writable: false, configurable: false });
  define(globalThis, 'console', { value: immutable({
    log: (...values) => log('info', values), info: (...values) => log('info', values),
    warn: (...values) => log('warning', values), error: (...values) => log('error', values),
  }), writable: false, configurable: false });
})()`;
