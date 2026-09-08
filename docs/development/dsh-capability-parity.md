# DSH 与 Muse 宿主能力对齐验证

本页记录可执行检查及其证据边界。DSH 固定为 `@deepseek-ai/dsh@0.1.1-rc.2`，ApiProxy SDK 使用同一版本。本机检测只把该固定版本视为兼容：优先复用兼容的系统 DSH，再选择 Muse 受管版本；系统版本不兼容时，引导显式安装受管版本，不升级或覆盖系统安装。代码清单一致、模型返回文字、测试用例被发现、所有集成测试被跳过，均不能证明完整平台能力已对齐。

## 比较边界

必须比较**同一宿主、同一组织、同一工作空间、同一 Agent、同一 mode** 下的 Builtin 与 DSH。Electron 与 Daemon 的宿主能力本身存在区别，不能先要求两种宿主有完全相同的工具，再以交集充当 DSH 完整支持。

- `local/cloud` 表示执行位置，`builtin/dsh` 表示运行引擎。
- DSH 接收当前宿主准备的工具和上下文，权限、组织范围、工作目录、技能可用性及取消状态均以该宿主的真实端口为准。
- 动态 MCP、安装的 Skill、组织权限和扩展目录必须从实际运行上下文采集。源码中的可能能力不等于某个 Agent 当前有权使用的能力。
- 已删除的 `retrieve_tool_result`、`summarize_context` 不属于现行工具清单。`load_skill` 也不能仅因旧设计讨论而被虚构为当前工具。

## 当前源码清单

机器可读真源：`scripts/dsh-parity/capability-inventory.json`。由 TypeScript AST 和当前 Go CLI 原生命令树生成，不扫描历史说明文档。

| 来源 | 当前清单 | 证明范围 |
| --- | --- | --- |
| Electron `ElectronToolProvider.getTools()` | 16 个工具工厂调用 | 当前注册路径；条件分支和用户开关仍需真实会话快照确认 |
| Electron runtime assembly | 8 个 Capability 构造器 | 当前装配使用的能力类，预览/实际装配去重 |
| Daemon `DaemonToolProvider.getTools()` | 14 个工具工厂调用 | 同上，不代表 Electron 应裁剪成 Daemon 工具集合 |
| Daemon runtime assembly | 7 个 Capability 构造器 | 同上 |
| Go CLI `commands --format json` | 590 条原生命令/命令组 | 默认可发现命令树；每条记录完整 schema 的 SHA-256，参数、权限、风险变化会触发漂移 |
| `HostedRuntime` 接口 | query、abort、getRuntimeId；可选 dispose、compactCheckpoint | 必需/可选接口契约；实现行为需控制链路测试 |
| `BackendSession` 接口 | 文件、执行及生命周期方法 | 宿主执行端口；不等同于模型直接可见工具 |

工厂清单包括工具工厂、子 Agent 工具包装和动态 MCP 工具工厂，**这些数字不是模型可见工具数量**。精确工具名称和 input schema 由运行快照检查负责。

CLI 清单生成使用临时 `MUSE_CONFIG_DIR` 并移除继承的 Muse 连接环境，避免读取用户登录数据或连到正在工作的 Muse 客户端。它只运行能力发现命令，不运行业务操作。因此 PlatformSurface、组织扩展及 marketplace 动态命令不在静态原生清单中；这些项目必须由真实宿主 CLI catalog 补齐。

```bash
# 重新采集前先检查对应源码差异；更新清单不等于批准实现。
node scripts/dsh-parity/inventory.mjs --write

# CI 默认只比较，不改文件。
node scripts/dsh-parity/inventory.mjs
node --test scripts/dsh-parity/checks.test.mjs
```

## 真实会话快照

`scripts/dsh-parity/capability-snapshot.mjs` 提供 `snapshotFromHostSession()` 和 `compareCapabilitySnapshots()`。独立文件可用以下命令比较：

```bash
node scripts/dsh-parity/compare-snapshots.mjs builtin.json dsh.json
```

快照必须有 `schemaVersion: 1`、`host`、`harness` 和 `scope`（organizationId、workspaceId、agentId、mode）。需要比较的分类如下：

