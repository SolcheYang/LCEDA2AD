# 立创元件 → Altium（无浏览器 / 无 UI 点击版）

输入**元件名称/型号**或**立创商城编号（C 开头）**，程序自动：

1. 通过 **EasyEDA 公开数据接口**取得元件的符号与封装几何（不需要浏览器、不需要登录）；
2. 在本机写出 Altium ASCII 5.0 格式的
   `<输出目录>\<C编号>_SCH.SchDoc` 与 `<C编号>_PCB.PcbDoc`（只读副本在 `_source\`）；
3. 回读解析这两个文档，校验引脚/焊盘数量；
4. 用 **Altium 脚本 API（DelphiScript）**生成 `SchLib` / `PcbLib`，并追加到指定的
   `.SchLib` / `.PcbLib`（不存在自动新建，同名幂等跳过）；
5. 复核库内名称与数量，输出 `RESULT: PASS` / `RESULT_JSON`。

> **全程没有浏览器、没有登录、没有 UIA、没有鼠标点击。**
> 旧的“网页版导出 + Altium 菜单点击”实现完整保存在 `_legacy\`，当前管线不引用。

---

## 1. 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11 |
| Node.js | ≥ 18（本机 v26） |
| Node 依赖 | 首次使用在项目目录执行 `npm install`（安装 `iconv-lite`，用于 GBK 脚本源码）；`node_modules` 已随工程提供 |
| Altium Designer | 默认 `E:\AD\AD\X2.EXE`；可用环境变量 `ALTIUM_EXE` 覆盖 |
| 网络 | 能访问 `easyeda.com` 的公开接口 |
| 浏览器 | **不需要**（Chrome 已从当前流程移除）；`启动.vbs` 打开界面时优先用 Edge/Chrome 应用窗口 |
| Windows Script Host | `启动.vbs` / `停止服务.vbs` 依赖它（Win10/11 默认可用）。若被组策略禁用，改用 `run.cmd` |
| Python（可选） | PcbLib 文件级校验用（`olefile`）；缺失时跳过校验，不影响生成 |

### Altium 可以保持打开

管线会**直接复用当前 Altium 实例**，不会关闭或重启它；两个阶段都在同一实例里执行。
如果 Altium 标题栏有 `*`（有未保存文档），请先 `Ctrl+S` 保存（不用关闭），再点生成。
程序不会覆盖你未保存的内容。

---

## 2. 启动与停止

### 推荐：双击 `启动.vbs`

- **不弹控制台窗口**；重复双击会复用已运行的实例，不会启动第二个服务。
- 自动从 `43180` 起找空闲端口（最多到 `43200`）。
- 用 Edge / Chrome 的**应用窗口**（无地址栏、无标签页）打开界面；
  没装 Edge/Chrome 时退回默认浏览器。
- 启动失败会弹窗，并给出日志目录；运行状态与日志在
  `%LOCALAPPDATA%\LCEDA2Altium\`：

```
state.json        当前实例的 pid / 端口 / 工程路径
server.log        服务标准输出
server.err.log    服务错误输出（启动失败先看这里）
```

停止服务：双击 **`停止服务.vbs`**。它会校验 PID 后结束服务进程树
（包括正在运行的生成管线/Altium 子进程）；有作业在跑时会先弹窗确认。
已经打开的页面不会自动关闭，停止后关闭或刷新即可。

### 桌面快捷方式（可选）

双击 **`创建桌面快捷方式.vbs`**，在桌面生成：

- `立创元件转Altium`：等同于双击 `启动.vbs`
- `停止服务 - 立创元件转Altium`：等同于双击 `停止服务.vbs`

不想要时直接删除这两个 `.lnk` 文件即可，不影响工程。

### 调试：`run.cmd`（带控制台）

需要看实时控制台日志时双击 `run.cmd`。它会先用 `tools\probe.mjs` 探测已运行实例：
有则直接打开界面并退出；没有才在 43180 **前台**启动（关掉窗口=停止该实例）。

也可以手动启动（浏览器只用于看本地界面，不参与导出）：

```bat
cd /d E:\EDA2Altium
node app\server.mjs --open
```

服务只监听 `127.0.0.1`。命令行等价方式还有：

```bat
npm run open     :: 隐藏启动/复用实例并打开应用窗口
npm run stop     :: 停止服务
```

---

## 3. 界面

1. 输入 `C92116` 或 `BQ7693003DBTR`，可先「搜索」选候选，也可以直接生成；
2. 三个路径可改：
   - `outDir`（输出目录；临时文档与可选中间产物都放在这里）
   - `schLib`（目标原理图库）
   - `pcbLib`（目标封装库）
   每个路径都有：
   - **「浏览…」**：打开 Windows 原生选择框。输出目录选文件夹；两个库选已有文件，
     或直接输入新文件名（不覆盖已有库，新库会自动创建）；
   - **常用下拉**：选择已保存的路径；「保存当前」把输入框当前值加入列表，
     「删除」移除当前选中项。三份列表各自保存（浏览器 localStorage）。
3. 可选勾选：
   - **保留 SchDoc / PcbDoc**
   - **生成单件 SchLib / PcbLib**
   勾选后的文件保存到 `<outDir>\<元件名>\`；不勾选则只留目标库；
4. 点 **「生成（无浏览器 + Altium 脚本）」**；
5. 五个步骤：解析输入 → 获取元件数据并生成文档 → Altium 脚本 PcbLib →
   Altium 脚本 SchLib → 校验产物；日志实时滚动，最后列出产物路径与大小。

默认路径：

```
E:\EDA2Altium\out
E:\EDA2Altium\library\MyLib.SchLib
E:\EDA2Altium\library\MyLib.PcbLib
```

---

## 4. 产物

页面有两个可选开关（默认关闭）：

- **保留 SchDoc / PcbDoc**
- **生成单件 SchLib / PcbLib**

勾选后，文件保存到 `<outDir>\<元件名>\`（元件名优先用 MPN，例如
`BQ7693003DBTR`、`0603WAF1002T5E`）：

```
<outDir>\<元件名>\<C编号>_SCH.SchDoc / _PCB.PcbDoc    （保留文档）
<outDir>\<元件名>\<C编号>_SCH.SchLib / _PCB.PcbLib    （单件库）
```

始终删除的中间文件：

```
<outDir> 下的临时文档、旧 _source、旧单件库
jobs\<C编号>*（脚本/日志/component.json/parsed-docs）
目标库旁 History / __Previews / *.bak-时间戳
```

最终保留：

```
<schLib> / <pcbLib>                目标库（直接创建/追加/幂等）
jobs\_lib-registry.json            内部版本登记表
<outDir>\<元件名>\                 仅当勾选保留文档/单件库时
```

> 两个开关默认关闭：只生成目标库，`out` 下不留文件。
> `DOC_ONLY=1` 仍会把文档留在临时目录 / 元件文件夹，用于调试。
> 成功生成会删除 `.bak` 备份；需要回滚时请在生成前自行备份目标库。

---

## 5. 实现细节

### 5.1 数据与文档

- 数据源：`https://easyeda.com/api/products/<C编号>/components`（公开接口），
  与搜索框使用的是同一套数据。
