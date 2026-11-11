import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exact upstream function, not a reimplementation of the new closure algorithm.
const upstreamSource = "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError(\"argTypes array size mismatch! Must at least get return value and 'this' types!\")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!==\"void\";var argsList=\"\";var argsListWired=\"\";for(var i=0;i<argCount-2;++i){argsList+=(i!==0?\", \":\"\")+\"arg\"+i;argsListWired+=(i!==0?\", \":\"\")+\"arg\"+i+\"Wired\"}var invokerFnBody=\"return function \"+makeLegalFunctionName(humanName)+\"(\"+argsList+\") {\\n\"+\"if (arguments.length !== \"+(argCount-2)+\") {\\n\"+\"throwBindingError('function \"+humanName+\" called with ' + arguments.length + ' arguments, expected \"+(argCount-2)+\" args!');\\n\"+\"}\\n\";if(needsDestructorStack){invokerFnBody+=\"var destructors = [];\\n\"}var dtorStack=needsDestructorStack?\"destructors\":\"null\";var args1=[\"throwBindingError\",\"invoker\",\"fn\",\"runDestructors\",\"retType\",\"classParam\"];var args2=[throwBindingError,cppInvokerFunc,cppTargetFunc,runDestructors,argTypes[0],argTypes[1]];if(isClassMethodFunc){invokerFnBody+=\"var thisWired = classParam.toWireType(\"+dtorStack+\", this);\\n\"}for(var i=0;i<argCount-2;++i){invokerFnBody+=\"var arg\"+i+\"Wired = argType\"+i+\".toWireType(\"+dtorStack+\", arg\"+i+\"); // \"+argTypes[i+2].name+\"\\n\";args1.push(\"argType\"+i);args2.push(argTypes[i+2])}if(isClassMethodFunc){argsListWired=\"thisWired\"+(argsListWired.length>0?\", \":\"\")+argsListWired}invokerFnBody+=(returns?\"var rv = \":\"\")+\"invoker(fn\"+(argsListWired.length>0?\", \":\"\")+argsListWired+\");\\n\";if(needsDestructorStack){invokerFnBody+=\"runDestructors(destructors);\\n\"}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var paramName=i===1?\"thisWired\":\"arg\"+(i-2)+\"Wired\";if(argTypes[i].destructorFunction!==null){invokerFnBody+=paramName+\"_dtor(\"+paramName+\"); // \"+argTypes[i].name+\"\\n\";args1.push(paramName+\"_dtor\");args2.push(argTypes[i].destructorFunction)}}}if(returns){invokerFnBody+=\"var ret = retType.fromWireType(rv);\\n\"+\"return ret;\\n\"}else{}invokerFnBody+=\"}\\n\";args1.push(invokerFnBody);var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}";
const originalFunctionSha = "c3b5cdb7cca16a1c5e64153b4c4a1fe191754afcb67e3821dbeb82992761732f";
const patchedGlueSha = "81cf6d926fefd75a700bd59f518750ff265ba7275886a25397505184f371f946";
const require = createRequire(import.meta.url);
const glue = readFileSync(require.resolve('opencascade.js/dist/opencascade.full.js'), 'utf8');
const begin = glue.indexOf('function craftInvokerFunction(');
const end = glue.indexOf('function heap32VectorToArray', begin);
const installedSource = glue.slice(begin, end);

type Destructor = (value: unknown) => void;
type Stack = unknown[];
interface Converter {
  name: string;
  destructorFunction?: Destructor | null;
  toWireType: (stack: Stack | null, value: unknown) => unknown;
  fromWireType: (value: unknown) => unknown;
}
type Invoker = (this: unknown, ...args: unknown[]) => unknown;
type Factory = (name: string, types: (Converter | null)[], classType: object | null,
  invoke: Invoker, target: unknown) => Invoker;

function factory(source: string): Factory {
  // Helpers retain upstream semantics. The glue itself executes as an ES module;
  // only the upstream Function constructor escapes strict mode.
  return runInNewContext(`"use strict";
    var char_0=48,char_9=57;
    function makeLegalFunctionName(name){if(undefined===name){return "_unknown"}
      name=name.replace(/[^a-zA-Z0-9_]/g,"$");var f=name.charCodeAt(0);
      if(f>=char_0&&f<=char_9){return "_"+name}return name}
    function throwBindingError(message){throw new Error(message)}
    function runDestructors(destructors){while(destructors.length){var ptr=destructors.pop();var del=destructors.pop();del(ptr)}}
    function new_(constructor,args){return Reflect.construct(constructor,args)}
    ${source}; craftInvokerFunction;
  `) as Factory;
}