| 分类 | 实际采集来源 | 检查要求 |
| --- | --- | --- |
| `tools` | 当前 ToolProvider/HostCapabilitySession 工具快照 | 名称及完整 inputSchema 相同；重复名称失败 |
| `cliCommands` | 当前宿主权限过滤后的 CLI catalog | 命令及其 schema 相同，包括实际动态命令 |
| `skills` | 当前 Run 冻结的可用技能 catalog | canonical key 及调用方提供的版本/资源摘要相同；确实没有技能时允许空数组 |
| `hooks` | EngineConfig 实际注入的 hook 函数名 | 集合一致；不能省略字段 |
| `contextSections` | 宿主实际准备的 system prompt/上下文段 | 默认对 systemPrompt 哈希，不在检查报告打印正文 |
| `policies` | 已注入 toolRiskPolicy/toolGate 等端口 | 集合一致，并需另有拒绝/审批行为测试 |
| `controls` | 当前宿主实际实现和注入的控制端口 | 集合一致，并需另有取消/暂停/恢复/压缩行为测试 |

抽取器不会从 system prompt 猜出 CLI/技能条目，也不会用空数组补缺失数据。未提供实际分类时报告 `missing actual capture`，避免把“没有采集”变成“没有差异”。除确实为空的 Skill catalog，其余空执行/上下文分类均失败。

分类相同只证明表面契约相同。它不能代替：真实工具执行、参数校验、组织/Agent 越权拒绝、审批回传、技能资源读取、取消传播、事件投递和资源释放测试。特别是 controls 列出了 `compactCheckpoint`，也必须实际验证压缩结果，不可仅判断方法存在。

## DSH 专用集成入口

`.github/workflows/dsh-parity.yml` 为单独的只读 CI 工作流，无生产 secrets、无部署步骤。它按锁文件安装 daemon 依赖闭包并构建共享依赖，使用 Node.js 22.20.0 与仓库 Go 版本。

CI 的集成入口：

```bash
node scripts/dsh-parity/run-integration.mjs /tmp/muse-dsh-ci-report
```

该入口会核验实际安装的 DSH/SDK 均为 `0.1.1-rc.2`，显式设置 `MUSE_DSH_INTEGRATION=1`，运行以下真实子进程集成测试：

1. `apps/tabtin-daemon/tests/dsh-api-proxy.integration.test.ts`：ApiProxy 进程/会话连接。
2. `apps/tabtin-daemon/tests/dsh-mcp.integration.test.ts`：带认证的 MCP 发现。
3. `apps/tabtin-daemon/tests/dsh-full-turn.integration.test.ts`：真实 DSH 经 loopback 模型 fixture 返回 Muse 流事件。
4. `apps/tabtin-daemon/tests/dsh-muse-plugin.integration.test.ts`：Muse 插件/宿主桥传输、历史、图片、暂停及压缩链路。
5. `apps/tabtin-daemon/tests/dsh-host-capability.integration.test.ts`：实际 ManagedDshRuntime + HostCapabilitySession + runTools/HookRunner + TabCode 原生执行守卫，验证文件读后编辑、平台执行、策略拒绝零副作用及 BudgetTracker 模型请求票据。

插件完整流程当前包含 10 次受控模型请求：保留原有文档式工具调用、图片、上下文、暂停、历史改写、压缩和冷恢复场景后，第 9 次请求保持上游响应未完成再取消，观察真实 `cancelAndWait` 返回 `stopped:true` 与 socket 关闭；第 10 次请求验证取消后同一会话仍可正常续聊。这是一项包含多个步骤的集成测试，不计为 10 个独立通过用例。

模型 fixture 使用本机回环服务和测试凭证。DSH 使用临时 Home/工作目录，不复用用户全局 DSH 测试路径，不向真实模型或用户工作空间派发任务。

`assert-integration-report.mjs` 逐个检查所需文件的 Vitest JSON 结果：每个文件必须存在、至少有一个实际通过的断言、所有断言均为 passed。空结果、缺文件、pending、skipped、failed 都会使检查失败；不能凭 Vitest 总退出码或一个无关用例通过就放行。

