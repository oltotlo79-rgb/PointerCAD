import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {FemClient,type FemWorkerPort} from './client.js';
import {FEM_PROTOCOL,isRequest,type FemRequest} from './protocol.js';
import {NATIVE_BOLT_KIND,prepareNativeBoltPreloadJob,readNativeBoltPreloadWireInput} from './nativeBoltPreloadBinding.js';
import {decodeNativeBoltPreload} from './nativeBoltPreload.js';
import {analyzeNativeBoltPreloadInBrowser} from './offlineBrowser.js';
const input:unknown=JSON.parse(readFileSync(new URL('./nativeBoltPreload.input.fixture.json',import.meta.url),'utf8'));
const raw:unknown=JSON.parse(readFileSync(new URL('./nativeBoltPreload.result.fixture.json',import.meta.url),'utf8'));
if(raw===null||typeof raw!=='object'||!('result'in raw)||raw.result===null||typeof raw.result!=='object')throw Error('Invalid fixed raw');
const numeric=raw.result;
const source={documentId:'explicit-numeric-owner',revision:2};
async function owned(plan:unknown,owner=source){
 const job=await prepareNativeBoltPreloadJob({source:owner,plan});
 // Controlled gateway changes only the digest of the same semantic numeric plan's canonical wire bytes.
 return {...decodeNativeBoltPreload({...numeric,planSha256:job.prepared.inputSha256},job.prepared),kind:NATIVE_BOLT_KIND,source:owner};
}
function fixture(){
 let post:(v:FemRequest)=>void=()=>{throw Error('Not initialized');};
 const posted=new Promise<FemRequest>(resolve=>{post=resolve;});
 const terminate=vi.fn();
 const port:FemWorkerPort={postMessage:vi.fn((v:FemRequest)=>post(v)),terminate,onmessage:null,onerror:null,onmessageerror:null};
 const create=vi.fn(()=>port);return {client:new FemClient(create),port,create,posted,terminate};
}
function reply(port:FemWorkerPort,data:unknown){port.onmessage?.(new MessageEvent<unknown>('message',{data}));}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('own Worker connection candidate: controlled ports, no native assembly',()=>{
 it('admits only an exactly owned wire envelope; Worker full validation refuses unsupported physics before assets',async()=>{
  expect(()=>readNativeBoltPreloadWireInput({source,plan:input,prepared:{}})).toThrow();
  expect(isRequest({protocol:FEM_PROTOCOL,kind:'analyze-native-bolt-preload',identity:{...source,generation:1,requestId:'x'},input:{source,plan:input}})).toBe(true);
  expect(isRequest({protocol:FEM_PROTOCOL,kind:'analyze-native-bolt-preload',identity:{...source,revision:3,generation:1,requestId:'x'},input:{source,plan:input}})).toBe(false);
  const phase=vi.fn();await expect(analyzeNativeBoltPreloadInBrowser({source,plan:{schema:'unsupported'}},phase)).rejects.toThrow('native-preload-input:');expect(phase).not.toHaveBeenCalled();
 });
 it('sends plain plan data, decodes a distinct result kind and retains all original identity fields',async()=>{
  const f=fixture(),completion=f.client.analyzeNativeBoltPreload({source,plan:input}),request=await f.posted;
  if(request.kind!=='analyze-native-bolt-preload')throw Error('Wrong request');
  expect(Object.keys(request.input).sort()).toEqual(['plan','source']);expect(JSON.stringify(request)).not.toContain('prepared');
  const result=await owned(request.input.plan,request.input.source);reply(f.port,{protocol:FEM_PROTOCOL,kind:'result',identity:request.identity,result});
  const done=await completion;expect(done.kind).toBe('result');if(done.kind!=='result')throw Error('Expected result');
  expect(done.result.kind).toBe(NATIVE_BOLT_KIND);expect(done.result.states[1].boltTensionN).toBeCloseTo(4200,8);expect(f.create).toHaveBeenCalledTimes(1);expect(f.terminate).toHaveBeenCalledTimes(1);
 });
 it('refuses a foreign revision instead of accepting a numerically valid reply',async()=>{
  const f=fixture(),completion=f.client.analyzeNativeBoltPreload({source,plan:input}),request=await f.posted;
  reply(f.port,{protocol:FEM_PROTOCOL,kind:'result',identity:{...request.identity,revision:3},result:await owned(input)});
  expect(await completion).toMatchObject({kind:'failed',failure:{code:'invalid-protocol'}});
 });
 it('aborts the owner and ignores a captured late valid reply',async()=>{
  const f=fixture(),controller=new AbortController(),completion=f.client.analyzeNativeBoltPreload({source,plan:input},{signal:controller.signal}),request=await f.posted;
  const late=f.port.onmessage;controller.abort();expect(await completion).toMatchObject({kind:'cancelled',reason:'abort'});
  late?.(new MessageEvent('message',{data:{protocol:FEM_PROTOCOL,kind:'result',identity:request.identity,result:await owned(input)}}));
  expect(f.terminate).toHaveBeenCalledTimes(1);
 });
 it('cannot let asynchronous preparation supersede a newer request',async()=>{
  const f=fixture(),first=f.client.analyzeNativeBoltPreload({source,plan:input});
  const nextSource={...source,revision:3},second=f.client.analyzeNativeBoltPreload({source:nextSource,plan:input}),request=await f.posted;
  expect(await first).toMatchObject({kind:'cancelled',reason:'superseded'});expect(request.identity.revision).toBe(3);expect(f.create).toHaveBeenCalledTimes(1);
  reply(f.port,{protocol:FEM_PROTOCOL,kind:'result',identity:request.identity,result:await owned(input,nextSource)});expect(await second).toMatchObject({kind:'result'});
 });
 it('preserves the existing 60000ms solve deadline with fake time',async()=>{
  vi.useFakeTimers();const f=fixture(),completion=f.client.analyzeNativeBoltPreload({source,plan:input}),request=await f.posted;
  reply(f.port,{protocol:FEM_PROTOCOL,kind:'phase',identity:request.identity,phase:'solving'});
  await vi.advanceTimersByTimeAsync(60000);expect(await completion).toMatchObject({kind:'failed',failure:{code:'deadline'}});
 });
});
