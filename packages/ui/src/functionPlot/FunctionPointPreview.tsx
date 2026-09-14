import {useEffect,useRef,useState} from 'react';
import type {SolidBody,ResolvedSpline,Vec3} from '@pointercad/model';
import type {PointCalculationCandidate} from '@pointercad/expression/math/contracts';
import {useFunctionPreviewFocus} from './useFunctionPreviewFocus.js';
import {t} from '../i18n/t.js';
import {createFunctionPointPreviewProjection} from './functionPreviewProjection.js';
import {drawFunctionCurve} from './drawFunctionCurve.js';

const initialRotation={yaw:-Math.PI/4,pitch:0.6};
/** Show the existing CAD geometry and explicit candidate buttons without changing the document. */
export function FunctionPointPreview({minimum,maximum,body,curves,candidates,selected,onSelect,direction}:{
  readonly minimum:Vec3;readonly maximum:Vec3;readonly body?:SolidBody;readonly curves:readonly ResolvedSpline[];
  readonly candidates:readonly PointCalculationCandidate[];readonly selected:PointCalculationCandidate|null;
  readonly onSelect:(candidate:PointCalculationCandidate)=>void;
  readonly direction?:{readonly from:Vec3;readonly to:Vec3};
}):React.JSX.Element {
  const canvas=useRef<HTMLCanvasElement>(null),figure=useFunctionPreviewFocus();
  const drag=useRef<{x:number;y:number}|null>(null),[rotation,setRotation]=useState(initialRotation);
  const [size,setSize]=useState({width:1,height:1});
  const project=createFunctionPointPreviewProjection(minimum,maximum,rotation);
  useEffect(()=>{
    const element=canvas.current,context=element?.getContext('2d');if(!element||!context)return;
    const projection=createFunctionPointPreviewProjection(minimum,maximum,rotation);
    const draw=()=>{
      const size=element.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
      const project=(point:Vec3):readonly [number,number]=>{
        const [x,y]=projection(point,size.width,size.height);return [x*ratio,y*ratio];
      };
      element.width=Math.max(1,Math.round(size.width*ratio));element.height=Math.max(1,Math.round(size.height*ratio));
      setSize(previous=>previous.width===size.width&&previous.height===size.height?previous:{width:size.width,height:size.height});
      context.clearRect(0,0,element.width,element.height);context.strokeStyle=getComputedStyle(element).color;context.lineWidth=ratio;
      const corners:Vec3[]=Array.from({length:8},(_,bits)=>[bits&1?maximum[0]:minimum[0],bits&2?maximum[1]:minimum[1],bits&4?maximum[2]:minimum[2]]);
      context.globalAlpha=0.25;context.beginPath();corners.forEach((corner,index)=>{for(const bit of [1,2,4])if(!(index&bit)){
        context.moveTo(...project(corner));context.lineTo(...project(corners[index|bit]));
      }});context.stroke();context.globalAlpha=0.45;context.beginPath();
      if(body){
        const {positions,indices}=body.mesh;
        const vertex=(index:number):Vec3=>[positions[index*3],positions[index*3+1],positions[index*3+2]];
        for(let index=0;index<indices.length;index+=3){
          context.moveTo(...project(vertex(indices[index])));context.lineTo(...project(vertex(indices[index+1])));
          context.lineTo(...project(vertex(indices[index+2])));context.closePath();
        }
      }
      for(const curve of curves)drawFunctionCurve(context,curve,project);
      context.stroke();
      // Keep every axis name outside the candidate buttons, including when an
      // axis corner projects onto the centre of the box. Leaders retain its meaning.
      context.globalAlpha=0.35;context.beginPath();
      for(const [index,corner]of [corners[1],corners[2],corners[4]].entries()) {
        context.moveTo(...project(corner));
        context.lineTo((size.width-30)*ratio,size.height*(index+1)/4*ratio);
      }
      context.stroke();context.globalAlpha=1;context.fillStyle=context.strokeStyle;
      if(direction){
        const from=project(direction.from),to=project(direction.to),angle=Math.atan2(to[1]-from[1],to[0]-from[0]);
        context.lineWidth=3*ratio;context.beginPath();context.moveTo(...from);context.lineTo(...to);
        for(const turn of [-0.45,0.45]){context.moveTo(...to);context.lineTo(to[0]-12*ratio*Math.cos(angle+turn),to[1]-12*ratio*Math.sin(angle+turn));}
        context.stroke();context.beginPath();context.arc(from[0],from[1],4*ratio,0,2*Math.PI);context.fill();
      }
    };
    const resize=new ResizeObserver(draw);resize.observe(element);draw();return()=>resize.disconnect();
  },[minimum,maximum,body,curves,rotation,direction]);
  return <figure ref={figure} className="pcad-function-preview">
    <div className="pcad-function-point-preview">
      <canvas ref={canvas} aria-label={t(direction?'functionDirection.result':'functionPoint.preview')} onPointerDown={event=>{
        drag.current={x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event=>{
        const previous=drag.current;if(!previous)return;
        const dx=event.clientX-previous.x,dy=event.clientY-previous.y;drag.current={x:event.clientX,y:event.clientY};
        setRotation(value=>({yaw:value.yaw+dx*0.01,pitch:Math.max(-Math.PI/2,Math.min(Math.PI/2,value.pitch+dy*0.01))}));
      }} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}/>
      {['X','Y','Z'].map((axis,index)=><span key={axis} className="pcad-function-axis-label"
        style={{left:size.width-20,top:size.height*(index+1)/4}}>{axis}</span>)}
      {candidates.map((candidate,index)=>{
        const [left,top]=project(candidate.point,size.width,size.height);
        return <button type="button" className="pcad-function-point-marker" key={index} aria-pressed={selected===candidate}
          aria-label={`${t('functionPoint.candidate')} ${index+1}: ${candidate.point.map((value,axis)=>`${['X','Y','Z'][axis]}=${value}`).join(', ')}`}
          style={{left,top}} onClick={()=>onSelect(candidate)}>{index+1}</button>;
      })}
    </div>
    <figcaption>{t(direction?'functionDirection.previewHint':'functionPoint.previewHint')}</figcaption>
    <button type="button" onClick={()=>setRotation(initialRotation)}>{t('functionPlot.resetView')}</button>
  </figure>;
}
