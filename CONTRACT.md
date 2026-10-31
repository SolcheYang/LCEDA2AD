# CONTRACT — 模块接口契约（A/B/C 并行开发的唯一约定）

> 任何一方要改这里，必须先改本文件并通知另两方。签名与字段名按此为准。

## 1. 归一化元件模型 ComponentModel（`component.json`）
```json
{
  "lcsc": "C25804",
  "mpn": "0603WAF1002T5E",
  "manufacturer": "UNI-ROYAL",
  "package": "0603",
  "description": "10K 1% 0603",
  "datasheet": "https://...",
  "designatorPrefix": "R",
  "symbol": {
    "pins": [
      { "number": "1", "name": "~", "x": -100, "y": 0, "orient": 0,
        "length": 100, "electrical": "passive" }
    ],
    "shapes": [
      { "kind": "rect", "x1": -100, "y1": -100, "x2": 100, "y2": 100 }
    ],
    "texts": [ { "x": 0, "y": 160, "text": "10K", "size": 60 } ]
  },
  "footprint": {
    "pads": [
      { "number": "1", "x": -0.75, "y": 0, "w": 0.9, "h": 0.95,
        "shape": "round", "layer": "top", "hole": 0, "rotation": 0, "plated": true,
        "pasteExpansion": -100, "solderExpansion": 0.0508 },
      { "number": "", "x": 2.4, "y": 0, "w": 0.7, "h": 0.7,
        "shape": "round", "layer": "multi", "hole": 0.7, "rotation": 0, "plated": false,
        "pasteExpansion": 0, "solderExpansion": 0.0508 }
    ],
    "tracks": [
      { "layer": "top_overlay", "x1": -0.9, "y1": -0.6, "x2": 0.9, "y2": -0.6, "width": 0.12 }
    ],
    "circles": [ { "layer": "top_overlay", "x": 0, "y": 0, "r": 0.3, "width": 0.12 } ],
    "arcs": [ { "layer": "top_overlay", "x": 0, "y": 0, "r": 0.3,
                "start": 0, "end": 180, "width": 0.12 } ],
    "regions": [
      { "layer": "top_paste", "kind": "solid", "points": [[-0.9,-0.6],[-0.6,-0.6],[-0.6,0.6],[-0.9,0.6]],
        "holes": [] },
      { "layer": "component_shape", "kind": "solid", "points": [[-0.8,-0.4],[0.8,-0.4],[0.8,0.4],[-0.8,0.4]] }
    ]
  }
}
```
约定：
- `symbol.*` 单位 **mil**，Y 轴向上，原点=元件中心。
- `footprint.*` 单位 **mm**，原点=封装中心。
- `orient` ∈ {0,90,180,270}，含义=引脚从 (x,y) 指向元件的方向（0=向右伸出，引脚主体在左侧）。
- `electrical` ∈ {input,output,bidirectional,passive,power,openCollector,openEmitter,unspecified}。
- `designatorPrefix` = 立创 EDA `head.c_para.pre` 的字母部分（转大写，如 `R?`→`R`、`CN?`→`CN`）。
  SchLib 的 Designator 写成 `<designatorPrefix>??`（如 `R??`、`U??`、`CN??`），保证前缀与立创 EDA 一致；
  模型缺该字段（旧 `component.json`）时回退 `U`。
- `shape` ∈ {round,rect,octagonal}；`layer` ∈ {top,bottom,multi,top_overlay,bottom_overlay,top_paste,bottom_paste,top_solder,bottom_solder,board_outline,document,top_assembly,bottom_assembly,mechanical,component_shape,lead_shape,component_marking}；`hole` = 孔径 mm，0=SMD（通孔件 `layer:"multi"` 且 hole>0）。
  层名对应 EasyEDA 标准层：1 top / 2 bottom / 3 top_overlay / 4 bottom_overlay / 5 top_paste / 6 bottom_paste / 7 top_solder / 8 bottom_solder / 10 board_outline / 11 multi / 12 document / 13 top_assembly / 14 bottom_assembly / 15 mechanical / 99 component_shape / 100 lead_shape / 101 component_marking。
