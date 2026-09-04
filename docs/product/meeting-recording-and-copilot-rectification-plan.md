# 会议记录与 Copilot 整改清单与决策记录

状态：实施完成 · 本地验证通过 · 未部署 · 日期：2026-08-28 · 范围：会议录制（需求一）+ 会议 Copilot（需求二）现有实现的整改
关联文档：docs/product/meeting-recording-and-copilot-requirements.md（产品需求与验收唯一真源）
调查依据：两轮 agent-teams 只读审查、逐项源码抽验与一次对抗复核。本文只记录实现差距、技术边界、顺序和验收，不另立产品口径。

---

## 一、已拍板的产品决策

| 编号 | 决策 | 拍板人 |
| --- | --- | --- |
| D1 | 有效会议的原始音频默认同步到 Muse 服务端对象存储，并支持跨设备读回与流式回放。服务端 provider 可为 VPS 持久卷上的 `local` 或阿里云 `aliyun`；二者产品语义一致。 | 用户 |
| D2 | 会议档案复用 `ResourcePermission` 权限模型，默认私有，按显式权限向组织成员共享，并与任务续接联动。 | 用户 |
| D3 | 会议档案默认永久保存；同时支持“删除原始音频、保留文字材料”和“删除整场会议”两种操作。 | 用户 |
| D4 | 实时转写只使用云端 ASR，不建设本地 ASR 兜底；ASR 故障不得停止录音。 | 用户 |
| D5 | Copilot 问答历史随会议档案同步到服务器持久化。 | 用户 |
| D6 | Copilot 默认关闭，会议进行中可以随时开启或关闭，不改变录音和实时转写生命周期。 | 用户 |
| D7 | 组织内 viewer 可以创建自己的会议，并上传该会议的录音；该授权不允许其修改其他成员会议。 | 用户 |
| E1 | 音频文件复用正常文件创建流程：presign → PUT → confirm → FileRecord + FileUsage，不建设会议专用文件系统。 | 用户 |
| E2 | 流式 ASR 先复用现有 meter 和计费入口记录费用，暂不调整单价。 | 用户 |

已明确排除的领域：本轮不做法规合规审查；不新增音频或逐字稿内容加密。会议对象仍必须使用私有对象、业务权限校验和签名 URL，不得因“不额外加密”而退化为公开文件。

---

## 二、架构边界

### 2.1 本机缓存与服务端对象存储

- Electron `userData/meeting-recordings` 是录制、断线和崩溃恢复所需的本机缓存。
- 服务端对象存储是跨设备会议档案。当前本地调试使用 `SERVICES_OSS_PROVIDER=local`；部署到 VPS 后，`local` 将对象写入 VPS 的 `LOCAL_OSS_ROOT` 持久卷，所有客户端仍通过统一 API 访问，因此已经具备跨设备存储语义。
- `aliyun` 只是另一种服务端 provider。会议业务不得根据 provider 分叉上传、权限、删除或播放逻辑。
- 当前会议实现尚未把本机录音文件接入服务端 OSS 上传链路；“服务端 local OSS 支持跨设备”和“会议音轨已经上传”是两个不同事实。

### 2.2 会议记录与 Copilot

- 会议记录拥有会话、音轨、转写、归档和恢复生命周期。
- Copilot 只读消费会议事实，不控制录音、不决定停止、不阻塞归档。
- Copilot 默认关闭；会议中开关 Copilot 只影响新的问题识别和回答生成。

### 2.3 读取权限与设备写权限

- 共享 viewer：可读取会议列表、详情、音频、逐字稿和 Copilot 历史。
- 会议创建者：可创建会议，并写入自己会议的生命周期、音轨和转写投影；组织角色为 viewer 时仍允许上传本人会议音频。
- admin/owner：可授权、撤销权限和删除会议。
- 共享权限不得自动授予录制中的生命周期、音轨或转写写权限。

### 2.4 文件引用与物理删除

- `FileUsage` 是业务引用、`ref_count`、存储计量和孤儿清理的统一事实源。
- 删除会议资源时先撤销本会议的 FileUsage 和访问；只有 FileRecord 不再被任何业务对象引用时，才进入物理对象清理。
- 数据库删除与 OSS 外部副作用采用幂等、最终一致的清理，不声称网络对象删除与数据库事务能够原子提交。

