import { LINEAR_DEFINITIONS, STATISTICS_DEFINITIONS, TENSOR_DEFINITIONS, INTEGER_DEFINITIONS } from './mathOperationMetadata.js';
/** The editor's positive LaTeX grammar is separate from evaluation and persistent ASTs. */
import {LatexSyntax,LATEX_DICTIONARY,type MathJsonExpression} from '@cortex-js/compute-engine/latex-syntax';
import {MathInputProblem,validateMathSource} from './mathInputContract.js';
import type {DisplayMathJson} from './mathNotationConversion.js';
import {CANDIDATE_MATH_OPERATIONS} from './mathOperations.js';

function mutableDisplayJson(value:DisplayMathJson):MathJsonExpression {
  if(typeof value==='string')return value;
  if('num' in value)return {num:value.num};
  if('str' in value)return {str:value.str};
  return [value[0],...value.slice(1).map(mutableDisplayJson)];
}

export function createMathLatexCodec():{
  readonly parse:(source:string)=>unknown;
  readonly serialize:(expression:DisplayMathJson)=>string;
} {
  const replaced=new Set([String.raw`\cdot`,String.raw`\times`,String.raw`\log`,String.raw`\otimes`,String.raw`\odot`]);
  const explicitHeads=new Set<string>([...STATISTICS_DEFINITIONS,...LINEAR_DEFINITIONS,...TENSOR_DEFINITIONS,...INTEGER_DEFINITIONS].map(([,head])=>head));
  const dictionary=LATEX_DICTIONARY.filter(entry=>{
    // Keep application arities and explicit list arguments for statistics and linear
    // algebra unchanged through text/LaTeX conversion, independently of engine display rules.
    if(entry.name!==undefined&&explicitHeads.has(entry.name))return false;
    if(!('latexTrigger' in entry))return true;
    const trigger=entry.latexTrigger;
    return !replaced.has(typeof trigger==='string'?trigger:Array.isArray(trigger)?trigger.join(''):'');
  });
  const extraFunctions=[...CANDIDATE_MATH_OPERATIONS.values()].filter(operation=>!operation.structural
    && !dictionary.some(entry=>entry.name===operation.engineHead) && !['PcadCoefficient','Rank','Log','TensorProduct','HadamardProduct'].includes(operation.engineHead))
    .map(operation=>({kind:'function' as const,name:operation.engineHead,symbolTrigger:operation.engineHead.toLowerCase()}));
  const syntax=new LatexSyntax({dictionary:[...dictionary,...extraFunctions,
    {kind:'infix',name:'TensorProduct',latexTrigger:String.raw`\otimes`,precedence:390,associativity:'left'},
    {kind:'infix',name:'HadamardProduct',latexTrigger:String.raw`\odot`,precedence:390,associativity:'left'},
    // Parse-only synonyms keep one serializer per name, while accepting both operator and function notation.
    {kind:'function',symbolTrigger:'tensorproduct',parse:parser=>{
      const args=parser.parseArguments('enclosure');return args===null?'TensorProduct':['TensorProduct',...args];
    }},
    {kind:'function',symbolTrigger:'hadamardproduct',parse:parser=>{
      const args=parser.parseArguments('enclosure');return args===null?'HadamardProduct':['HadamardProduct',...args];
    }},
    {kind:'function',symbolTrigger:'arccot',parse:parser=>{
      const args=parser.parseArguments('enclosure');return args===null?'Arccot':['Arccot',...args];
    }},
    {kind:'function',symbolTrigger:'arctan2',parse:parser=>{
      const args=parser.parseArguments('enclosure');return args===null?'Arctan2':['Arctan2',...args];
    }},
    {kind:'infix',name:'PcadDotToken',latexTrigger:String.raw`\cdot`,precedence:390,associativity:'left'},
    {kind:'infix',name:'PcadTimesToken',latexTrigger:String.raw`\times`,precedence:390,associativity:'left'},
    {kind:'function',name:'PcadCoefficient',symbolTrigger:'coef'},
    {kind:'function',name:'Rank',symbolTrigger:'rank'},
    {kind:'function',name:'Log',latexTrigger:String.raw`\log`,serialize:(serializer,expression)=>{
      if(!Array.isArray(expression)||expression.length!==3)throw new MathInputProblem('syntax','対数の底を表示できません。');
      const values:readonly MathJsonExpression[]=expression;
      return String.raw`\log_{`+serializer.serialize(values[2])+String.raw`}\left(`+serializer.serialize(values[1])+String.raw`\right)`;
    },parse:parser=>{
      // The upstream parser erases an explicit base 10, making it indistinguishable from unspecified log.
      // Read the base before that normalization so the stored expression retains the user's choice.
      if(!parser.match('_'))throw new MathInputProblem('syntax','対数は底を指定してください。自然対数はlnを使えます。');
      const base=parser.parseGroup()??parser.parseToken();
      const args=parser.parseArguments('implicit'),argument=args?.[0];
      if(base===null||argument===undefined||args?.length!==1)throw new MathInputProblem('syntax','対数の底と真数を1つずつ指定してください。');
      return ['Log',argument,base];
    }},
  ]});
  return {
    parse:source=>{validateMathSource(source);return syntax.parse(source);},
    serialize:expression=>{
      // The default nested-root style becomes a fractional power. Keep the
      // user's root operation intact at every depth for the semantic round trip.
      const source=syntax.serialize(mutableDisplayJson(expression),{prettify:false,fractionalDigits:'max',rootStyle:'radical'});
      validateMathSource(source);return source;
    },
  };
}
