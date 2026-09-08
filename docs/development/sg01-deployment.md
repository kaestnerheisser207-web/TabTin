# sg01 发布目标与切换验收

正式 Muse VPS 目标为 `sg01`：`15.235.211.82:22`，服务器 hostname 为 `vps-a54e75a4`，Actions 使用受限账户 `tabtin-deploy`。ks6 不是本工作流允许的发布目标。

## 发布保护

- 工作流在镜像构建、registry 登录和 SSH 凭证使用前，检查目标、host、port、user 及两个 SHA 的 main 归属。
- 工作流工具采用 `github.workflow_sha`，应用构建采用单独的 `RELEASE_SHA`。手工标准发布选择 `deployment=standard`；Cloud 仍是独立模式。
- 重用镜像仅适用于显式标准发布，必须核对固定仓库 digest、OCI revision 和 Linux/amd64；缺少镜像时失败，不静默重建或换版本。
- 受限 SSH gateway 和标准发布脚本再次核对物理 hostname；公钥只能调用固定部署脚本，不能交互登录、转发或上传脚本。
- 标准脚本逐个验证拉取镜像的 revision/platform，保留旧镜像及源发布目录。
- 本机健康检查通过后，公网响应必须同时含 `status=ready` 和 `X-Muse-Deployment-Target: sg01`。ks6 返回 200/ready 不能充当 sg01 验收。
- 普通 PR 契约测试有独立并发组，不能替换等待中的生产发布；生产审批和发布串行化仍保留。

## 服务器准备边界

受限发布密钥不能自举权限。管理员先审阅并配置 sg01 专用账户、公钥、固定 sudo 脚本范围、root 控制的发布目录、可信 SSH host keys，以及对应 GitHub Actions 配置。不要沿用指向 ks6 的 host/known_hosts，也不要把通用管理员私钥放入 Actions。

现有 sg01 Compose 的应用镜像名需要与 Muse 发布脚本一致，并包含 celery-beat。应用数据库、安装密钥卷和文件卷保留 sg01 现有内容；不将 ks6 旧数据库覆盖回来。正式入口切换前，核对实际应用域名、允许的 Origin、Nginx upstream 和 TLS，给 sg01 的目标虚拟主机加上上述来源响应头。停止旧主机的应用调度应与切换窗口协调，避免两端同时处理同一业务。

## 数据库兼容

sg01 已应用 `meetings.0007/0008`。旧发布包缺少这两个文件会被 `safe_migrate` 的 artifact preflight 拒绝，不能跳过保护或逆向迁移解决。本修复只携带原件迁移、对应被动模型和 nullable UUID 字段，不包含未完成的会议 API 或录音功能。

切换前已为 sg01 创建数据库、应用配置、密钥卷和文件卷的受控备份，并通过临时隔离数据库完整恢复验证。只读 migration plan 为空；实际部署仍必须重新执行 `safe_migrate --plan` 和完整保护检查。备份存在不等于允许覆盖数据库；恢复属于单独的、按目标核对的维护动作。

## 验证

```sh
python -m pytest scripts/tests/test_vps_deployment_guard.py scripts/tests/test_vps_deploy_workflow.py
```

这些测试覆盖目标错误、主线归属、镜像元数据、旧主机公网响应、SSH 参数及并发分组，且不访问远端。数据库 schema 兼容测试为 `apps/meetings/test_schema_compatibility.py`；运行时必须使用测试设置，不把测试连接到业务数据库。

交付须分别记录：PR/CI、批准的应用 SHA、Actions 结果、sg01 实际容器 revision/health、公网来源证明、旧主机应用状态和业务验收。Cloud 镜像构建、Cloud 主机部署和组织 Cloud Agent 启用是不同的完成条件。
