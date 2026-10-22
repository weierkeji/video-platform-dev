# 架构与数据语义

## 决策

TypeScript 同构内核、React UI、Three.js 显示层、Node HTTP 与内置 SQLite。原仓库只有 README 与 MIT LICENSE，未发现 AGENTS.md 或既有数据。选择这些组件让编辑、脚本和后台渲染共享校验及逐帧求值，不依赖 Blender 运行时。REA 仅用于研究。

| 模块 | 职责 |
| --- | --- |
| `src/core/model.ts` | v3 模型、v1/v2 迁移、引用/层级/时间轴约束、工作流拓扑检查 |
| `src/core/generation.ts` | 生成参数、模型系列限制、不可变请求规格 |
| `src/core/commands.ts` | 有限结构化命令，复制状态、整批应用并校验 |
| `src/core/geometry.ts` | 自主基本几何、共享边中点细分、三角面法向挤出、OBJ 交换 |
| `src/core/evaluate.ts` | 插值、片段激活区间与源帧映射 |
| `src/core/media.ts` | 居中画幅矩形、音频源入点与采样边界 |
| `src/render/` | Three.js 数据桥接、时间轴合成/媒体定位；导出复用同一模块 |
| `src/ui/` | 选择、属性、手柄、镜头、时间轴、素材、任务和审计入口 |
| `server/store.ts` | SQLite WAL、版本比较、原子快照/审计、跨重启历史、升级备份与迁移记录 |
| `server/media.ts` | 实际流探测、音轨偏移、48 kHz 立体声混音参数 |
| `server/jobs.ts` | 队列、去重、取消、重试、中断标记、结果回写 |
| `server/seedance.ts` | 官方 HTTP 适配、凭据读取、输入图片、响应校验和脱敏错误 |
| `server/generation-jobs.ts` | 外部任务 ID 持久化、恢复/取消、受限下载与媒体探测 |
| `server/render-worker.ts` | 限额工作线程、无界面 Chromium 逐帧渲染、FFmpeg 编码 |
| `server/index.ts` | 本机 API、媒体上传/范围读取、便携包和页面服务 |

工作线程与浏览器/编码子进程是独立执行层，HTTP 不直接逐帧渲染。尚不是分布式任务服务。本地渲染重启将残留 running 标为 interrupted，queued 继续调度；重试使用原始快照。外部任务由独立异步队列执行网络工作，可与一个本地渲染并行，不阻塞 HTTP 等待生成完成。

## 数据模型

`Project` 包含 `Asset`、`Scene`、`Entity`、`Geometry`、`Material`、实体上的 `Light` / `Camera`、`AnimationTrack`、`Shot`、`Timeline`、`Workflow`、`Artifact`。`GenerationJob` / `Revision` 在同一数据库通过 projectId 和修订号关联，避免编辑反向改变运行任务。

- ID：UUID 创建，项目内命名对象唯一校验；引用不依赖名称。
- 空间：右手系、Y 向上、米；本地位置、XYZ Euler 弧度、非零缩放；父子关系限制同场景。UI 显示度数。子对象继承父变换/可见性。重设父对象保留本地变换，不保留世界姿态。
- 时间：零起点整数帧，区间 `[start, start + duration)`；1–120 整数帧率，尚无 24000/1001。源帧=`sourceIn + timelineFrame - start`。改帧率保留帧位置，秒数变化。
- 摄影机：透视垂直 FOV、near/far；镜头引用摄影机实体。
- 颜色：sRGB 输入、Three.js 线性着色、ACES 映射、sRGB 输出；只有基础色/粗糙度/金属度，无 OCIO 或专业校色保证。
- 几何：本地顶点/三角面；修改几何后，预览和导出读取相同数据。线性四分三角形不是平滑曲面细分。
- 素材：SHA-256 内容寻址，ffprobe 读取真实流信息；便携包 base64 嵌入素材并校验哈希。没有压缩包或缺失媒体重定位流程。
- 画幅：Clip.fit 为 contain/cover/stretch。默认 contain 保持完整画面、空白处显示低轨；cover 居中裁切源画面；stretch 拉伸。预览和导出共用矩形计算。
- 数据版本：schemaVersion=3；显式拒绝未知格式。v1 在副本上升级，每个旧片段设为 stretch，保留音量；v2 保留已有 fit；不改原项目文件。数据库启动时先校验全部待迁移数据，`VACUUM INTO` 备份完整库，再在事务内升级项目、撤销历史、版本与任务快照，并写入 `schema_migrations` 的版本、备份名和计数；不增加用户编辑修订。夹具覆盖升级、原库备份和历史恢复。
- 生成：工作流节点保存参数和首尾帧 Asset ID，通过统一命令编辑并验证引用；被引用图片不可删除。提交时保存解析后的 GenerationRequest、Project 快照、工作流/输出节点和 requestKey；后续编辑不影响已提交请求。

