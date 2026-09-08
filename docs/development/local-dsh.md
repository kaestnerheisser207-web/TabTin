# 本地 DSH

Muse Desktop 的本地工作空间支持 `builtin` 和 `dsh` 两种运行引擎。执行位置仍由 Workspace 的设备与目录决定，Harness 由当前 Agent 的 `agent_config.harness.type` 决定。

## 使用

- 新建工作空间：选择「本地」，再选择「DeepSeek DSH」。
- 已有 Agent：进入「AI 分身」详情，将 Agent Runtime 切到 DSH。
- 已安装且版本兼容时显示版本并直接复用；未安装或版本不兼容时显示安装引导，只有点击「安装 DSH」才执行受管安装。
- 本地发送时若 DSH 缺失，会打开本地 DSH 安装面板并阻止发送，不回退到 Builtin。
- 引擎设置作用于该 Agent 的后续对话，不修改工作空间的设备、目录或云端开关。

## 检测与安装

检测先查 PATH 上的 DeepSeek npm 包 `@deepseek-ai/dsh`，再查 Muse 管理的安装位置。通过 package.json 名称和 bin 目标确认身份，避免误用同名 shell。要求可用 Node.js 22.12+。

安装按钮通过受信任 renderer 的 `dsh:install` IPC 调用主进程。使用 npm 官方 registry，把经过当前 SDK 验证的 `0.1.1-rc.2` 安装到 `userData/runtimes/dsh`；不升级或覆盖机器上的现有 DSH。安装失败不会把残留 bin 当作成功安装，支持重试。

`dsh:get-status` 返回安装/版本/进行中状态，不触发安装。并发安装请求共享同一个安装任务。

## 运行与隔离

Electron 和 Cloud Daemon 复用 `@muse/agent-host/runtime/dsh` 的 API client、事件转换器、driver、进程管理和模型网关。

本地运行使用机器上已安装的 DSH 程序，为每个用户、组织、工作空间、会话、模型和权限模式建立独立 DSH_HOME，并使用动态 loopback 端口。不会占用用户已有的 3080 服务或修改 `~/.dsh`。

模型请求经过 Muse 本地网关发往现有 LLM Proxy；本地订阅模型复用 Muse 已有的本地 provider。组织、会话和实际模型固定为该 runtime 的权威上下文。令牌只在进程内部使用，日志脱敏。启动需要 DSH API 连通和 Muse 插件握手；每轮初始化还会校验当前能力上下文与模型配置，API 存活不代表所有业务能力就绪。

Muse 随包提供适配插件，通过认证的本机能力桥复用平台工具、CLI、技能上下文、权限和审计；DSH 保留原生推理循环及代码工具。原生文件操作复用读取与变更保护，普通原生终端命令经过宿主预检；Muse CLI、技能凭证和后台执行使用宿主终端入口。只读 Agent 模式映射到 DSH read-only，其余本地模式使用 workspace-write。审批和问题通过 Muse 交互通道呈现，超时不自动批准。

取消支持启动检测、凭证准备和运行中，只有原生会话确认空闲后才报告停止成功；未确认时明确报错并禁止复用该实例。运行时重建、退出账号与关闭宿主时释放专有进程。普通非云端 Daemon 尚不具备本次 Electron 的 DSH 安装管理能力，后端继续明确拒绝该组合。

## 验证

不要根据模型回答「我是什么 Harness」判断实现。检查主进程日志：

- `Runtime created ... harness=dsh`
- `DSH process connected; awaiting turn capability initialization: thread=...`

同时检查实际 DSH 子进程和对话完成事件。测试覆盖本地检测/安装、安装引导、renderer 到主进程的 Harness 字段、权威 Agent 配置与 Workspace 兼容字段不同的情况、生命周期、审批问题桥接和真实机器 DSH 进程的完整对话。

完整能力矩阵、真实业务证据和尚未完成的验收见 [DSH 能力对齐记录](./dsh-capability-parity.md)。当前实现不等于所有双宿主业务场景均已通过，尤其云端真实运行、搜索上游与完整安装包需要独立验证。