共享 `HostCapabilitySession`、认证 bridge、ManagedDshRuntime 的测试，以及实际 agent 工具到 fork 的子引擎选择/清理测试，也分别出 JSON 报告并经过同一闸门。工作流保留报告 7 天。工作流文件存在不等于 GitHub 分支保护已把此任务设为必需检查；仓库规则仍需由维护者另行核实。

## Electron 外部 Node 资源

DSH 子进程无法通过普通文件系统读取 Electron `app.asar`。Electron 的 `extraResources` 将插件 dist 放入 `resources/dsh-muse-plugin/`；隔离 deploy 时映射为 `./dsh-muse-plugin-dist-src`。完整打包和 Mac quick 打包均调用 `stage-dsh-muse-plugin.mjs`，缺少构建入口时立即终止，避免复用旧资源。

单独复制 dist 会失去 npm 包根的 ESM 声明，因此 staging 同时写入最小 `package.json`（`type: module`）。插件 bundle 包含 ws；ws 的 CommonJS Node 内置模块调用需要构建输出提供 `createRequire`，仅检查文件存在无法发现这类加载失败。

```bash
node --test apps/tabtin-electron/scripts/packaged-dsh-plugin.test.mjs apps/tabtin-electron/scripts/prepare-deploy-package.test.mjs
node scripts/dsh-parity/check-packaged-plugin.mjs
```

第二条命令把**实际构建产物**放入临时目录，清除 `NODE_PATH`/`NODE_OPTIONS`，从独立 Node 进程导入并验证插件出口。它不运行 Agent，也不依赖仓库 node_modules 兜底。该检查已纳入专用 CI，但仍不能替代最终 `.app`/安装包验收。

Cloud 镜像的 daemon 生产依赖链为 daemon → agent-host → dsh-muse-plugin。插件 package 的 `files` 只发布 dist、导出指向 `dist/index.js`；Docker 构建在 `pnpm deploy --prod` 前构建依赖闭包。这里的契约检查确认了源码配置，完整镜像物料仍需单独构建验证。

## 本轮已验证与未验证

已在本地验证：

- 当前源码注册路径和隔离原生 CLI 清单可以生成，重新检查无漂移。
- `dsh-host-capability.integration.test.ts` 已用真实固定版本 DSH 跑通：原生 read → edit、平台工具写入、原生/平台两类策略拒绝，实际宿主 hooks、文件备份与文件结果、模型请求票据到 BudgetTracker 的准确用量。
- 该集成中，同配置的真实 Builtin/DSH capability session 的工具 schema、systemPrompt、context、hooks、policies、controls 相等；CLI/技能实际目录未采集，检查器仍明确报告这两类 missing，不能据此宣称整台宿主全量能力已对齐。
- 实际构建的 DSH Muse 插件已通过隔离物理资源目录的纯 Node 导入；包装路径/缺失构建产物拒绝/ESM 身份及生产依赖契约测试通过。
- 快照检查器的同宿主/身份边界、工具 schema 差异、缺分类、缺 CLI/技能/控制项、重复项和空采集反例。
- 报告闸门拒绝全跳过、混合 passed/pending、缺文件、无断言及失败报告。

以下必须保留独立证据，目前不能仅靠上述脚本宣布已完成：

- Electron 和 Daemon 分别从真实 ToolProvider/CLI/技能目录采集的 Builtin/DSH 全量对照快照。
- 真实 DSH Muse 插件的完整业务矩阵；当前 5 组固定版本进程集成通过，但没有覆盖所有真实服务、跨窗口审批和恢复排列。
- 已打包 Electron 应用内的插件资源定位、固定依赖加载、首次安装引导与执行验收。
- macOS/Windows/Linux 各宿主平台的实际执行差异，以及 CI 在线结果、发布镜像和部署后的业务验收。

新增或移除能力时，应同时更新当前宿主真源、共享桥接、运行快照/行为测试及经审阅的静态清单。不得删除测试、减少能力集合或把未支持项置为空来获得通过。

