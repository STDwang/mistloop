# 资产清单与许可 · ASSETS

> 本项目遵守 `docs/CLAUDE.md` 的资产纪律：**零下载素材**。
> 2026-10-08 经用户批准修订：允许两类**自产**资产 ——
> ① 运行时程序化生成；② ImageGen 自产贴图 + Blender 自建模型。

---

## 1. 外部资产

| 类别 | 数量 | 说明 |
|---|---|---|
| 3D 模型 | **0**（Blender 自建 2 件，见 §1.6） | 场景仍全部由 Three.js 基元构造 |
| 贴图 | **6**（ImageGen 自产） | `code/public/textures/`，见 §1.5 |
| 音频 | **0** | 全部由 Web Audio 合成 |
| 字体 | **0** | 使用系统字体栈 |
| 图标 | **0** | 无图标 |

### 依赖

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `three` | ^0.186 | MIT | 渲染（含 GLTFLoader，加载自建角色） |
| `vite` | ^8.3 | MIT | 构建（开发依赖） |

**外部资产体积：贴图 913 + 685 KB（JPEG q88）+ 模型 2 229 KB ≈ 3.8 MB（≤ 6 MB 预算）。**

---

## 1.5 自产贴图登记（ImageGen）

全部由内置 ImageGen 生成、`assets/prep-textures.py` 后处理
（裁水印 6% → roll+cross-fade 可平铺化 → JPEG q88）。

| 文件 | 内容 | 用途 | 体积 | 加载方 |
|---|---|---|---|---|
| `bark.jpg` | 湿的深色针叶树皮，纵向纹理 | 树干（`forest.js` 两类枯树） | 235 KB | `core/textures.js` |
| `ground.jpg` | 湿林地：落叶/苔藓/泥 | 地形（`terrain.js`），与顶点色相乘 | 329 KB | 同上 |
| `rock.jpg` | 湿花岗岩 + 地衣 | 山洞石块（`safehouse.js`） | 349 KB | 同上 |
| `char-coat.jpg` | 风湿的深橄榄羊毛外套布料（增益 ×1.4） | 玩家外套（`M_Coat`） | 236 KB | `core/characters.js` |
| `char-dress.jpg` | 灰白破旧亚麻裙布，污渍霉斑 | 女鬼裙（`M_GDress`） | 366 KB | 同上 |
| `char-skin.jpg` | 尸白皮肤：灰白底 + 青筋斑驳 | 玩家脸（`M_Skin`）+ 女鬼皮肤（`M_GSkin`） | 123 KB | 同上 |

**法线贴图不落盘**：运行时由 `core/textures.js` 对明度做 Sobel 推导（512²，几毫秒），
省下每张约 1.5 MB 的文件体积。

**许可**：ImageGen 产物归本项目使用，无第三方版权。
原始 PNG 存于 `assets/textures-src/`（约 6 MB，不进构建）。

**重新生成**：改贴图后跑
`"C:/Users/19462/.workbuddy/binaries/python/envs/default/Scripts/python.exe" assets/prep-textures.py [名称…]`
（缺省 = bark ground rock；角色贴图 = char-coat char-dress char-skin；亮度增益见脚本 `GAINS`）

---

## 1.6 自建模型登记（Blender → glTF）

两件角色模型在 Blender 5.2 中用基元拼装 + 噪声位移建成
（SAFE_MODE 白名单内脚本，`assets/render/` 存有各轮检查渲染图），
UV 智能投影，导出 GLB（Y-up，Blender +Y 朝前 = three.js −Z 朝前）。

| 文件 | 内容 | 面数 | 体积 | 关节/枢轴 |
|---|---|---|---|---|
| `player.glb` | 玩家：外套躯干/头/发/双臂/双腿/双靴/背包（10 部件，M_Coat 等 6 材质） | 15 394 | 2 083 KB | 肩 y=1.45，髋 y=0.90，与 avatar.js 步态枢轴一致 |
| `ghost.glb` | 女鬼：拖地破裙（替代腿，滑行设定）/苍白双臂垂至膝/歪头/覆面长发壳（脸窗露一线苍白脸）（5 部件，M_GDress 等 3 材质） | 2 782 | 146 KB | 肩 y=1.95，绕肩微风摆动 |

