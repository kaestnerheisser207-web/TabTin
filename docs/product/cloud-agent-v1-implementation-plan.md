# TabTin Cloud Agent v1 实施计划

状态：实施中 · 核心运行闭环已完成 · Workspace 导出待显式数据外发授权 · 日期：2026-08-30 · 范围：托管 Cloud Workspace + Builtin/DSH Harness + SaaS/Community Worker

关联架构图：[TabTin｜02 架构与流程｜Agent Runtime 与 Cloud 执行整体架构（中文）](https://www.figma.com/board/81QXO2Sw1TNsJyGcIZTcfi)

本文是 Cloud Agent v1 的产品与工程实施唯一真源。它沿用 TabTin 已确定的 Agent × Workspace × Device 分层，不建立 Cloud/DSH 专属消息链，不等待 ACS、休眠或弹性调度后才交付第一版。

---

## 一、已拍板的产品决策

| 编号 | 决策 |
| --- | --- |
| D1 | Cloud Workspace 是 TabTin 分配并持续运行的云端开发目录；用户侧只安装 macOS TabTin 客户端。 |
| D2 | SaaS 由 TabTin 托管 Worker；Community 由管理员部署同版本 Worker Supervisor，终端用户体验一致。 |
| D3 | 每个个人 Cloud Workspace 拥有独立逻辑 Cloud Device、隔离运行实例、`/workspace` 持久卷和 `DSH_HOME`。 |
| D4 | Active Workspace 的 Worker 始终在线；默认规格 `2 vCPU / 4 GiB / 20 GiB`，SaaS v1 每用户默认激活 1 个。 |
| D5 | Workspace 从空目录或 Git 仓库创建；云端目录与 `.git` 是唯一文件权威，不做持续本地同步。 |
| D6 | 用户需要本地副本时手动导出工作区快照；本地 Mirror、Syncthing 和冲突协议不进入 v1。 |
| D7 | Cloud Workspace 默认使用 DSH Agent，Builtin Agent 可选；Harness 与 Local/Cloud 执行平面正交。 |
| D8 | DSH 文件、Shell、代码工具负责 Workspace；TabTin MCP 只补 TabDoc、TabData、Memo、Site 等平台能力。 |
| D9 | SaaS DSH 模型调用、usage 和计费统一走 TabTin Model Gateway；Community 走自托管 Gateway/BYOK。 |
| D10 | SaaS v1 使用套餐权益、并发和存储配额，不做分钟级计算扣费。 |
| D11 | Disable 立即停止 Worker，持久卷保留 30 天；永久删除必须使用独立、明确确认的动作。 |
| D12 | v1 只支持个人 Workspace 和 macOS 客户端；团队多人 Workspace、Windows/Linux 客户端后续实现。 |

明确不进入 v1：ACS、hibernate、checkpoint clone、NAS mount、弹性暖池、多区域调度、持续本地目录同步、按分钟计算扣费和 DSH 私有 Web UI 表层。

---

## 二、架构边界

### 2.1 产品概念

- Agent 表示“谁参与”，持有 persona、规则、模型和 Harness 偏好。
- Workspace 表示“在哪里工作”；Cloud Workspace 的执行 Device 为逻辑 `cloud` Device，工作根固定为 `/workspace`。
- Device 表示真实执行环境；SaaS Worker 与 Community Worker 使用相同设备协议。
- ChatSession 继续显式绑定 Agent × Workspace；ExecutionRun 在准入时冻结 Workspace、派生执行平面、Harness 与 Worker generation。

### 2.2 执行平面与 Harness

- `runtime_plane` 不再由 Agent 持久配置；按 Workspace Device 派生：`cloud → cloud`，`electron|daemon → local`。
- `agent_config.harness.type` 取代 `agent_backend`，闭集为 `builtin | dsh`。
- 现有 Agent 一次性改写为 `builtin`；删除 `agent_backend`、Agent 级 `runtime_plane` 和兼容读取分支。
- Cloud Workspace 创建向导默认选择 DSH Agent；Workspace API 不隐式创建 Agent。

### 2.3 唯一 Runtime 主链

```text
Client
  → Django control plane / Electron IPC
  → Workspace + Device + Harness resolution
  → Cloud or Local Host
  → RuntimeDriverRegistry
      ├─ BuiltinRuntimeDriver
      └─ DshApiProxyRuntimeDriver
  → runtime.query()
  → Host DeliveryCoordinator
  → local transcript/event/snapshot
  → relay_events / ACK
  → Django authoritative message/state/trace
  → all clients
```

- `runtimeOf(session).query(): AsyncIterable<StreamEvent>` 保持唯一主循环入口。
- FIFO、暂停、终态、HITL、Cancel、DeliveryCoordinator、Outbox、Relay、Django 持久化和 UI 不建立 DSH/Cloud 分支协议。
- 禁止复活 `agent.runtime.*`、`ChatSession.external_session_id`、`ChatMessage.external_task_id` 或 ACP 专属事件表。

### 2.4 安全与租户隔离

- 每个 Cloud Workspace 使用独立容器或等价 OS 沙箱、持久卷、daemon data root 和 `DSH_HOME`。
- 逻辑 Device fingerprint 为 `cloud-{allocation_id}`；Host ID 为 `cloud:{allocation_id}:{generation}`。
- 一次性 allocation activation token 只能换取范围受限、短期 daemon 凭证；Worker 不保存用户 JWT。
- daemon、DSH ApiProxy、TabTin MCP 与 DSH Web 均不得暴露公网端口；MCP 只监听 loopback 并使用短期 Bearer token。
- 旧 Worker generation 恢复网络后必须被 RunHostLease fence，不能继续执行或写事件。

---

## 三、公共接口与数据模型

### 3.1 Agent 与 Runtime 契约

- 新增 `HarnessType = 'builtin' | 'dsh'` 与 `AgentHarnessConfig`。
- 新增 `HostedRuntime`：`query`、`abort`、`getRuntimeId`；`compactCheckpoint` 为可选 capability。
- 新增 `RuntimeDriver`：create/resume/dispose Driver Session。
- 新增 `RuntimeDriverRegistry`：按 Harness 选择 Driver。
- Driver 选择发生在 `RuntimeResourceFactory.build`；`harnessType` 进入 Runtime cache key，Harness 变化强制 hard rebuild，活跃 Run 中禁止切换。

### 3.2 服务端模型

- `CloudWorkerNode`：Worker 身份、edition、状态、容量、版本、能力和心跳。
- `CloudRuntimeAllocation`：一对一绑定 Cloud Workspace，保存 Worker、逻辑 Device、state、generation、volume ref、runtime image、last error 和 retention deadline。
- `RuntimeBinding`：唯一键 `(organization, workspace, thread, harness)`，保存 opaque Driver session ref、allocation、host generation、state 与 CAS revision。
- `ExecutionRun`、`client_message_id`、RunHostLease 与 SessionRunProjection 继续作为 Run、消息幂等和 fencing 权威，不在 RuntimeBinding 重复保存第二份业务状态。

### 3.3 用户 API

- 幂等创建 Cloud Workspace：organization、name、working_dir_type、source `empty | git`；Git 来源携带 URL、ref 与可选 credential ref。
- 查询 Workspace provisioning、allocation、Worker/version、runtime 和 export 状态。
- restart、disable、恢复与手动导出 tar/manifest。
- disable 保留卷 30 天；永久删除使用独立接口和明确确认，不与 disable 复用。
- Workspace DTO 增加派生 `runtime_plane` 和 Cloud 状态；Cloud Workspace 不接受客户端任意改写 `device` 或 `/workspace`。

### 3.4 Worker 内部接口

- Worker register/heartbeat/capability/version/capacity。
- Allocation provision/restart/disable/destroy/status。
- Provision 成功以容器内 cloud daemon 心跳和版本门禁通过为准，不能用“容器进程存在”替代 ready。

---

## 四、实现内容

### 4.1 Cloud Worker 与 Workspace

- 新增 `tabtin-cloud-worker` Supervisor；SaaS 注册到平台 Worker Pool，Community 以专用非特权账号连接 rootless Docker/Podman，并通过 systemd 注册管理员自托管节点。
- 每个 Workspace 创建独立运行实例，挂载持久卷到 `/workspace`；Active 时始终在线。
- 实现最小 `VpsCloudBackendSession`：持久 Workspace、文件/命令沙箱和后台运行；能力标记中 hibernate/checkpoint/mount 均为 false。
- 空目录直接初始化 `/workspace`；Git 来源按 remote/ref clone，私库凭证通过 Credential Broker 临时注入。
- Git metadata 只存在云端；commit/push 继续走现有审批策略。
- 手动导出使用异步 tar/manifest 任务写入现有 OSS，返回短期下载 URL。

### 4.2 Builtin Runtime

- `BuiltinRuntimeDriver` 包装现有 Agent Runtime，不改变模型、工具、事件或持久化语义。
- Cloud daemon 注册 `device_type=cloud`，补齐 RunHostLease claim/heartbeat/reconcile/fencing。
- 先用 Builtin 跑通 Cloud Workspace、Relay/ACK、客户端离线继续执行和 Worker 重启恢复，再接 DSH。

### 4.3 DSH ApiProxy Driver

- Worker 镜像锁定经过集成测试的 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`，不使用 floating `latest`。
- 版本调查确认 `0.1.1-rc.2` 不提供 ACP server；接入使用 DSH Web 自身消费的正式 ApiProxy 契约：HTTP unary（`session.create/prompt/cancel`、`respond`）+ WebSocket downlink（`events.mux`），不虚构 ACP 传输层。
- 使用稳定业务 `thread_id` 创建/恢复 DSH session，不使用每轮变化的 task/session ID。
- ApiProxy session event、thought、tool、context usage 与状态更新统一翻译为现有 `agent.stream.*`。
- ApiProxy `approval/requested` / `question/requested` 映射到现有 HITL；scheduled/batch 无交互端时 fail closed。
- Cancel 同时触发 ConversationSupervisor/AbortSignal 与 ApiProxy `session.cancel`；只有 Host 在执行确实停止后生成 `host_confirmed` aborted terminal。
- TabTin 继续负责历史、Outbox 和重放；DSH resume 不重放旧 update。
- DSH session 初始化时注入 daemon loopback TabTin MCP endpoint 和短期 token。
- 实现 TabTin Model Gateway 的 DSH adapter；Sidecar 不持有长期上游模型 Key。

### 4.4 macOS 产品入口

- Cloud Workspace 创建向导：Organization、名称、空目录/Git 来源、Agent 选择；默认选中 DSH Agent。
- 展示 provisioning/ready/error、Worker/version、远程文件树、终端和 Agent 运行状态。
- 客户端关闭不停止 Cloud Agent；重新打开后通过 Django 权威状态和 Outbox 回放恢复 UI。
- 提供 restart、disable、恢复、export 和永久删除入口；破坏性后果必须显式区分。

### 4.5 Edition

- SaaS：TabTin 管理 Worker Pool、套餐权益、1 个激活 Workspace、`2C/4G/20G` 默认规格和存储配额。
- Community：管理员部署同版本 rootless Worker Supervisor 和自托管 Model Gateway/BYOK；终端用户仍只操作 TabTin 客户端。
- SaaS 与 Community 运行同一 Cloud Worker 协议与验收套件，不维护两套 Runtime 实现。

---

## 五、实施顺序

1. 契约与配置收敛：Harness config、Workspace 派生 plane、HostedRuntime/Driver/Registry、数据模型与迁移。
2. Cloud Workspace + Builtin 最小闭环：Worker、逻辑 Device、Allocation、持久卷、空目录/Git、Lease、Relay/ACK。
3. 可靠性与生命周期：RuntimeBinding、generation fencing、Outbox/NAK、restart、disable/30 天恢复、版本门禁、导出。
4. DSH 首发接入：ApiProxy Driver、事件翻译、Gateway adapter、MCP、HITL、Cancel、resume/close。
5. 产品与发行：macOS UI、SaaS 配额/运维面、Community rootless systemd、内部 dogfood 与 Organization 灰度。

每一阶段必须形成独立可运行闭环；不得用下一阶段的占位实现掩盖当前阶段未完成。

---

## 六、测试与验收

### 6.1 契约与回归

- Local/Cloud 派生、Agent harness 数据改写、Driver Registry、Harness hard rebuild、可选 compact capability。
- Local Builtin、普通远端 daemon、Web/mobile 会话、审批和计费链全部保持通过。

### 6.2 Provisioning 与安全

- 重复创建幂等；空目录、公开 Git、私有 Git；失败可诊断且 DB/卷/Device 不留半状态。
- 租户 A 无法访问 B 的卷、token、MCP 或 DSH_HOME。
- 一次性激活 token 不可重放；DSH ApiProxy/MCP/daemon 无公网监听。
- Worker 版本不兼容时 fail closed、不接单。

### 6.3 Lease、事件与恢复

- claim/heartbeat/reconcile/fence；Worker、daemon、Builtin Runtime 和 DSH Sidecar 分别崩溃后恢复。
- 旧 generation 不能继续 heartbeat、执行工具或写事件。
- Host 本地事件日志 → relay → Django ACK 顺序正确；断网完成后最终落库，不丢、不重、不乱序。

### 6.4 HITL 与 Cancel

- 默认拒绝、allow-once、重复响应幂等；scheduled/batch fail closed。
- Cancel 只影响目标 Session，队列、活跃 Run 与 pending HITL 一并取消。
- 最终只有一个 host-confirmed terminal。

### 6.5 端到端验收

- macOS 用户只安装 TabTin 客户端即可创建 Cloud Workspace。
- Builtin 与默认 DSH 均能在云端真实创建/修改文件并通过远程文件树和终端看到结果。
- 客户端退出后 Agent 继续运行；重开后会话和事件恢复。
- Worker/daemon/Sidecar 重启后同一卷和 Runtime Binding 恢复。
- DSH 消息、思考、通用工具、TabTin MCP、usage、HITL、Cancel、close/resume 全链通过。
- 手动导出能恢复完整云端工作树。
- Disable 后 30 天内恢复同一卷；永久删除后卷和 Runtime Binding 不可恢复。
- SaaS 与 Community 运行相同协议测试，Community 不产生 SaaS 计算扣费。

---

## 七、发布与观测

- Organization 级 `cloud_agent_enabled` 控制灰度；Cloud 不兼容旧客户端直接拒绝，不保留双协议。
- 生产合并由 Actions 用同一 release SHA 构建并推送 Django、Cloud Runtime、Cloud Worker 三个 `linux/amd64` 镜像；当前稳定 VPS 只切换 Django digest，Cloud Runtime/Worker 不会在未初始化的宿主上被隐式启用。
- 替换后的 dogfood 节点通过独立 `tabtin-cloud-vps-release.sh` 启用：专用 `tabtin-cloud-worker` systemd 服务连接同账号的 rootless Podman socket，graphroot 位于独立 XFS `pquota` 文件系统，Worker 启动前必须通过真实 volume quota 与 cgroup v2/systemd 探针。
- Worker 端口只绑定宿主 Docker bridge，Django 通过 `https://tabtin.dovelora.com/_internal/cloud-worker` 的现有 TLS 入口访问；Bearer token 只存在于 Worker 私有 env 与 Django file secret，不写数据库、不进 Action 参数或日志。
- Django 现有 `/metrics/` 从数据库权威状态导出 Worker edition/state/容量/占用、Allocation state、RuntimeBinding harness/state 与 Worker 心跳年龄；Worker 自身 `/v1/metrics` 导出有界 operation/result 请求计数和耗时。两者都禁止租户、用户、Workspace、Allocation、Thread 等高基数 Prometheus label。
- 指标至少覆盖 provisioning latency、allocation state、active Workspace、Worker capacity/version、lease expiry/fence、Runtime/DSH restart、relay backlog、模型 usage、存储用量和导出状态。
- 日志统一带 organization、workspace、allocation、generation、thread、run、harness；不得记录 token、模型 Key、Git 凭证或文件正文。
- 先内部 dogfood 单 Worker，再小范围 Organization Beta；只有全链验收通过后扩大 Worker Pool。

---

## 八、当前实施快照（2026-08-30）

已完成：Harness/执行平面解耦、Runtime Driver/缓存硬重建、Cloud Worker 与持久卷、逻辑 Cloud Device/一次性激活、token 验证成功后原子绑定 Cloud fingerprint、Allocation/RuntimeBinding/generation fencing、RunHostLease、Model Gateway、真实 DSH ApiProxy 完整轮次、TabTin MCP 发现、HITL/Cancel、Cloud 创建与生命周期 UI、创建时当前 Agent 默认 DSH/Builtin 显式切换、Electron 收到 DSH 时 fail-closed、2 秒有界状态刷新、settings 自动注册/health 激活 Worker（token 不落库）、Podman XFS project quota startup probe 与每卷硬配额、cgroup v2/systemd CPU/内存/PID 门禁，以及不暴露 rootful Docker Socket 的 Community rootless systemd 部署定义。

已验证：Cloud 后端 PostgreSQL 套件 25/25（包含 DB 权威 Cloud metrics、metrics DB 故障 fail-closed、容器 running 不等于 ready、真实 heartbeat、generation token 轮换、DSH local fail-closed 与 Worker 自动注册→版本/配额/资源门禁匹配 ready→错配置 error→移除配置 offline）、Prometheus 单进程/多进程 endpoint 9/9、settings import/file registry 8/8、Harness 聚焦契约 10/10、Agent Host Runtime 5/5、Daemon DSH/租约 9/9、真实 DSH ApiProxy/Model Gateway/MCP 3/3、Electron Cloud 创建/Harness/Runtime 聚焦回归 29/29、Cloud Worker 单测 17/17。真实 Docker 已证明 Worker process 重建会复接相同 generation/container，generation 升级会替换容器但保留同一 `/workspace` 命名卷及测试文件，随后 disable/restart/permanent-delete 通过且无容器/卷残留。Cloud Runtime 已从固定 Node 22 Debian digest 完整构建，成品以 UID 1000 运行，`tabtin-daemon 0.1.0`、`dsh 0.1.1-rc.2` 与 loopback ApiProxy 真启动通过；真实镜像 bootstrap→Cloud activation→fingerprint/generation 配置落盘→TabTin MCP/DSH→WebSocket 鉴权订阅→HTTP heartbeat E2E 1/1 通过。Cloud Worker 固定 Node 22 Alpine digest、UID 1000、Bearer health/metrics 门禁和无敏感正文 JSON 日志通过；新增发布 Dockerfile 已在本地 Docker 从干净 build context 完整构建，三镜像发布、稳定 Django 部署与独立 Cloud Host 门禁契约测试 6/6 通过。

尚未完成：完整 `/workspace` tar/manifest 导出会把可能含私密源码的目录发送到对象存储预签名地址，必须获得产品开发者对这一类敏感数据外发的明确授权后实施；私有 Git 目前在控制面明确拒绝并等待一次性 Credential Broker 授权。GHCR `linux/amd64` 实际推送、sg01 的 rootless Podman + XFS project quota/cgroup v2 实机 probe、节点注册和客户端端到端验收仍属于发布阶段，不能用本地 Docker 结果替代。
