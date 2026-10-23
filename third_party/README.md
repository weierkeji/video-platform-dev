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
