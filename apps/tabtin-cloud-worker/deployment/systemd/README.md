# Community Cloud Worker（rootless）

Community 版的 Cloud Worker Supervisor 直接运行在管理员的 VPS 上，并只连接同一专用账号拥有的 rootless Podman Docker-compatible socket。终端用户不部署 Worker，只安装 TabTin 客户端；Django 控制面通过现有域名的 TLS 反向代理访问 Worker 控制 API。

## 安全边界

- 禁止把宿主 `/var/run/docker.sock` 挂进容器，也不要把 `tabtin-cloud-worker` 加入 rootful `docker` 组；两者都等价于把宿主 root 权限交给 Worker。
- 为 `tabtin-cloud-worker` 创建无登录专用系统账号，并以该账号安装、启动 rootless 容器运行时。
- `DOCKER_HOST` 必须指向该账号自己的 `/run/user/<uid>/podman/podman.sock`；控制 API 只绑定宿主 bridge 地址，由 TLS 反向代理向 Django 暴露。
- Podman volume 根目录必须位于启用 `prjquota`/`pquota` 的 XFS 文件系统；Worker 启动时会真实创建 `1 MiB` probe volume，配额不生效就拒绝启动，不能仅靠配置字符串宣称支持。
- Rootless Podman 必须运行在 cgroup v2 + systemd manager/delegation 下；Worker 会读取 runtime info 验证，否则不宣称 CPU/内存/PID 硬限制可用。
- `/etc/tabtin/cloud-worker.env` 权限设为 `0600 root:root`；Worker token 只配置在 Django 的 `TABTIN_CLOUD_WORKERS_JSON_FILE` 与该文件中。

## 安装轮廓

1. 构建 `@tabtin/cloud-worker`，将 `dist/` 部署到 `/opt/tabtin-cloud-worker/dist/`。
2. 安装 rootless Podman 与 Docker-compatible socket，把 graphroot 与 volume storage 放在 XFS `prjquota`/`pquota` 挂载点；使用专用账号验证 `DOCKER_HOST=... docker info` 成功，并创建 `tabtin-cloud-runtime` 网络。
3. 从 `cloud-worker.env.example` 生成 `/etc/tabtin/cloud-worker.env`，替换 UID、随机 token 与不可变 Runtime 版本。
4. 安装 `tabtin-cloud-worker.service` 后执行 `systemctl daemon-reload`、`systemctl enable --now tabtin-cloud-worker`。
5. 在 Django 侧通过 `TABTIN_CLOUD_WORKERS_JSON_FILE` 配置同一个 token；周期 heartbeat 会自动物化 `CloudWorkerNode`，只有 HTTPS `/v1/health` 的 protocol/runtime/storageQuotaMode 三重门禁通过后才置为 `ready`，无需手工插数据库。

`TABTIN_CLOUD_WORKERS_JSON` 的 Community 节点示例（生产 endpoint 必须是 HTTPS）：

```json
{
  "community-vps-1": {
    "name": "Community VPS 1",
    "edition": "community",
    "organization_id": "00000000-0000-4000-8000-000000000000",
    "endpoint": "https://tabtin.example.com/_internal/cloud-worker",
    "token": "replace-with-the-same-random-secret",
    "protocol_version": "1",
    "runtime_version": "replace-with-the-runtime-image-version",
    "storage_quota_mode": "podman-xfs",
    "resource_isolation_mode": "cgroup-v2",
    "capacity_cpu_millicores": 8000,
    "capacity_memory_mb": 16384,
    "capacity_storage_gb": 80
  }
}
```

token 只存在于 Django secret 与 Worker env，不写入 `CloudWorkerNode`；从 JSON 移除的 settings 托管节点会自动标为 `offline`。

Worker 的 `/v1/health` 与 `/v1/metrics` 使用同一个 Bearer 边界；metrics 只暴露有界 operation/result 请求计数、耗时和不可变版本能力，不使用 organization、user、Workspace、allocation 或 thread 作为 Prometheus label。systemd stdout/stderr 为单行 JSON 事件，可携带 allocation/generation 诊断字段，但不记录请求 body、token、命令 stderr 或文件内容。

此目录只定义 Community Worker Supervisor；Cloud Runtime 镜像仍由 `apps/tabtin-daemon/Dockerfile.cloud` 构建并以 `image@sha256:<digest>` 供给，禁止 floating tag。
