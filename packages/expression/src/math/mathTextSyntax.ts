import { EQUATION_DEFINITIONS } from './equationSolutions.js';
import { INTEGRAL_TRANSFORM_DEFINITIONS } from './integralTransforms.js';
/** Explicit plain-text math. Never infer a multiplication, a coefficient, or a function call from adjacency. */
import { TAYLOR_DEFINITIONS } from './taylorExpansion.js';
import { SEQUENCE_DEFINITIONS } from './sequenceCalculations.js';
import {MathInputProblem,MATH_INPUT_LIMITS,validateMathSource,validateMathDecimal,type MathNode,type MathOperationDefinition} from './mathInputContract.js';
import {decodeMathJson,type DecodeMathOptions} from './decodeMathJson.js';
import {VECTOR_CALCULUS_AT_DEFINITIONS} from './vectorCalculusAt.js';
import {CLOSED_INTEGRAL_UNAVAILABLE,LINE_INTEGRAL_DEFINITIONS,closedIntegralHead} from './lineIntegrals.js';
import {REGION_INTEGRAL_DEFINITIONS} from './regionIntegrals.js';
import {GENERAL_PROBABILITY_DEFINITIONS} from './generalProbability.js';
import { differentialEquationNotation, derivativePrimeOrder, NABLA_DEFAULT_VARIABLES, NABLA_LAPLACIAN,
  NABLA_VARIABLE_LIST } from './differentialEquationNotation.js';
import type { ParsedMathJson } from './mathLatexTokens.js';
type Raw=ParsedMathJson;
/** Array.isArray needs an explicit predicate to narrow readonly recursive tuples. */
function isRawArray(value:Raw):value is readonly [string,...Raw[]] { return Array.isArray(value); }
/** A decimal written 0.1(6) carries its parenthesized repeating digits (MC-19c). */
interface Token {readonly kind:'number'|'name'|'string'|'operator'|'end';readonly text:string;readonly start:number;readonly repetend?:string}
// ∇_ and ∇²_ open a variable list; a lone ² stays unsupported elsewhere.
const OPERATORS=['∇²_','∇_','∇²','<=','>=','!=','<>','==','**','&&','!!'];
const SINGLE=new Set("+-−±∓*/×·⊗⊙÷^!%=<≤>≥≠≈∉⊂⊆⊃⊇∁⟨⟩∧∨¬()[],|√∛⌊⌋⌈⌉{}'′″‴⁗∇:");
/** Number notation shared with the structured-input reader (MC-19c, Q1=A). Messages omit the final 。 */
export const REPEATING_DECIMAL_FORM='循環小数は、小数点の後で繰り返す数字だけを括弧で囲んで指定してください（例 0.1(6)＝1/6、0.(3)＝1/3）';
export const REPEATING_DECIMAL_DIGITS=`循環小数の桁が多すぎます。整数部分・小数部分・繰り返す数字を合わせて${String(MATH_INPUT_LIMITS.literalDigits)}桁までにしてください`;
export const RATIO_TERMS='比は a:b のように2つの項で指定してください。3つ以上の項の比や時刻（例 1:30:00）には対応していません';
export const RATIO_TIME='比の項に先頭が0の数（例 12:05 の 05）は使えません。時刻には対応していないため、比は0を付けない数で指定してください';
export const RATIO_IN_LIST='一覧や集合の要素にそのまま書いた「:」は、範囲・区間や集合の条件（例 {x:x>0}）と区別できません。比の値は (1:2) のように括弧で囲み、区間は interval(a,b) で指定してください';
export const RATIO_DEFINITION='「:=」による定義はこの式では使えません。比は a:b、等式は a=b で指定してください';
/** a:b binds looser than + and −, tighter than = and <, so x+1:x-1 is (x+1)/(x-1) and 1:2=2:4 compares two values. */
const RATIO_BINDING=40;

/**
 * a.b(c) as the reduced fraction (abc − ab) / (10^|b|·(10^|c| − 1)); the value is never rounded.
 * The written digits share the 2048-digit limit of any other number literal.
 */
