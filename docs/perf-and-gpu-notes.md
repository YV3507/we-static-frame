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

GPU 编译报错的行号是**归一后源码**的行号（shim 头约 60 行）：
- 报 `0:79: 'v_TexCoord': undeclared identifier`（当前提交版）**对应原文件 L18 的写操作**；
- 该 shader 归一后共 99 行，`varying vec2 v_TexCoord;` 落在 L78。

⇒ 归因成立，但**降级局部变量会打破声明顺序**：
`varying` 原先被 `hoistTopLevelUniforms` 提到函数之前，改成局部后不再提前，
一旦 helper 函数写在声明之前就报 `undeclared identifier`（我实测到过这一形态）。

**正确修法（未完成）**：保留 `varying` 声明（供插值读取），只把**片元里对该 varying 的
赋值**改写到"提升到文件最前"的局部别名上，例如：

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
