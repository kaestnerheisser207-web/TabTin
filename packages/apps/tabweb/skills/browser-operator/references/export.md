# Browser Operator · 页面导出

> 讲把页面导出成 PDF / Markdown / 截图（`print` + `glance --screenshot`）。
> **保存路径白名单**：Electron 端 `--save` 只允许 `~/.tabtin` 与 `/tmp` 下的路径（Daemon 额外允许工作区内路径）；要交付到工作区，先存白名单目录再复制过去。

## 页面导出（print，始终落盘、--save 必填）

```bash
muse browser print --as pdf --save ~/.tabtin/exports/report.pdf
muse browser print --as pdf --landscape --page-size Letter --save ~/.tabtin/exports/report.pdf
muse browser print --save ~/.tabtin/exports/article.md              # 默认 markdown
muse browser print --url "https://..." --save ~/.tabtin/exports/article.md
```

> **print 默认剥离内容类型**：默认**剥离图片 / 链接 / 媒体 / 表格**，只留正文文本。
> 要保留用内容类型白名单 `--include`：
>
> ```bash
> muse browser print --include images,links --save out.md   # 保留图片与链接
> muse browser print --include all --save out.md            # 全部保留
> ```

## 截图（glance --screenshot）

```bash
muse browser glance --screenshot --save ~/.tabtin/exports/page.png
muse browser glance --screenshot --full-page --save ~/.tabtin/exports/full.png
muse browser glance --screenshot --som --save ~/.tabtin/exports/annotated.png   # SoM 标注
```

不传 `--save` 时截图落到 `~/.tabtin/screenshots/`，响应里带 `screenshot_path`。