export function repeatingDecimalFraction(decimal:string,repetend:string):{readonly numerator:string;readonly denominator:string} {
  const [integer='',fraction='',...extra]=decimal.split('.');
  if(extra.length>0||!/^[0-9]*$/u.test(integer)||!/^[0-9]*$/u.test(fraction)||!/^[0-9]+$/u.test(repetend)) {
    throw new MathInputProblem('syntax',`${REPEATING_DECIMAL_FORM}。`);
  }
  if(integer.length+fraction.length+repetend.length>MATH_INPUT_LIMITS.literalDigits) {
    throw new MathInputProblem('budget',`${REPEATING_DECIMAL_DIGITS}。`);
  }
  const numerator=BigInt(integer+fraction+repetend)-BigInt(integer+fraction||'0');
  const denominator=10n**BigInt(fraction.length)*(10n**BigInt(repetend.length)-1n);
  let divisor=numerator,remainder=denominator;
  while(remainder!==0n){const next=divisor%remainder;divisor=remainder;remainder=next;}
  return {numerator:String(numerator/divisor),denominator:String(denominator/divisor)};
}
/** An integer literal written with a leading zero, such as 05 in 12:05, reads as clock time next to a colon. */
function clockDigits(text:string):boolean {return /^0[0-9]/u.test(text);}
function own<T>(values:Readonly<Record<string,T>>,key:string):T|undefined {return Object.hasOwn(values,key)?values[key]:undefined;}
function fail(message:string,position:number):never {throw new MathInputProblem('syntax',`${message}（${position+1}文字目）`);}
function normalizeNumericWidth(source:string):string {
  let quoted=false,escaped=false,result='';
  for(const character of source) {
    if(quoted) {
      result+=character;
      if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;
    }else if(character==='"'){quoted=true;result+=character;}
    // The ratio sign ∶ (U+2236) has no compatibility mapping; the full-width colon of Japanese input does.
    else if(character==='∶')result+=':';
    else result+=/[０-９＋－＊／＾（）［］｛｝，％！＝＜＞．：]/u.test(character)?character.normalize('NFKC'):character;
  }
  return result;
}
function tokenize(source:string):readonly Token[] {
  validateMathSource(source);source=normalizeNumericWidth(source);const tokens:Token[]=[];let at=0;
  while(at<source.length) {
    if(tokens.length>=MATH_INPUT_LIMITS.nodes)throw new MathInputProblem('budget','数式の項目が多すぎます。');
    const char=source[at];if(/\s/u.test(char)){at+=1;continue;}
    const start=at;
    if(char==='"') {
      at+=1;let escaped=false,closed=false;
      while(at<source.length) {
        const next=source[at++];if(escaped){escaped=false;continue;}
        if(next==='\\'){escaped=true;continue;}if(next==='"'){closed=true;break;}
      }
      if(!closed)fail('係数名の引用符を閉じてください',start);
      let value:unknown;try{value=JSON.parse(source.slice(start,at));}catch{fail('係数名の引用符とエスケープを確認してください',start);}
      if(typeof value!=='string')fail('係数名を文字列で指定してください',start);
      tokens.push({kind:'string',text:value,start});continue;
    }
    const tail=source.slice(at),number=/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u.exec(tail)?.[0];
    if(number){
      validateMathDecimal(number);at+=number.length;
      // Nothing may follow a number with "(" today, so 0.1(6) and 0.(3) take no existing meaning.
      if(source[at]==='('&&number.includes('.')&&!/[eE]/u.test(number)) {
        const repetend=/^\(([0-9]+)\)/u.exec(source.slice(at))?.[1];
        if(repetend===undefined)fail(REPEATING_DECIMAL_FORM,at);
        repeatingDecimalFraction(number,repetend);
        tokens.push({kind:'number',text:number,start,repetend});at+=repetend.length+2;continue;
      }
      tokens.push({kind:'number',text:number,start});continue;
    }
    const name=/^[\p{L}_][\p{L}\p{M}\p{N}_]*/u.exec(tail)?.[0];
    if(name){tokens.push({kind:'name',text:name,start});at+=name.length;continue;}
    if(char==='∞'||char==='∅'){tokens.push({kind:'name',text:char,start});at+=1;continue;}
    const operator=OPERATORS.find(operator=>source.startsWith(operator,at));
    if(operator){tokens.push({kind:'operator',text:operator,start});at+=operator.length;continue;}
    if(SINGLE.has(char)){tokens.push({kind:'operator',text:char,start});at+=1;continue;}
    // ∮(…) and ∯(…) name the closed integrals (MC-19d); prefix() rejects a symbol without its arguments.
    if(char==='∮'||char==='∯'){tokens.push({kind:'name',text:char,start});at+=1;continue;}
    fail('この記号は数式パレットまたはLaTeX入力で指定してください',at);
  }
  tokens.push({kind:'end',text:'',start:source.length});return tokens;
}
const INFIX:Readonly<Record<string,readonly [head:string,binding:number]>>={
  '+':['Add',50],'-':['Subtract',50],'−':['Subtract',50],'*':['Multiply',60],'/':['Divide',60],'÷':['Divide',60],
  '±':['PlusMinus',50],'∓':['MinusPlus',50],
  '⊗':['TensorProduct',60],'⊙':['HadamardProduct',60],
  '×':['PcadTimesToken',60],'·':['PcadDotToken',60],'^':['Power',80],'**':['Power',80],
  '∧':['And',20],'&&':['And',20],'∨':['Or',10],
};
const COMPARE:Readonly<Record<string,string>>={'=':'Equal','==':'Equal','!=':'NotEqual','<>':'NotEqual','≠':'NotEqual',
  '∉':'NotElement','⊂':'Subset','⊆':'SubsetEqual','⊃':'Superset','⊇':'SupersetEqual','≈':'ApproxEqual',
  '<':'Less','<=':'LessEqual','≤':'LessEqual','>':'Greater','>=':'GreaterEqual','≥':'GreaterEqual'};