## 2026-09-08 实施与验收记录

状态：**共享实现和本地业务增量已落地，完整对齐尚未达到最终完成条件。** 本记录不代表 P0–P7 已依次通过。特别是实际 CLI/技能全量快照缺失，因此 P0 的完整基线出口仍未关闭。

已实现的主链路为 Electron/Daemon → ManagedDshRuntime → 独立 loopback 模型网关与认证能力桥 → 随包 Muse 插件 → HostCapabilitySession。共享会话复用真实工具执行、hooks、权限和预算；DSH 路径不再为工具创建闲置 Builtin。原生文件工具保留读取范围、过期读取保护、文件备份及变更回调。原生终端保留普通代码执行；需要 Muse CLI 身份、技能凭证或后台管理的命令使用宿主终端入口，不能通过原生 shell 绕过身份与审计。

控制和历史实现包括运行代次、绑定文件、正式 seed/resume、图片双向转换、暂停边界、取消传播及原生压缩。子任务继承 Harness，创建与清理异常进入同一生命周期。模型请求票据绑定 run 与费用归属；本地订阅模型复用已有 provider。启动失败前已经接收的用户消息通过持久化事件保留，避免被误当作空草稿清理。工具写入去重只对当前实例的调用票据提供保证，不应将其扩大解释为所有远端业务跨崩溃恰好一次执行。

取消确认使用原生会话终态，`sessions.cancel` 的 `accepted` 仅表示接收请求。无法确认停止时返回明确错误并拒绝继续复用该实例，宿主会尝试清理本次受管进程；该异常路径不声称此前副作用已回滚，也不把尽力清理当作跨平台进程树全部退出的证明。冷启动检测/凭证等待及本地 provider 内部准备阶段均需要可取消边界，晚到凭证不能触发已停止任务的新请求。

本轮最后一次本地回归：

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| agent-runtime、插件、agent-host 构建 | 通过 | 当前源码构建 |
| Electron、Daemon TypeScript | 通过 | 无生产部署含义 |
| 共享能力、桥接、受管生命周期、provider facade | 52 项通过 | 真实本机回环与受控上游，包括准备阶段及时取消及晚到请求零派发 |
| 模型网关 | 11 项通过 | 缓存用量、费用事件、身份、凭证/图片准备取消边界 |
| DSH 驱动与云端入口 | 10 + 6 项通过 | 延迟取消确认、拒绝/超时不假报成功；入口 bootstrap 与旧全局路由清理 |
| 界面执行态对账 | 27 项通过 | 同 run 的已知 done/error/cancelled 不被空闲对账覆盖，旧 run 及等待期间的新 run 均隔离 |
| 消息接收与取消流水线 | 37 项通过 | 运行初始化失败时保留已接收用户消息 |
| 插件原生终端截止时间 | 10 项通过 | 与实际 DSH shell 默认值、上限协调 |
| 固定版本真实 DSH 集成 | 5 组通过，无跳过 | 受控模型，真实子进程、插件和宿主 |
| 清单、检查器反例、打包资源契约 | 14 项通过 | 实际隔离 Node 导入也通过；不等于成品安装包验收 |
| loopback 桥接暖请求 | p95 2.640 ms，100 次 | 仅传输/桥接，排除实际业务、数据库与模型耗时 |

包含真实取消后续聊的最终五组测试报告保存在本机 `/private/tmp/muse-parity-final-reports/integration.json`；最终构建/类型检查使用 `/private/tmp/muse-parity-frozen-` 前缀，共享单元测试使用 `/private/tmp/muse-parity-verified-` 前缀，此前聚焦检查使用 `/private/tmp/muse-parity-close-` 前缀。临时路径不是长期 CI 制品；在线工作流尚未运行。已有 ShellCap 全套中的 22 个失败已与 HEAD 基线比较，失败名称相同，不能把全套测试报告写成全绿。

