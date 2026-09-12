import {expect,type Page} from '@playwright/test';

/** Retain the real request until the test releases it. No timing guess or synthetic geometry response. */
export async function installDrawingRefreshHold(page:Page):Promise<void> {
  await page.addInitScript(()=>{
    const original=Worker.prototype.postMessage;
    let armed=false;
    const pending:(()=>void)[]=[];
    Object.defineProperty(window,'pcadDrawingRefreshHold',{configurable:true,value:{
      arm:()=>{if(armed||pending.length>0)throw new Error('Drawing hold already active');armed=true;},
      count:()=>pending.length,
      release:()=>{armed=false;for(const send of pending.splice(0))send();},
    }});
    Worker.prototype.postMessage=function(this:Worker,message:unknown,options?:Transferable[]|StructuredSerializeOptions):void {
      const path:unknown=message!==null&&typeof message==='object'?Reflect.get(message,'path'):undefined;
      const send=()=>Reflect.apply(original,this,options===undefined?[message]:[message,options]);
      if(armed&&Array.isArray(path)&&path.length===1&&path[0]==='checkShapeAvailability')pending.push(send);
      else send();
    };
  });
}
export async function controlDrawingRefresh(page:Page,action:'arm'|'release'):Promise<void> {
  await page.evaluate(action=>{
    const hold:unknown=Reflect.get(window,'pcadDrawingRefreshHold');
    const method:unknown=hold!==null&&typeof hold==='object'?Reflect.get(hold,action):undefined;
    if(typeof method!=='function')throw new Error('Drawing refresh control missing');
    Reflect.apply(method,hold,[]);
  },action);
}
export async function expectDrawingRefreshHeld(page:Page):Promise<void> {
  await expect.poll(()=>page.evaluate(()=>{
    const hold:unknown=Reflect.get(window,'pcadDrawingRefreshHold');
    const count:unknown=hold!==null&&typeof hold==='object'?Reflect.get(hold,'count'):undefined;
    if(typeof count!=='function')throw new Error('Drawing refresh control missing');
    return Reflect.apply(count,hold,[]) as number;
  })).toBeGreaterThan(0);
}