---

## 三、审计时现状与整改内容

### A. 服务端存储、跨设备读回与生命周期

**A1. 会议音频尚未接入服务端对象存储【高】**

- 现状：`MeetingRecordingManager.checkpointServerTrack` 只同步音轨元数据；`MeetingTrack.file_record` 已预留但没有写入方；音频只存在本机会议档案。
- 整改：
  1. 本地音轨 finalize 成功后，由 Electron Main 复用 `@tabtin/oss-client` 完成 presign → PUT → confirm。
  2. 使用 `module='meeting'`、`context_type='meeting_track'` 和稳定的 track ID 创建 FileUsage。
  3. 本地 manifest 每轨持久化 `storageStatus`、`fileRecordId`、失败原因和可重试状态；应用重启后可从 manifest 重建上传或 confirm。
  4. 服务端补会议档案列表、详情、逐字稿、Copilot 历史和授权音频 URL 的读取接口。
  5. Electron 会议库按 session ID 合并本机缓存与服务端档案，第二台设备只依赖服务端档案即可打开和播放。
  6. 若所有有效会议都必须同步服务端，删除没有真实业务变体的 `AudioSyncPolicy.LOCAL_ONLY`，不保留空策略分支。
- 验收：
  - 在 `local` provider 下，录音对象实际写入服务端 `LOCAL_OSS_ROOT`；切换 `aliyun` 不改变会议业务代码。
  - PUT 成功但 confirm 失败、应用退出或网络中断后均可重试，不产生永久无引用对象。
  - 第二台客户端登录同一 VPS 后，可以按权限看到会议、读取逐字稿并流式播放两路音频。
  - 只有 FileRecord、FileUsage、MeetingTrack 和本地 manifest 全部绑定成功后，音轨才标记 `synced`。

**A2. FileUsage、孤儿清理与 file_record 绑定【并入 A1，高】**

- 现状：`upsert_meeting_track` 可以直接接受任意 `file_record_id`；FileUsage 尚无 `meeting` 展示枚举。
- 整改：
  - confirm 在事务内创建 FileRecord 和 active FileUsage，并递增 `ref_count`；不增加 meeting 专用孤儿保留分支。
  - 绑定音轨时验证 FileRecord 已完成、为私有对象、organization 与会议一致，并存在精确指向当前 track 的 active meeting FileUsage。
  - 私有 meeting 上传不得秒传命中历史公开 FileRecord；首版可禁用 meeting hash 秒传，或把 meeting 加入 private-only 兼容校验。
  - viewer 上传本人会议录音时，通过会议所有权进行窄授权；不得因此放宽通用 OSS 对其他资源的 viewer 上传限制。
- 验收：
  - 跨组织、跨用户、跨会议或跨音轨绑定 file_record 均被拒绝。
  - 正常上传的 ref_count 不为 0，七天孤儿任务不会误删。
  - 公开历史对象不能作为私有会议音频复用。

**A3. 两种删除链路均未完成【高】**

- 现状：会议 API 和 Electron UI 都没有完整删除入口；转写目前只有写接口。
- 整改：
  - “删除原始音频、保留文字材料”：停用两路音轨 FileUsage，释放本会议存储计量，音轨标记 deleted 并解除 file_record；保留会议、逐字稿、会后分析和 Copilot 历史。
  - “删除整场会议”：先停用会议全部 FileUsage 和权限，再删除 MeetingSession；转写、分析和 Copilot 子记录使用 FK CASCADE；Handoff 引用查看时返回 deleted。
  - 两种操作都立即使被删除内容不可访问。仅当 FileRecord 无其他 active 引用时，才由现有安全删除或孤儿清理机制物理回收 OSS 对象。
- 验收：
  - 删除音频后，文字材料仍可跨设备打开，音频入口明确显示已删除。
  - 删除整场后，创建者和共享者访问均返回 404，权限与交接引用失效。
  - 共享 FileRecord 不会因删除一场会议而被误删；零引用对象最终从当前 provider 物理清除。

**A4. 大文件分片【待实测，不进入当前整改】**

