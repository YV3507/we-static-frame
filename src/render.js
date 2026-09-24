/**
 * we-static-frame —— 独立可用的静态帧渲染入口（库）。
 *
 * 这是**新写的适配层**，不属于从主插件镜像过来的 `src/**`（那部分是逐字节搬运的
 * 渲染器本体，禁止手改；见 README 的"搬运契约"）。
 *
 * 契约：
 *   renderFrame({ input, width, height, time, weAssetsDir, videoFrames, gpuAccel, warm })
 *     → { png, width, height, time, sceneSrc, ms }
 *   · input          `scene.pkg` 路径，或含 scene.json/project.json 的场景目录
 *   · weAssetsDir    Wallpaper Engine 的官方 assets（shader / material / model / particle
 *                    / scripts）。**两种写法都接受**：`<WE 安装目录>/assets`（locateWeAssets()
 *                    的返回形式，推荐）或 `<WE 安装目录>` 本身 —— 内部按内容自动归一。
 *                    不提供也能渲染，但官方效果链会退化（见 README「已知限制」）。
 *   · videoFrames    可选：场景内嵌视频纹理的预抽帧 { [纹理路径]: Uint8Array }，由调用方负责
 *                    抽帧（主插件用 ffmpeg；独立使用时可以不传 ⇒ 跳过视频纹理）
 *   · gpuAccel       可选：效果链走 WebGL（需要 supreium-headless-gl + x64）
 */
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SceneRenderer, encodePng } from './scene-renderer.js';

/** 目录入参 → 真实场景主文件（project.json 的 `file` 字段，回退目录本身）。 */
export function resolveSceneMainFile(src) {
  try {
    if (!statSync(src).isDirectory()) return src;
  } catch { return src; }
  try {
    const pj = JSON.parse(readFileSync(join(src, 'project.json'), 'utf8'));
    const f = pj && typeof pj.file === 'string' ? pj.file : null;
    if (f && /\.json$/i.test(f) && f !== 'scene.json' && existsSync(join(src, f))) return join(src, f);
  } catch { /* 无 project.json / 解析失败 → 保持目录入参 */ }
  return src;
}

/**
 * 渲染一帧。
 * @param {object} opts 见文件头
 * @returns {Promise<{png: Uint8Array, width: number, height: number, time: number, sceneSrc: string, ms: number}>}
 */
export async function renderFrame(opts = {}) {
  const {
    input, width = 3840, height = 2160, time = 2.5,
    weAssetsDir = null, videoFrames = null, gpuAccel = false,
    warm = true, log = () => {}, onDegraded = null,
  } = opts;
  if (!input) throw new Error('renderFrame: input 必填（scene.pkg 路径或场景目录）');

  const sceneSrc = resolveSceneMainFile(input);
  const t0 = Date.now();
  const renderer = new SceneRenderer(sceneSrc, {
    width, height, time, weAssetsDir, videoFrames,
    gpuAccel: gpuAccel === true,
    log,
    ...(typeof onDegraded === 'function' ? { onDegraded } : {}),
  });

  // 块行并行预解码（与主插件 worker 同序：构造 → 预热 → render）。
  // 失败/未启用只是少预热若干纹理，像素不变。
  if (warm) {
    try {
      const { warmSceneTextures } = await import('./we-renderer/predecode.js');
      const st = await warmSceneTextures(renderer);
      if (st) log(`预热 ${st.textures} 张 / ${st.workers} worker / ${Math.round(st.ms)}ms`);
    } catch (e) {
      log('预热跳过: ' + (e && e.message ? e.message : e));
    }
  }

  const canvas = renderer.render();
  const png = encodePng(canvas.w, canvas.h, canvas.data);
  return {
    png, width: canvas.w, height: canvas.h, time: time == null ? 0 : time, sceneSrc,
    ms: Date.now() - t0,
    // 归一后的实际生效值（入参可能是 <WE>/assets，而内部按 <WE> 根拼 assets/）
    weAssetsDir: renderer.weAssetsDir || null,
  };
}

/** 便捷：渲染并写出 PNG 文件。 */
export async function renderToFile(input, outPath, opts = {}) {
  const { writeFileSync } = await import('node:fs');
  const res = await renderFrame({ ...opts, input });
  writeFileSync(outPath, res.png);
  return { ...res, outPath };
}

/** GE 安装目录下的 assets 定位（独立实现；主插件有更完整的 Steam 库解析，见其 locateWallpaperEngineP）。 */
export function locateWeAssets() {
  const env = process.env.WE_ASSETS || process.env.DSH_WE_ASSETS;
  if (env && existsSync(join(env, 'shaders'))) return env;
  const roots = [];
  const steamEnv = process.env.DSH_WE_STEAM_ROOT;
  if (steamEnv) roots.push(...steamEnv.split(/[;,]/).map((s) => s.trim()).filter(Boolean));
  for (const d of ['C', 'D', 'E', 'F']) roots.push(`${d}:\\SteamLibrary`, `${d}:\\Steam`, `${d}:\\Program Files (x86)\\Steam`);
  for (const r of roots) {
    const p = join(r, 'steamapps', 'common', 'wallpaper_engine', 'assets');
    if (existsSync(join(p, 'shaders'))) return p;
    // libraryfolders.vdf 里的其它库
    const vdf = join(r, 'steamapps', 'libraryfolders.vdf');
    if (!existsSync(vdf)) continue;
    try {
      for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s*"([^"]+)"/g)) {
        const q = join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common', 'wallpaper_engine', 'assets');
        if (existsSync(join(q, 'shaders'))) return q;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export default { renderFrame, renderToFile, resolveSceneMainFile, locateWeAssets };