- `rotation` = 焊盘旋转角（度，0–360）；`plated` 缺省为 `true`，`false` = 非金属化机械孔（NPTH，通常 `number:""`、`w=h=hole`）。EasyEDA 的 `HOLE` 记录归一化为这种 pad。
- `pasteExpansion` / `solderExpansion` = 钢网 / 阻焊开窗的单边扩边量（mm），来自 EasyEDA `PAD` 记录第 17/18 字段（单位 10 mil ×0.254）。LCEDA 的 Altium 导出原样写入焊盘 Cache：`pasteExpansion ≠ 0` 时启用 Manual（官方库通常为 `-393.7` 单位 ⇒ `-3937 mil`，表示“焊盘不出钢网、钢网由 layer 5 区域提供”），`= 0` 时保持 Rule；`solderExpansion` 官方库通常为 `0.2` 单位 ⇒ `2 mil`。
- `arcs[]` = 圆弧丝印/铜箔弧：(`x,y`) 圆心 mm、`r` 半径 mm、`start`/`end` Altium 角度（逆时针，度）。EasyEDA 的 `CIRCLE` 仍单独放在 `circles[]`（等价于 0→360 的 arc）。
- `regions[]` = EasyEDA `SOLIDREGION` 填充多边形：`layer` 同上；`points` 为闭合外轮廓（mm，首点不重复）；`kind` ∈ {solid,cutout,npth}；`holes` = 额外子轮廓（当前写库只画外轮廓，holes 仅记录）。Altium 侧映射：真实制造层（silk/mask/paste/copper）用同名层，EasyEDA 文档层落到机械层（100→Mechanical 9，12→Mechanical 2，13/14/15→Mechanical 4/5/6）。**101（component_marking）不落任何层**：LCEDA 的 Altium 导出会丢弃它，pin-1 标记已经由 layer 3 的丝印圆弧表达；`apiFootprintToMil` 在写文档前就过滤掉 101 的线/弧/圆/区域。`component_shape`（99）不画填充区、线、弧、圆：Mechanical 6 仍按 LCEDA 导出规则用 2 mil 线宽把轮廓画一遍；Mechanical 8 只写一个约 0.15 mm 半径的实心小圆点，位于 1 号焊盘外侧（远离焊盘外接框中心的方向）。
- `symbol.shapes[].kind` 布局（实测确认，五种）：
  `{kind:"rect", x1,y1,x2,y2}` / `{kind:"ellipse", x,y,rx,ry}` / `{kind:"arc", x,y,r,start,end}` /
  `{kind:"polyline", points:[[x,y],…]}` / `{kind:"polygon", points:[[x,y],…]}`。
  `arc` 的 (`x,y`)=圆心、`r`=半径、`start`/`end`=Altium 角度（逆时针，度）；
  EasyEDA 的 `A` 记录若为椭圆弧，按 10° 采样成 `polyline`。
  EasyEDA 的 `PG`（闭合点列）与 `PT`（路径）都归一化为 `polygon`。
- 丢弃项：`SVGNODE`（3D 模型占位，契约内无字段）。`SOLIDREGION` 已纳入 `regions[]`（v12），所有 EasyEDA 层都绘制；`solid` 画成填充区，`cutout`/`npth` 与 `regions[].holes` 画成闭合轮廓线（不填充）。少于 3 个点的无效区域记入 `skippedregions`。
  注：EasyEDA 的 `ARC` 与 `RECT` 记录已纳入绘制 —— `ARC` 归一化为 `arcs[]`（椭圆弧按 10° 采样成 `tracks[]`），`RECT` 归一化为四条 `tracks[]` 边。
- PcbDoc 中间文档（`buildPcbDoc`）暂不写 Region 记录；`regions[]` 在库阶段直接取自 EasyEDA 模型。
- `symbol.texts` 为保留字段，当前恒为 `[]`（探测样本均无文本记录）。
- 命名口径：`model.package` 取 EasyEDA 包名（如 `R0603`），搜索结果里的 `package` 取 LCSC 值（如 `0603`）；Altium 侧命名一律用 `model.package`。
- `datasheet` 允许恒为空串；`pin.name` 为空时归一化为 `~`。
- 字符串一律 UTF-8；缺失字段可省略，但 `lcsc/pins/pads` 必有。

## 2. A 数据层 — `app/lib/fetch-component.mjs`
```js
export async function searchComponents(query, { limit = 20 } = {})
// -> [{ lcsc, mpn, manufacturer, package, description, stock, price }]

export async function resolveComponent(query)
// query 可为 "C25804" 或任意名称/型号；返回 { chosen: <candidate>, candidates: [...] }

export async function fetchComponentModel(lcsc)
// -> ComponentModel（见上）
```
要求：纯 ESM、零第三方依赖（Node 内置 fetch）、失败抛出 Error 且 message 含可读原因。

