/** Product integration must use the pinned browser package and bundle its OFL fonts locally. */
import 'mathlive/fonts.css';
import type {StructuredMathField} from './mathFieldHost.js';
let factory:Promise<()=>StructuredMathField>|null=null;
export function loadStructuredMathField():Promise<()=>StructuredMathField> {
  if(factory!==null)return factory;
  factory=import('mathlive').then(async ({MathfieldElement})=>{
    // Compute Engine is owned by the calculation Worker. MathLive remains an editor.
    MathfieldElement.computeEngine=null;
    // The locally bundled @font-face CSS owns fonts. Null prevents the automatic remote font loader.
    MathfieldElement.fontsDirectory=null;
    MathfieldElement.soundsDirectory=null;
    MathfieldElement.keypressSound=null;
    MathfieldElement.plonkSound=null;
    const loads: Promise<FontFace>[] = [];
    document.fonts.forEach(font => { if (font.family.replaceAll('"', '').startsWith('KaTeX_')) loads.push(font.load()); });
    if (loads.length === 0) throw new Error('数式用の字体を読み込めませんでした。');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(loads), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('数式用の字体の読み込みが時間切れになりました。')), 5_000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
    return ()=>new MathfieldElement();
  }).catch(error=>{factory=null;throw error;});
  return factory;
}
