# 2026-10-21：统一项目、编辑与时间语义

## 工具与来源

已先读 REA 官方 README、LICENSE、package.json、浏览器观察契约。读取日期 2026-10-21，main 包版本及实际安装均为 6.7.0。REA 自有代码 MIT，第三方分别保留许可；要求 Node 22.19+ 的 22.x、24.11+ 的 24.x 或 26+。本机 Node 24.20.0 满足。只在 `.local/research-tools` 安装 CLI，不改全局 Agent 配置；使用浏览器 CDP，不安装 Hopper/Ghidra 等原生引擎。包依赖含可选分析组件，但未执行其原生安装脚本或分析引擎。

- [REA 官方仓库](https://github.com/morluto/rea)
- [REA LICENSE](https://github.com/morluto/rea/blob/main/LICENSE)
- [REA 浏览器观察契约](https://github.com/morluto/rea/blob/main/docs/browser-observation.md)
- [Blender 4.5 LTS 时间轴](https://docs.blender.org/manual/en/4.5/editors/video_sequencer/sequencer/navigating.html)
- [Blender 4.5 LTS 插值](https://docs.blender.org/manual/nb/4.5/editors/graph_editor/fcurves/properties.html)
- [Blender 4.5 LTS 场景片段](https://docs.blender.org/manual/id/4.5/video_editing/edit/montage/strips/scene.html)
- [Blender 4.5 LTS 音频片段](https://docs.blender.org/manual/id/4.5/video_editing/edit/montage/strips/sound.html)
- [Blender 4.5 LTS 数据恢复](https://docs.blender.org/manual/es/4.5/troubleshooting/recover.html)
- [LibTV 公开首页](https://www.liblib.tv/)

部分 Blender 英文页面被抓取服务拒绝，改用返回的官方搜索结果及可访问语言路径；没有运行 Blender 或直接检查 .blend 文件。结论仅代表公开说明。LibTV 可见标签 v1.5 不代表精确服务器/客户端构建版本。

## R1：编辑如何跨入口校验、保存与恢复？

1. 对象/版本：Blender 4.5 LTS 数据恢复说明；本平台格式 v1。
2. 输入/步骤：阅读自动保存、历史撤销与保存副本说明，列出编辑、关闭、重开、撤销需求。
3. 观察输出：文档分开描述会话撤销与磁盘恢复；未获得内部事务实现。
4. 证据：官方数据恢复链接；自有运行依据为 `tests/core.test.ts` 的 SQLite 重开及 `scripts/smoke.ts` 浏览器操作。
5. 确认：误操作回退与崩溃恢复是不同能力。
6. 推断：统一命令与原子快照可支撑多入口，是本平台设计，不是 Blender 内部结论。
7. 未知：Blender 依赖图、撤销结构、大型文件恢复细节。
8. 独立规格：有限命令、整批校验、乐观版本、SQLite 事务、跨重启历史、单调修订；Agent 同入口且记调用者标签。

## R2：关键帧、镜头和剪辑如何共享时间？

1. 对象/版本：Blender 4.5 LTS F-Curve、场景片段与时间轴说明。
2. 输入/步骤：比较保持/线性/曲线插值，阅读摄影机覆盖、播放头与片段来源。
3. 观察输出：关键帧间存在不同插值；时间轴可引用场景/摄影机；播放头跨编辑器同步。
4. 证据：上述插值、场景片段及导航文档；本项目半开边界检查和真实 24 帧导出。
5. 确认：镜头从场景取得画面；场景预览与最终渲染可能采用不同着色路径。
6. 推断：统一源帧映射避免两条路径各自计算时间；这是独立设计。
7. 未知：精确亚帧、复杂 Bézier、NLA 语义；不声称等价。
8. 独立规格：整数零起点、半开区间、源入点映射、共用求值；保持/线性/smoothstep，不把后者称为 Bézier。

## R3：LibTV 可公开确认哪些工作流入口？

1. 对象/版本：2026-10-21 未登录首页，可见 v1.5；Chrome 155.0.8059.82、REA 6.7.0。
2. 输入/步骤：`node scripts/research.mjs` 用独立浏览器打开首页、截图，再执行 `inspect-web-page`；精确 origin，1 秒观察，只额外请求无障碍文本。
3. 实际输出：REA 成功，1950 个 DOM 节点；可见项目、资产、画布、Agent、视频/图片/音频/剧本生成和剪辑入口。
4. 证据：[可提交摘要](2026-10-21-libtv-evidence.json)；原始 JSON、截图、文本在 `.local/research/`；摘要含原始哈希与 evidence ID。
5. 确认：这些是公开入口，不是具体功能执行的证据。
6. 推断：项目、素材、生成结果需要引用关系，因此本平台选统一 ID、素材库、异步任务；这是独立产品设计。
7. 未知/限制：completeness=`policy_filtered`；先前网络活动不可见、跨域内容受限；未捕获脚本源、存储值、私有接口、服务器算法、权重、生成取消/恢复行为。未捕获不代表不存在。
8. 独立规格：类型化 DAG、连接检查、删除清理依赖、任务快照、进度/取消/重试/产物回库。先执行本地真实渲染节点；外部节点需正式接口适配，当前明确拒绝生成。

## 来源边界与下一项

实现输入是独立规格、通用算法和许可明确的组件。未复制 Blender/LibTV 源码、反编译内容、界面、图标、社区素材或内部数据。研究证据不导入产品代码，文档正文不进入产品。

下一项研究：Seedance 正式接口的模型标识、提交/查询/取消、结果有效期；可编辑动画曲线与片段源时间。不得从 LibTV 前端推断供应商内部接口。
