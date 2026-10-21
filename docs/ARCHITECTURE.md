# 架构与数据语义

## 决策

TypeScript 同构内核、React UI、Three.js 显示层、Node HTTP 与内置 SQLite。原仓库只有 README 与 MIT LICENSE，未发现 AGENTS.md 或既有数据。选择这些组件让编辑、脚本和后台渲染共享校验及逐帧求值，不依赖 Blender 运行时。REA 仅用于研究。

| 模块 | 职责 |
| --- | --- |
| `src/core/model.ts` | v1 模型、引用/层级/时间轴约束、工作流拓扑检查 |
| `src/core/commands.ts` | 有限结构化命令，复制状态、整批应用并校验 |
| `src/core/geometry.ts` | 自主基本几何、共享边中点细分、三角面法向挤出、OBJ 交换 |
| `src/core/evaluate.ts` | 插值、片段激活区间与源帧映射 |
| `src/render/` | Three.js 数据桥接、时间轴合成/媒体定位；导出复用同一模块 |
| `src/ui/` | 选择、属性、手柄、镜头、时间轴、素材、任务和审计入口 |
| `server/store.ts` | SQLite WAL、版本比较、原子快照/审计、跨重启历史 |
| `server/jobs.ts` | 队列、去重、取消、重试、中断标记、结果回写 |
| `server/render-worker.ts` | 限额工作线程、无界面 Chromium 逐帧渲染、FFmpeg 编码 |
| `server/index.ts` | 本机 API、媒体上传/范围读取、便携包和页面服务 |

工作线程与浏览器/编码子进程是独立执行层，HTTP 不直接逐帧渲染。尚不是分布式任务服务。重启将残留 running 标为 interrupted，queued 继续调度；重试使用原始快照。

## 数据模型

`Project` 包含 `Asset`、`Scene`、`Entity`、`Geometry`、`Material`、实体上的 `Light` / `Camera`、`AnimationTrack`、`Shot`、`Timeline`、`Workflow`、`Artifact`。`GenerationJob` / `Revision` 在同一数据库通过 projectId 和修订号关联，避免编辑反向改变运行任务。

- ID：UUID 创建，项目内命名对象唯一校验；引用不依赖名称。
- 空间：右手系、Y 向上、米；本地位置、XYZ Euler 弧度、非零缩放；父子关系限制同场景。UI 显示度数。子对象继承父变换/可见性。重设父对象保留本地变换，不保留世界姿态。
- 时间：零起点整数帧，区间 `[start, start + duration)`；1–120 整数帧率，尚无 24000/1001。源帧=`sourceIn + timelineFrame - start`。改帧率保留帧位置，秒数变化。
- 摄影机：透视垂直 FOV、near/far；镜头引用摄影机实体。
- 颜色：sRGB 输入、Three.js 线性着色、ACES 映射、sRGB 输出；只有基础色/粗糙度/金属度，无 OCIO 或专业校色保证。
- 几何：本地顶点/三角面；修改几何后，预览和导出读取相同数据。线性四分三角形不是平滑曲面细分。
- 素材：SHA-256 内容寻址，ffprobe 读取真实流信息；便携包 base64 嵌入素材并校验哈希。没有压缩包或缺失媒体重定位流程。
- 数据版本：schemaVersion=1；显式拒绝未知格式，不修改原文件。没有历史格式迁移实例，不宣称已覆盖升级迁移。

## 编辑、审计与任务

`POST /api/projects/:id/commands` 接收 `{baseRevision, actor, label, commands}`。服务检查来源，复制项目，应用整批命令并验证引用，然后在同一 SQLite 事务写入快照、撤销状态及审计。错误不写项目；版本冲突返回 409，客户端提示刷新，不自动覆盖。

撤销重做恢复快照，但修订号递增。恢复历史也是一次可撤销操作。actor 是本地声明的 user/agent 标签，不是经过认证的身份；后台产物登记用 system。没有任意 JS、shell 或用户插件执行入口。

任务固定快照并存 requestKey。逐帧黑底，按视觉轨道低到高合成镜头或媒体。FFmpeg 根据同一入点、开始帧和时长裁剪/延迟/混音，使用参数数组调用，不构建 shell 字符串。尚未支持的视频原声不会静默丢弃：非零原声音量会拒绝导出。

完成后保存实际字节数及 SHA-256，把 MP4 纳入素材，通过系统命令追加 Asset/Artifact 修订。当前编辑器需刷新同步，没有实时订阅。

只监听本机并检查变更来源，不是远程多租户安全方案。JSON 全量快照和包会占用内存，大型项目需增量事务及流式存储。媒体解码依赖浏览器/FFmpeg。H.264/AAC 及 FFmpeg 发行许可、专利需针对发行方案评估，相同效果不代表没有权利限制。
