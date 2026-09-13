/** Function points retain the selected branch's defining input, never cached XYZ output. */
import {readFunctionPointChoice,type FunctionPointReference,type FunctionPointParent} from '@pointercad/model';
import {type Checked,checkRecord,fieldProblem,joinPath,readArray,readExpression,readLiteral,readRecord,readString} from '../guards.js';
import {serializeExpression} from './fields.js';

function readParent(source:Record<string,unknown>,path:string):Checked<FunctionPointParent> {
  const record=readRecord(source,'parent',path); if(!record.ok) return record;
  const at=joinPath(path,'parent'),parent=record.value;
  const kind=readLiteral(parent,'kind',at,['curve','surface']); if(!kind.ok) return kind;
  const featureId=readString(parent,'featureId',at); if(!featureId.ok) return featureId;
  if(featureId.value.length===0 || featureId.value.length>256) return fieldProblem(joinPath(at,'featureId'),'type');
  const keys=kind.value==='curve'?['kind','featureId','sketchId']:['kind','featureId'];
  if(Object.keys(parent).some(key=>!keys.includes(key))) return fieldProblem(at,'type');
  if(kind.value==='surface') return {ok:true,value:{kind:'surface',featureId:featureId.value}};
  const sketchId=readString(parent,'sketchId',at); if(!sketchId.ok) return sketchId;
  if(sketchId.value.length===0 || sketchId.value.length>256) return fieldProblem(joinPath(at,'sketchId'),'type');
  return {ok:true,value:{kind:'curve',sketchId:sketchId.value,featureId:featureId.value}};
}

export function readFunctionPointReference(record:Record<string,unknown>,path:string):Checked<FunctionPointReference> {
  if(record['kind']!=='functionPoint' || Object.keys(record).some(key=>!['kind','parent','known','choice','direction'].includes(key))) return fieldProblem(path,'type');
  const parent=readParent(record,path); if(!parent.ok) return parent;
  const list=readArray(record,'known',path); if(!list.ok) return list;
  if(list.value.length<1 || list.value.length>2) return fieldProblem(joinPath(path,'known'),'type');
  const known:FunctionPointReference['known'][number][]=[];
  for(let index=0;index<list.value.length;index++) {
    const at=`${joinPath(path,'known')}[${index}]`,item=checkRecord(list.value[index],at); if(!item.ok) return item;
    if(Object.keys(item.value).some(key=>!['axis','value'].includes(key))) return fieldProblem(at,'type');
    const axis=readLiteral(item.value,'axis',at,['X','Y','Z']); if(!axis.ok) return axis;
    const value=readExpression(item.value,'value',at); if(!value.ok) return value;
    if(known.some(existing=>existing.axis===axis.value)) return fieldProblem(joinPath(at,'axis'),'type');
    known.push({axis:axis.value,value:value.value});
  }
  try {
    const choice=readFunctionPointChoice(record['choice']);
    if(choice.input.known.length!==known.length || known.some(item=>!choice.input.known.some(previous=>previous.axis===item.axis))) {
      return fieldProblem(joinPath(path,'choice'),'type');
    }
    let direction:FunctionPointReference['direction'];
    if(Object.hasOwn(record,'direction')){
      const data=readRecord(record,'direction',path);if(!data.ok)return data;
      const at=joinPath(path,'direction'),raw=data.value;
      if(Object.keys(raw).some(key=>!['kind','length','reverse','sourcePointId'].includes(key)))return fieldProblem(at,'type');
      const length=readExpression(raw,'length',at);if(!length.ok)return length;
      const kind=readLiteral(raw,'kind',at,['tangent','normal','tangent-u','tangent-v']);if(!kind.ok)return kind;
      if(!Number.isFinite(length.value.value)||length.value.value<=0)return fieldProblem(joinPath(at,'length'),'type');
      const reverse=raw['reverse'];if(typeof reverse!=='boolean')return fieldProblem(joinPath(at,'reverse'),'type');
      let sourcePointId:string|undefined;
      if(Object.hasOwn(raw,'sourcePointId')){
        const source=readString(raw,'sourcePointId',at);if(!source.ok)return source;
        if(source.value.length===0||source.value.length>256)return fieldProblem(joinPath(at,'sourcePointId'),'type');
        sourcePointId=source.value;
      }
      direction={kind:kind.value,reverse,length:length.value,...(sourcePointId?{sourcePointId}:{})};
    }
    return {ok:true,value:{kind:'functionPoint',parent:parent.value,known,choice,...(direction?{direction}:{})}};
  } catch {return fieldProblem(joinPath(path,'choice'),'type');}
}

export function serializeFunctionPointReference(reference:FunctionPointReference):FunctionPointReference {
  const result=readFunctionPointReference({kind:'functionPoint',parent:reference.parent,
    known:reference.known.map(item=>({axis:item.axis,value:serializeExpression(item.value)})),choice:reference.choice,
    ...(reference.direction?{direction:{...reference.direction,length:serializeExpression(reference.direction.length)}}:{})},'functionPoint');
  if(!result.ok) throw new Error('関数上の点の参照と選択条件を保存できません。');
  return result.value;
}