真实模型验收使用专用 `dsh-acceptance-20260908-pILXGe` 工作空间与两份相同来源的 Agent 配置，模型为当前 Muse 配置的 DeepSeek。DSH 自行发现文档 CLI 并创建、读取、呈递文档；既有 Muse 窗口的编辑器实际显示 `DSH 平台文档验收标记 pILXGe`。Builtin 对照也创建并回读了文档。该对照使用两份测试 Agent，因此不能替代要求同一 Agent 身份的全量快照比较。

| 产物 | 资源 ID | 当前证据 |
| --- | --- | --- |
| DSH 文档 | `4fa0d788-afb0-4fde-9183-ec0ff4d0e371` | 创建、读取、呈递、续聊局部追加与回读通过；重启开发实例后原会话再次读取并追加“重启恢复编辑验收 pILXGe”，Muse 编辑器显示三个独立验收段落，无重复 |
| Builtin 对照文档 | `f7617248-467c-4e39-8c0b-3f6cc892176b` | 创建、回读及数据库核验 |
| DSH 多维表 | `9caa52b3-7e20-4245-8d1c-89688900bd6e` | 创建、记录列表回读、只读 PostgreSQL 核验通过：名称为 text，数量为 number/double precision，恰好甲=1、乙=2 两行；SQL 查询端点返回内部错误，不能算 SQL 查询通过 |

真实搜索已确认经过 Muse 的 `web_search` 服务。两次调用的持久化结果均为 `is_error=true`、HTTP 502、`upstream_code=SEARCH_ERROR`，错误为 `The search provider could not complete the request.`；这证明桥接和错误传播可达，不能算搜索成功。没有为 DSH 新增第二套搜索密钥或更改 provider。字段/行和搜索脱敏证据为 `/private/tmp/muse-qa-table-search-evidence.json`。

重启后另行通过 Django 文档详情的 `content` 正文分支读取，三个验收段落各出现一次，与 Muse 编辑器吻合；证据为 `/private/tmp/muse-qa-document-final-read.json` 与 `/private/tmp/muse-qa-cold-resume-ui.json`。文档详情的 `document` 分支仅含元数据，不能用它代替正文校验。

页面验收发现并修复了 `sessionRunReconcile` 把正常完成强制改成取消的路径。本机只保留同 run 已观察到的终态；远端只采用同 run 明确的 HTTP 终态；未知仍保留原兜底，不根据 `busy=false` 推断成功。旧状态已经污染的历史 run 不被强制改写。独立 `electron-state-regression` CI job 运行这组回归；它是状态逻辑测试，不替代真实 Electron 页面验收。

修复后新提交只读任务进行胶囊复测时，主进程拒绝：`workspace execution binding state is not ready`，现场同时出现网关连接超时。该任务没有成功进入执行；对应页面复测标记为**受阻/未通过**，不能因 27 项状态测试通过而改为真实页面通过。没有绕过执行归属校验。发送证据为 `/private/tmp/muse-qa-final-read-prepared-submit.json`，当前开发日志为 `/private/tmp/muse-parity-frozen-live.log`。

资源位于测试组织中，文档实际没有归入指定测试集合；不能据工作空间名推断资源具有工作空间隔离。资源清理须按这些精确 ID 及验收清单进行，当前保留供页面复核，清理尚未计为完成。

未关闭的最终准入项：

1. 真实 Electron/Daemon 同身份全量工具、动态 CLI 和技能快照，以及所有能力组的成功/失败业务矩阵。
2. 云端真实模型验收：当前组织 Cloud Agent 关闭、没有可用 Worker/分配，运行镜像配置缺失；本次未更改这些部署配置。
3. 文档并发冲突、表格完整异常矩阵；真实搜索成功、连接器、记忆、附件解析及跨窗口审批/重启恢复等尚不能以代表用例替代。文档局部追加及重启后继续编辑已通过真实模型与编辑器验证，但不替代其他能力的恢复边界。
4. 真实页面发送 200 ms、完整桥接处理 p95 50 ms、断线反馈、完整暂停/排队交互均需独立测量。现场还存在 WebSocket relay 超时，Builtin 也可见，不能将其标为本次修复。
5. 完整 Electron 安装包、Cloud 镜像、在线 CI 及最终清理验收。本次没有提交、推送或部署。