type Failure = 'none' | 'this' | 'argument' | 'native' | 'destructor' | 'return';
interface Scenario {
  method: boolean;
  stack: boolean;
  returns: boolean;
  failure: Failure;
  receiver?: unknown;
  wrongArity?: boolean;
  mutate?: boolean;
  nullDestructors?: boolean;
}
function observe(make: Factory, scenario: Scenario) {
  const events: unknown[] = [];
  function converter(name: string, dynamic: boolean): Converter {
    const destructor: Destructor = function (this: unknown, value) {
      events.push(['destroy', name, value, this === undefined]);
      if (scenario.failure === 'destructor') throw new Error('destructor failure');
    };
    return {
      name,
      destructorFunction: dynamic ? undefined : scenario.nullDestructors ? null : destructor,
      toWireType(stack, value) {
        const receiver = name === 'this';
        events.push(['convert', name, this.name,
          receiver ? Object.prototype.toString.call(value) : value, stack === null]);
        if ((scenario.failure === 'this' && receiver)
          || (scenario.failure === 'argument' && name === 'arg1')) throw new Error(`${name} failure`);
        const wire = `${name}-wire`;
        if (stack) stack.push(destructor, wire);
        return wire;
      },
      fromWireType(value) {
        events.push(['return', this.name, value]);
        if (scenario.failure === 'return') throw new Error('return failure');
        return { converted: value };
      },
    };
  }
  const ret = converter(scenario.returns ? 'result' : 'void', false);
  const receiver = scenario.method ? converter('this', scenario.stack) : null;
  const arg0 = converter('arg0', scenario.stack);
  const arg1 = converter('arg1', false);
  const types = [ret, receiver, arg0, arg1];
  const fn = make('9 Test::call', types, scenario.method ? {} : null,
    function (this: unknown, ...args) {
      events.push(['invoke', this === undefined, ...args]);
      if (scenario.failure === 'native') throw new Error('native failure');
      return 123;
    }, 456);
  if (scenario.mutate) {
    // Type slots and destructor values were captured at registration, but
    // converter methods are resolved on the captured objects at call time.
    types[2] = converter('replacement', false);
    arg0.destructorFunction = () => { throw new Error('new destructor must not run'); };
    arg0.toWireType = function (stack, value) {
      events.push(['updated converter', this.name, value, stack === null]);
      return 'updated-wire';
    };
    ret.name = 'changed name';
  }
  let value: unknown;
  let error: string | undefined;
  try {
    value = Reflect.apply(fn, Object.hasOwn(scenario, 'receiver') ? scenario.receiver : { receiver: true },
      scenario.wrongArity ? [10] : [10, 20]);
  } catch (caught) {
    error = String(caught);
  }
  return { events, value, error, name: fn.name, length: fn.length,
    constructible: Object.hasOwn(fn, 'prototype'),
    nameDescriptor: Object.getOwnPropertyDescriptor(fn, 'name'),
    lengthDescriptor: Object.getOwnPropertyDescriptor(fn, 'length') };
}

const scenarios: Scenario[] = [
  { method: false, stack: false, returns: true, failure: 'none' },
  { method: true, stack: false, returns: true, failure: 'none', nullDestructors: true },
  { method: true, stack: false, returns: true, failure: 'none' },
  { method: true, stack: true, returns: false, failure: 'none' },
  { method: false, stack: true, returns: true, failure: 'none' },
  { method: true, stack: false, returns: true, failure: 'none', receiver: 7 },
  { method: true, stack: false, returns: true, failure: 'none', receiver: null },
  { method: true, stack: false, returns: true, failure: 'none', receiver: undefined },
  { method: true, stack: true, returns: true, failure: 'this' },
  { method: true, stack: true, returns: true, failure: 'argument' },
  { method: false, stack: false, returns: true, failure: 'native' },
  { method: true, stack: true, returns: true, failure: 'native' },
  { method: true, stack: false, returns: true, failure: 'destructor' },
  { method: true, stack: true, returns: true, failure: 'destructor' },
  { method: false, stack: true, returns: true, failure: 'return' },
  { method: true, stack: false, returns: true, failure: 'none', wrongArity: true },
  { method: true, stack: false, returns: true, failure: 'none', mutate: true },
];

