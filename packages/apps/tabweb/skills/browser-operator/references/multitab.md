# Browser Operator · 多标签页与管道组合

> 讲多标签页并行工作流，以及把多步操作串成一条 CLI 流水线。

## 多标签页工作流

```bash
muse browser open --url "https://source-a.com"
muse browser open --url "https://source-b.com"
muse browser tab list
muse browser tab switch --tab-id <id>
muse browser tab close --tab-id <id>
```

## 管道组合

CLI 核心优势 — 一条命令完成多步流水线：

```bash
muse browser open --url "https://docs.example.com/guide" && \
  muse browser wait --selector ".content" && \
  muse browser print --as pdf --save ~/.tabtin/exports/guide.pdf && \
  muse browser print --save ~/.tabtin/exports/guide.md

for url in "https://a.com" "https://b.com"; do
  # Linux 用 md5sum；macOS 上同名 hash 工具调用方式不同，跨平台脚本请自行适配
  muse browser print --url "$url" --save "$(echo $url | md5sum | cut -d' ' -f1).md"
done

muse browser glance --format json | jq -r '.observed_elements[0].ref' | \
  xargs -I{} muse browser act --actions "[{\"type\":\"click\",\"ref\":\"{}\"}]"
```