- 事实：当前每轨 MediaRecorder 配置为 64kbps；4 小时单轨理论值约 115MB，两轨分别上传，均低于单文件 200MiB 上限。原“4 小时双轨约 460MB”估算无效。
- 决策：先通过真实 4–8 小时会议建立单轨体积、上传成功率和首发最长时长基线。只有单轨真实接近上限或全文件重试无法满足弱网成功率时，才启动通用 multipart Spike；不在本轮预建分片端点。

### B. 权限与协作

**B1. 会议权限只支持创建者【高】**

- 现状：`_owned_session` 同时承担读写鉴权，列表和详情只对 created_by 开放。
- 整改：
  - 新增 `MeetingPermission(ResourcePermission)` 和会议域单一 `MeetingAccessService`。
  - 分开 viewer 读取、创建者设备写、editor 后续逐字稿编辑、admin/owner 授权与删除。
  - 补 grant/list/revoke 权限 API；会议默认私有，不因同组织成员身份自动可见。
  - viewer 可以创建自己的会议并上传自己的音轨，但不能写入其他成员会议。
- 验收：创建者、共享 viewer、无权限成员和跨组织用户分别覆盖列表、详情、音频、转写、Copilot 历史、生命周期写入和删除权限矩阵。

**B2. OSS 下载鉴权无 meeting 业务校验【中】**

- 整改：通过 active meeting FileUsage 定位 MeetingTrack/MeetingSession，再统一调用 MeetingAccessService 判断 viewer；业务域授权后复用现有私有文件签名交付。
- 验收：知道 FileRecord ID 但没有会议权限的用户仍得到 404；权限撤销后旧业务入口不能继续签发新 URL。

**B3. 任务续接缺少 meeting 引用【中】**

- 整改：在 `apps/tabtin_django/apps/tabchat/handoff` 中新增 meeting RefType、创建时回源校验、查看时实时鉴权和会议入口 source_link。
- 发送交接是否同时授予 viewer，必须沿用 D2 的显式权限规则并提供可回滚授权；不能仅增加 RefType 后假定接手人自动有权。
- Handoff 不依赖 ContextSyncMixin。是否把会议做成 Project ContextItem、全局搜索的一等资源属于后续独立信息架构事项，不在本整改中顺带实现。
- 验收：交接包可引用会议；有权限接手人可打开，无权限、已撤销或已删除时返回明确状态。

### C. Copilot 数据完整性

**C1. Copilot 历史只在客户端本地【中】**

- 整改：新增最小 `MeetingCopilotAnswer` 模型，包含 Session FK、客户端 request ID、问题段、冻结结果快照、model/provider、耗时和时间；request ID 唯一，防止重试重复生成与重复落库。
- 来源标题、摘录和资源标识随答案冻结，不因原文后续变化破坏历史可核对性。
- GET 走会议 viewer 权限；删除音频保留历史，删除整场使用 FK CASCADE 清理。
- 验收：换设备与任务交接后历史可见；同 request ID 重试不产生重复记录。

**C2. 最近 12 段上下文不是可删除的双实现【改为契约验收】**

- Electron 负责 final 去重、排序、窗口选择和保留用户指定问题。
- Django 负责对不可信输入做类型、来源、final、长度和时间清洗。
- 两边职责都保留，不建设跨 TypeScript/Python 共享运行包；使用同一组 fixtures 验证“最多 12 段、指定问题不丢、非法输入被服务端拒绝”。

### D. 计费

**D1. 流式 ASR 计费【已实现，未提交/未合并】**

- 当前改动复用 `speech.asr.seconds`、`_charge_speech_usage` 和幂等 key；零音频、连接失败、发送失败、consumer 断连、正常 final、重复 cleanup 和计费异常隔离共 13 个聚焦测试通过。
- 零音频不按墙钟时间扣费，只有成功发送或 provider 确认的音频进入计量。
- 本文件不得把 dirty worktree 的本地改动描述为已合并。

**D2. TTS 流式计费【移出会议整改】**

- TTS 不属于会议记录或当前 Copilot 的依赖。其计费缺口另建 Speech 平台技术债，不进入本整改顺序。

**D3. 存储计量【并入 A1/A3】**

- A1 confirm 通过 FileRegistry 增加计量，A3 通过通用 deactivate 工具释放计量。
- 只补 meeting 模块展示与对账口径；本轮不讨论存储定价。

### E. 验收与现有硬违约

**E1. 验收拆分为独立故障域【高】**

