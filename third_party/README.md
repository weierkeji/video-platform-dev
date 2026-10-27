# 第三方组件与来源

项目业务代码采用根 MIT LICENSE，版权 weierkeji。第三方能力不计为自主实现。

| 组件 | 实际版本 | 用途与许可 |
| --- | --- | --- |
| React / React DOM | 19.1.1 | UI，MIT |
| Three.js | 0.180.0 | WebGL/数学/视口手柄，MIT；未修改上游 |
| Zod | 4.1.11 | 校验，MIT |
| Node / 内置 SQLite | 24.20.0 | HTTP/文件/线程/持久化；Node 和内含组件各自许可，不打包 Node |
| Vite | 7.3.7 | 开发/构建，MIT；升级到审计修复版本，安装报告零漏洞 |
| TypeScript | 5.9.3 | 类型检查，Apache-2.0 |
| tsx | 4.20.6 | TS 服务/脚本，MIT |
| Prettier | 3.6.2 | 新代码格式化，MIT |
| Playwright Core | 1.56.0 | 后台浏览器和检查，Apache-2.0；不打包浏览器 |
| gltf-validator | 2.0.0-dev.3.10 | Khronos 官方开发校验器，Apache-2.0；无修改，保留 LICENSE/NOTICES（含 Dart 声明），不进入产品前端 |
| Chrome | 155.0.8059.82 | 用户已安装浏览器，遵从自身条款 |
| FFmpeg / ffprobe | 9.0.2 Gyan full shared | 外部进程媒体处理；本机 build 含 GPL/version3 组件，不随仓库分发；未来打包需核对构建配置、对应源码及 GPL 义务 |
| REA | 6.7.0 | 研究工具，不进入产品；自有代码 MIT，第三方另计 |
| Seedance / 火山方舟 | 由配置的模型/接入点 ID 决定；尚未真实调用 | 外部模型服务，适用供应商服务条款与账号权限；平台未分发模型权重或供应商 SDK，自主实现 HTTP 适配和任务管理，不将模型能力归为自研 |

[inventory.json](inventory.json) 来自实际 lockfile/安装包，记录 41 个已安装包的版本、许可、类别和未修改状态。全平台精确解析见 `package-lock.json`，许可文本见 [licenses](licenses/)。更新：`node scripts/notices.mjs`。

平台专用 esbuild/rollup 包未附独立 LICENSE，适用父项目 MIT，父项目许可已保留。REA 的完整第三方清单保留在本地安装包 `THIRD_PARTY_NOTICES.md`；本仓库不分发其依赖。

正式构建自动把本目录与根许可证复制到 dist，发布时须保留。正式发行需进一步核查编码专利、媒体来源及平台条款，不以自主实现声明替代许可审查。

默认几何/材质由本项目生成；检查音频是脚本合成正弦波，视频由本平台渲染。未使用 LibTV 社区素材或 Blender 示例。研究截图仅保留本地，不作为产品素材分发。

glTF 解析/序列化由本仓库按公开格式独立实现；Three.js 负责基础数学/渲染，其 GLTFLoader 仅用于独立读取检查。glTF 规范与商标属于 Khronos，未作完整合规或认证声明。`scene-exchange` 的几何和材质由原创脚本生成，MIT；导入资产的 copyright 元数据随 Scene 保存和重新导出，不能把该字符串视为自动获得资产许可。

0.7 没有新增依赖或修改第三方源码。图片解码来自浏览器，GPU 采样/着色来自 Three.js；贴图资源生命周期、UV 投影和格式映射为本仓库实现。`pbr-textures` 的几何、PNG 像素与生成脚本为原创 MIT 资源，未复制 Blender/LibTV 或其他第三方图片。KHR_texture_transform / EXT_texture_webp 语义来自 Khronos 公开格式，不代表完整合规或认证。

0.8 没有新增依赖或修改第三方源码。动作与命令、SLERP/Hermite 求值及动画文件映射在本仓库实现，遵循公开数学和 glTF 格式；Euler/四元数转换和显示使用 Three.js 数学/渲染。其 GLTFLoader/AnimationMixer 作为开发中的独立读取/取样对照。`animation-exchange` 的几何、材质、动作与生成脚本为原创 MIT 资源，无外部人物/模型/动画素材。

0.9 没有新增依赖或修改第三方源码。镜头/片段动作继承、恒速/循环/往返映射和切分相位为本仓库实现；Blender 4.5 手册仅用于公开功能行为研究，不复制其界面、源码或资产。`action-montage` 使用本项目已有原创几何和动作，经自身渲染流程生成，无外部素材或模型调用。

0.10 没有新增依赖或修改第三方源码。对象动作层、权重包络、顺序/通道和增量规格为自主实现；基础四元数相乘/求逆使用 Three.js，球面插值复用本项目求值。Blender 4.5 NLA 手册与 4.4 API 文档仅作公开行为参照，不执行 bpy；缩放增量规格不同于 Blender Combine。`object-layers` 使用已有原创长方体和新编写的动作、层与摄影机数据，自身渲染输出；检查参考使用手算姿态和 Three.js 数学，无外部人物/动画素材。

