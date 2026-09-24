# we-static-frame · WebUI

一个**独立的**浏览器测试台：导入壁纸 → 调配置 → 直接看渲染结果。
不改动 `src/**` 的任何渲染逻辑，只通过 `src/render.js` 的 `renderFrame` 复用既有渲染器。

```bash
npm run webui              # → http://127.0.0.1:43121
npm run webui -- --port 8080
```

端口默认 **43121**，刻意避开 DSH Web GUI 自己占用的 43120，免得看错页面。
服务只监听回环地址。

## 为什么是"服务端渲染 + 浏览器显示"

上游的实时渲染器 [webwallgl](https://github.com/oneincase/webwallgl) 在**有 GPU** 的机器上是主路径；
本仓库是它的**静态帧兜底**（虚拟机 / 远程端 / 无 WebGL2）。这个 WebUI 也不试图把渲染搬进浏览器：

| 事实 | 后果 |
|---|---|
| 渲染内核是 Node 专用（`node:fs`/`node:path`、`node:zlib` 解 pkg、`node:vm` 跑场景脚本、`node:worker_threads`） | 浏览器里跑不起来，除非把内核重构进浏览器 |
| `Buffer` 出现 17 处 | 同上 |
| 内核是**全同步**设计（`readPkg`、纹理解码都是同步的） | 即便移植也要整体异步化 |
| README 的搬运契约：`src/**` 逐字节搬运、禁止手改 | 移植等于把"可对照官方"的前提丢掉 |

所以分工是：**浏览器只管"选 + 配 + 看"，渲染在服务进程内跑**。
静态帧本来就不需要实时 GL 上下文共享，这个分工没有性能损失。

## 三个面板

1. **导入壁纸** —— 三种入口：
   - 本机 workshop 场景列表（自动扫描 `steamapps/workshop/content/431960`；
     只有 `index.html` 的 **Web 壁纸**会被识别并排除，它们不在本渲染器范围内）
   - 拖拽上传 `scene.pkg` 或整个场景目录（落到 `webui/tmp/`，可单独删除）
   - 直接填路径（场景外的样本也能测）
2. **配置** —— 五个 tab，覆盖 `renderFrame` 暴露的**全部**下游接口（见下表）
3. **渲染结果** —— 图像 + 降级列表 + 决策表 + gpuStats + 逐行日志，可下载 PNG

## 配置项 → 下游接口对照

| UI | `renderFrame` 参数 | 说明 |
|---|---|---|
| 宽度 / 高度 / 时间 t | `width` / `height` / `time` | 含 320×180 … 4K 预设 |
| 纹理预解码预热 | `warm` | 关掉可测冷启动成本 |
| 启用 GPU 通道 | `gpuAccel` | 历史开关，等价 `gpu:'auto'` |
| WE assets 目录 | `weAssetsDir` | 留空则自动定位 |
| videoFrames | `videoFrames` | 内嵌视频纹理需要外部抽帧（JSON 形式传入） |
| gpu 模式 | `gpu` | `auto` / `off` / `force` / 对象形式 |
| failStreakLimit、allowEffects、denyEffects | `gpu.{failStreakLimit,allowEffects,denyEffects}` | 熔断阈值与 GPU 效果名单 |
| skipDegenerate | `effects.skipDegenerate` | 关掉则保留退化输出，便于取证 |
| effects.allow / deny | `effects.allow` / `effects.deny` | 全局效果白/黑名单 |
| 统一后端 | `policy.decideBackend` | `auto`/`cpu`/`gpu`/`gpu-only` |
| **逐对象勾选** | 数据层 `scene.objects[i].visible` | 渲染器没有对象级策略钩子，按官方语义改数据 |
| **逐效果勾选** + 逐效果后端 | 数据层 `effects[j].visible` | 同一图层里的**同名效果也能分别控制**，比 allow/deny 精确 |
| 着色器补丁 | `shaderPatch` | key = 效果名 / 着色器 stem，正则替换源码 |
| 诊断取证 | `DSH_WE_*` 环境变量 | 见下 |

逐对象/逐效果这两条是**数据层**改写（写一份临时 `.webui-tmp-scene.json` 再渲染，原文件不动）：
- 只有**松散场景目录**（`scene.json` 可直接读）才能用；`scene.pkg` 的场景 JSON 在 PKG 容器内
  （条目还是 LZ4 块链），本层不改写压缩包 —— 这时接口会**明确报错**而不是静默忽略勾选。
- 用 `allow/deny` 或逐效果后端时不受此限（走的是策略层）。

## 诊断取证开关

UI 里每个开关对应一个 `DSH_WE_*` 环境变量，逐请求注入：

`DSH_WE_FX_DUMP`（逐 pass：target/尺寸/各槽位绑到哪个 RT/编译源签名/像素摘要）、
`DSH_WE_FX_TRACE`（生成 JS 的出错行）、`DSH_WE_NO_FX`、`DSH_WE_NO_FXJSON`、
`DSH_WE_NO_FXJSON_GPU`、`DSH_WE_NO_FX_CHAIN`、`DSH_WE_CHAIN_VERIFY`、
`DSH_WE_DEBUG_GLSL`、`DSH_WE_PROFILE`、`DSH_WE_RT_ALL`、`DSH_WE_NO_SEED_VTEXCOORD`。

为了让这些开关能**逐请求**切换，渲染器里原本在模块加载期读取的开关已改为**每次调用读取**
（`xxxOn()` 取值函数，见 `effects/effectjson.js`、`gpu-gl/adapter.js`、`effects.js`、
`glsl/executor.js`、`profile.js` 等）。这是"读取时机"的改变，不改变任何渲染逻辑：
对"启动前设好环境变量"的既有用法行为完全一致（既有测试与逐场景普查均无回归）。

服务端对 `process.stderr.write` 做了请求作用域接管，因此少数直接写 stderr 的诊断输出
（如 gpu-gl 的单 pass 统计）也能出现在 UI 的日志面板里；渲染结束立即还原，不影响服务自身输出。

## 已知边界（诚实记录）

- **GPU 熔断是进程级的**：`gpu-gl/adapter.js` 的失败计数活在进程内，一次连续失败可能让后续
  请求都变成 `state=off`。所以 UI 的 `gpu:'force'` 会**显式复位**熔断状态（`resetGpuAdapter()`）
  —— 否则用户只能重启服务才能把 GPU 拿回来。gpuStats 会如实显示当前状态。
- **渲染期间无法取消**：内核是同步的，HTTP 请求一旦进入渲染就跑到结束。大分辨率 + 重效果
  场景请先从小分辨率试。
- 上传的体积上限是服务端 `readBody` 的 1GB（整个 pak 读进内存）；20-40MB 的 pkg 没问题。
- 逐对象/逐效果勾选对 `scene.pkg` 不可用（见上）；需要先把 pkg 落成松散目录。
- 每次请求的渲染状态（scenes/纹理缓存）**会**跨请求复用 —— 这是有意的（预热收益），
  代价是"改了同一个场景文件后"可能命中旧缓存；要绝对干净就重启服务。

## 文件结构

```
webui/
  serve.mjs            零依赖 HTTP 服务：路由 + 上传 + 渲染编排（进程内）
  lib/scenes.mjs       场景发现（区分 pkg / loose / web）与场景内省（对象·效果树）
  lib/render.mjs       job → renderFrame 参数的**唯一映射点**（全部下游接口都在这里落地）
  public/index.html    三段式布局
  public/app.css       深色主题
  public/app.js        选区/配置/上传/结果展示（零框架、零构建）
  public/state.js      极简发布订阅状态中心
  tmp/                 上传落盘（已加入 .gitignore）
```

## 冒烟自检

```bash
npm run webui -- --port 43121      # 另开一个终端
curl -s localhost:43121/api/health
curl -s localhost:43121/api/scenes
curl -s -X POST localhost:43121/api/render -H 'content-type: application/json' \
  -d '{"input":"<scene.pkg 路径>","render":{"width":480,"height":270,"time":2.5}}'
```