1. Electron 确定性测试：双轨写盘、隐藏 Renderer 异常、进程退出、重启恢复和本机缓存。
2. Django/OSS 集成测试：上传、FileUsage、精确绑定、权限、签名读回、两种删除和 ref_count。
3. Electron 云端档案测试：服务端列表、详情、跨设备播放和本地/云端去重。
4. macOS 真机基线：Zoom、Meet、FaceTime、AirPods、USB/非默认麦克风、切换设备、睡眠唤醒、长时录音和弱网。
5. 最后保留一个短 happy-path smoke，不把所有异常塞入一个巨型 E2E。

**E2. 需求一必须先形成独立闭环【高】**

- 会后摘要、决策、行动项、未解决问题、搜索、导出和 Project/任务关联仍未完成。
- 需求一未达到需求基线 §10 前只能报告“部分通过”；不得因为 Copilot 能回答、音频文件存在或本地测试通过而报告完整会议记录已完成。
- C1 Copilot 历史和 B3 任务交接排在需求一独立闭环之后。

**E3. 当前实现与已确认口径直接冲突【高】**

- 指定麦克风失效时，`MeetingCaptureController.openMicrophone` 会静默回落默认设备；必须改为明确失败并提示重新选择。
- `MeetingSetupView` 检测到可用模型后会自动开启 Copilot；必须保持默认关闭，只有用户主动操作才能开启。
- 隐藏采集 Renderer 关闭或崩溃时需要通知 RecordingManager，把对应音轨和会议标记为 interrupted/failed，并保留已写入内容。

---

## 四、整改顺序

0. 文档口径对齐 —— 已完成：服务端 `local`/`aliyun` 边界、Copilot 默认关闭、两种删除、viewer 创建与本人上传均写入需求基线。
1. 修正现有硬违约：麦克风静默回落、Copilot 自动开启、隐藏采集 Renderer 异常状态；补齐流式 ASR 计费边界。
2. 完成 A1+A2：Main 耐久上传、FileUsage、精确绑定、私有对象约束、服务端读取、Electron 云端列表与跨设备回放。
3. 完成 B1+B2：会议权限矩阵、授权入口和 OSS 业务鉴权。
4. 完成 A3：删除音频留文字、删除整场、引用安全的最终物理清理。
5. 完成 E2：会后处理、搜索、导出和关联，独立验收完整会议记录。
6. 完成 C1：Copilot 历史服务器持久化与幂等。
7. 完成 B3：任务续接的 meeting 引用、授权与回源。
8. A4 仅在真实长时录音数据触发时启动；TTS 计费保持在会议整改范围之外。

顺序依据：先消除已经违反确认口径的行为，再形成“本机可靠录制 → VPS/阿里云服务端对象 → 权限读取 → 跨设备重开 → 两种删除”的需求一闭环；Copilot 历史和交接不得先于完整会议记录的独立验收。

---

## 五、实施结果

- Electron：指定麦克风失效不再静默回落；Copilot 默认关闭；隐藏采集 Renderer 异常退出会中断并保留已写内容；manifest V2 支持音轨上传状态、崩溃恢复和重试。
- 服务端档案：会议音轨复用统一 OSS presign/PUT/confirm 与 FileUsage，支持 VPS `local` 和 `aliyun` provider；FileRecord 绑定精确到 `sessionId:source`，服务端列表、逐字稿和签名音频已接入 Electron 跨设备档案。
- 权限与删除：MeetingPermission 采用创建者或显式 ACL，不回退组织角色；viewer 仅可上传本人会议音轨；“删除录音保留文字”和“删除整场”均已接通后端、Electron IPC 与 UI，且不会误删共享 FileRecord。
- 完整会议记录：会后分析、组合检索、Markdown/JSON 导出、文档/任务关联和行动项幂等建任务已实现；失败不会改变原始录音和逐字稿。
- Copilot 与交接：Copilot 结果按客户端 request ID 幂等持久化并向共享 viewer 开放历史；Handoff meeting 引用具备实时回源鉴权和来源授权账本，撤销只回收本次交接创建的权限。
- 验证边界：本地自动测试、类型检查、Django system check、迁移漂移和静态检查已通过；尚未 commit、push、部署到 VPS，也未完成真实第二设备、真实会议软件和长时录音验收，因此生产结论仍为“未验证”。
