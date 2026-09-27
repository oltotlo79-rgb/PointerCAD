/** Explicitly opening an old scalar expression in the structured editor preserves its roles and units. */
import { MathInputProblem, MATH_INPUT_LIMITS, validateMathDecimal, type MathNode } from './mathInputContract.js';
import { mathLatexLabel } from './mathLatexLabel.js';
export function legacyDefinitionToLatex(expression:MathNode):string {
  let nodes=0;
  function visit(node:MathNode,depth:number):string {
    nodes+=1;
    if(nodes>MATH_INPUT_LIMITS.nodes||depth>MATH_INPUT_LIMITS.depth)throw new MathInputProblem('budget','変換する数式が複雑すぎます。');
    let source:string;
    if(node.kind==='number'){
      validateMathDecimal(node.decimal);
      const [mantissa,exponent]=node.decimal.toLowerCase().split('e');
      source=exponent===undefined?mantissa:`${mantissa}\\cdot10^{${exponent}}`;
    }else if(node.kind==='constant'&&(node.name==='pi'||node.name==='e')){
      source=node.name==='pi'?String.raw`\pi`:String.raw`\exponentialE`;
    }else if(node.kind==='symbol'&&node.reference.role==='coefficient'){
      source=String.raw`\operatorname{coef}\left(\text{`+mathLatexLabel(node.reference.label)+String.raw`}\right)`;
    }else if(node.kind==='operation'){
      const values=node.operands.map(value=>visit(value,depth+1));
      const grouped=values.map(value=>String.raw`\left(`+value+String.raw`\right)`);
      const first=values[0],second=values[1],left=grouped[0],right=grouped[1];
      if(node.operation==='add'&&values.length>=2)source=grouped.join('+');
      else if(node.operation==='multiply'&&values.length>=2)source=grouped.join(String.raw`\cdot`);
      else if(node.operation==='subtract'&&values.length===2)source=`${left}-${right}`;
      else if(node.operation==='divide'&&values.length===2)source=String.raw`\frac{`+first+'}{'+second+'}';
      else if(node.operation==='power'&&values.length===2)source=`{${left}}^{${second}}`;
      else if(node.operation==='negate'&&values.length===1)source=`-${left}`;
      else if(node.operation==='sqrt'&&values.length===1)source=String.raw`\sqrt{`+first+'}';
      else if(node.operation==='root'&&values.length===2)source=String.raw`\sqrt[`+second+']{'+first+'}';
      else if(node.operation==='absolute'&&values.length===1)source=String.raw`\left|`+first+String.raw`\right|`;
      else throw new MathInputProblem('unsupported','旧形式にない演算を自動変換できません。');
    }else throw new MathInputProblem('unsupported','旧形式の定義と異なる記号を自動変換できません。');
    if(source.length>MATH_INPUT_LIMITS.sourceCodeUnits)throw new MathInputProblem('budget','変換後の数式が長すぎます。');
    return source;
  }
  return visit(expression,0);
}