0.11 没有新增依赖或修改第三方源码。采样事件映射、精度拒绝、边界保护、探测误差和新动作命令为本仓库实现；GUI Worker 来自浏览器基础能力。Blender 4.5 Bake Action 文档仅作行为参照，glTF 2.0 语义来自 Khronos；Three.js 加载器/AnimationMixer 和 gltf-validator 用作独立读取/格式检查，不是自研。`baked-layers` 源自已有原创作品，新写保持段/往返调度，经本平台烘焙、重导入及渲染，无外部素材或模型调用。

0.12 没有新增依赖或修改第三方源码。蒙皮数据、命令、权重/拓扑传播、CPU 线性混合与编辑辅助为本仓库实现；矩阵/向量运算和最终显示仍来自 Three.js。Khronos glTF 2.0 规范/Skins 教程、Blender 4.5 Armature 文档仅提供公开行为依据，未复制其资源、角色、动画或求解实现。使用已安装 Three.js GLTFLoader 源码核对缺法线时的平面着色行为，并以其 SkinnedMesh/AnimationMixer 独立核对顶点；其实现不属于自研。`scripts/skin-fixture.ts` 自行生成分段柱体、关节、权重和运动，`skin-sculpture` / `skin-pose` 由本平台输出，无外部素材或模型调用。
0.13 没有新增依赖或修改第三方源码。约束模型/命令、依赖拓扑排序、空间转换、朝向差值、QR 仿射混合和烘焙整合为本仓库根据公开数学独立实现；Matrix4/Quaternion/Vector3 基础运算与 WebGL 显示仍来自 Three.js。Blender 4.5 的公开约束文档只作为行为参照，不执行其程序或复制求解代码；glTF 格式规则来自 Khronos。`target-study` 的目标运动/摄影机控制由本仓库编写，沿用原创分段柱体和关节，无外部角色、素材或模型生成。

