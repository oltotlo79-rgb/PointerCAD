/**
 * 画面の網(表示のボディの三角形)の弦の最大のずれ(mm)。カーネルの既定をそのまま引く(書き写すと、画面側の既定を変えた時にここだけ古くなる。
 * kernelBridge.ts の DISPLAY_MESH_QUALITY と同じ考え)。
 * 寸法で動かす(配置の補助 P-A)が、式で測れない形(自由な曲面など)を網で測った時の、誤差の上限として予告に出す。
 */
import { DEFAULT_LINEAR_DEFLECTION } from '@pointercad/kernel';

export const DISPLAY_MESH_DEVIATION_MM = DEFAULT_LINEAR_DEFLECTION;