## 编辑、审计与任务

`POST /api/projects/:id/commands` 接收 `{baseRevision, actor, label, commands}`。服务检查来源，复制项目，应用整批命令并验证引用，然后在同一 SQLite 事务写入快照、撤销状态及审计。错误不写项目；版本冲突返回 409，客户端提示刷新，不自动覆盖。

撤销重做恢复快照，但修订号递增。恢复历史也是一次可撤销操作。actor 是本地声明的 user/agent 标签，不是经过认证的身份；后台产物登记用 system。没有任意 JS、shell 或用户插件执行入口。

任务固定快照并存 requestKey。逐帧黑底，按视觉轨道低到高合成镜头或媒体。FFmpeg 根据同一入点、开始帧和时长裁剪/延迟/混音，使用参数数组调用，不构建 shell 字符串。视频和独立音频使用第一条音轨；导出重新探测真实文件，兼容没有音轨元数据的旧素材，无音轨视频仍可导出。

音频在 48 kHz 下按边界取整，处理音轨相对容器的开始偏移，以采样数执行 atrim/adelay；用 `asetpts=N/SR/TB` 重建时间戳，避免无效输入时间戳传播。单声道以单位增益复制到立体声；片段增益 0–2，混音关闭隐式归一化。浏览器用 MediaElementAudioSourceNode → GainNode → 共享输出，保持相同增益范围。预览会按时间轴纠偏，但不是采样精度调度；环绕声、多音轨选择和限幅尚未实现。编码后核对视频尺寸/时长及音轨时长/起点，异常结果不会标记成功。

完成后保存实际字节数及 SHA-256，把 MP4 纳入素材。`registerResult` 在同一数据库事务中登记 blob、追加 Asset/Artifact 系统修订并完成任务；失败回滚，重复完成不重复登记。文件先写入内容寻址目录，事务失败可留下未引用 blob。当前编辑器需刷新同步，没有实时订阅。

## 外部生成状态

Seedance 仅请求固定的官方北京 API 地址，API Key 只在服务端。模型 ID 不硬编码；用户选择与之对应的系列，应用按公开文档验证基础参数。首尾帧使用库中 PNG/JPEG/WebP 的 Base64，检查内容哈希、尺寸和每张 20 MB 限制；签名产物 URL 不写项目或日志。

新建任务先持久化 submitting，再发 POST，取得 taskId 后先保存再轮询。已有 ID 的重启任务恢复 GET；没有 ID 且可能已经提交的任务标为 uncertain/interrupted，需要用户核对并关联，禁止直接重试生成。查询/下载错误保留已有 ID；每轮本地最多等待 60 分钟，随后可恢复。外部状态没有百分比时界面显示不定进度。

取消先读取远端状态，只对 queued 调用 DELETE，再查询确认；running 不支持取消，不伪称已停止。官方 DELETE 在已完成状态会删除记录，因此排队到完成之间仍有供应商端竞态，本地不会把 DELETE 成功响应直接标成 cancelled。未知结果保留为 interrupted 供核对。

成功结果从允许的 `.volces.com` HTTPS 地址流式下载，重定向逐次复核；不携带 API Key，最大 50 MB、120 秒，随后 ffprobe 探测真实视频。生产没有模拟提供者或自定义代理 URL。测试使用注入的协议夹具，实际供应商端行为、网络恢复和权限仍待有凭据的集成运行确认。

只监听本机并检查变更来源，不是远程多租户安全方案。JSON 全量快照和包会占用内存，大型项目需增量事务及流式存储。媒体解码依赖浏览器/FFmpeg。H.264/AAC 及 FFmpeg 发行许可、专利需针对发行方案评估，相同效果不代表没有权利限制。