- 文档写入器：`app/lib/altium-doc-writer.mjs`
  - **SchDoc ASCII 坐标是 10 mil 单位**（实测：模型引脚 −600 mil ↔ 文档 −60），
    写入器会把模型 mil 除以 10；回读解析器再乘回 10。
  - **PcbDoc 坐标带 `mil` 后缀**，写入器直接输出 `1234.5600mil`。
  - PcbDoc 使用一份**无元件的板级骨架**（`altium/blank-pcb-skeleton.txt`，来自真实
    Altium 导出，已剥离所有元件/焊盘），再追加本元件的 Component/Pad/Track/Arc。
  - SchDoc 的图纸记录来自 `altium/blank-sch-sheet.txt`。
- 写入后立即用 `doc-parse.mjs` 回读，引脚/焊盘数必须与元件模型一致，否则失败。

### 5.2 Altium 脚本阶段

两个阶段**直接写目标库**，复用同一个 Altium 实例；进程通过
`-RScriptingSystem:RunScript(...)` 执行生成的 `job.pas`，全程无窗口点击。
先建 PcbLib，再建 SchLib，这样 SchLib 的 footprint model 能直接挂到已存在的封装上。

| 阶段 | 动作 |
|---|---|
| `pcblib` | 打开/新建目标 PcbLib，创建封装（焊盘、TopOverlay 丝印线/圆弧）；已存在则跳过；空组件自动重写 |
| `schlib` | 打开/新建目标 SchLib，创建组件（MPN、`U??`、隐藏 Comment、绑定封装、颜色 128、引脚 150mil）；已存在则跳过 |
| `pcblib_part`* | 仅勾选「单件库」时：在 `<outDir>\<元件名>\<C>_PCB.PcbLib` 创建单件封装库 |
| `schlib_part`* | 仅勾选「单件库」时：在 `<outDir>\<元件名>\<C>_SCH.SchLib` 创建单件符号库 |

