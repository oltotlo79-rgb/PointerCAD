/** Local test browsers only. WARP chooses a renderer; force-enabled separately
 * permits WebGL2 on Windows VMs whose graphics feature checks otherwise block it.
 * Linux keeps its own software renderer but needs force-enabled too: the first Firefox
 * launch of a CI job once refused WebGL2 there (AllowWebgl2:false) while every later
 * launch of the same job rendered (run 44991756823, ubuntu shard 1, 2nd attempt).
 * Mozilla: dom/canvas/WebGLContext.cpp, WebGLContext::CreateAndInitGL.
 */
export const FIREFOX_GRAPHICS_PREFS:Record<string,boolean>=process.platform==='win32'
  ?{'webgl.angle.force-warp':true,'webgl.force-enabled':true}:{'webgl.force-enabled':true};