describe('eager invoker compatibility with the pinned upstream generator', () => {
  it('loads the exact patched dependency and the exact upstream oracle', () => {
    expect(createHash('sha256').update(glue).digest('hex')).toBe(patchedGlueSha);
    expect(createHash('sha256').update(upstreamSource).digest('hex')).toBe(originalFunctionSha);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
  });

  it.each(scenarios)('retains conversion, invocation and exceptional cleanup: %j', (scenario) => {
    expect(observe(factory(installedSource), scenario)).toEqual(observe(factory(upstreamSource), scenario));
  });

  it('keeps free-function zero-argument void returns and rejects invalid type arrays', () => {
    for (const source of [upstreamSource, installedSource]) {
      const make = factory(source);
      expect(() => make('invalid', [], null, () => undefined, 0)).toThrow(/argTypes array size mismatch/);
      const ret: Converter = { name: 'void', destructorFunction: null,
        toWireType: () => undefined, fromWireType: () => { throw new Error('void conversion'); } };
      const fn = make('zero', [ret, null], null, () => 123, 0);
      expect(fn()).toBeUndefined();
      expect(fn.length).toBe(0);
    }
  });
});

const namedBegin = glue.indexOf('function createNamedFunction(');
const namedEnd = glue.indexOf('function extendError(', namedBegin);
const legalBegin = glue.indexOf('function makeLegalFunctionName(');
const legalEnd = glue.indexOf('function createNamedFunction(', legalBegin);
const originalNamedSource = "function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function(\"body\",\"return function \"+name+\"() {\\n\"+'    \"use strict\";'+\"    return body.apply(this, arguments);\\n\"+\"};\\n\")(body)}";

function namedFactory(source: string): (name: string | undefined, body: Invoker) => Invoker {
  return runInNewContext(`var char_0=48,char_9=57;${glue.slice(legalBegin, legalEnd)}${source};createNamedFunction`) as
    (name: string | undefined, body: Invoker) => Invoker;
}

describe('installed named wrapper preserves the original public calling contract', () => {
  it('retains strict receivers, arguments, returns and thrown identity', () => {
    for (const source of [originalNamedSource, glue.slice(namedBegin, namedEnd)]) {
      const make = namedFactory(source);
      const fn = make('9 Test::call', function (this: unknown, ...args: unknown[]) { return [this, args]; });
      for (const receiver of [undefined, null, 7, 'text', true, {}]) {
        const observed: unknown = Reflect.apply(fn, receiver, [1, 2]);
        expect(observed).toEqual([receiver, [1, 2]]);
      }
      expect(fn()).toEqual([undefined, []]);
      const failure = new Error('body failure');
      let caught: unknown;
      try { make('failure', () => { throw failure; })(); } catch (error: unknown) { caught = error; }
      expect(caught).toBe(failure);
      expect(fn.name).toBe('_9$Test$$call');
      expect(fn.length).toBe(0);
      expect(Object.getOwnPropertyDescriptor(fn, 'name')).toEqual({ value: fn.name, writable: false, enumerable: false, configurable: true });
      expect(make(undefined, () => undefined).name).toBe('_unknown');
    }
  });

  it('retains independent prototypes and ordinary constructor return rules', () => {
    for (const source of [originalNamedSource, glue.slice(namedBegin, namedEnd)]) {
      const make = namedFactory(source);
      const first = make('First', () => 7);
      const second = make('Second', () => undefined);
      const firstPrototype: unknown = Object.getOwnPropertyDescriptor(first, 'prototype')?.value;
      const secondPrototype: unknown = Object.getOwnPropertyDescriptor(second, 'prototype')?.value;
      expect(firstPrototype).not.toBe(secondPrototype);
      if (typeof firstPrototype !== 'object' || firstPrototype === null) throw new Error('Missing prototype');
      expect(Reflect.get(firstPrototype, 'constructor')).toBe(first);
      expect(Object.getPrototypeOf(Reflect.construct(first, []))).toBe(firstPrototype);
      const returned = {};
      expect(Reflect.construct(make('ReturnsObject', () => returned), [])).toBe(returned);
    }
    expect(glue).not.toContain('new Function(');
  });
});
