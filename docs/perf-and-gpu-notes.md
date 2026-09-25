# filmgrain / auto_sway / GPU 相关：本机场景与效果索引（给后续接手用）

生成时间：本轮会话。**本文件是一次性排查笔记，不当源码使用。**

## 效果 → 场景索引（`workshop/431960`，共 24 条目：16 可渲染 / 6 Video / 2 Web）

| 效果 | 出现场景 | 备注 |
|---|---|---|
| `filmgrain` | `3641860575`（后处理层）、`3690417937`（Post-processing Layer） | 参数名 bug 已修（`bce59f3`） |
| `auto_sway` | `3641860575`（cat/w、窗帘1、窗帘2、树叶r1）、`3486806915`、`3640755971`、`3554161528` | 工坊 `effects/workshop/3235948233`；CPU 逐像素跑完即被丢弃 → 退化负缓存可省（见 `0002db4`） |
| `bokeh_blur` | `3641860575` | 工坊 `effects/workshop/2798319181`；数据通路多 pass |
| `bloom` | `3461168300` | 官方 `effects/bloom`；数据通路多 pass |
| `blurprecise` | `3461168300`×2 | 官方 |
| `geometric_transform` | `3641860575`（云1..4） | 工坊 `effects/workshop/3157623591`；**片元写 varying**（见下） |

## "片元写 varying" 的三个 shader（场景包内）

用 `.test-tmp/find-written-varying.mjs` 扫出（`<scene.pkg> [id]`）：

```
shaders/workshop/3157623591/effects/geometric_transform.frag   写 v_TexCoord  首处 L18
shaders/workshop/3082978660/effects/Simple_Audio_Bars.frag     写 v_TexCoord  首处 L215
shaders/workshop/3235948233/effects/auto_sway.frag             写 v_TexCoord  首处 L447
```

`geometric_transform` 形态（WE/dx 允许，WebGL/ANGLE 拒绝）：
```glsl
varying vec2 v_TexCoord;                                  // L11
v_TexCoord.y += offset * u_osStrength;                    // L18/L19 ← 写
v_TexCoord.x = mix(v_TexCoord.x, ...);                    // L21
vec4 albedo = texSample2D(g_Texture0, v_TexCoord.xy);     // L23
```
ANGLE 报：`'l-value required (can't modify a varying "v_TexCoord")`。

## 关键坐标（错误行号 ↔ 源码位置）

**先看这条，能省一整轮**：编译错误必须**分步**看（frag 编译 / vert 编译 / link 三步各自的
`getShaderInfoLog` / `getProgramInfoLog`），否则报错行号会指到你没在读的那份源码上。
我为此浪费了两轮 —— `texture_override` 的报错一直在 **vert**，而我盯着 316 行的 frag 解读，
于是"行号对不上"看起来像编译器 bug，其实是我读错了文件。
复现脚本：`.test-tmp/dbg-stages.mjs <效果名> [scene.pkg]`（分别编译三步并打印完整 log）。

```js
// gl-effect.js 的 compileShader 只抛 getShaderInfoLog；要分步请自己 createGLContext 后逐个编译
const gl = createGLContext(64, 64);
const sh = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(sh, vert); gl.compileShader(sh);
gl.getShaderParameter(sh, gl.COMPILE_STATUS); gl.getShaderInfoLog(sh);
```

GPU 编译报错的行号是**归一后源码**的行号（shim 头约 60 行）：
- 报 `0:79: 'v_TexCoord': undeclared identifier`（当前提交版）**对应原文件 L18 的写操作**；
- 该 shader 归一后共 99 行，`varying vec2 v_TexCoord;` 落在 L78。

⇒ 归因成立，但**降级局部变量会打破声明顺序**：
`varying` 原先被 `hoistTopLevelUniforms` 提到函数之前，改成局部后不再提前，
一旦 helper 函数写在声明之前就报 `undeclared identifier`（我实测到过这一形态）。

**正确修法（未完成）**：保留 `varying` 声明（供插值读取），只把**片元里对该 varying 的
赋值**改写到"提升到文件最前"的局部别名上，例如：

## ⚠ 重要否证：「能编译」≠「该启用」（务必先读）

`texture_override` 的 GPU 失败根因已确认在 **vert**：

```glsl
vec2 scale  = g_Texture0Resolution / g_Texture1Resolution;   // vec4 / vec4 → 赋给 vec2
vec2 offset = g_TexOffset / g_Texture0Resolution;            // vec2 / vec4 → 运算本身非法
```
DX 宽松语义允许（按目标维度取前 N 分量），WebGL 拒绝。

- **语义确实一致**：`glsl/transpile.js::declInit`（P1-35）就是按声明类型取前 N 分量。
  数值验证：CPU 跑 `vec4(1,2,3,4)/vec4(1,1,1,1)` 赋给 `vec2` → 得到 `(1,1)`，与补 `.xy` 等价。
