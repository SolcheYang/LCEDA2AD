# 交付说明（无浏览器 / 无 UI 点击版）

## 交付物

`E:\EDA2Altium`：输入元件名称/立创编号 → EasyEDA 公开数据接口 → 本机生成
本地生成临时 Altium ASCII SchDoc/PcbDoc → Altium 脚本 API 直接写目标 SchLib/PcbLib。
成功生成后自动删除所有中间文件，只保留目标库。

- 没有浏览器自动化、没有登录、没有 UIA、没有鼠标点击。
- 旧的网页导出 + Altium 菜单点击实现完整保存在 `_legacy\`，当前管线不引用。
- 打开方式：双击 `启动.vbs`（无控制台窗口、自动复用已运行实例、优先用
  Edge/Chrome 应用窗口）；`停止服务.vbs` 停止服务；`创建桌面快捷方式.vbs`
  可选生成桌面快捷方式；`run.cmd` 为带控制台的调试方式。

## 需求对照

| 需求 | 实现 | 证据 |
|---|---|---|
| 输入名称或立创编号 | 服务端解析，名称经 EasyEDA 搜索转 C 编号 | `C92116`、`BQ7693003DBTR` 搜索实测通过 |
| 得到 SchDoc/PcbDoc（临时） | 由 EasyEDA 数据接口取几何，`altium-doc-writer.mjs` 写出临时 Altium ASCII 5.0 文档用于解析 | 生成后回读：SchDoc 1 元件/30 引脚/1 矩形/1 椭圆；PcbDoc 1 元件/30 焊盘/4 丝印线/2 圆弧；成功后文档删除 |
| AD Make Schematic Library / Make PCB Library | 改为**脚本 API 等价转换**：在 Altium 内创建库组件，不调用菜单、不点击 | 生成的 job.pas 通过静态校验；几何与数据层 30/30 一致 |
| 并入指定 SchLib/PcbLib | 目标库不存在则新建；同名幂等跳过；追加后校验名称 | 已真机复验：新库创建、追加、幂等、旧空库自动修复均 PASS |
| SchLib Description / Value | Description 取 EasyEDA `result.description`；Value 取 `c_para.Value`，有值则新建可见 `Value` 参数 | C25804：`10KΩ (1002) ±1%` / `10kΩ`（可见）；C92116 接口返回空描述/无 Value |
| Pin Name / Value 位置 | Designator=Name 时隐藏 Name；Value 放符号右下角、右下对齐、只显示值 | C25804 引脚 1/2 已验证；C92116 的 Name 与 Designator 不同，保持可见 |
| 可选中间产物 | 页面勾选保留 SchDoc/PcbDoc、生成单件 SchLib/PcbLib；保存到 `<outDir>\<元件名>\`；其他中间文件清理 | C25804 临时库验证；默认关闭时 out 为空 |
| 常用路径 / 浏览 | outDir、schLib、pcbLib 三个路径都有常用下拉（保存到 state 目录 `ui-prefs.json`，关闭程序后仍保留；保存当前 / 删除）与 Windows 原生选择框；库文件可选已有或新建 | UI + `GET/POST /api/prefs` + `POST /api/pick-path` |
| 工程在 E: | `E:\EDA2Altium` | — |

## 已验证（离线，不需要 Altium）

- **SchDoc 解析/生成闭环**：C92116 的 30 个引脚，坐标、长度、朝向与 EasyEDA 模型
  **30/30 一致**；矩形/椭圆坐标一致。
- **PcbDoc 解析/生成闭环**：30 个焊盘（位置、尺寸、形状、层）与模型 **30/30 一致**；
  4 条 TopOverlay 丝印线、2 个圆弧一致。
- **单位校准**：SchDoc ASCII 使用 10 mil 单位（模型 −600 mil ↔ 文档 −60），
  PcbDoc 使用显式 `mil` 后缀；写入/回读都按此换算。
- **生成脚本**：ASCII、无占位符、30 条 AddPin、30 个焊盘对象、4 条走线、2 个圆弧，
  通过 `validatePas` 静态守卫。

## 真机验收（2026-10-22，Altium 26.7.1）

1. **干净库 C92116（全新目标库）**
   - 四阶段全 `ok`，`EXIT=0`，`RESULT: PASS`
   - SchDoc 11302B / PcbDoc 63804B / 单件 SchLib 6144B / 单件 PcbLib 105984B
   - 目标 SchLib 6144B / PcbLib 105984B；`COUNT pins=30 pads=30`
   - Altium 脚本引擎 `OpenDocument` 验证：`OK sch open` / `OK pcb open`
2. **追加第二颗料 C25804 到同一目标库**
   - `LIB BEFORE`：`[C92116]` 6144B / `[TSSOP-30…]` 105984B
   - `LIB AFTER`：`[C92116, C25804]` 7680B / `[TSSOP-30…, R0603]` 109056B
   - 日志：`merged C25804 into the existing target library` /
     `merged R0603 into the existing target library`
   - `COUNT pcblib comps=2 before=1`；`RESULT: PASS`
3. **幂等重跑 C25804**
   - 两段均 `idempotent skip`；库大小保持 7680 / 109056；`RESULT: PASS`

历史验收日志/探针已清理（v5 起中间文件在成功后自动删除）。

> 注：上面 v2 的 105984B PcbLib 是“空组件”版本；2026-10-22 下午已修复，见下。

## 修复后复验（2026-10-22 下午）

- **复用同一个 Altium 实例**（PID 38728 未变，未关闭/重启），两阶段在同一实例内完成。
- **直写目标库 + 可选中间产物（v7+，当前 v8）**：目标 `pcblib` / `schlib` 始终执行；
  勾选「单件库」时另跑 `pcblib_part` / `schlib_part`，写入
  `<outDir>\<元件名>\`；勾选「保留文档」时 SchDoc/PcbDoc 也写入该文件夹。
  默认关闭时只保留目标库，`out` 为空。
- **自动清理**：成功后删除临时文档、旧 `_source`、旧单件库、`jobs\<C>*`、Altium
  `History/__Previews`、旧库 `.bak-时间戳`；勾选的文档/单件库保留在元件文件夹。
- **UI**：输出目录下拉（localStorage）保存/删除常用目录；两个勾选框；去掉冗长提示。
- **SchLib**：引脚“本体边缘 + 向外朝向”（180° 修正）；矩形/椭圆 `eSmall`；
  Design Item ID / 库引用 = MPN（`BQ7693003DBTR`）；Designator = 立创 EDA 前缀 + `??`
  （`R?`→`R??`、`U?`→`U??`、`CN?`→`CN??`，接口无前缀时回退 `U??`）；
  Comment = MPN 且 `Comment.IsHidden := True`；border 颜色 128（RGB 128,0,0）；
  Ellipse `IsSolid=False` / `AreaColor=0`；pin length 150 mil。
- **封装绑定（v5，v8 修正）**：`AddSchImplementation` + `ModelName=<封装名>` +
  `ModelType='PCBLIB'` + **`AddDataFileLink('<封装名>', '', 'PCBLib')`**。
  位置必须为空字符串；**v8 起不再设置 `UseComponentLibrary=True`**（真实 Altium
  SchLib 的 RECORD=45 不含该字段；设 True 会被当作 IntLib 模型，导致 PcbLib
  封装无法解析）。
- **v6 Description / Value**：Description = EasyEDA `result.description`；生成的 `.pas`
  以 **GBK** 写出（`iconv-lite`），中文/Ω/± 原样进入 SchLib。Value = `c_para.Value`，
  有值时通过 `AddParameter` 新建并**可见**。
  C25804 实测：Description `10KΩ (1002) ±1%`、Value `10kΩ`；C92116 的接口
  Description/Value 都为空，所以默认库没有这两项。
- **v7 Pin Name / Value 位置**：`If Num = PName Then Pin.ShowName := False`；
  C25804 引脚 1/2 的 Name 已隐藏；C92116 的 DSG/CHG 等 Name 与 Designator
  不同，保持可见。
- **v8 Value 位置 + 封装绑定修正**：
  - Value 锚点取「符号图形 + 引脚端点」包围盒右下角，再向右/下各 20 mil；
    `eJustify_TopLeft`，文字向右下展开。C25804 => `(270,-60)` mil，
    `ShowName=False`、`IsHidden=False`，不再与符号/引脚重叠。
  - 移除 `UseComponentLibrary`；RECORD=45 与真实 Altium 库字段一致。
  - 版本 `LCEDA2AD-v8-p150`；当前 `MyLib.SchLib` 旧 v7 备份后重建。
- **v9 PcbLib 路径绑定 + Description 回退**：
  - `AddDataFileLink` 后设置 `Impl.DatafileLink[0].Location := <目标 PcbLib>`；
    RECORD=45 写入 `ModelDatafile0=E:\EDA2Altium\library\MyLib.PcbLib`，
    SchLib 的 Footprint 直接指向 UI 选择的 PcbLib。
  - Description 优先 EasyEDA `result.description`；为空时（C92116）用立创商城
    商品页 `paramList` 生成参数摘要。C25804 仍为 `10KΩ (1002) ±1%`。
  - 版本 `LCEDA2AD-v9-p150`。
- **可选产物实测（C25804 临时库）**：`KEEP_DOCS=1 MAKE_PART_LIBS=1` 时
  `out\0603WAF1002T5E\` 下有 `C25804_SCH.SchDoc` / `_PCB.PcbDoc` 与
  `C25804_SCH.SchLib` / `_PCB.PcbLib`；目标库 5632B / 107008B，`RESULT: PASS`；
  默认关闭时 out 为空、不建元件文件夹。服务端 `keepDocs` / `makePartLibs`
  经 `job.options` 传给管线。
- **PcbLib**：`CreatePCBLibComp + RegisterComponent`，空 `PCBComponent_1` 用
  `RemoveComponent` 删除；目标组件 `Data=7485B`、`PrimitiveGuids=888B`。
- **旧库处理**：旧目标 SchLib 备份为 `.bak-时间戳` 后重建；旧空 PcbLib 自动修复。
- **最终结果**：`RESULT: PASS`；`MyLib.SchLib` 9728B
  `[BQ7693003DBTR, 0603WAF1002T5E]`，`MyLib.PcbLib` 120832B
  （`TSSOP-30…` 30 焊盘 / `R0603` 2 焊盘）；两个 RECORD=45 均含
  `ModelDatafile0=E:\EDA2Altium\library\MyLib.PcbLib`，`ModelName` 与
  PcbLib 组件名一致。
- **v9 复验**：C92116 + C25804 两次 `RESULT: PASS`（不重启 Altium）；
  BQ Description = 立创参数摘要（`芯片类型:…;工作电压:6V~36V;…`），
  0603 Description = `10KΩ (1002) ±1%`；C25804 Value 记录
  `Location=(27,-6)`（10 mil 单位 => 270,-60 mil）、`Justification=6`；
  PADCHECK 通过；临时 `_linktest`/`_reuse` 库已删除，`out` 为空。
- **便携版**：`E:\EDA2Altium-exe\library\MyLib.*` 同为 v9，RECORD=45 的
  `ModelDatafile0=E:\EDA2Altium-exe\library\MyLib.PcbLib`。
- 临时验证库、验收日志等中间产物已清理；旧 v7/v8 SchLib 备份在
  `_backup\`，目标库与 `jobs\_lib-registry.json` 保留。

## 运行前提

- Node ≥18；在项目目录执行一次 `npm install`（`iconv-lite`，GBK 脚本源码）；
  Altium 在 `E:\AD\AD\X2.EXE`（`ALTIUM_EXE` 可覆盖）。
- 能访问 `easyeda.com` 公开接口；Description 为空时还会访问 `item.szlcsc.com`
  商品页读取参数（失败时自动跳过）。**不需要 Chrome、不需要立创登录**。
- Altium 可以保持打开：程序复用当前实例，不关闭/重启。若标题栏有 `*`，先 `Ctrl+S` 保存。

## 已知差异

- 符号重建引脚、矩形、椭圆、圆弧、折线、闭合多边形（v11）；未知图形会记入
  `skippedShapes=N`，符号文本框 `T` 未重建。
- 符号参数（SupplierPart、Datasheet 等 `RECORD=41`）未重建；只新增 `Value`
  （仅当 EasyEDA `c_para.Value` 存在且设为可见）。
- Description 取 EasyEDA `result.description`；若接口返回空（如 C92116），
  SchLib Description 为空。
- 封装重建 EasyEDA 的每一层（v14，与嘉立创导出的 PcbDoc 逐项对齐）：焊盘
  （含旋转、NPTH、钢网/阻焊扩边）、丝印、阻焊、钢网、Multi、Document、
  引脚外形（Mechanical 9）+ Mechanical 6 外框、制造层 `SOLIDREGION` 填充区；
  Mechanical 8 只保留 1 脚旁的一个约 0.15 mm 小圆点；layer 101（极性标记）按
  嘉立创导出的行为丢弃；仅 3D Body（`SVGNODE`）不重建。
- 导出 PcbDoc 里的 Designator/Comment 两段 Text 尚未在 PcbLib 组件里生成（v13）。
- 目标 SchLib 已有同名组件时不会覆盖；旧版组件需在 Altium 里删除一次再生成，
  或换一个新的目标库路径。PcbLib 的旧空组件会自动检测并重写。
- 这些差异来自“无浏览器 + 脚本 API 重建”的路线；若需要 100% 菜单同等产物，
  需要继续补参数/3D 对象并做新的 API 探测。
