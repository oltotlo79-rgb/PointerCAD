/** Explicit plain-text math. Never infer a multiplication, a coefficient, or a function call from adjacency. */
import {MathInputProblem,MATH_INPUT_LIMITS,validateMathSource,validateMathDecimal,type MathNode,type MathOperationDefinition} from './mathInputContract.js';
import {decodeMathJson,type DecodeMathOptions} from './decodeMathJson.js';
type Raw=string|{num:string}|{str:string}|[string,...Raw[]];
interface Token {readonly kind:'number'|'name'|'string'|'operator'|'end';readonly text:string;readonly start:number}
const OPERATORS=['<=','>=','!=','==','**','&&','!!'];
const SINGLE=new Set('+-−*/×·⊗⊙÷^!%=<≤>≥≠∧∨¬()[],|√∛⌊⌋⌈⌉{}');
function own<T>(values:Readonly<Record<string,T>>,key:string):T|undefined {return Object.hasOwn(values,key)?values[key]:undefined;}
function fail(message:string,position:number):never {throw new MathInputProblem('syntax',`${message}（${position+1}文字目）`);}
function normalizeNumericWidth(source:string):string {
  let quoted=false,escaped=false,result='';
  for(const character of source) {
    if(quoted) {
      result+=character;
      if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;
    }else if(character==='"'){quoted=true;result+=character;}
    else result+=/[０-９＋－＊／＾（）［］｛｝，％！＝＜＞．]/u.test(character)?character.normalize('NFKC'):character;
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
    if(number){validateMathDecimal(number);tokens.push({kind:'number',text:number,start});at+=number.length;continue;}
    const name=/^[\p{L}_][\p{L}\p{M}\p{N}_]*/u.exec(tail)?.[0];
    if(name){tokens.push({kind:'name',text:name,start});at+=name.length;continue;}
    if(char==='∞'||char==='∅'){tokens.push({kind:'name',text:char,start});at+=1;continue;}
    const operator=OPERATORS.find(operator=>source.startsWith(operator,at));
    if(operator){tokens.push({kind:'operator',text:operator,start});at+=operator.length;continue;}
    if(SINGLE.has(char)){tokens.push({kind:'operator',text:char,start});at+=1;continue;}
    fail('この記号は数式パレットまたはLaTeX入力で指定してください',at);
  }
  tokens.push({kind:'end',text:'',start:source.length});return tokens;
}
const INFIX:Readonly<Record<string,readonly [head:string,binding:number]>>={
  '+':['Add',50],'-':['Subtract',50],'−':['Subtract',50],'*':['Multiply',60],'/':['Divide',60],'÷':['Divide',60],
  '⊗':['TensorProduct',60],'⊙':['HadamardProduct',60],
  '×':['PcadTimesToken',60],'·':['PcadDotToken',60],'^':['Power',80],'**':['Power',80],
  '∧':['And',20],'&&':['And',20],'∨':['Or',10],
};
const COMPARE:Readonly<Record<string,string>>={'=':'Equal','==':'Equal','!=':'NotEqual','≠':'NotEqual',
  '<':'Less','<=':'LessEqual','≤':'LessEqual','>':'Greater','>=':'GreaterEqual','≥':'GreaterEqual'};
const ALIASES:Readonly<Record<string,string>>={abs:'Abs',sgn:'Sign',ceil:'Ceil',min:'Min',max:'Max',sqrt:'Sqrt',root:'Root',
  exp:'Exp',ln:'Ln',log:'Log',log2:'Lb',log10:'Lg',asin:'Arcsin',acos:'Arccos',atan:'Arctan',asinh:'Arsinh',acosh:'Arcosh',atanh:'Artanh',
  atan2:'Arctan2',acot:'Arccot',asec:'Arcsec',acsc:'Arccsc',acoth:'Arcoth',asech:'Arsech',acsch:'Arcsch',npr:'Permutations',
  re:'Re',im:'Im',conj:'Conjugate',det:'Determinant',inverse:'Inverse',diff:'D',mod:'Mod',list:'List',set:'Set',interval:'Interval',open:'Open'};

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
  function argumentsOf(end:string,depth:number):Raw[] {
    const values:Raw[]=[];
    if(peek().text===end){take();return values;}
    for(;;) {
      if(values.length>=MATH_INPUT_LIMITS.arguments)throw new MathInputProblem('budget','引数が多すぎます。');
      values.push(expression(0,depth+1));
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
    const binding=['sum','product','integrate'].includes(name);
    if(binding) {
      const variable=values[1];
      if(typeof variable!=='string')fail('総和や積分の2番目には変数名を指定してください',start);
      const head=name==='sum'?'Sum':name==='product'?'Product':'Integrate';
      if(name==='integrate'&&values.length===2)return node(head,values[0],variable);
      if(values.length!==4&&(name==='integrate'||values.length!==5))fail('式、変数、下限、上限を指定してください',start);
      return node(head,values[0],node('Tuple',variable,...values.slice(2)));
    }
    if(name==='limit') {
      if(values.length!==3||typeof values[1]!=='string')fail('limit(式,変数,近づける値)を指定してください',start);
      return node('Limit',node('Function',values[0],values[1]),values[2]);
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
  function prefix(depth:number):Raw {
    const token=take();
    if(token.kind==='number')return {num:token.text};
    if(token.kind==='name')return peek().text==='('?call(token.text,token.start,depth):token.text;
    if(token.text==='+'||token.text==='-'||token.text==='−'||token.text==='¬') {
      const value=expression(token.text==='¬'?25:70,depth+1);
      return token.text==='+'?value:node(token.text==='¬'?'Not':'Negate',value);
    }
    if(token.text==='('){const value=expression(0,depth+1);expect(')');return value;}
    if(token.text==='[')return node('List',...argumentsOf(']',depth));
    if(token.text==='{')return node('Set',...argumentsOf('}',depth));
    if(token.text==='|'||token.text==='⌊'||token.text==='⌈') {
      if(token.text==='|'&&peek().text==='|')fail('ノルムはnorm(値)、絶対値はabs(値)で意味を指定してください',token.start);
      const value=expression(0,depth+1);expect(token.text==='|'?'|':token.text==='⌊'?'⌋':'⌉');
      return node(token.text==='|'?'Abs':token.text==='⌊'?'Floor':'Ceil',value);
    }
    if(token.text==='√'||token.text==='∛') {
      expect('(');const value=expression(0,depth+1);expect(')');
      return token.text==='√'?node('Sqrt',value):node('Root',value,{num:'3'});
    }
    fail('数値、変数、または括弧で囲んだ式を指定してください',token.start);
  }
  function expression(minimum:number,depth:number):Raw {
    if(depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','数式の入れ子が深すぎます。');
    let left=prefix(depth);
    for(;;) {
      const token=peek();
      if((token.text==='!'||token.text==='!!'||token.text==='%')&&90>=minimum) {
        take();left=token.text==='%'?node('Divide',left,{num:'100'}):node(token.text==='!'?'Factorial':'Factorial2',left);continue;
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