**加载与容错**：`core/characters.js` 把 glTF 节点变换烘焙进几何体
（角色空间，脚底 y=0），网格挂进既有枢轴组 —— 步态/蹲伏/冻结动画代码零改动。
加载失败时保留基元拼装的 fallback（游戏永不黑屏）。
角色贴图由 `applyCharacterTexture` 异步挂到**命名材质**上，缺文件保持纯色。

**重新生成**：Blender GUI 打开 → 重建脚本见会话记录；导出用
`bpy.ops.export_scene.gltf(use_selection=True, export_format='GLB', export_yup=True, …)`

---

## 2. 程序化资产登记

以下是本项目实际"生成"的资产，全部由代码产出，无需许可。

### 2.1 几何

| 名称 | 生成方式 | 面数量级 | 位置 |
|---|---|---|---|
| 地形网格 | `PlaneGeometry` + 周期 fBm 顶点位移 | ~100k tri | `world/terrain.js` |
| 枯树 · 高瘦型 | 圆台躯干（顶点弯曲）+ 7 根下垂枝桠，`mergeGeometries` 合并 | ~300 tri | `world/forest.js` |
| 枯树 · 树桩型 | 矮粗圆台（分段位移）+ 3 根断枝 | ~180 tri | `world/forest.js` |
| 蕨草广告牌 | 十字交叉双四边形 | 4 tri | `world/undergrowth.js` |
| 身影剪影 | 基元 fallback（躯干 + 头 + 双臂 + 双腿）；GLB 到货后换装 `ghost.glb` | ~500 tri / 2 782 | `entities/stalker.js` |
| 玩家化身 | 基元 fallback；GLB 到货后换装 `player.glb` | ~800 tri / 15 394 | `player/avatar.js` |
| 残破石龛 | 双立柱 + 倒伏横梁 + 碎石环 + 锈灯 + 阶段附加件 | ~400 tri | `world/landmark.js` |
| 手电光锥 | `ConeGeometry`（开口）+ 加性着色器 | 64 tri | `player/flashlight.js` |

### 2.2 程序化贴图（全部 ≤ 512²，可平铺）

| 名称 | 生成方式 | 尺寸 | 用途 |
|---|---|---|---|
| 地面污渍 | Canvas 多八度值噪声 + 斑块 | 256² | 地面混合层 |
| 雾团 alpha | 径向渐变 + 噪声扰动 | 128² | 水汽粒子 / 雾墙 |
| 蕨草 alpha | 绘制 ~28 根锥形叶片 + 随机弯折 | 256² | 草丛广告牌 |
| 雨丝 alpha | 垂直渐变细线 | 16×64 | 雨 |

### 2.3 音频（全部 Web Audio 合成）

| 名称 | 生成方式 |
|---|---|
| 噪声底 | 4 秒白噪 `AudioBuffer`（循环） |
| 呼吸包络曲线 | 双高斯拟合，烘焙进 `WaveShaper.curve`（1024 点） |
| 心跳包络曲线 | 双峰高斯（lub-dub），烘焙进 `WaveShaper.curve` |
| 所有一次性音效 | 运行时构造振荡器/噪声 + 包络，用完即弃 |

---

## 3. 若未来引入外部素材（预留）

若要加强真实感而引入采样音（例如**真实林地环境录音**），必须遵守：

1. 仅接受 **CC0 / CC-BY / Public Domain**
2. 逐个登记到本文件下表
3. 单个文件 ≤ 2 MB，采样率 ≤ 44.1 kHz，单声道优先
4. 优先来源：`freesound.org`（**筛选 CC0 授权**）、`opengameart.org`

| 文件名 | 来源 URL | 作者 | 许可 | 用途 | 大小 |
|---|---|---|---|---|---|
| —（空） | | | | | |

> **注意**：引入采样音会破坏"零资产"这条约束带来的部署优势（网络受限环境下无外部请求）。
> 若要引入，必须同时提供**程序化回退**：采样加载失败时自动退回合成方案。
