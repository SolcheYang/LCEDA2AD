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
        "shape": "round", "layer": "top", "hole": 0 }
    ],
    "tracks": [
      { "layer": "top_overlay", "x1": -0.9, "y1": -0.6, "x2": 0.9, "y2": -0.6, "width": 0.12 }
    ],
    "circles": [ { "layer": "top_overlay", "x": 0, "y": 0, "r": 0.3, "width": 0.12 } ]
  }
}
```
约定：
- `symbol.*` 单位 **mil**，Y 轴向上，原点=元件中心。
- `footprint.*` 单位 **mm**，原点=封装中心。
- `orient` ∈ {0,90,180,270}，含义=引脚从 (x,y) 指向元件的方向（0=向右伸出，引脚主体在左侧）。
- `electrical` ∈ {input,output,bidirectional,passive,power,openCollector,openEmitter,unspecified}。
- `shape` ∈ {round,rect,octagonal}；`layer` ∈ {top,bottom,multi}；`hole` = 孔径 mm，0=SMD（通孔件 `layer:"multi"` 且 hole>0）。
- `symbol.shapes[].kind` 布局（实测确认，四种）：
  `{kind:"rect", x1,y1,x2,y2}` / `{kind:"ellipse", x,y,rx,ry}` / `{kind:"polyline", points:[[x,y],…]}` / `{kind:"polygon", points:[[x,y],…]}`。
- 丢弃项（契约内无字段，已实测确认）：ARC、SOLIDREGION(层 99/100/101 属装饰区，非焊盘)、SVGNODE(3D 占位)。
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
- `POST /api/build` body `{ query, outDir, schLib, pcbLib }` → `{ ok:true, jobId }`（异步执行）
- `POST /api/pick-path` body `{ mode:"folder"|"schlib"|"pcblib", current? }` → `{ ok:true, path }`
  （由本机弹出 Windows 原生选择框；取消时返回空 path。浏览器无法直接取得绝对路径。）
- `GET /api/job?id=...` → `{ ok:true, state:"running|done|error", steps:[...], artifacts:[...], log:"<tail>" }`

默认值（UI 与服务端一致）：`outDir = E:\EDA2Altium\out`，`schLib = E:\EDA2Altium\library\MyLib.SchLib`，`pcbLib = E:\EDA2Altium\library\MyLib.PcbLib`。