- 只对**赋值右侧整体维度可静态确定**的行补 `.xy/.rgb`（不碰 `vec2/vec4` 这类运算级非法写法），
  全库 GPU 可编译数 **195 → 206（+11）**，`texture_override` 三步全通过。

**但最终没有提交**，因为出现了这个信号：

```
改前: GPU 模式 降级 6（与 CPU 一致）
改后: GPU 模式 降级 2      ← 4 个 auto_sway 不再被退化保护拦下
```

直接测量那 4 个效果的 GPU 输出：**整幅纯黑、平均亮度 0.0（确实退化）**。

⇒ 结论：**编译通过会让某些效果的"早失败"变成"晚失败"**，而退化保护的判据
（`sa.uniRgba && !sb.uniRgba`）在**整幅纯黑但输入本身单色**时会失效 ⇒ 退化输出被当成正常结果应用。
CPU 路径之所以看起来"正常"，只是因为它在编译期就失败了、根本没跑（效果=未应用）。
**这不是"GPU 修好了"，是"把编译期失败推后成了运行期退化且没被拦住"。**

**下一步的正确顺序**（不要跳过）：
1. 先给 GPU 路径补上与 CPU 侧同强度的**输出退化检查**（或让 `_tryEffectGpu` 在返回前做同样的
   `stat()` 判据），确保"晚失败"也被拦住；
2. 再启用维度截断归一，并用"CPU/GPU 输出对照"（而非仅"能否编译"）作为验收门槛；
3. 验收脚本建议：对每个"新增可编译"的效果，比较 CPU 与 GPU 结果的退化性与像素统计。

## ⚠⚠ 复测确认（本轮追加，务必先读）——两条会让判读全错的陷阱

启用维度归一后，`auto_sway` 的 GPU 输出实测为 **`mean=0, cov=0, colors=1`（全透明黑）**，
确属退化。但我在复测过程中**两次**得到过相反的"看起来正常"读数，原因值得记录：

**陷阱 1：把 CPU 回退的结果当成 GPU 的结果。**
`auto_sway` 的 GPU 尝试在两次失败后已被**拉黑**，此后 `_tryEffectGpu` 直接返回 null、
走 CPU。于是我在外层包装里看到的"输出"其实来自 CPU 回退，却误读成"GPU 也跑对了"。
⇒ **要判定 GPU 输出，必须在 `_tryEffectGpu` 返回非 null 时读取**，或直接调用它并检查返回值；
不能只看最终的图层输出。

**陷阱 2："退化"的判据必须带 alpha。**
这些图层是**纯色层**（输入 `mean=255, cov=100, colors=1` —— RGB 单色、靠 alpha 显形），
GPU 退化的结果是**全透明**（alpha=0）而不是"RGB 单色"。只比 RGB 会得出"输出仍是单色、
与输入同类"的错误结论。
⇒ 判据用 `RGBA 四通道是否同值`（`cov=0` 即全透明也算退化），与 effects.js 的 `uniRgba` 同口径。

**结论**：维度截断归一本身语义正确（与 CPU 解释器的 HLSL 截断一致、且能让 11 个效果编译通过），
但**启用它会把 `auto_sway` 这类效果的"编译期失败（效果=未应用）"变成"运行期全透明退化"**，
而后者会被退化保护的"输入本身是单色"豁免规则放过。当前兜底（`isFlatRgba`，见 adapter.js）
也未拦住它 —— 该判据只覆盖"整幅同一 RGBA"，而这里是"alpha 全 0 / RGB 全 0"，需要按
"全透明 + 覆盖度塌陷"单独判。**在补齐这条之前不要启用维度归一。**


```glsl
// 文件最前（与 uniform 一同提升）
vec4 we_vtc;
// main 开头
we_vtc = v_TexCoord;
// 片段体内
v_TexCoord.y += x;   →   we_vtc.y += x;
```

## 复现与验证脚本（.test-tmp/，均按 `node <file> [args]` 跑）

| 脚本 | 用途 |
|---|---|
| `find-written-varying.mjs <scene.pkg>` | 扫出"声明并写 varying"的 frag |
| `find-undeclared.mjs [scene.pkg]` | 对场景内全部效果做 WebGL 归一，找"未声明即写" |
| `gpu-primitive.mjs` | GPU 单 pass 成本 vs 分辨率（实测 1080p 单 pass 2.96ms） |
| `perf-clean.mjs <id> [--gpu]` | 逐效果摘除测耗时（单调时钟、3 次中位） |
| `perf-gain.mjs` | 负缓存净收益对照 |
| `fg-diverge.mjs` | filmgrain 官方 GLSL vs 手写内核逐项对拍 |

## 本机环境

- 场景根：`E:\SteamLibrary\steamapps\workshop\content\431960`
- WE assets：`E:\SteamLibrary\steamapps\common\wallpaper_engine\assets`
- 剖析入口：`node scripts/profile-scene.mjs <scene.pkg> [--w N] [--h N] [--gpu]`
