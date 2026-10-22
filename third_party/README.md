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
| Chrome | 155.0.8059.82 | 用户已安装浏览器，遵从自身条款 |
| FFmpeg / ffprobe | 9.0.2 Gyan full shared | 外部进程媒体处理；本机 build 含 GPL/version3 组件，不随仓库分发；未来打包需核对构建配置、对应源码及 GPL 义务 |
| REA | 6.7.0 | 研究工具，不进入产品；自有代码 MIT，第三方另计 |
| Seedance / 火山方舟 | 由配置的模型/接入点 ID 决定；尚未真实调用 | 外部模型服务，适用供应商服务条款与账号权限；平台未分发模型权重或供应商 SDK，自主实现 HTTP 适配和任务管理，不将模型能力归为自研 |

[inventory.json](inventory.json) 来自实际 lockfile/安装包，记录 40 个已安装包的版本、许可、类别和未修改状态。全平台精确解析见 `package-lock.json`，许可文本见 [licenses](licenses/)。更新：`node scripts/notices.mjs`。

平台专用 esbuild/rollup 包未附独立 LICENSE，适用父项目 MIT，父项目许可已保留。REA 的完整第三方清单保留在本地安装包 `THIRD_PARTY_NOTICES.md`；本仓库不分发其依赖。

正式构建自动把本目录与根许可证复制到 dist，发布时须保留。正式发行需进一步核查编码专利、媒体来源及平台条款，不以自主实现声明替代许可审查。

默认几何/材质由本项目生成；检查音频是脚本合成正弦波，视频由本平台渲染。未使用 LibTV 社区素材或 Blender 示例。研究截图仅保留本地，不作为产品素材分发。
