# Muse

**A more elegant way for teams and Agents to collaborate**

[中文](README.md)

[Website](https://tabtin.com/) · [Business inquiries](mailto:contact@larchiveai.com) · [Get started](#get-started) · [Run from source locally](#run-from-source-locally) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md)

<p align="center">
  <img src="assets/readme/tabtin-collaboration-hero.png" alt="Muse collaboration between people and Agents" />
</p>

Muse is an open-source collaboration platform for people and Agents, built for individuals and teams that want to bring Agents into real work. We want to reduce the friction of working with Agents, so work completed by one person can be continued, reused, and reviewed by the team.

> **Try Muse:** [Visit the Muse website](https://tabtin.com/) to use the official hosted service without operating your own server.
>
> **Business inquiries:** For deployment assessments, migration assistance, commercial licensing, or custom services, contact [contact@larchiveai.com](mailto:contact@larchiveai.com).

Public repository: [github.com/tabtin-ai/TabTin](https://github.com/tabtin-ai/TabTin)

> We want work to feel easier, collaboration smoother, and task execution clearer—while making each person's work visible, their decisions understandable, and their contributions verifiable.

## Why Muse

AI increases individual output, but it does not automatically improve team efficiency.

As teams rely more heavily on Agents, repeated research, lost context and decision rationale, repeated Token spending, methods that are difficult to reuse, and unclear accountability become more visible.

Muse starts by asking one question: **Can work completed by one person become the next colleague's starting point?**

Teams already using AI deeply are Muse's first wedge, not its product boundary. Muse is for any individual or team that wants to bring Agents into real work.

## What individuals and teams can do with Muse

Individuals can configure different Agents, models, Skills, and execution rules, then involve Agents directly in research, information gathering, documents, tables, presentations, code, and other real work. Over time, they can develop an Agent workflow that fits how they work.

Teams can hand off tasks, context, and results; reuse validated methods; work together on online content; and use permissions, models, usage records, and execution history to make work continuable, reviewable, and traceable.

### Work can be handed off

A handoff can include more than the final document. Task continuation freezes the necessary conversation context and carries documents, tables, cloud files, and local files referenced by the task when they can be shared. The next person can understand how the outcome was formed and create an independent task with an Agent and Workspace they select.

Each person's local files and execution environment remain separate, while completed research does not need to be repeated.

### People and Agents operate on the same result

Muse provides collaboration applications for messaging, documents, data tables, and presentations. Agents can create and edit this content directly, and data and media collected by the browser can continue into the work applications.

People and Agents work on the same online result instead of repeatedly moving content between chat, downloads, and office software.

### Team methods can be reused

Different Agent roles can have their own rules, models, Skills, and memory. A research method, review rule, test procedure, or release process that has already been validated can be reused in later work instead of depending on a prompt written by one person at one moment.

Agents can execute work, while important decisions, accountability, and acceptance remain human responsibilities.

### Teams can own their Agent work system

Muse includes more than a client. It also includes server components, an Agent Runtime, real-time collaboration, work applications, and administration capabilities. Individuals and small teams can use the official service, while developers can run Community Server on their own computer or continue developing and modifying the product from source.

We will continue making the architecture more modular and pluggable. Only capabilities that exist in the public source and have been verified are described as current. Future directions belong in the [roadmap](ROADMAP.en.md).

## Current status

Muse is currently in Public Preview and preparing its first complete public source release. Its core workflows are available to try, but components still differ in maturity and cross-platform consistency.

Some modules currently rely on default implementations and still need easier replacement and extension paths. Community Server is primarily designed for local use today. Mobile clients require a configured computer execution environment, and Project is a focus for the next version.

Current capabilities are defined by the public source and verified behavior. See the [roadmap](ROADMAP.en.md) for future directions.

## Open-source scope

Muse is open-sourcing the actual product code, not a separate simplified demo.

Developers can run the platform in their own environments, extend it, and help build it.

The intended public system includes desktop and mobile clients, server components, the Agent Runtime, real-time collaboration, messaging, documents, tables, presentations, model management, and administration. The final Public Preview scope and availability status must match the released snapshot and its verification record.

## Get started

Choose one of these two entry points:

1. **Official service**: for individuals and small teams that want to experience Muse without operating server infrastructure. Visit the [Muse website](https://tabtin.com/).
2. **Run from source locally**: for users and developers who want to try, debug, or extend Muse on their own computer. An Agent can prepare and start the environment, or you can run it manually.

### Run from source locally

There are two ways to run the Muse source locally: ask an Agent to prepare and start it, or run the scripts and commands yourself. Both use the same local development environment; neither is a Community distribution package or a production release build.

#### Option 1: Start with an Agent

Use an Agent that can operate on local files and ask it to follow the [Community development Agent prompt](docs/development/community-dev-agent-prompt.en.md). Agent startup has two steps:

##### Step 1: Prepare the environment

Ask the Agent to check and prepare Node.js, pnpm, Python, Go, Git, Docker, Docker Compose, and the build tools required by the current platform. It then creates local configuration, installs project dependencies, and runs the Doctor check. Missing software must come from system package managers or official vendor channels. The Agent pauses for system permissions, Docker's first launch, security confirmations, or license confirmations that require the user.

##### Step 2: Choose a preview mode

After the environment is ready, ask the Agent to run one of these previews:

| Preview | Best for | Starts |
| --- | --- | --- |
| **Quick Preview** | Quickly trying or developing the desktop client | Community backend, Collab, Centrifugo, and Electron |
| **Full Preview** | Complete local integration and cross-application acceptance | Backend, AdminDash, tabtin-web, and Electron |

Send one of these instructions to the Agent:

```text
Run the “Quick Preview” for https://github.com/tabtin-ai/TabTin.
```

or:

```text
Run the “Full Preview” for https://github.com/tabtin-ai/TabTin.
```

Quick Preview and Full Preview are local development entry points, not Community distribution packages or production release builds. Android and iOS debug packages must be built separately on their target platforms. The Agent may report success only after the backend is healthy, Electron is ready, and the relevant acceptance conditions are met.

See the [Community development Agent prompt](docs/development/community-dev-agent-prompt.en.md) for the full environment, dependency, failure-handling, and completion-report requirements.

#### Option 2: Start manually

Before the first run, prepare the dependencies, Docker, and local configuration using the [Beginner's Guide to Local Development and Desktop Packaging](docs/development/getting-started.en.md), then choose click-to-start or the command line.

##### Click to start

On Windows, double-click the following file in the repository root:

```text
start-community-dev.bat
```

On macOS, double-click:

```text
start-community-dev.command
```

These launchers call the shared Community development orchestrator. They check the environment, start or reuse the local backend, and start Electron after the backend is healthy. They are suitable for users who want the desktop development chain without remembering commands. They are equivalent to Quick Preview and do not start AdminDash or tabtin-web. Linux users should use the command-line entry point below.

##### Command-line startup

From the repository root, run:

```bash
# Quick Preview: Community backend + Electron
node scripts/dev.mjs community

# Full Preview: backend + AdminDash + tabtin-web + Electron
pnpm dev
```

Quick Preview is for desktop development and fast local testing. Full Preview waits for backend health checks and then starts AdminDash, tabtin-web, and Electron in order for complete integration. The command owns all child processes; press `Ctrl+C` to stop them.

To debug one service separately, use `node scripts/dev.mjs backend`, `admindash`, `tabtin-web`, or `electron`. These individual commands do not replace Full Preview's complete health gates or startup order.

Create the base configuration from the template without overwriting an existing local file:

```bash
cp .env.example .env
```

Put personal overrides in the root `.env.local`; neither file should be committed. For mainland China networks, use `node scripts/dev.mjs community --region cn`.

For region selection, backend reuse, and troubleshooting, see the [Electron open-source development guide](apps/tabtin-electron/docs/open-source-development.md); the [Chinese guide](apps/tabtin-electron/docs/open-source-development.zh-CN.md) is also available. For standalone Community Server setup and BYOK configuration, see the [Community quickstart guide](docs/development/community-quickstart.md).

### Mobile builds

> The mobile clients are companion interfaces to Muse Desktop and do not provide an independent Agent execution environment. Before starting or controlling Agent tasks from mobile, configure and bind the execution environment in the desktop client and keep that computer online while tasks run. A mobile client alone cannot execute Agent tasks.

- [iOS build guide](apps/tabtin-ios/README.md)
- [Android build guide](apps/tabtin-android/README.md)

## Documentation

- [Product concepts](docs/architecture/product-concepts.en.md)
- [Contributing](CONTRIBUTING.en.md)
- [Support](SUPPORT.en.md)
- [Security](SECURITY.en.md)
- [Code of Conduct](CODE_OF_CONDUCT.en.md)
- [Roadmap](ROADMAP.en.md)
- [Changelog](CHANGELOG.en.md)

## Explore with us

We welcome individuals, teams, and developers around the world who are using or exploring Agents to try Muse, report real problems, share working methods, or contribute code, documentation, Skills, work applications, and adapters.

We hope to explore better ways for people and Agents to collaborate in the AI era—together.

Use Issues for bugs and well-shaped feature requests, Discussions for help and open-ended ideas, and follow [SECURITY.en.md](SECURITY.en.md) to report vulnerabilities privately. If you cannot submit a report through GitHub, email [issue@larchiveai.com](mailto:issue@larchiveai.com).

Contributions in Chinese and English are welcome. When AI is used, the contributor remains responsible for understanding, reviewing, and verifying the submitted work. See [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## Data and privacy

Community Server listens only on the local machine by default and stores account, configuration, and business data in local Docker volumes. The Community client does not connect to Muse-maintainer Sentry or update services by default. Full diagnostic bundles may be uploaded only with explicit user consent. Data processing for the official service follows its published privacy policy.

## License and trademarks

Muse's public source is provided under [AGPL-3.0-only](LICENSE). Organizations whose use or distribution is incompatible with AGPL-3.0-only may contact Shanghai Mofan Technology Co., Ltd. at [contact@larchiveai.com](mailto:contact@larchiveai.com) about separate commercial licensing.

Third-party components remain subject to their respective licenses. See [THIRD_PARTY_NOTICES.en.md](THIRD_PARTY_NOTICES.en.md). The Muse name and marks are trademarks of the project maintainer. Forks may truthfully state that they are “based on Muse,” but must not impersonate an official release.

Copyright © 2026 Shanghai Mofan Technology Co., Ltd.