0.14 没有新增依赖或修改第三方源码。双段几何解、IK 链数据/命令、分组依赖、极向控制、矩阵重建和编辑整合由本仓库编写；多段求解采用 Aristidou / Lasenby 的公开 FABRIK 算法（Graphical Models 73，2011，243–260，[作者论文](https://andreasaristidou.com/publications/papers/FABRIK.pdf)），算法不归为本项目发明，没有复制第三方求解代码。Three.js 仍提供基础数学/显示；Blender 手册仅为公开行为参照。ik-reach 的控制器、曲线和摄影机沿用本仓库原创分段柱体/蒙皮，无外部素材或模型调用。

0.15 没有新增依赖或修改第三方源码。参考姿态限角、摆动/扭转投影、可行初值、有限线搜索及 UI 为独立实现；CCD 是公开算法，参照 Ben Kenwright《Inverse Kinematics – Cyclic Coordinate Descent (CCD)》（Journal of Graphics Tools 16(4)，DOI 10.1080/2165347X.2013.823362），不归为本项目发明，未复制其求解源码。Blender 4.5 文档仅提供行为依据；Three.js 仍提供数学/渲染。limited-reach 复用自有雕塑/权重，合法姿态与目标曲线由本仓库编写，无外部素材或模型调用。

0.16 没有新增依赖或修改第三方源码。单值 IK 轨道、动作/层路由、依赖激活、编辑命令与烘焙事件为本仓库实现，复用已有自主 Bézier/Hermite 曲线计算。Blender 4.5 约束/IK/曲线文档仅作行为参照；不是对其内部求解语义的复制。control-transition 的参数曲线与层由本仓库编写，沿用原创雕塑/权重/摄影机；无外部素材或模型调用。Three.js 数学、渲染、独立 GLTFLoader 检查和 gltf-validator 仍明确属于第三方。

0.17 没有新增依赖或修改第三方源码。基础姿态/固定频道参考、绑定补偿、编辑命令与 UI 为自主实现；补偿关系来自通用矩阵代数与 Khronos 公开线性蒙皮公式，不归为本项目发明。Blender 4.5 骨架编辑/摆姿说明仅作行为参照，未复制其内部实现。Three.js 提供基础数学/渲染，GLTFLoader/AnimationMixer 与 gltf-validator 用于独立读取/检查。rest-sculpture 沿用原创分段柱体/权重，自行编写基础姿态和摄影机约束；无外部素材、角色或模型生成。

0.18 没有新增依赖或修改第三方源码。FK/IK 匹配、层反算、控制器转换、事务姿态验收及完全折叠双段语义由本仓库按公开矩阵/四元数数学独立实现，不复制 Rigify 控制器/求解源码。Blender 4.5 IK 与另行标注的 Rigify 5.1 文档仅提供公开行为参照；Three.js 仍提供数学/渲染与独立 GLTFLoader/AnimationMixer，gltf-validator 用于格式检查。matched-controls 沿用原创雕塑/权重，自行编写基础偏移与 FK/IK 接续关键帧，无外部角色、动作资产或模型生成。

0.19 没有新增依赖或修改第三方源码。骨架映射、参考坐标转换、QR 方向转移、根位移与命令/UI 由本仓库按通用矩阵/四元数数学独立实现，不复制 Unreal/Blender 的重定向器或私有代码。Epic 公开参考姿态/映射说明仅作另行标注的行为参照；Blender 4.5 指定页面直取失败已记录。Three.js 提供基础数学/渲染与独立加载对照，gltf-validator 检查格式。retargeted-performance/retargeted-pose 使用原创分段柱体、权重、两套骨架与自编动作；无下载角色、动捕或 AI 生成资产。REA 本机 6.7.0 MIT 保留，当前 main 的更高 Node 要求单独记录，未升级工具或安装原生分析引擎。

0.20 没有新增依赖或修改第三方源码。曲线分段、Bernstein 差界、四元数区间界、保护规则与事务/worker/UI 由本仓库按通用数学独立编写；Blender 3.6 / 5.3 dev 与 main 官方说明仅用于识别用户行为，没有复制或调用其精简器。glTF 2.0 规范用于交换语义，Three.js 提供基础数学/渲染及独立加载对照。reduced-performance/reduced-pose 继续使用原创柱体、骨架/权重/动作，添加自主摄影机曲线；无下载资产或 AI 生成。REA 本机 6.7.0 MIT 保持，最新 main 环境要求单独记录，本单元未运行其分析引擎。

0.21 没有新增依赖或修改第三方源码。五点探测、Float32 中点细分、工作量/输出判定、命令和 UI 为自主实现；Blender 4.5 官方 NLA 文档、另行标注的 Maya 2024 Smart Bake 说明仅作公开行为参考，没有复制求解源码。非四分点是通用数值探测选择，不提供积分或误差证明声明。Three.js 继续提供数学/渲染和独立加载对照，FFmpeg 实际编码；adaptive-performance/adaptive-pose 沿用原创几何、权重/骨架/动作并增加自编摄影机曲线，无外部下载资产或 AI 生成。REA 当前文档/许可/要求已核对，本机 6.7.0 保持，未运行额外分析引擎。

0.22 没有新增依赖或修改第三方源码。批量选择、最终键集合变换、碰撞拒绝、Bézier 时间控制点/Hermite 导数换算和 UI/命令为本仓库独立实现。Blender 4.5 官方 Graph Editor 选择/编辑说明只作公开行为参考，没有复制其选择器或变换源码。Three.js 继续提供基础数学/渲染与独立 GLTFLoader/AnimationMixer，FFmpeg 生成实际影片。key-editing 使用自建立方体、材质及自编三轨动作，无下载动作资产或 AI 生成。REA 6.7.0 MIT 保持，当前 main 环境要求单独记录，本单元未执行其分析引擎。

0.23 没有新增依赖或第三方源码修改。父级补偿、整场景姿态验收、视口频道反算和命令/UI 为本仓库按通用矩阵数学独立编写；Blender 3.0 官方 Parent 文本与 4.5 页面搜索结果仅用于公开行为参考，没有复制其实现。Three.js 提供矩阵/渲染/手柄及独立 GLB 读取，FFmpeg 编码影片。parented-animation 沿用原创蒙皮柱体、骨架、权重，增加自建方块和 Hermite 曲线，无下载模型或 AI 生成资产。REA 6.7.0 MIT 保持，当前 main 更高 Node 要求单列，未运行额外引擎。

0.24 没有新增依赖或第三方源码修改。有序选择、活动对象、父子成组变换算法、频道反算、原子命令及交互为本仓库独立实现；Three.js 提供矩阵、基础图形、TransformControls 与包围框显示，FFmpeg 编码影片，Khronos 校验器检查 GLB。Blender 4.5 官方选择/枢轴文档只作公开行为参照，未复制源码或视觉资源。grouped-motion 使用自建方块、材料与动画，无下载/生成资产。REA 6.7.0 MIT 保持，当前文档/许可/环境要求已复核，没有额外引擎运行声明。

0.25 没有新增依赖或第三方源码修改。子树/依赖闭包、内部引用映射、确定批次 ID、复制数据策略、命令与 UI 为本仓库独立编写。Blender 4.5 Duplicate/Outliner 的公开搜索文本仅提供对象/数据共享行为参照，没有复制其实现或素材；直取失败如实记录。copied-assembly 复用本仓库原创柱体、骨架与权重，增加自主装配/双附件/控制动作和层；Three.js 显示，FFmpeg 编码，Khronos 校验 GLB。REA 当前官方能力/安装/MIT 已复读，保留本地 6.7.0，无额外引擎执行声明。

0.26 没有新增依赖或第三方源码修改。全项目数据用户统计、按组/逐对象独立化、输入/容量检查、事务与 UI 为本仓库独立实现；Blender 4.5 Data-Blocks/Make Single User 的官方搜索抓取仅提供用户数量及复制引用的公开行为参考，直接页面 402 未绕过。independent-sculptures 复用本仓库原创分段柱体、骨架和动作，自编 16×16 方格 PNG，无下载模型、图片或生成资产。Three.js 提供渲染/数学，FFmpeg 编码，Khronos 校验 GLB；REA 本地 6.7.0 MIT 保留，未运行额外引擎。