> `*` 为可选阶段；两个目标库阶段始终先执行，单件库阶段随后在同一 Altium 实例中执行。
> 保留 SchDoc/PcbDoc 时，文档副本写入 `<outDir>\<元件名>\`，临时原件在成功后清理。

引脚换算（实测校准）：

- 文档里的 `LOCATION` 是元件本体边缘，`PINCONGLOMERATE` 低两位指向外；
- SchLib API 的 `Pin.Location` 是连接端点，所以脚本把坐标换算成
  `tip = 本体边缘 + 外法向 × 引脚长度`，朝向取反。
- C92116 实测：30 个引脚的坐标/朝向与数据层 **30/30 一致**；30 个焊盘 **30/30 一致**。

### 5.3 本轮修复（2026-10-22 下午）

- **SchLib 引脚方向**：改用文档的“本体边缘 + 向外朝向”（`bodyX/bodyY/outwardOrient`），
  每个引脚相对旧输出旋转 180°。C92116 引脚 1 现在是 `(-500,700) orient 180`
  （旧输出是 `(-600,700) orient 0`）。
- **SchLib border**：矩形 `LineWidth := eSmall`（Altium 的 Small 线宽）。
- **PcbLib 实际未绘制**：不再复用新建 PCBLIB 自带的空 `PCBComponent_1`；改用
  `CreatePCBLibComp` + `RegisterComponent` 新建组件，焊盘/丝印才会写进组件 Data 流。
  空的 `PCBComponent_1` 用 `RemoveComponent` 删除。
- **文件级硬校验**：`tools\pcblib-check.py` 直接读 PcbLib 的 OLE 组件 Data 流。
  空组件约 38B，真实 30 焊盘封装约 7485B；空库不会再假 PASS。
  需要 Python 3 + `olefile`；缺失时该校验会跳过并打印提示。
- **旧空库自动修复**：目标 PcbLib 里的同名组件若为空，且本次是幂等跳过，
  程序会自动删除该组件并用新几何重写一次。
- **v4 元件字段**：
  - Design Item ID / 库引用 = **元件名称（MPN）**，不再用 C 编号；
  - Designator = **`U??`**；
  - Comment = MPN，且 `Comment.IsHidden := True`（显示复选框不勾选）；
  - 绑定封装：`Target.AddSchImplementation` + `ModelName=<封装名>` +
    `ModelType='PCBLIB'`（v8 起不再设置 `UseComponentLibrary`，见下方 v8 修正）；
  - Rectangle / Ellipse border 颜色 = **RGB(128,0,0)**（TColor **128**）；
  - Ellipse：`eSmall`、`IsSolid=False`（Fill Color 不勾选）、`AreaColor=0`；
  - Pin length = **150 mil**；
  - 版本标记 `LCEDA2AD-v6-p150`；旧目标 SchLib 只含当前一颗料时会备份并重建。
- **封装绑定（v5，v8 修正）**：在 `AddSchImplementation` 后调用
  `Impl.AddDataFileLink('<封装名>', '', 'PCBLib')`。位置参数必须为空字符串
  （传真实路径会卡住 AD26）；FileKind 用 `'PCBLib'`。
  **v8 修正**：不再设置 `Impl.UseComponentLibrary := True`。真实 Altium 生成的
  SchLib 的 RECORD=45 不含该字段；设为 True 会被当作 IntLib 模型，导致 PcbLib
  封装无法解析。当前生成的 RECORD=45 与真实 Altium 库逐字段一致。
- **v6 Description / Value**：
  - Description = EasyEDA `result.description`（C25804：`10KΩ (1002) ±1%`；
    C92116 的接口返回为空）。生成的 `.pas` 以 **GBK**（系统 ACP=936）写出，
    中文 / Ω / ± 原样进入 SchLib；不再附加版本标记。
  - Value = `c_para.Value`（C25804：`10kΩ`）。有值时通过
    `AddParameter(Target, 'Value', '<值>', False)` 新建 `Value` 参数并设为**可见**
    （`IsHidden=False`）；无 Value 的元件不加。
  - 依赖 `iconv-lite` 做 UTF-8→GBK 转码。
- **v7 Pin Name / Value 位置（Value 位置已被 v8 修正）**：
  - Pin：`If Num = PName Then Pin.ShowName := False`；Designator 与 Name 相同时
    只显示 Designator，避免同一文字出现两次。
  - Value：v7 放在符号 bbox 的右下角（`maxX, minY`），
    `P.Justification := eJustify_BottomRight`；v8 起改为下方的包围盒 + TopLeft。
  - 版本 `LCEDA2AD-v7-p150`（v8 为 `LCEDA2AD-v8-p150`）。
- **v8 Value 位置 + 封装绑定修正**：
  - Value 锚点取**符号图形 + 引脚端点**包围盒的右下角，再向右、向下各 20 mil；
    `P.Justification := eJustify_TopLeft`，文字向右下展开。C25804 的锚点为
    `(270,-60)` mil，不再压住矩形或引脚。
  - 移除 `Impl.UseComponentLibrary := True`；RECORD=45 只保留
    `ModelName / ModelType=PCBLIB / DatafileCount=1 / ModelDatafileEntity0 /
    ModelDatafileKind0=PCBLib / IsCurrent=T`，与真实 Altium 库一致。
  - 版本 `LCEDA2AD-v8-p150`；当前 `MyLib.SchLib` 已备份 v7 并用 C92116 + C25804 重建。
- **v9 PcbLib 路径绑定 + Description 回退**：
  - `AddDataFileLink(<封装>, '', 'PCBLib')` 之后设置
    `Impl.DatafileLink[0].Location := '<目标 PcbLib>'`，生成的 RECORD=45 带
    `ModelDatafile0=<目标 PcbLib 路径>`；SchLib 的 Footprint 直接指向 UI 选择的 PcbLib。
  - Description 优先用 EasyEDA `result.description`；为空时（如 C92116）从立创商城
    商品页的 `paramList` 生成参数摘要（`芯片类型:…;工作电压:…;`）。
  - 版本 `LCEDA2AD-v9-p150`；当前 `MyLib` 已按 v9 重建（旧 v8 备份在 `_backup\`）。
- **直写目标库**：目标 `pcblib` / `schlib` 两阶段始终执行；`pcblib_part` /
  `schlib_part` 仅在勾选「生成单件库」时执行，写入 `<outDir>\<元件名>\`。
- **可选中间产物**：UI 勾选 `KEEP_DOCS` / `MAKE_PART_LIBS` 控制是否保留
  SchDoc/PcbDoc 与单件 SchLib/PcbLib；选中的文件保存到 `<outDir>\<元件名>\`。
- **自动清理**：默认删除临时文档、旧 `_source`、旧单件库、`jobs\<C>*`、
  Altium `History/__Previews` 与 `.bak-时间戳`；勾选的文档/单件库保留在元件文件夹。
  失败时保留中间文件便于排查。
- **常用路径 / 浏览（UI）**：输出目录、SchLib、PcbLib 三个路径都有各自独立的常用下拉
  （localStorage，可保存当前/删除）与「浏览…」按钮；服务端 `POST /api/pick-path`
  调用 PowerShell 弹出 Windows 原生文件夹/文件选择框（库文件可选已有或输入新文件名）。

### 5.4 已知能力边界（如实说明）

- 符号只重建**引脚、矩形、椭圆**。EasyEDA 模型里的折线/多边形图形会跳过，
  日志里会打印 `skippedShapes=N`；常见 IC/电阻/电容样本未出现该情况。
- 符号参数（SchDoc 的 `RECORD=41`，如 SupplierPart、Datasheet）没有重建；
  库组件保留 LibReference、描述、Designator、引脚和图形。
- 封装只重建**焊盘、TopOverlay/BottomOverlay 丝印线与圆弧**；3D Body / Mechanical
  Region 不重建。电气焊盘与丝印完整。
- 目标 SchLib 里已有同名组件时，程序**不会覆盖**（幂等跳过）。如果它是旧版本组件
  且目标库只含这一颗料，v5 会自动备份（`.bak-时间戳`）并重建；如果目标库还含其他元件，
  程序不会动它，会明确报错，请改用新的目标 SchLib 路径或手动删除该组件。
  PcbLib 里的旧空组件会自动检测并重写。成功的作业会删除这些 `.bak` 备份。
- Description 优先取 EasyEDA `result.description`；如果该接口为空（例如 C92116），
  会用立创商城商品页的 `paramList` 生成参数摘要；两者都不可用时才留空。
  Value 只在 `c_para.Value` 存在时创建。
- 如需要 100% 等同 Altium 菜单产物的参数/3D，需要继续补脚本（要新的 API 探测）。

### 5.5 真机验收结果（2026-10-22，修复后）

- **复用同一个 Altium 实例**（PID 21280 保持不变，未关闭/重启）：两阶段均在同一实例内完成。
- **C25804（临时目标库，验证后删除）**：`RESULT: PASS`；引脚 1/2 的 Name 与
  Designator 相同，Name 已隐藏；Value = `10kΩ`，位于符号右下角 `(100,-40)`，
  `eJustify_BottomRight`、只显示值；Description = `10KΩ (1002) ±1%`；
  PcbLib R0603 `Data` 806B。SchLib 内 GBK 字节精确命中。
- **C92116（默认 MyLib v7）**：`RESULT: PASS`；SchLib **6656B `[BQ7693003DBTR]`** /
  PcbLib 116736B；引脚 1..30 的 Name（DSG/CHG/…）与 Designator 不同，全部可见；
  EasyEDA 的 `result.description`/`c_para.Value` 为空，所以没有 Description/Value；
  `PCBLib` datafile link、`U??`、颜色 128、150mil 引脚都在。
- **PcbLib**：`TSSOP-30…` 一个组件，`Data` **7485B**、`PrimitiveGuids` 888B。
- **旧库处理**：旧目标 SchLib 已备份后重建；旧空 PcbLib 自动修复。
- **可选中间产物（C25804 临时库）**：`KEEP_DOCS=1 MAKE_PART_LIBS=1` 时，
  `out\0603WAF1002T5E\` 下生成 `C25804_SCH.SchDoc` / `_PCB.PcbDoc` 与
  `C25804_SCH.SchLib` / `_PCB.PcbLib`；目标库 5632B / 107008B；`RESULT: PASS`。
- **默认关闭**：只生成目标库，`out` 为空，不创建元件文件夹。
- **服务端/API**：`keepDocs` / `makePartLibs` 经 `job.options` 传给管线；
  产物清单包含可选的文档/单件库；临时测试库已删除。
- 临时库与验收中间文件已删除；最终只保留目标库与 `jobs\_lib-registry.json`。

### 5.6 v8 复验（2026-10-22）

- **临时库**：C25804 `RESULT: PASS`。SchLib RECORD=41 的 Value 为
  `Location.X=27 / Location.Y=-6`（SchLib 记录单位 10 mil，即 `270,-60` mil）、
  `Justification=6`（TopLeft）；RECORD=45 与真实 Altium 库逐字段一致。
- **当前 `MyLib.SchLib`**（旧 v7 已备份到 `_backup\MyLib.SchLib.v7-<时间戳>`）：
  C92116 + C25804 各自 `RESULT: PASS`。`0603WAF1002T5E` 的 Value 为
  `(270,-60)` mil；两个组件的 RECORD=45 均为
  `ModelName=<封装>|ModelType=PCBLIB|DatafileCount=1|ModelDatafileEntity0=<封装>|ModelDatafileKind0=PCBLib|IsCurrent=T`，
  不再含 `UseComponentLibrary / DatalinksLocked / DatabaseDatalinksLocked`。
- **PcbLib 对照**：`R0603`（2 焊盘，Data 806B）与 `TSSOP-30…`（30 焊盘，
  Data 7485B）均通过 PADCHECK；SchLib 的 ModelName 与 PcbLib 组件名一致。
- **真实库交叉对照**：`C:\Users\Public\Documents\Altium\HandDriveBoard\LIB\*.SchLib`
  的 RECORD=45 字段集合与当前生成结果相同。
- `jobs\_lib-registry.json` 两个目标库版本 = `LCEDA2AD-v8-p150`；临时
  `_verify` 库已删除，`out` 为空。

### 5.7 v9 复验（2026-10-22）

- **当前 `MyLib.SchLib`**：9728B，`[BQ7693003DBTR, 0603WAF1002T5E]`；
  `MyLib.PcbLib` 120832B（`TSSOP-30…` 30 焊盘 / `R0603` 2 焊盘）。
- **Footprint 路径绑定**：两个组件的 RECORD=45 都包含
  `ModelDatafile0=E:\EDA2Altium\library\MyLib.PcbLib`，且
  `ModelName` 与 PcbLib 组件名一致。
- **Description**：
  - `BQ7693003DBTR`：EasyEDA 接口为空，用立创参数生成
    `芯片类型:监测芯片；保护芯片；均衡芯片;工作电压:6V~36V;电池类型:锂电池；磷酸铁锂电池;电池节数:6~10;…`
  - `0603WAF1002T5E`：`10KΩ (1002) ±1%`（EasyEDA `result.description`）。
- **Value**：RECORD=41 `Location=(27,-6)`（10 mil 单位 => `270,-60` mil）、
  `Justification=6`（TopLeft）。
- **连续生成**：临时库 `C92116 → C25804` 不重启 Altium，两次 `RESULT: PASS`；
  `_reuse`/`_linktest` 临时库已删除，`out` 为空。
- **便携版**：`E:\EDA2Altium-exe\library\MyLib.SchLib` 同为 v9，RECORD=45 的
  `ModelDatafile0=E:\EDA2Altium-exe\library\MyLib.PcbLib`，描述相同。

---

## 6. 失败排查

| 提示 | 处理 |
|---|---|
| `Altium 有未保存文档` | 在 Altium 里 `Ctrl+S` 保存（不用关闭），再重试 |
| `立创数据接口请求失败` | 检查网络 / 接口限流，稍后重试；也可直接输入 C 编号 |
| `元件不存在` | C 编号错误或已下架；先用搜索框按名称找编号 |
| `生成的 SchDoc/PcbDoc ... 不一致` | 数据接口返回异常；看 `jobs\<C编号>\parsed-docs.json` |
| `Altium 脚本阶段失败` | 看页面实时日志里的 `STEP/OK/ERR` 与 `STAGE` 行；失败时中间文件会保留便于排查 |
| `Altium 未安装或路径不对` | 设置 `ALTIUM_EXE` 指向 `X2.EXE` |
| 双击 `启动.vbs` 没反应 | 看 `%LOCALAPPDATA%\LCEDA2Altium\server.err.log`；确认 Node 18+；若系统禁用 Windows Script Host，改用 `run.cmd` |
| 停止服务提示“没有检测到…” | 服务已停止；若还有 `run.cmd` 控制台窗口，直接关闭即可 |
| 端口占用 | `启动.vbs` 会自动换到空闲端口；`run.cmd` 可 `set PORT=43181` 后重启 |

环境变量：

- `OUT_DIR` / `LIB_SCH` / `LIB_PCB`：输出与目标库（服务端会自动传）
- `ALTIUM_EXE`：Altium 可执行文件
- `ALTIUM_STARTUP_MS`：单阶段冷启动上限（默认 180000）
- `ALLOW_UNSAVED=1`：跳过“Altium 有未保存文档”的检查（默认禁止；仍不会关闭 Altium）
- `KEEP_DOCS=1` / `MAKE_PART_LIBS=1`：保留 SchDoc/PcbDoc / 生成单件库
  （服务端按页面勾选传入；CLI 可直接设置）
- `ALLOW_FIXTURE=1`：仅调试，使用 `test/tmp-out` 离线数据
- `DOC_ONLY=1`：只生成并回读 SchDoc/PcbDoc，不启动 Altium（试运行）
- `LCEDA2ALTIUM_STATE_DIR` / `LCEDA2ALTIUM_NO_BROWSER=1`：启动器的状态目录覆盖 /
  不打开浏览器（自动化测试用）

---

## 7. 目录

```
E:\EDA2Altium\
├─ 启动.vbs                       一键启动（无控制台，复用实例）
├─ 停止服务.vbs                   一键停止（含生成管线子进程）
├─ 创建桌面快捷方式.vbs           可选：生成桌面快捷方式
├─ run.cmd                        带控制台的调试启动（会复用已运行实例）
├─ app\server.mjs                 HTTP 服务 + 作业管理 + /api/health
├─ app\public\                    页面
├─ app\lib\fetch-component.mjs    EasyEDA 数据 → 归一化模型
├─ app\lib\easyeda\               数据接口与归一化
├─ app\lib\altium-doc-writer.mjs  模型 → Altium ASCII SchDoc/PcbDoc
├─ app\lib\doc-parse.mjs          文档回读解析
├─ app\lib\emit-script-lib.mjs    解析结果 → DelphiScript
├─ app\lib\run-altium.mjs         启动/复用 Altium、等待阶段日志
├─ node_modules\                  iconv-lite（UTF-8→GBK 脚本源码）
├─ tools\launcher-common.ps1      启动器共享函数（健康检查/端口/PID）
├─ tools\launch.ps1               启动逻辑（复用实例、应用窗口、失败弹窗）
├─ tools\stop.ps1                 停止逻辑（校验 PID 后结束进程树）
├─ tools\make-shortcut.ps1        桌面快捷方式生成
├─ tools\pick-path.ps1            UI「浏览…」的原生文件/文件夹选择框
├─ tools\probe.mjs                run.cmd 探测已运行实例
├─ tools\pcblib-check.py          读 PcbLib OLE 流，验证焊盘真的落盘
├─ altium\template-script.pas     脚本模板（两阶段，无点击）
├─ altium\run-stages.mjs          当前管线
├─ altium\blank-sch-sheet.txt     SchDoc 图纸记录模板
├─ altium\blank-pcb-skeleton.txt  无元件的 PcbDoc 板级骨架
├─ library\                       目标库
├─ out\                           临时工作目录；勾选的文档/单件库写入其 <元件名>\ 子目录
├─ jobs\                          版本登记表（作业中间文件成功后删除）
└─ _legacy\                       旧版网页导出/UI 点击实现（不调用）
```

---

## 8. 分发版本（2026-10-22）

- `E:\EDA2Altium-exe\`：**便携版**。自带 `node.exe`、当前 `MyLib` v9 和常用路径；
  双击 `LCEDA2Altium.exe` 即可，不需要安装 Node。默认路径自动指向该文件夹，
  不会写入本工程。停止用 `停止服务.vbs` 或 `LCEDA2Altium.exe --stop`；
  状态/日志在 `%LOCALAPPDATA%\LCEDA2Altium-exe\`。
- `E:\EDA2Altium-html\`：**单文件静态界面**（`index.html`，内联 CSS/JS）。
  可离线查看完整界面；搜索/生成/浏览需要运行便携版或本工程的服务。
- 当前工程 `E:\EDA2Altium\` 保留，继续作为最新源码与开发目录。
