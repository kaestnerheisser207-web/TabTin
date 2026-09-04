<div align="center">

<img src="assets/readme/muse-logo.png" alt="Muse" width="96" height="96" />

# Muse

**让团队和 Agent 协作更优雅**

[访问官网](https://tabtin.com/) · [商务合作](mailto:contact@larchiveai.com) · [开始使用](#开始使用) · [本地运行源码](#本地运行源码) · [参与贡献](CONTRIBUTING.md) · [安全政策](SECURITY.md)

中文 | [English](README.en.md)

</div>

<p align="center">
  <img src="assets/readme/tabtin-collaboration-hero-zh.png" alt="Muse 团队与 Agent 协作界面" />
</p>

Muse 是一个开源的人与 Agent 协作平台，面向希望把 Agent 带进真实工作的个人和团队。我们希望降低人和 Agent 共同工作的协作成本，让个人完成的工作能够被团队接续、复用和检查。

> **直接体验：** [访问 Muse 官网](https://tabtin.com/)，使用官方服务，无需自行维护服务端。
>
> **企业合作：** 如需部署评估、迁移协助、商业授权或定制服务，请联系 [contact@larchiveai.com](mailto:contact@larchiveai.com)。

公开仓库：[github.com/tabtin-ai/TabTin](https://github.com/tabtin-ai/TabTin)

> 我们希望工作因此更轻松，协作更顺畅，任务推进更清晰；每个人的工作被看见、判断被理解、贡献有据可验。

## 为什么做 Muse

AI 提高了个人产出，却没有自动提高团队效率。

团队使用 Agent 越深入，重复调研、上下文与判断依据丢失、Token 重复消耗、方法难复用和结果责任不清的问题越明显。

Muse 首先想解决一个问题：**一个人已经完成的工作，能不能直接成为下一位同事的起点？**

深度使用 AI 的团队是 Muse 最初切入的人群，但不是产品边界。Muse 面向所有希望把 Agent 带进真实工作的个人和团队。

## 个人和团队可以用 Muse 做什么

个人可以配置不同的 Agent、模型、Skill 和执行规则，让 Agent 直接参与调研、资料采集、文档、表格、演示文稿和代码等真实工作，并逐步形成自己的 Agent 工作方式。

团队可以交接任务、上下文和结果，复用已经验证的方法，共同处理在线内容，并通过权限、模型、用量和执行记录，让工作可以接续、检查和追溯。

### 工作可以交接

交接的不只是最后一份文档。任务续接会冻结必要的对话上下文，并带上任务中引用且有权共享的文档、表格、云端文件和本地文件。接手人能够理解结论怎样形成，并在自己选择的 Agent 和 Workspace 中创建独立任务继续推进。

每个人的本地文件和执行环境仍然相互独立，但已经完成的调研不必重做。

### 人和 Agent 操作同一份结果

Muse 提供消息、文档、多维表格和演示文稿等协作应用。Agent 可以直接创建和编辑这些内容；浏览器采集到的数据与媒体也可以继续进入工作应用。

人和 Agent 面对的是同一份在线结果，不需要在聊天框、文件下载和办公软件之间反复搬运。

### 团队方法可以复用

不同的 Agent 角色可以配置自己的规则、模型、Skill 和记忆。验证过的调研方法、Review 规则、测试步骤和发布流程可以在后续任务中继续使用，而不是依赖某位成员临时写出的一段 Prompt。

Agent 可以执行工作，但重要判断、责任确认和结果验收仍然由人完成。

### 团队可以拥有自己的 Agent 工作系统

Muse 不只提供客户端，也包括服务端、Agent Runtime、实时协作、工作应用和管理能力。个人和小团队可以直接使用官方服务；开发者可以在自己的电脑上运行 Community Server，也可以从源码继续修改。

我们会继续让架构更加模块化和可插拔。只有已经在公开代码中存在并经过验证的能力，才会写成当前能力；未来方向进入 [ROADMAP](ROADMAP.md)。

## 当前状态

Muse 当前处于 Public Preview（公开预览）阶段，正在进行首次完整公开发布。核心工作链路已经可以体验，但不同组件的成熟度和跨端体验仍有差异。

部分模块目前采用默认实现，替换和扩展能力仍待完善；Community Server 主要面向本机运行；移动端需要配合电脑执行环境；Project 是下一版本将重点推进的能力。

当前能力以公开代码、文档和实际验证结果为准，后续方向见 [ROADMAP](ROADMAP.md)。

## 开源范围

Muse 开放的是实际产品代码，而不是为开源单独制作的简化 Demo。

开发者可以在自己的环境中运行、扩展并参与建设这套平台。

计划公开的系统包括桌面和移动客户端、服务端、Agent Runtime、实时协作、消息、文档、表格、演示文稿、模型管理和管理后台等组成部分。Public Preview 阶段的最终范围和可用状态，以发布快照及验证记录为准。

## 开始使用

你可以根据自己的目标选择两种入口：

1. **官方服务**：适合希望直接体验产品、不自行维护服务端的个人和小团队。访问 [Muse 官网](https://tabtin.com/)。
2. **本地运行源码**：适合希望在本机体验、调试或二次开发 Muse 的用户和开发者。既可以让 Agent 自动准备环境并启动，也可以手动运行。

### 本地运行源码

在本机运行 Muse 源码有两种方式：使用 Agent 自动准备并启动，或手动运行脚本和命令。两种方式使用同一套本地开发环境，都不是 Community 分发包或正式 Release 构建。

#### 方式一：使用 Agent 启动

请使用支持本地代码操作的 Agent，并让它严格参考 [Community 开发 Agent 提示词](docs/development/community-dev-agent-prompt.md)。Agent 启动分为两步：

##### 第一步：安装依赖环境

先让 Agent 检查并准备项目所需的 Node.js、pnpm、Python、Go、Git、Docker、Docker Compose 以及当前平台的构建工具，再创建本地配置、安装项目依赖并执行 Doctor 检查。缺失的软件只能通过系统包管理器或官方渠道安装；遇到系统权限、Docker 首次启动、安全确认或许可证确认时，需要暂停并由用户确认。

##### 第二步：选择预览模式

环境准备完成后，让 Agent 运行下面两种预览之一：

| 预览模式 | 适用场景 | 启动内容 |
| --- | --- | --- |
| **快速预览** | 尽快体验或开发桌面端 | Community 后端、Collab、Centrifugo 和 Electron |
| **全量预览** | 完整本地联调和跨应用验收 | 后端、AdminDash、tabtin-web 和 Electron |

发送给 Agent 的指令可以是：

```text
请运行 https://github.com/tabtin-ai/TabTin 的「快速预览」
```

或：

```text
请运行 https://github.com/tabtin-ai/TabTin 的「全量预览」
```

快速预览和全量预览都是本地开发入口，不是 Community 分发包或正式 Release 构建。Android 和 iOS Debug 包需要在对应平台单独构建，不会由全量预览自动启动。只有后端健康、Electron 窗口就绪并满足对应验收条件时，Agent 才能报告启动成功。

详细的环境检查、依赖安装、失败处理和完成报告要求，见 [Community 开发 Agent 提示词](docs/development/community-dev-agent-prompt.md)。

#### 方式二：手动启动

首次运行前，请先按[本地开发与桌面打包新手指南](docs/development/getting-started.md)准备依赖、Docker 和本地配置，再选择点击启动或命令行启动。

##### 点击启动

Windows 用户在仓库根目录双击：

```text
start-community-dev.bat
```

macOS 用户双击：

```text
start-community-dev.command
```

这两个入口会调用统一的 Community 开发编排器，检查环境、启动或复用本地后端，并在后端健康后启动 Electron。适合不想记命令、但需要桌面开发链路的用户；它等价于快速预览，不会启动 AdminDash 或 tabtin-web。Linux 用户请使用下面的命令行入口。

##### 命令行启动

在仓库根目录执行：

```bash
# 快速预览：Community 后端 + Electron
node scripts/dev.mjs community

# 全量预览：后端 + AdminDash + tabtin-web + Electron
pnpm dev
```

快速预览适合桌面端开发和快速体验；全量预览会等待后端健康检查，通过后依次启动 AdminDash、tabtin-web 和 Electron，适合完整联调。所有进程由当前命令管理，按 `Ctrl+C` 停止。

如只需要调试单个服务，可使用 `node scripts/dev.mjs backend`、`admindash`、`tabtin-web` 或 `electron`；这些命令不替代完整预览的健康检查和启动顺序。

首次配置只复制模板，不覆盖已有本地文件：

```bash
cp .env.example .env
```

Community 启动入口只从根 `.env` 读取 `MUSE_EDITION` 和 `AUTH_FIXED_VERIFICATION_CODE` 两个公开开关，并生成不包含其他密钥的内部运行文件。模板默认 `MUSE_EDITION=community`；手机号注册/登录固定提示码可在 `.env` 中留空关闭，关闭后使用真实发送链路。

个人覆盖配置放在根目录 `.env.local`，两个文件都不得提交。中国大陆网络环境可使用 `node scripts/dev.mjs community --region cn`。

区域选择、复用既有后端和排障见 [Electron 开源开发指南](apps/tabtin-electron/docs/open-source-development.zh-CN.md)，英文版见 [Electron open-source development](apps/tabtin-electron/docs/open-source-development.md)。Community Server 的独立安装和 BYOK 配置见[Community 快速开始指南](docs/development/community-quickstart.md)。

### 移动端构建

> 当前移动端是 Muse 桌面端的配套入口，不提供独立的 Agent 执行环境。要从移动端发起或控制 Agent 任务，需要先在桌面端完成执行环境配置与设备绑定，并在任务运行时保持该电脑在线。只安装移动端不能独立执行 Agent 任务。

* [iOS 构建指南](apps/tabtin-ios/README.md)
* [Android 构建指南](apps/tabtin-android/README.md)

## 文档导航

* [产品概念](docs/architecture/product-concepts.md)
* [贡献指南](CONTRIBUTING.md)
* [支持入口](SUPPORT.md)
* [安全政策](SECURITY.md)
* [社区行为准则](CODE_OF_CONDUCT.md)
* [公共路线图](ROADMAP.md)
* [版本记录](CHANGELOG.md)

## 参与社区

Bug 和信息相对完整的功能需求请使用 Issue；使用帮助、开放想法和尚未成形的方向请使用 Discussions；安全漏洞请按照 [SECURITY.md](SECURITY.md) 私密报告。如果暂时无法通过 GitHub 提交问题，可以发送邮件至 [issue@larchiveai.com](mailto:issue@larchiveai.com)。

中文和英文贡献都受欢迎。使用 AI 辅助贡献时，提交者仍需理解、审阅并验证自己提交的内容。具体规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 数据与隐私

Community Server 默认只监听本机地址，并把账号、配置和业务数据保存在本机 Docker 数据卷中。Community 客户端默认不连接 Muse 维护方的 Sentry（错误监控）或更新服务；完整诊断包只能在用户明确同意后上传。官方服务的数据处理以公开隐私政策为准。

## 许可证与商标

Muse 的公开源码依据 [AGPL-3.0-only](LICENSE) 提供。对于无法采用 AGPL-3.0-only 的使用或分发场景，可以通过 [contact@larchiveai.com](mailto:contact@larchiveai.com) 向 Shanghai Mofan Technology Co., Ltd. 咨询单独商业授权。

第三方组件继续适用各自的许可证，参阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Muse 名称和标识属于项目维护方的商标；分支项目可以如实说明“基于 Muse”，但不得冒充官方版本。

Copyright © 2026 Shanghai Mofan Technology Co., Ltd.
