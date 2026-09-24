// WebUI 服务端 — 零依赖（只用 node:http / node:fs / node:child_process）
//
// 设计要点:
//   · **复用现有渲染器**: 通过 `src/render.js` 的 renderFrame 渲染, 不碰 `src/**` 的渲染逻辑。
//   · **渲染在服务进程内跑**（不再 spawn 子进程）: 沙箱环境里"父进程用管道抓子进程输出"是被
//     禁止的（EPERM，见 harness 说明），而子进程方案的唯一好处——干净进程状态——已经由
//     "把 `DSH_WE_*` 开关改成每次调用读取"替代（见各文件里的 `xxxOn()` 取值函数）。
//     于是每个请求只需在进程内**临时**设置环境变量并在渲染后还原。
//   · **服务端只渲染**: 浏览器拿到 PNG 与结构化结果自己画（静态帧路线本来就没有实时 GL 可共享）。
//
// 诊断输出收集: `src/**` 里有两类日志 —— ① 渲染器的 log 回调（注入）；② 少数模块直接
// `process.stderr.write`（如 gpu-gl 的输出统计）。后者用 AsyncLocalStorage 在请求作用域内
// 挂一个"临时接收器"，渲染结束后立刻还原，不影响服务自身的 stderr。
//
// 路由:
//   GET  /                     → 单页 UI
//   GET  /api/health           → 环境自检（weAssets / 场景根 / 节点版本 / headless-gl）
//   GET  /api/scenes           → 本机 workshop 场景列表
//   GET  /api/scene?path=...   → 场景内省（对象/效果树，供逐条勾选）
//   POST /api/render           → 渲染一帧（JSON 进、JSON 出，PNG 走 base64）
//   POST /api/upload           → 上传 scene.pkg / 场景目录文件
//
// 安全: 只监听回环地址；上传写入 workspace 内的 webui/tmp/；env 白名单见 lib/render.mjs。
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listScenes, describeScene, normalizeSceneInput, workshopRoots } from './lib/scenes.mjs';
import { DEBUG_ENV_KEYS, debugEnv, runJob } from './lib/render.mjs';
import { unpackPkg, findSceneEntry, deriveSceneKey, readSidecar } from './lib/unpack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PUBLIC = join(HERE, 'public');
const TMP = join(HERE, 'tmp');
mkdirSync(TMP, { recursive: true });

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
// 默认端口刻意避开 43120（那是 DSH Web GUI 自己占用的地址，撞上会让人分不清连的是哪个）
const PORT = Number(argOf('--port', process.env.WEBUI_PORT || 43121));
const HOST = argOf('--host', '127.0.0.1');

// ── 小工具 ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limitBytes = 1024 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  // 只服务 public/ 下的内容；路径先归一化再前缀校验，防目录穿越
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC)) return sendText(res, 403, 'forbidden');
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    // SPA 回退：未知路径交给前端路由
    const idx = join(PUBLIC, 'index.html');
    if (existsSync(idx)) return sendText(res, 200, readFileSync(idx, 'utf8'), MIME['.html']);
    return sendText(res, 404, 'not found');
  }
  const buf = readFileSync(abs);
  res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

/** 统计耗时 & 行数的日志缓冲：把渲染期间的诊断输出回传 UI。 */
function makeLogBuffer(limit = 800) {
  const lines = [];
  return {
    push(chunk) {
      for (const l of String(chunk).split(/\r?\n/)) {
        if (!l) continue;
        lines.push(l);
        if (lines.length > limit) lines.shift();
      }
    },
    get lines() { return lines; },
  };
}

// 请求作用域的诊断输出接收器（见文件头说明）
const als = new AsyncLocalStorage();

/**
 * 渲染一个 job —— **在服务进程内**执行。
 *
 * 环境变量处理: UI 传来的诊断开关在渲染前写入 process.env, 渲染后**精确还原**（只动白名单内
 * 的键，且记录旧值）。因为 `src/**` 的取值函数都是每次调用读取，所以这足以让每个请求拿到
 * 自己的开关组合，且不会污染服务自身的环境。
 */