const ALIASES:Readonly<Record<string,string>>={abs:'Abs',sgn:'Sign',ceil:'Ceil',min:'Min',max:'Max',sqrt:'Sqrt',root:'Root',
  exp:'Exp',ln:'Ln',log:'Log',log2:'Lb',log10:'Lg',asin:'Arcsin',acos:'Arccos',atan:'Arctan',asinh:'Arsinh',acosh:'Arcosh',atanh:'Artanh',
  atan2:'Arctan2',acot:'Arccot',asec:'Arcsec',acsc:'Arccsc',acoth:'Arcoth',asech:'Arsech',acsch:'Arcsch',npr:'Permutations',
  re:'Re',im:'Im',conj:'Conjugate',det:'Determinant',inverse:'Inverse',diff:'D',grad:'Gradient',div:'Divergence',mod:'Mod',list:'List',set:'Set',interval:'Interval',open:'Open'};

/** raw output remains uncanonicalized until decodeMathJson has enforced operation and symbol permissions. */
export function parseMathTextRaw(source:string,operations:ReadonlyMap<string,MathOperationDefinition>):Raw {
  const tokens=tokenize(source);let at=0,nodes=0;
  const functions=new Map([...operations.values()].filter(value=>!value.structural||value.id==='open-endpoint')
    .map(value=>[value.engineHead.toLowerCase(),value.engineHead]));
  const peek=()=>tokens[at];
  const take=()=>tokens[at++];
  const node=(head:string,...operands:Raw[]):Raw=>{
    if(++nodes>MATH_INPUT_LIMITS.nodes)throw new MathInputProblem('budget','数式の構造が複雑すぎます。');
    return [head,...operands];
  };
  const expect=(text:string)=>{if(peek().text!==text)fail(`「${text}」を指定してください`,peek().start);take();};
  // True while an element of [ ] or { } is read directly; ( ), a call and the other delimiters reset it.
  const groups:boolean[]=[];
  function within<T>(listed:boolean,read:()=>T):T {groups.push(listed);try{return read();}finally{groups.pop();}}
  function argumentsOf(end:string,depth:number,listed=false):Raw[] {
    const values:Raw[]=[];
    if(peek().text===end){take();return values;}
    for(;;) {
      if(values.length>=MATH_INPUT_LIMITS.arguments)throw new MathInputProblem('budget','引数が多すぎます。');
      values.push(within(listed,()=>expression(0,depth+1)));
      if(peek().text===end){take();return values;}
      expect(',');
    }
  }
  function call(name:string,start:number,depth:number):Raw {
    name=name.toLowerCase();
    expect('(');
    if(name==='coef') {
      const label=take();if(label.kind!=='string')fail('coef("名前")のように係数名を指定してください',label.start);
      expect(')');return node('PcadCoefficient',{str:label.text});
    }
    const values=argumentsOf(')',depth);
    // ∮ reads as closedcirculation for an explicit vector field and closedlineintegral otherwise; ∯ likewise.
    if(name==='∮'||name==='∯')name=closedIntegralHead(name,values[0]).toLowerCase();
    if(name==='odesolve'||name==='pde') {
      const dependent=values[2], independent:Raw=name==='odesolve'?['List',values[1]]:values[1];
      if(values.length!==4||!isRawArray(dependent)||dependent[0]!=='List'
        ||!isRawArray(independent)||independent[0]!=='List'
        ||[...dependent.slice(1),...independent.slice(1)].some(value=>typeof value!=='string')) {
        fail('微分方程式の一覧、独立変数、求める関数の一覧、初期値や境界の条件を指定してください',start);
      }
      return node(name==='odesolve'?'ODESolve':'PDE',
        node('Function',differentialEquationNotation(node('List',values[0],values[3]),independent.slice(1),dependent.slice(1)),...independent.slice(1),...dependent.slice(1)),
        {num:String(independent.length-1)});
    }
    if(name==='solvesystem') {
      const variables=values[1];
      if(values.length!==3||!isRawArray(variables)||variables[0]!=='List'||variables.length<2||variables.length>9
        ||variables.slice(1).some(value=>typeof value!=='string')) fail('方程式の一覧、未知数の一覧、実数または複素数の範囲を指定してください',start);
      return node('SolveSystem',node('Function',values[0],...variables.slice(1)),values[2]);
    }
    const equation=EQUATION_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(equation!==undefined) {
      if(values.length!==3||typeof values[1]!=='string')fail('式、未知数、実数/複素数または区間を指定してください',start);
      return node(equation[1],node('Function',values[0],values[1]),values[2]);
    }
    if(name==='mapping') {
      if(values.length!==4||typeof values[1]!=='string')fail('写像の式、変数、定義域と出力先の集合を指定してください',start);
      return node('Mapping',node('Function',values[0],values[1]),...values.slice(2));
    }
    if(name==='numericroots') {
      if(values.length!==5||typeof values[1]!=='string')fail('式、未知数、探索範囲の両端と精度を指定してください',start);
      return node('NumericRoots',node('Function',values[0],values[1]),...values.slice(2));
    }
    if(name==='fourierseries') {
      if(values.length!==5||typeof values[1]!=='string')fail('級数の式、変数、区間の両端と最高次数を指定してください',start);
      return node('FourierSeries',node('Function',values[0],values[1]),...values.slice(2));
    }
    const transform=INTEGRAL_TRANSFORM_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(transform!==undefined) {
      if(values.length!==3||typeof values[1]!=='string'||typeof values[2]!=='string')fail('変換する式、変換前と変換後の変数を指定してください',start);
      return node(transform[1],node('Function',values[0],values[1],values[2]));
    }
    const expansion=TAYLOR_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(expansion!==undefined) {
      if(values.length!==expansion[2]+1||typeof values[1]!=='string')fail('展開する式、変数、中心と打切り次数を指定してください',start);
      return node(expansion[1],node('Function',values[0],values[1]),...values.slice(2));
    }
    const sequence=SEQUENCE_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(sequence!==undefined) {
      const recurrence=sequence[0]==='recurrence-value', variable=values[1];
      if(values.length!==sequence[2]+1)fail('数列の式、添字と評価条件をすべて指定してください',start);
      const names=recurrence&&isRawArray(variable)&&variable[0]==='List'?variable.slice(1):[variable];
      if(names.some(value=>typeof value!=='string')||(!recurrence&&typeof variable!=='string')) {
        fail('添字を指定してください。漸化式は添字に続けて古い順の項を一覧で指定します',start);
      }
      return node(sequence[1],node('Function',values[0],...names),...values.slice(2));
    }
    const probability=GENERAL_PROBABILITY_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(probability!==undefined) {
      const count=probability[2], variables=values[count];
      if(values.length!==count+2||!isRawArray(variables)||variables[0]!=='List'
        ||variables.length<2||variables.length>9||variables.slice(1).some(value=>typeof value!=='string')) {
        fail('式、変数一覧、分布を指定してください。条件付き確率や共分散には式を2個指定します',start);
      }
      return node(probability[1],node('Function',node('List',...values.slice(0,count)),...variables.slice(1)),values[count+1]);
    }
    const regionIntegral=REGION_INTEGRAL_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(regionIntegral!==undefined) {
      const coordinates=values[1],parameters=values[3];
      if(values.length!==6||!isRawArray(coordinates)||coordinates[0]!=='List'
        ||!isRawArray(parameters)||parameters[0]!=='List'
        ||[...coordinates.slice(1),...parameters.slice(1)].some(value=>typeof value!=='string')) {
        fail('量または場、座標変数一覧、座標式一覧、媒介変数一覧、下限一覧、上限一覧を指定してください',start);
      }
      return node(regionIntegral[1],node('Function',values[0],...coordinates.slice(1)),
        node('Function',values[2],...parameters.slice(1)),values[4],values[5]);
    }
    const lineIntegral=LINE_INTEGRAL_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(lineIntegral!==undefined) {
      const variables=values[1];
      if(values.length!==6||!isRawArray(variables)||variables[0]!=='List'
        ||variables.length<2||variables.length>4||variables.slice(1).some(value=>typeof value!=='string')
        ||typeof values[3]!=='string')fail('場、座標変数一覧、曲線の座標式一覧、媒介変数、下限、上限を指定してください',start);
      return node(lineIntegral[1],node('Function',values[0],...variables.slice(1)),
        node('Function',values[2],values[3]),values[4],values[5]);
    }
    const vectorAt=VECTOR_CALCULUS_AT_DEFINITIONS.find(([,head])=>head.toLowerCase()===name);
    if(vectorAt!==undefined) {
      const variables=values[1];
      if(values.length!==3||!isRawArray(variables)||variables[0]!=='List'
        ||variables.length<2||variables.length>4||variables.slice(1).some(value=>typeof value!=='string')) {
        fail('式、順序付きの変数一覧、同じ順序の評価点一覧を指定してください',start);
      }
      return node(vectorAt[1],node('Function',values[0],...variables.slice(1)),values[2]);
    }
    const binding=['sum','product','integrate'].includes(name);
    if(binding) {
      const variable=values[1];
      if(typeof variable!=='string')fail('総和や積分の2番目には変数名を指定してください',start);
      const head=name==='sum'?'Sum':name==='product'?'Product':'Integrate';
      if(name==='integrate'&&values.length===2)return node(head,values[0],variable);
      if(values.length!==4&&(name==='integrate'||values.length!==5))fail('式、変数、下限、上限を指定してください',start);
      return node(head,values[0],node('Tuple',variable,...values.slice(2)));
    }
    if(name==='derivativeat') {
      if((values.length!==3&&values.length!==4)||typeof values[1]!=='string')fail('derivativeat(式,変数,位置,回数)を指定してください。回数は省略すると1です',start);
      return node('DerivativeAt',node('Function',values[0],values[1]),values[2],values[3]??{num:'1'});
    }
    if(name==='limsup'||name==='liminf') {
      if(values.length<3||values.length>5||typeof values[1]!=='string') {
        fail('上極限・下極限は式、変数、近づける値を指定し、必要なら方向と実数・整数・自然数の範囲を続けてください',start);
      }
      return node(name==='limsup'?'LimSup':'LimInf',node('Function',values[0],values[1]),...values.slice(2));
    }
    if(name==='limit') {
      if((values.length!==3&&values.length!==4)||typeof values[1]!=='string')fail('limit(式,変数,近づける値,方向)を指定してください。方向は省略できます',start);
      return node('Limit',node('Function',values[0],values[1]),...values.slice(2));
    }
    if(name==='forall'||name==='exists') {
      if(values.length!==3||typeof values[0]!=='string')fail('変数、集合、条件を指定してください',start);
      return node(name==='forall'?'ForAll':'Exists',node('Element',values[0],values[1]),values[2]);
    }
    if(name==='cbrt') {
      if(values.length!==1)fail('cbrtの値は1つで指定してください',start);
      return node('Root',values[0],{num:'3'});
    }
    const head=own(ALIASES,name)??functions.get(name);
    if(!head)throw new MathInputProblem('unsupported',`関数「${name}」を確認してください。係数はcoef("名前")で挿入します。`);
    return node(head,...values);
  }
  /** ∇f, ∇·F, ∇×F, ∇²f and ∇_[x,y,z]…; without a list the decoder supplies only a plot's X/Y/Z axes. */
  function nabla(marker:string,depth:number):Raw {
    let laplacian=marker.startsWith('∇²'),variables:Raw=NABLA_DEFAULT_VARIABLES;
    if(marker.endsWith('_')) {
      if(peek().text!=='[')fail(NABLA_VARIABLE_LIST,peek().start);
      take();variables=node('List',...argumentsOf(']',depth,true));
    } else if(peek().kind==='name'&&peek().text.startsWith('_'))fail(NABLA_VARIABLE_LIST,peek().start);
    if(!laplacian&&peek().text==='^') {
      const exponent=tokens[at+1];
      if(exponent.kind!=='number'||exponent.text!=='2')fail(NABLA_LAPLACIAN,peek().start);
      take();take();laplacian=true;
    }
    let head=laplacian?'Laplacian':'Gradient';
    if(!laplacian&&(peek().text==='·'||peek().text==='×'))head=take().text==='·'?'Divergence':'Curl';
    return node(head,expression(70,depth+1),variables);
  }
  function prefix(depth:number):Raw {
    const token=take();
    if(token.kind==='number') {
      if(token.repetend===undefined)return {num:token.text};
      const {numerator,denominator}=repeatingDecimalFraction(token.text,token.repetend);
      return denominator==='1'?{num:numerator}:node('Divide',{num:numerator},{num:denominator});
    }
    if(token.kind==='name'&&(token.text==='∮'||token.text==='∯')&&peek().text!=='(')throw new MathInputProblem('unsupported',CLOSED_INTEGRAL_UNAVAILABLE);
    if(token.kind==='name')return peek().text==='('?call(token.text,token.start,depth):token.text;
    if(token.kind==='operator'&&token.text.startsWith('∇'))return nabla(token.text,depth);
    if(token.text==='±'||token.text==='∓')return node(token.text==='±'?'PlusMinus':'MinusPlus',expression(70,depth+1));
    if(token.text==='+'||token.text==='-'||token.text==='−'||token.text==='¬') {
      const value=expression(token.text==='¬'?25:70,depth+1);
      return token.text==='+'?value:node(token.text==='¬'?'Not':'Negate',value);
    }
    if(token.text==='('){const value=within(false,()=>expression(0,depth+1));expect(')');return value;}
    if(token.text==='[')return node('List',...argumentsOf(']',depth,true));
    if(token.text==='{')return node('Set',...argumentsOf('}',depth,true));
    if(token.text==='⟨'||token.text==='∁') {
      if(token.text==='∁')expect('(');
      const values=argumentsOf(token.text==='⟨'?'⟩':')',depth);
      if(values.length!==2)fail(token.text==='⟨'?'内積には2つの値を指定してください':'補集合には集合と母集合を指定してください',token.start);
      return node(token.text==='⟨'?'Dot':'Complement',...values);
    }
    if(token.text==='|'||token.text==='⌊'||token.text==='⌈') {
      if(token.text==='|'&&peek().text==='|')fail('ノルムはnorm(値)、絶対値はabs(値)で意味を指定してください',token.start);
      const value=within(false,()=>expression(0,depth+1));expect(token.text==='|'?'|':token.text==='⌊'?'⌋':'⌉');
      return node(token.text==='|'?'Abs':token.text==='⌊'?'Floor':'Ceil',value);
    }
    if(token.text==='√'||token.text==='∛') {
      expect('(');const value=within(false,()=>expression(0,depth+1));expect(')');
      return token.text==='√'?node('Sqrt',value):node('Root',value,{num:'3'});
    }
    fail('数値、変数、または括弧で囲んだ式を指定してください',token.start);
  }
  function expression(minimum:number,depth:number):Raw {
    if(depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','数式の入れ子が深すぎます。');
    let left=prefix(depth);
    for(;;) {
      const token=peek();
      const primeOrder=derivativePrimeOrder(token.text);
      if(primeOrder>0&&90>=minimum) {
        take();left=node('PcadPrimeDerivative',left,{num:String(primeOrder)});continue;
      }
      if((token.text==='!'||token.text==='!!'||token.text==='%')&&90>=minimum) {
        take();left=token.text==='%'?node('Divide',left,{num:'100'}):node(token.text==='!'?'Factorial':'Factorial2',left);continue;
      }
      // The ratio a:b is its value a÷b (Q1=A). Forms that also read as a range, set condition or clock time are refused.
      if(token.text===':'&&RATIO_BINDING>=minimum) {
        take();
        if(peek().text==='=')fail(RATIO_DEFINITION,token.start);
        if(groups.at(-1)===true)fail(RATIO_IN_LIST,token.start);
        const before=tokens[at-2],after=peek();
        if((before.kind==='number'&&clockDigits(before.text))||(after.kind==='number'&&clockDigits(after.text)))fail(RATIO_TIME,token.start);
        left=node('Divide',left,expression(RATIO_BINDING+1,depth+1));
        if(peek().text===':')fail(RATIO_TERMS,peek().start);
        continue;
      }
      if(own(COMPARE,token.text)&&30>=minimum) {
        const comparisons:Raw[]=[];let previous=left;
        while(own(COMPARE,peek().text)) {
          const operator=take(),next=expression(31,depth+1);
          const head=own(COMPARE,operator.text);if(!head)fail('比較演算子を指定してください',operator.start);
          comparisons.push(node(head,previous,next));previous=next;
        }
        left=comparisons.length===1?comparisons[0]:node('And',...comparisons);continue;
      }
      const infix=own(INFIX,token.text);if(!infix||infix[1]<minimum)break;
      take();left=node(infix[0],left,expression(infix[0]==='Power'?infix[1]:infix[1]+1,depth+1));
    }
    return left;
  }
  const result=expression(0,0);
  if(peek().kind!=='end')fail('項を区切ってください。掛け算は *、係数はcoef("名前")で指定します',peek().start);
  return result;
}
export function parseMathText(source:string,options:Omit<DecodeMathOptions,'allowRenderedProducts'|'symbolNotation'>):MathNode {
  return decodeMathJson(parseMathTextRaw(source,options.operations),{...options,allowRenderedProducts:false,symbolNotation:'text'});
}
