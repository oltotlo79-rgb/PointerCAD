/** Browser-only adapter. The expression package remains independent of DOM types. */
import type {MathWorkerPort} from '@pointercad/expression/math/client';
/** Initial module/backend loading took about 6.5s under load before a 13ms result.
 * Keep a finite 15s first-request allowance; warm calculations retain their caller deadline.
 */
export const MATH_WORKER_STARTUP_TIMEOUT_MS = 15_000;
export function browserMathWorker(worker:Worker):MathWorkerPort {
  let terminated=false, received=false, retire=false;
  const port:MathWorkerPort={onmessage:null,onerror:null,onmessageerror:null,
    get startupTimeoutMs(){return received ? 0 : MATH_WORKER_STARTUP_TIMEOUT_MS;},
    get retireAfterReply(){return retire;},
    postMessage(value){if(terminated)throw new Error('Math Worker is closed');worker.postMessage(value);},
    terminate(){
      if(terminated)return;terminated=true;
      worker.removeEventListener('message',message);worker.removeEventListener('error',error);worker.removeEventListener('messageerror',messageerror);
      port.onmessage=null;port.onerror=null;port.onmessageerror=null;worker.terminate();
    },
  };
  function message(event:MessageEvent<unknown>):void{
    if(terminated)return;
    const value=event.data;
    if(value!==null&&typeof value==='object'&&!Array.isArray(value)
      &&Object.keys(value).length===1&&'kind' in value&&value.kind==='math-worker-retire') {
      retire=true;return;
    }
    received=true;port.onmessage?.({data:value});
  }
  function error(event:ErrorEvent):void{if(!terminated)port.onerror?.({preventDefault:()=>event.preventDefault()});}
  function messageerror():void{if(!terminated)port.onmessageerror?.();}
  worker.addEventListener('message',message);worker.addEventListener('error',error);worker.addEventListener('messageerror',messageerror);
  return port;
}

export function createBrowserMathWorker(): MathWorkerPort {
  return browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }));
}