async function runRender(job) {
  const t0 = Date.now();
  const logs = makeLogBuffer();
  const env = debugEnv(job.debug);
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // 与 job.render.weAssetsDir 对应的环境变量（渲染器内部也会读 WE_ASSETS 兜底）
  if (job.render && job.render.weAssetsDir) {
    saved.WE_ASSETS = process.env.WE_ASSETS;
    process.env.WE_ASSETS = job.render.weAssetsDir;
  }
  job.render = { ...(job.render || {}), log: (m) => logs.push('[we-sf] ' + m) };

  // 少数模块直接写 process.stderr（绕过 log 回调）—— 在请求作用域内临时接管
  const origStderrWrite = process.stderr.write;
  process.stderr.write = function (chunk, enc, cb) {
    const buf = als.getStore();
    if (buf) { buf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true; }
    return origStderrWrite.call(process.stderr, chunk, enc, cb);
  };

  try {
    return await als.run(logs, async () => {
      try {
        const out = await runJob(job);
        return { ok: true, ...out, logs: logs.lines, wallMs: Date.now() - t0 };
      } catch (e) {
        return {
          ok: false,
          error: String(e && e.message ? e.message : e),
          code: e && e.code ? e.code : null,
          logs: logs.lines,
          wallMs: Date.now() - t0,
        };
      }
    });
  } finally {
    process.stderr.write = origStderrWrite;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 极简 multipart/form-data 解析（只处理文件字段；零依赖）。 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim(), 'latin1');
  const parts = [];
  let pos = 0;
  while (true) {
    const start = buf.indexOf(boundary, pos);
    if (start < 0) break;
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    const seg = buf.subarray(start + boundary.length + 2, next - 2); // 跳过 CRLF 与前一个 CRLF
    const headEnd = seg.indexOf('\r\n\r\n');
    if (headEnd < 0) { pos = next; continue; }
    const headers = seg.subarray(0, headEnd).toString('utf8');
    const body = seg.subarray(headEnd + 4);
    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : null, data: body, headers });
    pos = next;
  }
  return parts;
}

/** 把上传的路径安全地落到 TMP 下（防穿越 / 绝对路径注入）。 */
function safeJoin(base, relPath) {
  const clean = String(relPath).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const abs = resolve(base, clean);
  if (!abs.startsWith(base)) throw new Error('非法上传路径: ' + relPath);
  return abs;
}

