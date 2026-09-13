/** A direction attached to a point follows that point's defining choice, including later edits. */
import type {PartDocument} from '../part/types.js';
import {evaluatedDocumentMathValue} from '../part/evaluateDocumentMath.js';
import type {FunctionPointReference} from './functionPointReference.js';

export function functionDirectionSource(document:PartDocument,reference:FunctionPointReference,ownerId:string,
  ownerSketch:{readonly id:string;readonly index:number}|undefined,invalid:ReadonlyMap<string,string>):FunctionPointReference {
  const pointId=reference.direction?.sourcePointId;if(pointId===undefined)return reference;
  const sourceSketch=document.sketches.find(sketch=>sketch.features.some(feature=>feature.id===pointId));
  const index=sourceSketch?.features.findIndex(feature=>feature.id===pointId)??-1,point=sourceSketch?.features[index];
  if(!sourceSketch||point?.kind!=='point'||point.id===ownerId||invalid.has(pointId)
    ||(ownerSketch?.id===sourceSketch.id&&index>=ownerSketch.index)||point.at.mode!=='relative'
    ||point.at.base.kind!=='functionPoint'||point.at.base.direction!==undefined){
    throw new Error('接線・法線の起点には、この線より前に作成した関数上の点を選んでください。');
  }
  for(const offset of [point.at.dx,point.at.dy,point.at.dz]){
    const value=evaluatedDocumentMathValue(document,offset);
    if(value===null||value.value!==0)throw new Error('起点が関数から移動しています。関数上の点を選び直してください。');
  }
  return point.at.base;
}
