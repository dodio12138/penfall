# 工作区与稿件格式（v1）

## 概念

| 名称 | 是什么 | 文件 |
|---|---|---|
| **工作区** | 一个文件夹，相当于 VS Code 打开的项目文件夹 | 根目录下的 `workspace.wtw` 保存本工作区共用的机器设置 |
| **稿件** | 一份要书写的东西：正文和它的 G-code 成对出现 | `名称.wtl`（链接）+ `名称.txt`（正文）+ `名称.gcode`（程序） |
| 单独文件 | 没有链接的 `.txt` / `.md` / `.gcode` / `.nc` / `.tap` | 可直接打开；单独的正文一旦生成 G-code，会自动补上 `.wtl` 变成稿件 |

文件树按 VS Code 的「文件嵌套」方式显示：`名称.wtl` 显示为一个「稿」节点，同名的 `.txt` 和 `.gcode` 嵌套在它下面。打开稿件后，「正文」和「G-code」是同一稿件的两页。

工作区可以在两个地方：

- **本浏览器**：存放在 IndexedDB，离线可用，只在当前浏览器里。
- **服务器文件夹**：运行 `server.py` 的电脑上 `workspaces/<工作区名>/`（可用 `--workspaces` 指定根目录），是真实的磁盘文件，其他程序也可以编辑。访问需要密钥，密钥保存在 `.bridge-key`，重启不变。

## `workspace.wtw`

```json
{ "format": "web-typewriter/workspace", "version": 1, "machine": { "penWidth": 0.5, "pens": [{ "name": "黑", "color": "#1f2328" }, { "name": "红", "color": "#d0342c" }] } }
```

- `machine.penWidth`：笔在纸上画出的线宽（mm，0.05–5），用于纸张预览，以及刀轨页「按笔宽显示」。
- `machine.pens`：笔架，1–8 支，按顺序编号为笔 1、笔 2……；图形颜色自动对应到颜色最接近的笔。

## `名称.wtl`（稿件链接）

```json
{
  "format": "web-typewriter/link",
  "version": 1,
  "text": "给妈妈.txt",
  "gcode": "给妈妈.gcode",
  "settings": { "paper": "a4", "orientation": "portrait", "font": "serif", "font-size": "5", "line-gap": "3", "letter-gap": "1", "margin": "20" },
  "motion": { "feed": "1200", "pen-up": "5", "pen-down": "0", "page": "1", "origin-corner": "top-left", "origin-x": "10", "origin-y": "8", "x-dir": "1", "y-dir": "-1" },
  "glyphs": { "libraries": ["builtin-latin"], "strategy": "first", "seed": 1, "prefer": {}, "pins": [] },
  "view": "editor",
  "drawing": { "file": "给妈妈.svg", "page": 1, "x": 20, "y": 20, "width": 120 },
  "sync": { "source": "generated", "textHash": "…", "paramsHash": "…", "gcodeHash": "…", "at": "2026-11-09T03:00:00.000Z" }
}
```

- `text` / `gcode`：同一文件夹中的文件名（不能含路径）。重命名或移动稿件时三个文件一起改。
- `settings` / `motion` / `glyphs`：生成 G-code 用到的全部参数（排版、笔轴、笔起点、页码、选字，见 [glyph-format.md](glyph-format.md)）。
- `drawing`（可选）：同一文件夹中的 `.svg` / `.dxf`，以及它在纸上的位置（`x` / `y` 为左上角距纸边 mm，`width` 为宽度 mm，`page` 为所在页）。图形文件的内容也计入梳串。
- `motion.text-pen` / `motion.pen`：正文用哪支笔、当前生成哪支笔（`all` 表示不换笔）。
- `view`：只在第一次打开时作为默认视图；之后每台设备自己记住看的是哪一页，切换视图不会改写文件。
- `sync`：上次「正文、参数、程序三者一致」时各自的哈希值，以及程序来源：`generated` 表示生成器输出，`manual` 表示手动编辑或导入的程序。

## 梳串

打开稿件时，以及每次「开始模拟」「发送至机器」之前，都会执行一次：

1. 保存本页改动；如果文件在别处（其他页面或其他程序）有更新，先重新载入。
2. 用 `sync` 中记录的哈希比较当前文件：

| 情况 | 处理 |
|---|---|
| 还没有 G-code | 从正文生成 |
| 正文或参数变了，G-code 是未改动的生成器输出 | 重新生成 |
| 正文或参数变了，G-code 是手动版本 | 保留，不改写；提示不一致，模拟前需确认，刀轨页可一键重新生成 |
| G-code 被外部修改过 | 保留，此后按手动版本对待 |
| 都没变 | 一致，直接运行 |

3. 保存结果，更新 `sync`。

## 冲突

每次写入都带着上次读到的修改时间。如果文件已在别处改过，写入会被拒绝，页面会暂停编辑并提示两个选择：「载入最新版本」（放弃本页未保存的改动），或「用本页内容覆盖」。

## 备份

「备份工作区」下载一个 JSON 文件（`web-typewriter/workspace-archive`），包含全部文件，以及本页尚未保存的内容。导入备份时，会在所选文件夹下新建一个同名文件夹放置这些文件，不覆盖已有文件。旧版的浏览器文稿备份（v3）导入时会自动转换为稿件。第一次打开新版时，旧版浏览器中的文稿会自动转换到「我的工作区」，旧数据保留不删。