// ── 路由处理 ──────────────────────────────────────────────────────────────
async function handle(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    let glOk = false, glErr = null;
    try {
      const mod = await import('supreium-headless-gl');
      glOk = !!mod;
    } catch (e) { glErr = e.message; }
    return sendJson(res, 200, {
      ok: true,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: ROOT,
      weAssetsDir: (await import('../src/render.js')).locateWeAssets(),
      workshopRoots: workshopRoots(),
      headlessGl: glOk,
      headlessGlError: glErr,
      debugKeys: [...DEBUG_ENV_KEYS],
      tmpDir: TMP,
    });
  }

  if (p === '/api/scenes') {
    const scenes = listScenes();
    // 标出哪些 pkg 已经解包过 —— 解包目录才能用「逐对象/逐效果」开关（数据层改写 scene.json）
    const base = join(TMP, 'unpacked');
    for (const sc of scenes) {
      const d = join(base, sc.id);
      const e = existsSync(d) ? findSceneEntry(d) : null;
      sc.unpackedDir = e || null;
    }
    // listScenes 会把不可渲染的条目挂成数组属性，JSON 化时会丢；显式取出来
    return sendJson(res, 200, { ok: true, scenes, skipped: scenes.skipped || [], roots: workshopRoots() });
  }

  if (p === '/api/scene') {
    const target = url.searchParams.get('path');
    if (!target) return sendJson(res, 400, { ok: false, error: '缺少 path' });
    try {
      const info = describeScene(target);
      return sendJson(res, 200, { ok: true, scene: info });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === '/api/render' && req.method === 'POST') {
    let job;
    try { job = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON: ' + e.message });
    }
    if (!job || !job.input) return sendJson(res, 400, { ok: false, error: '缺少 input（场景路径）' });
    const r = await runRender(job);
    return sendJson(res, 200, r);
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const ctype = req.headers['content-type'] || '';
    let parts;
    try { parts = parseMultipart(await readBody(req), ctype); } catch (e) {
      return sendJson(res, 400, { ok: false, error: '上传解析失败: ' + e.message });
    }
    // 每次上传落一个独立子目录，便于"删除这次上传"和避免同名互踩
    const stamp = 'up-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const dir = join(TMP, stamp);
    mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const part of parts) {
      if (part.filename == null) continue;
      // 目录上传时前端把相对路径塞进 filename（webkitRelativePath / DataTransfer entry）
      const abs = safeJoin(dir, part.filename);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, part.data);
      saved.push({ name: relative(dir, abs).replace(/\\/g, '/'), bytes: part.data.length });
    }
    if (!saved.length) return sendJson(res, 400, { ok: false, error: '没有收到文件' });
    // 决定"这个上传怎么渲染": 有 scene.pkg 用它；否则找 scene.json 所在目录
    let input = null;
    const pkg = saved.find((s) => /(^|\/)scene\.pkg$/i.test(s.name));
    if (pkg) input = join(dir, pkg.name);
    else {
      const sj = saved.find((s) => /(^|\/)scene\.json$/i.test(s.name));
      if (sj) input = join(dir, dirname(sj.name));
    }
    return sendJson(res, 200, {
      ok: true, dir, files: saved,
      input, // 可能为 null（用户只传了零散文件）
      hint: input ? null : '上传里没找到 scene.pkg / scene.json，无法直接渲染',
    });
  }

  if (p === '/api/unpack' && req.method === 'POST') {
    // scene.pkg → 松散场景目录。逐对象/逐效果开关走数据层（改写 scene.json），
    // 而 scene.json 封在 PKG 容器里（条目多为 LZ4 块链）⇒ 必须先落成目录。
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: '非法 JSON' }); }
    const src = normalizeSceneInput(body.input);
    if (!src) return sendJson(res, 400, { ok: false, error: '缺少 input' });
    if (!existsSync(src) || statSync(src).isDirectory()) {
      return sendJson(res, 200, { ok: false, error: '不是 scene.pkg 文件（松散目录无需解包）' });
    }
    const id = (() => {
      const norm = src.replace(/\\/g, '/');
      const m = /\/431960\/([^/]+)\//.exec(norm + '/');
      return m ? m[1] : 'pkg-' + Date.now().toString(36);
    })();
    const out = join(TMP, 'unpacked', id);
    try {
      const r = unpackPkg(src, out, { sceneKey: deriveSceneKey(src) });
      const entry = findSceneEntry(out);
      return sendJson(res, 200, {
        ok: !!entry, ...r, input: entry, id,
        sceneKey: r.sceneKey,
        hint: entry ? null : '解包完成但目录里没有 scene.json',
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e), code: e.code || null });
    }
  }

  if (p === '/api/unpacks' && req.method === 'GET') {
    const base = join(TMP, 'unpacked');
    const list = [];
    try {
      for (const name of readdirSync(base)) {
        const d = join(base, name);
        try {
          if (!statSync(d).isDirectory()) continue;
          const entry = findSceneEntry(d);
          if (!entry) continue;
          list.push({ id: name, dir: d, input: entry, sidecar: readSidecar(d), mtimeMs: Math.round(statSync(d).mtimeMs) });
        } catch { /* ignore */ }
      }
    } catch { /* 目录还没建 */ }
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sendJson(res, 200, { ok: true, unpacks: list });
  }

  if (p === '/api/uploads' && req.method === 'GET') {
    const list = [];
    for (const name of readdirSync(TMP)) {
      const d = join(TMP, name);
      try { if (statSync(d).isDirectory()) list.push({ name, dir: d, mtimeMs: Math.round(statSync(d).mtimeMs) }); } catch { /* ignore */ }
    }
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sendJson(res, 200, { ok: true, uploads: list });
  }

  if (p === '/api/upload/delete' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: '非法 JSON' }); }
    const dir = safeJoin(TMP, String(body.name || ''));
    if (dir === TMP) return sendJson(res, 400, { ok: false, error: '非法目录' });
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
    return sendJson(res, 200, { ok: true });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口 ' + p });
  return serveStatic(res, p);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || HOST)); } catch { return sendText(res, 400, 'bad url'); }
  // 只允许回环来源的跨域（本地工具，不开 CORS）
  handle(req, res, url).catch((e) => {
    try { sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }); } catch { /* ignore */ }
  });
});

server.listen(PORT, HOST, () => {
  const url = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT;
  process.stdout.write('we-static-frame webui → ' + url + '\n');
  process.stdout.write('  workspace: ' + ROOT + '\n');
  process.stdout.write('  上传目录:  ' + TMP + '\n');
  process.stdout.write('  停止:      Ctrl+C\n');
});

const shutdown = () => { try { server.close(); } catch { /* ignore */ } process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
