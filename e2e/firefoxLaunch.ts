/** Local test browsers only. WARP chooses a renderer; force-enabled separately
 * permits WebGL2 on Windows VMs whose graphics feature checks otherwise block it.
 * Mozilla: dom/canvas/WebGLContext.cpp, WebGLContext::CreateAndInitGL.
 */
export const FIREFOX_GRAPHICS_PREFS:Record<string,boolean>=process.platform==='win32'
  ?{'webgl.angle.force-warp':true,'webgl.force-enabled':true}:{};
