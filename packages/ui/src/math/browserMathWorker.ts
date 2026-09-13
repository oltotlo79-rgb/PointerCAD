/** Browser-only adapter. The expression package remains independent of DOM types. */
import type {MathWorkerPort} from '@pointercad/expression/math/client';
export function browserMathWorker(worker:Worker):MathWorkerPort {
  let terminated=false;
  const port:MathWorkerPort={onmessage:null,onerror:null,onmessageerror:null,
    postMessage(value){if(terminated)throw new Error('Math Worker is closed');worker.postMessage(value);},
    terminate(){
      if(terminated)return;terminated=true;
      worker.removeEventListener('message',message);worker.removeEventListener('error',error);worker.removeEventListener('messageerror',messageerror);
      port.onmessage=null;port.onerror=null;port.onmessageerror=null;worker.terminate();
    },
  };
  function message(event:MessageEvent<unknown>):void{if(!terminated)port.onmessage?.({data:event.data});}
  function error(event:ErrorEvent):void{if(!terminated)port.onerror?.({preventDefault:()=>event.preventDefault()});}
  function messageerror():void{if(!terminated)port.onmessageerror?.();}
  worker.addEventListener('message',message);worker.addEventListener('error',error);worker.addEventListener('messageerror',messageerror);
  return port;
}

export function createBrowserMathWorker(): MathWorkerPort {
  return browserMathWorker(new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }));
}