## 3. B Altium 层 — `app/lib/emit-altium.mjs`
```js
export async function emitAltiumJob(model, opts)
// opts: { outDir, schLibPath, pcbLibPath, workDir }
// -> { pasPath, prjScrPath, cmdPath, logPath, schDocPath, pcbDocPath }
```
- `schDocPath` = `<outDir>/<lcsc>_SCH.SchDoc`，`pcbDocPath` = `<outDir>/<lcsc>_PCB.PcbDoc`。
- 生成的 `.pas` 必须自包含（路径与几何数据以 Pascal 常量内嵌），入口过程名 `RunJob`。
- `.cmd` 用：`start "" "E:\AD\AD\X2.EXE" -RScriptingSystem:RunScript(ProjectName="<prjScr>"^|ProcName="RunJob")`
- `job.log` 行协议（ASCII，服务端据此判成败）：
  ```
  STEP <name>
  OK <name> <可读细节>
  ERR <name> <错误原文>
  DONE artifacts=<n>
  COUNT schlib comps=<n> pins=<m> libref=<名>
  COUNT pcblib comps=<n> pads=<m> name=<封装名>
  ```

判定规则：COUNT 的数字必须等于输入模型的数量，否则作业必须记 ERR 并失败（禁止 log 成 OK）。

已实测确认的原生进程名（来自 Altium 安装资源文件，勿再猜）：
- 原理图：Sch:CreateLibraryFromProject（advsch.rcs，Caption=&Make Schematic Library）
- PCB：PCB:BuildPCBLibrary（AdvPcb.rcs，Caption=Make &PCB Library，Params=AddLibraryToProject=True）

## 3b. B Altium 层 — app/lib/run-altium.mjs
export async function runAltiumJob(job, { timeoutMs = 180000 } = {})
// job 为 emitAltiumJob 的返回值
// -> { ok, log, steps:[{name,status,detail}], error? }
负责：调用 job.cmdPath 拉起 Altium、等待退出或超时、读 job.log 解析 STEP/OK/ERR/DONE 行；
超时必须杀掉本进程启动的 Altium（只杀自己启动的 PID）。

## 4. C 应用层 — `app/server.mjs`
HTTP（仅 localhost，端口 43180，可用 PORT 覆盖）：
- `GET /` → `app/public/index.html`
- `GET /api/health` → `{ ok:true, app:"lceda2altium", version, pid, port, root, startedAt, busy }`（启动器用于复用实例与停止服务）
- `GET /api/search?q=...` → `{ ok:true, candidates:[...] }`
- `GET /api/preview?lcsc=C25804` → `{ ok:true, lcsc, mpn, package, value, description, pinCount, padCount, symbolSvg, footprintSvg }`
  （把 ComponentModel 的符号/封装几何渲染成内联 SVG 供页面预览；只读、不落盘，结果缓存 10 分钟。
  参数必须是 C 编号；按名称搜索请先走 `/api/search`。）
- `POST /api/build` body `{ query, outDir, schLib, pcbLib }` → `{ ok:true, jobId }`（异步执行）
- `POST /api/pick-path` body `{ mode:"folder"|"schlib"|"pcblib", current? }` → `{ ok:true, path }`
  （由本机弹出 Windows 原生选择框；取消时返回空 path。浏览器无法直接取得绝对路径。）
- `GET /api/prefs` → `{ ok:true, prefs:{ paths, lists, options }, file }`
- `POST /api/prefs` body `{ prefs:{ paths?, lists?, options? } }` → `{ ok:true, prefs }`
  （常用路径与上次使用的路径写入启动器 state 目录的 `ui-prefs.json`，关闭程序后仍保留。）
- `GET /api/job?id=...` → `{ ok:true, state:"running|done|error", steps:[...], artifacts:[...], log:"<tail>" }`
- `GET /api/update` → 更新检查缓存结果
  `{ ok, supported, checking, hasUpdate, current:{ tag, commit, date, subject }, latest:{ tag, commit, subject, message, url, compareUrl }, dismissed }`
  （`git ls-remote --tags origin` 只读比对远端 tag 与当前 tag；结果缓存 10 分钟，过期后在后台刷新。）
- `POST /api/update/check` → 强制重新检查（等待完成，可能耗时数秒到 20 秒）
- `POST /api/update/dismiss` body `{ tag, clear? }` → 忽略某个 tag 的更新提示；
  `clear:true` 恢复提醒。写入 state 目录的 `update-state.json`。

默认值（UI 与服务端一致）：`outDir = E:\EDA2Altium\out`，`schLib = E:\EDA2Altium\library\MyLib.SchLib`，`pcbLib = E:\EDA2Altium\library\MyLib.PcbLib`。
