# Skill Market · CLI 命令

> 本文从主 [`../SKILL.md`](../SKILL.md) 拆出，给需要核对 `muse skill` 子命令完整 flag、
> 参数约束或示例时查阅。CLI 定义源：`packages/tabtin-cli-go/cmd/apps_discovery.go`。
>
> Wave 1：安装主契约与 Electron 对齐——`POST /skills/{canonicalKey}/enable`，
> 设备端（Electron / Daemon CliServer）负责物化本地文件。

### `muse skill list` —— 列出已装 Skill

```bash
muse skill list                              # 当前已装全部
muse skill list --category data              # 按分类过滤
muse skill list --include-disabled           # 包含已禁用的 Skill
```

**Flags**：
- `--category <cat>` / `-c <cat>`：按分类过滤。
- `--include-disabled`：默认隐藏已禁用 Skill，加此 flag 显示全部。

### `muse skill info <key>` —— 看详情

```bash
muse skill info user:web-search
```

**参数**：`<key>` = canonical key（必填）。走 `GET /skills/{key}/package`。

### `muse skill market` —— 看市场

```bash
muse skill market
```

### `muse skill managed` —— 当前 Space 可见 Skill

```bash
muse skill managed
```

**说明**：原「托管列表」端点已下线；现对齐 Wave 1 `GET /skills/visible`（需 Space 上下文）。

### `muse skill search <query>` —— 搜索

```bash
muse skill search data-analysis
```

走 `GET /skills/market?q=<query>`。

### `muse skill install <key>` —— 安装（= enable）

```bash
muse skill install user:web-search
muse skill install app:tabtin-office-skills-pack/meeting-notes-to-actions
```

**参数**：`<key>` = canonical key（必填）。

**契约**：`POST /skills/{key}/enable` + body `{ space_id }`。CliServer 成功后：
- `app:` → `materializeAppSkill`（bundled 源拷贝）
- `user:` + `package_id` → Package Registry 下载到 Space skills 目录

**Risk: RiskWrite**。RequiresAgent。安装后已启用，无需再 `enable`。

### `muse skill install npm:<pkg>` —— 本机 npm 安装

```bash
muse skill install npm:@scope/foo
muse skill install --from-npm @scope/foo
muse skill install npm:@scope/foo --import-to-space   # 可选：再导入成「我的」
```

**契约**：`POST /skills/install-npm` → 本机执行 `npx skills add <pkg> -y -g`，写入
`~/.agents/skills/`（可用 `MUSE_AGENTS_SKILLS_DIR` 覆盖），并刷新 LocalSkillRegistry。
默认只出现在面板「本机」分组（只读发现，见 ）；加 `--import-to-space` 再走 import API。

### `muse skill import <source>` —— 本地 / HTTPS 导入

```bash
muse skill import ./my-skill
muse skill import ./pack.zip
muse skill import https://example.com/skill.zip
muse skill import ./my-skill --no-enable
muse skill import ./my-skill --name custom-name
```

**参数**：`<source>` = 本地目录 / `SKILL.md` / `.zip`，或 `https://` URL。

**契约**：`POST /skills/import`（CliServer）：
- 本地：读文件组 `files[]` → Django import → 物化到当前 Space sandbox → 默认 enable
- HTTPS：后端 `_import_from_url`（仅 https）
- `--no-enable`：只导入不启用

需要 Space 上下文（`--space-id` 或 Agent 会话）。

### `muse skill remove <key>` —— 卸载

```bash
muse skill remove user:web-search
```

**契约**：`POST /skills/{key}/disable` + `{ space_id, remove: true }`，并清理本地目录。

### `muse skill enable <key>` —— 启用

```bash
muse skill enable user:web-search
muse skill enable app:tabtin-office-skills-pack/meeting-notes-to-actions
```

与 `install` 同路径；用于 previously disabled 的 skill 重开。

### `muse skill disable <key>` —— 禁用

```bash
muse skill disable user:web-search
```

**契约**：`POST /skills/{key}/disable`（默认 `remove=false`）——保留安装记录与本地文件。

### `muse skill update <key>` —— 更新

```bash
muse skill update user:web-search
```

**契约**：再次 `POST /skills/{key}/enable`，后端刷到最新已发布版本并重新物化。
