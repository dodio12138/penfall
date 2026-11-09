# 工作区与稿件格式（v1）

> 落笔 Penfall 改名前写入的文件使用 `web-typewriter/…` 作为 format 标识，仍可读取；再次保存时改写为 `penfall/…`。

## 概念

| 名称 | 是什么 | 文件 |
|---|---|---|
| **工作区** | 一个文件夹，相当于 VS Code 打开的项目文件夹 | 根目录下的 `workspace.wtw` 保存本工作区共用的机器设置 |
| **稿件** | 一份要书写的东西：正文和它的 G-code 成对出现 | `名称.wtl`（链接）+ `名称.txt`（正文）+ `名称.gcode`（程序） |
| 模板 | 新建稿件时使用的版式与起始正文 | `名称.wtt`（`penfall/template`：`name`、`description`、`settings`、`text`） |
| 单独文件 | 没有链接的 `.txt` / `.md` / `.gcode` / `.nc` / `.tap` | 可直接打开；单独的正文一旦生成 G-code，会自动补上 `.wtl` 变成稿件 |

文件树按 VS Code 的「文件嵌套」方式显示：`名称.wtl` 显示为一个「稿」节点，同名的 `.txt` 和 `.gcode` 嵌套在它下面。打开稿件后，「正文」和「G-code」是同一稿件的两页。

工作区可以在两个地方：

- **本浏览器**：存放在 IndexedDB，离线可用，只在当前浏览器里。
- **服务器文件夹**：运行 `server.py` 的电脑上 `workspaces/<工作区名>/`（可用 `--workspaces` 指定根目录），是真实的磁盘文件，其他程序也可以编辑。访问需要密钥，密钥保存在 `.bridge-key`，重启不变。

## `workspace.wtw`

```json
{ "format": "penfall/workspace", "version": 1, "machine": {
  "penWidth": 0.5, "pens": [{ "name": "黑", "color": "#1f2328" }, { "name": "红", "color": "#d0342c" }],
  "preset": "我的写字机",
  "motion": { "pen-mode": "servo-m5", "servo-down": "30", "pen-delay": "0.15", "feed": "2000" },
  "limits": { "machine-x": "210", "machine-y": "297", "machine-z-min": "0", "machine-z-max": "10", "travel-x-min": "-300", "baud": "115200" },
  "presets": [{ "name": "我的写字机", "motion": { … }, "limits": { … } }]
} }
```

- `machine.penWidth`：笔在纸上画出的线宽（mm，0.05–5），用于纸张预览，以及刀轨页「按笔宽显示」。
- `machine.pens`：笔架，1–8 支，按顺序编号为笔 1、笔 2……；图形颜色自动对应到颜色最接近的笔。
- `machine.preset`：最近应用的机型预设名称（「机器 › 机型」）。
- `machine.motion`：机型的抬笔方式、速度和笔零点。之后新建的稿件以它为默认值（字段名同 `.wtl` 的 `motion`）。
- `machine.limits`：「行程与安全」中的纸张范围、Z 范围、机器行程和波特率，按工作区记住。发送前的安全确认不保存，每次都要重新勾选。
- `machine.presets`：本工作区保存的机型预设（最多 50 个）。内置预设（通用 GRBL Z 轴、两种舵机）不写入文件。

## `名称.wtl`（稿件链接）

```json
{
  "format": "penfall/link",
  "version": 1,
  "text": "给妈妈.txt",
  "gcode": "给妈妈.gcode",
  "settings": { "paper": "a4", "orientation": "portrait", "font": "serif", "font-size": "5", "line-gap": "3", "letter-gap": "1", "margin": "20" },
  "motion": { "feed": "1200", "pen-up": "5", "pen-down": "0", "page": "1", "origin-corner": "top-left", "origin-x": "10", "origin-y": "8", "x-dir": "1", "y-dir": "-1" },
  "glyphs": { "libraries": ["builtin-latin"], "strategy": "first", "seed": 1, "prefer": {}, "pins": [] },
  "view": "editor",
  "drawing": { "file": "给妈妈.svg", "page": 1, "x": 20, "y": 20, "width": 120 },
  "style": { "runs": [{ "from": 0, "to": 4, "size": 8 }, { "from": 10, "to": 14, "pen": 2 }], "paras": [{ "at": 0, "align": "center" }, { "at": 5, "indent": 10 }] },
  "sync": { "source": "generated", "textHash": "…", "paramsHash": "…", "gcodeHash": "…", "at": "2026-11-09T03:00:00.000Z" }
}
```

- `text` / `gcode`：同一文件夹中的文件名（不能含路径）。重命名或移动稿件时三个文件一起改。
- `settings` / `motion` / `glyphs`：生成 G-code 用到的全部参数（排版、笔轴、笔起点、页码、选字，见 [glyph-format.md](glyph-format.md)）。
- `settings.natural`（`on` / `off`）及 `natural-size`、`natural-baseline`、`natural-spacing`、`natural-join`（%），`natural-slant`、`natural-slant-var`（°），`natural-seed`：拟真笔迹。同一种子的结果完全相同。
- `settings.brush`（`on` / `off`）、`brush-pen`（`gel` / `fountain` / `felt` / `brush` / `custom`）及 `brush-entry`、`brush-exit`（% 字高）、`brush-pressure`、`brush-speed`、`brush-corner`、`brush-hook`（%）、`brush-depth`（mm）、`brush-width-min`、`brush-width-max`（% 笔宽，只影响预览）：运笔。
- `motion.pen-mode`：`z`（Z 轴，用 `pen-up` / `pen-down`），`servo-m5`（`M3 S<servo-down>` 落笔，`M5` 抬笔），`servo-s`（`M3 S<servo-down>` / `M3 S<servo-up>`）；`pen-delay` 为舵机每次抬落笔后的 `G4 P` 等待秒数。
- `drawing`（可选）：同一文件夹中的 `.svg` / `.dxf`，以及它在纸上的位置（`x` / `y` 为左上角距纸边 mm，`width` 为宽度 mm，`page` 为所在页）。图形文件的内容也计入梳串。
- `style`（可选）：在纯文本之上的格式层。`runs` 是码点区间 `[from, to)` 的字号（mm）、用笔、`underline`、`strike`（`true`）和 `script`（`sup` / `sub`）；`paras` 是段落起点 `at` 的对齐（`center` / `right`）、首行缩进（mm）、行距倍数 `spacing`（1–3）和列表 `list`（`bullet` / `number`，连续的编号段落依次编号）。正文被编辑时，格式随文字平移。正文中的 `\( … \)` 是公式（LaTeX 写法）。格式也计入梳串。
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

「备份工作区」下载一个 JSON 文件（`penfall/workspace-archive`），包含全部文件，以及本页尚未保存的内容。导入备份时，会在所选文件夹下新建一个同名文件夹放置这些文件，不覆盖已有文件。旧版的浏览器文稿备份（v3）导入时会自动转换为稿件。第一次打开新版时，旧版浏览器中的文稿会自动转换到「我的工作区」，旧数据保留不删。
