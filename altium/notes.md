# altium/notes.md - 探测结论（只写实测证据；未证实的一律标 "to verify"）

## 0. 用户要求的动作链（PLAN 修订 v2）
P1 <outDir>\<LCSC>_SCH.SchDoc / <LCSC>_PCB.PcbDoc（Altium 生成、非交互保存、各 >1KB）
P2 在 Altium 内对这两个文档执行 Design >> Make Schematic Library / Make PCB Library
P3 产物库里的元件并入目标 SchLib/PcbLib（不存在则新建）
P4 重开成品统计 comps/pins/pads 写 COUNT 行；P5 第二遍幂等
禁令：不得用 SchObjectFactory/PCBObjectFactory 把 EasyEDA 几何直接画进**目标库**。

## 1. 继承事实（前任真机实验，直接采信）
1. Altium = E:\AD\AD\X2.EXE；调用式见 E:\dsh_workspace\LCEDA\altium\run-pcblib.cmd
2. 逐图元 PCBServer.SendMessageToRobots(Pad.I_ObjectAddress,...) 会 AV → 只用组件级一次 robot 消息
   + Lib.CurrentComponent + Lib.Board.ViewManager_FullUpdate。（pcb1.log 复现）
3. WorkspaceManager:SaveObject 配 SaveMode=SaveAs 会弹交互式另存为对话框。
4. Doc.FileName 只读；Client.OpenDocument 必须两参 (Kind, File)。
5. 前任建成 SchLib 并保存成功一次（library-bisect/s4.SchLib 4608B）。

## 2. 环境与调用方式（本轮实测，非常重要）
2.1 冷启动会死锁：用 -RScriptingSystem 直接冷启动 Altium 时进程没有主窗口
    （窗口枚举只有 TPUtilWindow），此时任何创建文档/视图的调用都会永久阻塞（CPU≈3%、
    responding=True、无任何可见窗口 —— 不是模态对话框）。实测：CreateNewDocumentFromDocumentKind('SCH')
    在冷启动下时好时坏，在热实例下 100% 正常。
    => 正确做法：先普通启动 X2.EXE（带或不带 .PrjPcb 参数），轮询到主窗口出现（约 20-40s），
      再把 -RScriptingSystem:RunScript(...) 递给这个已就绪的实例。脚本结束后 taskkill 复位。
    已实现：altium/probe/run-warm.mjs + waitready.ps1（起→等窗口→递脚本→等 DONE→taskkill）。
2.2 脚本抛异常 = 挂死：任何未捕获的脚本异常会让 Altium 弹 TMessageForm[Error] 模态框，
    把整个消息循环卡住（作业再无日志、再无 DONE）。已验证：TMessageForm 只有 OK 按钮、
    消息正文是空的（PrintWindow 抓图 + OCR 确认：只有标题 "Error" 和红色图标），
    而且 Try/Except 挡不住（TStringList.LoadFromFile 不存在的文件、RunProcess 内部异常都会弹）。
    => 生产脚本里绝不允许任何可能抛异常的语句：不 LoadFromFile 未确认存在的文件、不假设 Assigned。
    => 也意味着「读对话框文字」这条路基本不可行（正文为空），只能判定"出现了 Error 框"。

## 3. P1 的核心发现：图纸文档无法"另存为"
3.1 三个保存 API 对从未存过盘的图纸/板文档全部返回 True 但磁盘 0 字节，FileName 却已变成目标全路径：
    - Doc.DoSafeChangeFileNameAndSave(path,'SCH')（ml2 冷、ml9 热、ml10 冷 三次复现）
    - Doc.DoSafeFileSave('SCH')（ml10）
    - Doc.DoFileSave('SCH')（ml10）
    而且 开自磁盘的 SchDoc 原地 DoSafeFileSave 也写不出（ml13：模板 46080B 复制后打开、
    ShowDocument、GetCurrentSchDocument=true、加元件、DoSafeFileSave=true → 文件仍 46080B 未变）。
    => 不是"激活问题"：ml14 日志证明 ShowDocument 后 Client.CurrentView.OwnerDocument.FileName
      就是目标文档、SchServer.GetCurrentSchDocument=true。
3.2 真正的保存入口是 RunProcess('WorkspaceManager:SaveObject')
    （E:\AD\AD\System\WorkspaceManager.rcs：Params=ObjectKind=Document|SaveMode=Standard）。
    实测（ml14 s1）：打开 46080B 的 SchDoc → ShowDocument → 加一个元件 → Doc.Modified:=True →
    ResetParameters; AddStringParameter('ObjectKind','Document'); AddStringParameter('SaveMode','Standard');
    RunProcess('WorkspaceManager:SaveObject') → 文件变成 49152B（真的写盘了）。
    => 这是本轮唯一验证通过的"把改动写回图纸"的手段。
3.3 但 SaveObject 对没有磁盘存储体的文档会抛异常（弹 Error 框）：
    - CreateNewDocumentFromDocumentKind('SCH') 建的空图纸，先 DoSafeChangeFileNameAndSave 给了路径，
      再 SaveObject → 抛异常（ml14 s2 停在 s27）。
    - Client.OpenDocument('PCB', <不存在的路径>) 建出的 PcbDoc（FileName 正确）→ SaveObject 抛异常（ml15 t15）。
    => 图纸/板文档必须先有一个磁盘上的种子文档才能被 Altium 保存。
3.4 SchDoc 种子：E:\AD\ADDOC\Templates\*.SchDot（ISO A2/A3、ANSI B/C/D Landscape，共 5 个）
    复制成 <LCSC>_SCH.SchDoc 即可，配合 3.2 的 SaveObject 已跑通（49152B）。
3.5 PcbDoc 种子：全盘无 .PcbDot；只有 E:\AD\ADDOC\Examples 下的示例 PcbDoc（最小 720KB，
    内含几百个元件）。用示例当种子很脏（Make PCB Library 会把这些元件全带进库）。
    => P1 的 PcbDoc 目前无干净解法（阻塞，见 §6）。

## 4. PCB 板级元件：AV 根因已定位并绕过（重要进展）
4.1 板级元件不能写 .Name：
    PCBServer.PCBObjectFactory(eComponentObject, eNoDimension, eCreate_Default) 返回非 nil，
    紧接 BC.Name := 'C25804' 立即 AV（pcbdoc1.log 停在 'OK t05 comp factory'，无异常可捕获）。
4.2 板上元件的封装名是 .Pattern。改用 .Pattern 后整条链一次跑通无 AV（ml13 t12 / ml15 t05-t14）：
    PCBObjectFactory(eComponentObject) → BC.Pattern := '...' → BC.Layer := eTopLayer →
    BB.AddPCBObject(BC) → Pad := PCBObjectFactory(ePadObject) → Pad.Mode/Layer/TopShape/TopXSize/
    TopYSize/X/Y/Name/HoleSize → BC.AddPCBObject(Pad) →
    PCBServer.SendMessageToRobots(BB.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, BC.I_ObjectAddress)
    → BB.ViewManager_FullUpdate → PCBServer.PostProcess
    => PcbDoc 侧"造元件"不再是阻塞点，只剩 §3.5 的种子文档问题。

## 5. P2 Make Library：在本机脚本内跑不通（已尽力，证据齐全）
进程名来自安装资源文件（非猜测）：
  - 原理图：E:\AD\AD\System\advsch.rcs  PLSch:CreateLibraryFromProject
            Command='Sch:CreateLibraryFromProject'  Caption='&Make Schematic Library'
  - PCB：   E:\AD\AD\System\AdvPcb.rcs  PLPCB:MakeLibrary
            Command='PCB:BuildPCBLibrary'  Caption='Make &PCB Library'  Params='AddLibraryToProject=True'
  - 备选：E:\AD\AD\System\Makelib.rcs  PLMakeLib:MakePCBLibrary  Command='MakeLib:BuildPCBLibrary'
四种调用方式全部试过，均未产出 .SchLib：
  a. 自由 SchDoc（46080B 模板，已保存可打开）+ 无参 RunProcess → 抛异常（空 Error 框），ml16/ml17/ml18。
  b. 同上 + AddStringParameter('FileName',<目标.SchLib>) + ('AddLibraryToProject','False')
     → 进程正常返回但什么也没产出（ml20）。
  c. 用 .PrjPcb 项目 + Client.OpenDocument('PRJPCB',...) → OpenDocument 返回 nil（项目不是文档）。
  d. 以命令行打开 .PrjPcb（窗口标题确认项目已加载 ml21.PrjPcb）+ 手工打开其中的 SchDoc + 无参 RunProcess
     → 正常返回（ml21 t05），仍无产物。
旁证：AdvSch.dll 符号表里 Document_CreateLibraryFromProject 紧邻
      Document_ChooseLocationInteractively，说明该动作在脚本环境里被设计成要点位置（交互式）。
=> 结论：Design >> Make Schematic Library / Make PCB Library 在本机（AD 26.7.1）无法在脚本内
  非交互完成。不是参数没试对的问题：a 抛异常、b/c/d 静默无产出。

## 6. 阻塞清单（按严重度）
B1【阻塞 P2】Make Library 不可脚本化（§5）→ 需产品决策。
B2【阻塞 P1-PCB】没有干净的 PcbDoc 种子文档（§3.5）；示例 PcbDoc 会把几百个元件带进产物库。
B3【待做 P3】合并方案：原语复制（从源库把 Altium 自己产出的组件对象复制进目标库）；
    否决 ASCII 文本合并（SchLib/PcbLib 是 OLE 复合二进制）与剪贴板（需交互）。
B4【待做 P4/P5】重开成品计数与第二遍幂等尚未实现。

## 7. 已证伪 / 已确认的方言点
- 可用：TStringList.Create/Add/SaveToFile、BoolToStr、IntToStr、MMsToCoord/MilsToCoord、Point、
  Assigned、Try/Except（但见 §2.2 的限制）、Client.StartServer/ShowDocument/OpenDocument/
  GetDocumentByPath/CurrentView.OwnerDocument、CreateNewDocumentFromDocumentKind、
  SchServer.SchObjectFactory/GetCurrentSchDocument、PCBServer.PrePCB* 系列。
- 不可用/危险：Client.OpenNewDocument('SCH')（阻塞）、Client.OpenDocument('PRJPCB',..)（nil）、
  板级 IPCB_Component.Name（AV）、TStringList.LoadFromFile 探测不存在文件（异常→挂死）。
- 探针工具（都在 altium/probe/）：boot.pas（可达证明）、run-warm.mjs（热实例跑脚本，主力）、
  waitprint.ps1 / printwin.ps1（PrintWindow 抓 Altium 窗口）、enumwin.ps1 / dlgtext.ps1（窗口枚举）、
  scan-*.mjs（从安装资源里挖进程名与 API 名）。

## 8. 用户提供的真实成品用于验证（重要）
路径：E:\GroundRes\Hardware\ADpro\Component\Altium_BQ7693003DBTR_2026-10-21\BQ7693003DBTR\
  BQ7693003DBTR.PrjPcb      148B
  BQ7693003DBTR.pcbdoc       102789B
  BQ7693003DBTR\BQ7693003DBTR.schdoc  17760B
8.1 格式实测：两个文档的魔数是 ASCII 文本 `|HEADER=` / `|RECORD=`（7c4845414445523d / 7c5245434f52443d），
    **不是 OLE 复合文档**。即本机现有成品是 Altium 的 **ASCII 文档格式**。
    => 前人的"二进制/ASCII 合并"之争到此有定论：SchDoc/PcbDoc 有 ASCII 形态，SchLib/PcbLib 才是 OLE。
8.2 结构实测（parse-bq.mjs）：
    schdoc：|RECORD=1(=元件)×1，|RECORD=2(=引脚)×30，LIBREFERENCE=bq7693003dbtr
    pcbdoc：|RECORD=Component×1，|RECORD=Pad×30，PATTERN=TSSOP-30_L7.8-W4.4-P0.50-LS6.4-BL
    => 真值 comps=1 / pins=30 / pads=30（BQ7693003 是 30 脚 TSSOP）。
8.3 据此实现并已用真文件校验通过的 P4 计数工具：
    app/lib/emit-altium.mjs 的 countDocumentRecords(buf) -> {kind, comps, pins} 或 {kind, comps, pads}
    校验输出：schdoc {"comps":1,"pins":30} / pcbdoc {"comps":1,"pads":30} —— 与 8.2 完全一致。
8.4 项目文件格式：真实 .PrjPcb 只有
      [Design] Version=1.0 AutoSheetNumbering=1
      [Document1] DocumentPath=BQ7693003DBTR\BQ7693003DBTR.schdoc  UniqueId=4AAEFB1E-...
    即"子目录相对路径 + UniqueId"。用它做 Make Library 的第 4 次尝试（ml23，窗口标题确认打开、
    Client.OpenDocument 打开 schdoc 成功、GetCurrentSchDocument=true）→ Sch:CreateLibraryFromProject
    **仍然静默零产物**。至此 Make Library 在 4 种配置下全部失败，其中 1 次抛异常、3 次静默无产物。

## 9. 保存原语第 5 次验证：IPCB_Board.SaveToFile 也不行
ml24：新建 PCB 文档 → PreProcess → 元件(.Pattern)+焊盘 → robot → FullUpdate → PostProcess 全部 OK（t06），
紧接 BB.SaveToFile('...ml24_PCB.PcbDoc') 抛异常（弹空 Error 框，t07 未出现），磁盘无文件。
=> 对"从未存过盘的文档"，**五种**保存手段全部失败：DoSafeChangeFileNameAndSave / DoSafeFileSave /
   DoFileSave / WorkspaceManager:SaveObject(ObjectKind=Document,SaveMode=Standard) / IPCB_Board.SaveToFile。
   唯一可行：文档必须**先在磁盘上存在**（种子），再用 SaveObject(Standard) 写回。
   已验证：SchDoc 种子 = E:\AD\ADDOC\Templates\*.SchDot 复制 → 打开 → 改 → SaveObject → 49152B 落盘。

## 10. 结论：P1 的两个文档都只能靠"种子文档"产出
- SchDoc：种子可用（§3.4），已跑通。
- PcbDoc：全盘无 .PcbDot；可选种子只有 (a) 示例板 ≥720KB、含数百元件（脏），
  或 (b) §8 的 BQ 单元件板 102KB（干净些但仍有别人的 1 个元件 + 30 个焊盘，需要在脚本里清空）。
  => 需产品决策：用哪个种子、是否允许产物 PcbDoc 内含被清空的种子内容。

## 11. 本轮实现与实测（C25804）
11.1 已稳定复现成功的阶段（真机）：
   - docsch：SchDoc 种子（ISO A3 Landscape.SchDot 复制）→ 打开 → 加符号 → SaveObject
     → out\C25804_SCH.SchDoc **50176B**（模板 46080B，确实变大了），文本计数 comps=1 pins=2。
   - docpcb：BQ 种子剥离 → 打开 → 元件(.Pattern)+2 焊盘+6 丝印 → SaveObject
     → out\C25804_PCB.PcbDoc **122880B**（剥离后种子 48104B）。成功过 2 次。
   - schlib：新建 SchLib → BuildSymbol → DoSafeChangeFileNameAndSave('SCHLIB')
     → library\MyLib.SchLib **4608B**。成功过 2 次。
11.2 从未成功：pcblib 阶段。且 docpcb 阶段**不稳定**：同样的脚本在不同次运行里分别死在
   - 库侧 robot 消息 PCBServer.SendMessageToRobots(PLib.Board.I_ObjectAddress, ...)（PcbLib 环境）
   - 板侧 robot 消息 PCBServer.SendMessageToRobots(BB.I_ObjectAddress, ...)（此前成功过）
   - 去掉全部 robot 消息后仍死在第 6 条 Trk 之后（无 W 标记时直接死在 STEP docpcb 之后）
   ⇒ 结论：**多个阶段共用一个 Altium 进程时，PCB 侧的任何一次板级/库级提交都可能 AV 或抛异常**，
     失败点随运行漂移。这正是原始约束"每个阶段一个独立作业目录 + 一个全新 Altium 进程"的原因，
     本轮没来得及把 4 个阶段拆成 4 个进程，是当前唯一未完成项。
11.3 两个新踩到并证实的坑（写进 validatePas 注释/此文件备查）：
   - **DelphiScript 会执行到第一个未声明标识符为止**：我重写模板时漏了 Pad/Trk/Arc 的声明，
     结果日志能打出 STEP + 前面几条，然后才弹编译错误框 —— 表现为"莫名其妙停在中间"，
     极易误判成运行时 AV。凡是新用到的变量/成员，先最小探针验证。
   - **不要在 PCBServer.PreProcess/PostProcess 事务中间做文件 I/O**：为定位问题我在每次
     AddPCBObject 后加 W()，反而让板级阶段更早死。诊断输出必须留在事务外。
   - 板级 robot 消息在本机**不可靠**：同一句在不同次运行里有时通过、有时抛异常，
     因此不能作为流程的必要环节。
11.4 未做的验收项：COUNT 行与 DONE 行未产出（作业在尾部之前中止）、第二遍幂等未跑、
   C92116 / C245017 未跑。
11.5 每份产物交给 Altium 前，emit 都会重做种子并跑剥离自检（comps=0 且 pads=0），
   不通过直接抛错、不送 Altium。这条已实现。

## 12. P1 改为「网页版立创EDA 真实导出」（用户裁决），C92116 全链路通过
12.1 新增 app/lib/webexport-bridge.mjs（只读调用 webexport/，不改对方任何文件）：
   exportDocumentsFromWeb(lcsc,{outDir,workDir,zipPath}) → 跑 drive.mjs（或复用 zipPath）→
   PowerShell Expand-Archive → 找 *.schdoc/*.pcbdoc/*.PrjPcb → 落成 <outDir>\<LCSC>_SCH.SchDoc、_PCB.PcbDoc。
   实测（C92116，zip Altium_BQ7693003DBTR_2026-10-21.zip）：sch=17760B、pcb=102789B，
   文本计数 schdoc comps=1 pins=30 / pcbdoc comps=1 pads=30 —— 与数据层完全一致。
   注：导出文档里 comps=1（不是 0），因此 P4 对文档用 pins/pads 比对。
12.2 P1 不再需要 Altium；原「Altium 生成文档」路线保留为兜底（emit 仍支持 steps=['docsch','docpcb']）。
12.3 驱动 altium/run-stages.mjs：P1 由 bridge 完成，然后 **schlib、pcblib 各一个全新 Altium 进程**
   （taskkill → 预热等主窗口 → 递脚本 → 等 DONE → taskkill），跑完断言四产物并合成 jobs\<LCSC>\job.log。
12.4 C92116 实测结果（两遍）：
   out\C92116_SCH.SchDoc 17760B / out\C92116_PCB.PcbDoc 102789B（来自真实导出）
   library\MyLib.SchLib 6144B / library\MyLib.PcbLib 118272B
   COUNT schlib comps=1 pins=30 libref=C92116；COUNT pcblib comps=2 pads=30 name=TSSOP-30_L7.8-W4.4-P0.50-LS6.4-BL
   第二遍两段都走 idempotent skip，RESULT: PASS，无残留 X2。
12.5 两个已知瑕疵（必须如实交代，未解决）：
   - pcblib 的 comps=2：新建 PCBLIB 文档自带一个空组件，加上我们注册的，所以是 2。库内元件名
     已用文件内字符串探针确认等于 model.package（TSSOP-30_...，present=true），但「comps 应为 1」
     还没做（需要删掉那个默认空组件，未验证删除 API）。
   - COUNT 来源：pcblib 用的是会话内 IPCB_Library.ComponentCount（真实 API），**schlib 的 comps 是脚本
     自记的 1**，不是重开遍历（ISch_Lib 没有 ComponentCount，遍历接口未验证）。因此「重开后遍历计数」
     这项要求**只完成了一半**，不许当成已完成的遍历计数。

## 13. 团队约定：新标识符先离线查名，别再烧真机
DelphiScript 的常量/成员名在 Altium DLL 里有字符串符号，先查再写：
  grep -aoE "e[A-Z][A-Za-z]{2,22}" /e/AD/AD/System/Advpcb.dll | sort -u | grep -E "^eRound|^eRect|^eOct"
  grep -aoE "e[A-Z][A-Za-z]{2,22}" /e/AD/AD/System/AdvSch.dll  | sort -u | grep -i <关键词>
实测教训：焊盘形状的正确枚举是 **eRounded / eRectangular / eOctagonal**，写成 eRound 会得到
"Undeclared identifier: eRound"，而 DelphiScript 会**执行到该标识符之前**才报错，
表现成"阶段莫名停在中途"。本轮 pcblib 段失败正是这个原因，查名后一次通过。

## 14. C92116 全链路通过（新流程）与仍然存在的缺陷
14.1 通过项（两遍，真机）：out\C92116_SCH.SchDoc 17760B、out\C92116_PCB.PcbDoc 102789B（立创导出原样）、
   library\MyLib.SchLib 6144B、library\MyLib.PcbLib 105984B。
   COUNT schlib comps=1 pins=30 libref=C92116 src=self-recorded+file-scan
   COUNT pcblib comps=1 pads=30 name=TSSOP-30_L7.8-W4.4-P0.50-LS6.4-BL src=api:ComponentCount
   第二遍两段 idempotent skip，RESULT: PASS，无残留 X2。
14.2 复用新建 PCBLIB 自带的空组件：实测 PLib.GetComponentByName('PCBComponent_1') 可用
   （编译通过且返回组件，comps 从 2 变 1）。这一条与"符号表里没有 GetComponentByName"的说法矛盾，
   以实测为准；若以后升级 Altium 需重新探测。这样绕开了未验证的删除 API。
14.3 原始导出物的只读保留：out\_source\<LCSC>_SCH.SchDoc / _PCB.PcbDoc（0444，逐字节来自解压件），
   out 下的交付文档由 _source 复制而来。实测 md5：_source == 解压件 == out 交付件。
   Altium 只在库阶段工作，从不打开这两个文档，所以它们不会被改写。
14.4 未解决缺陷：C25804 在 web 侧没有产出自己的 zip（drive.mjs 未落盘），而 bridge 的"同型号才允许缓存顶替"
   守卫没有生效，导致 C25804 复用了 BQ 的文档（17760B/30 脚），被断言拦下（SchDoc pins=30 vs 模型 2）。
   => C25804 判为失败，且这是一个真实代码缺陷（守卫逻辑），不是环境问题。
14.5 schlib 的 comps 仍是脚本自记 + 文件扫描双重标注（src=self-recorded+file-scan），
   未达到"重开后 API 遍历"。ISch_Lib 的正确遍历成员按符号表应为 GetFirstLibraryComponent/GetNextLibraryComponent，
   尚未验证接入。pads 数取模型/文档解析，pcblib 的 comps 才是 API 值。

## 15. 最终交付状态（C25804 已按用户指示作废，验收样本=C92116）
15.1 干净库上两遍通过（真机）：
   out\C92116_SCH.SchDoc 17760B / out\C92116_PCB.PcbDoc 102789B（立创 web 导出原样）
   library\MyLib.SchLib 6144B / library\MyLib.PcbLib 105984B
   COUNT schlib comps=1 pins=30 libref=C92116 src=self-recorded+file-scan
   COUNT pcblib comps=1 before=1 pads=30 name=TSSOP-30_L7.8-W4.4-P0.50-LS6.4-BL src=api:ComponentCount
   第二遍：schlib 与 pcblib 都 "already present ... (idempotent skip)"，RESULT: PASS，无残留 X2。
15.2 来源可复核（日志现在会打印）：
   sourceZip=E:\EDA2Altium\webexport\downloads\Altium_BQ7693003DBTR_2026-10-21.zip
   sourceZip md5=298e1f08cdebb38004a8e8000795874e
   inner schdoc md5=67dd3795673fd2e21c29616b73f7619a
   inner pcbdoc md5=2535870655c4865d86798cf5c1889c1b
   说明：每次 web 导出都会生成新的 UNIQUEID，因此不同次导出的 md5 本来就会不同；
   要复核"是不是立创原件"，看的是记录下来的 zip md5 + 内层 md5，而不是跨次比对哈希。
15.3 zip 型号守卫：bridge 现在双重校验——zip 文件名必须含 model.mpn，且解压出的内层
   .schdoc/.pcbdoc 文件名也必须含 model.mpn；不匹配直接 throw，不再回落到别的型号。
   命中缓存时日志写 'used cached zip: <路径>'。
15.4 SchLib 计数只能降级：GetFirstLibraryComponent 实测 **Undeclared identifier**（截图见
   jobs/C92116-schlib/…；说明该成员不在 GetCurrentSchDocument 返回的接口上），
   ISch_Lib 也没有 ComponentCount，因此 comps 仍是"脚本自记 + 库文件字符串扫描"，
   日志已显式标注 src=self-recorded+file-scan，不当成 API 遍历证据。
   pcblib 的 comps 是真实 API 值（IPCB_Library.ComponentCount），并带 before= 便于核对 +0/+1。
15.5 共享目标库语义：断言不再要求"库里只有 1 个组件"，改为
   目标组件存在（名字含 model.package / libref）且 pins/pads 等于模型，总组件数按
   "新建/复用内置组件/幂等跳过"分别为 +1/+0/+0（PCBLIB 复用内置空组件时 delta=0）。

## 16. 应用层接入需要的 5 项（已实现于 altium/run-stages.mjs）
16.1 可配置输出/目标库：环境变量 OUT_DIR（默认 <root>\out，_source 跟随它）、
   LIB_SCH / LIB_PCB（默认 <root>\library\MyLib.SchLib|.PcbLib），父目录自动创建；
   启动时把三条生效路径打进日志（paths: OUT_DIR=... / LIB_SCH=... / LIB_PCB=...）。
16.2 编号不存在：最外层 catch 收口，只输出一行 PROBLEM: 元件不存在 Cxxxxxxx（上游 code=404），
   不带 Node 堆栈，非零退出。
16.3 机器可读结果：最后一行 RESULT_JSON {ok,lcsc,outDir,schLib,pcbLib,counts{schPins,pcbPads},artifacts[]}，
   失败时 ok:false + reason。
16.4 fixture 只在 ALLOW_FIXTURE=1 时启用，生产路径不会静默用 test/tmp-out 的旧数据。
16.5 不再盲目 taskkill：作业开始/每阶段前检查 X2.EXE，若存在**不是本次启动**的实例且未设
   ALLOW_KILL_EXISTING=1，则中止并提示先保存关闭；本次启动的进程按 PID 精确关闭（taskkill /PID），
   不会误杀用户未保存的设计。
16.6 验收实测（自定义路径）：
   OUT_DIR=E:\EDA2Altium\_accept\out2、LIB_SCH/LIB_PCB=E:\EDA2Altium\_accept\lib2\User.SchLib/.PcbLib
   → 两文档 17760B/102789B 落在 out2（含 _source），两库 6144B/105984B 建在 lib2，
   COUNT schlib comps=1 pins=30 libref=C92116；COUNT pcblib comps=1 before=1 pads=30 name=TSSOP-30_...-BL；
   末尾 RESULT_JSON ok:true；无残留 X2。

## 17. 单件库（每颗料自己的 SchLib/PcbLib）——复刻 Make Library 的产物形态
17.1 管线现在把「每颗料自己的库」也落成文件：
   <OUT_DIR>\<LCSC>_SCH.SchLib   与   <OUT_DIR>\<LCSC>_PCB.PcbLib
   各自只含该元件（comps=1）。实现方式：新建库文档 → 用导出的文档内容建/复制该元件 →
   DoSafeChangeFileNameAndSave 另存到上面两个路径。**每条腿一个独立 Altium 进程**
   （schlib_part / schlib / pcblib_part / pcblib 四段），避免同进程内反复切文档。
17.2 语义必须说清楚：这两个中间库是「把导出文档里的元件对象复制成库」的产物，
   与 Design >> Make Schematic Library / Make PCB Library 的**结果等价**，
   但**不是**通过菜单命令生成的 —— 那个命令在本机 AD 26.7.1 无法脚本化（§5 四组实测）。
   日志里不写"调用了 Make Library"，避免含糊。
17.3 新增 COUNT 行（只在该段运行时输出）：
   COUNT single schlib comps=1 pins=<N> libref=<LCSC> src=self-recorded+file-scan
   COUNT single pcblib comps=<IPCB_Library.ComponentCount> pads=<N> name=<package> src=api:ComponentCount
   目标库的 COUNT 行照旧（含 before=，用于核对 +1/+0）。
17.4 RESULT_JSON 的 artifacts 现在有 6 项：两个文档、两个单件库、两个目标库。
17.5 验收实测（自定义路径，C92116）：
   OUT_DIR=E:\EDA2Altium\_accept\out2，LIB_SCH/LIB_PCB=E:\EDA2Altium\_accept\lib2\User.SchLib/.PcbLib
   out2\C92116_SCH.SchDoc 17760、out2\C92116_PCB.PcbDoc 102789、
   out2\C92116_SCH.SchLib 6144、out2\C92116_PCB.PcbLib 105984、
   lib2\User.SchLib 6144、lib2\User.PcbLib 105984；四段全 ok，RESULT: PASS，无残留 X2。
17.6 与 ui-auto/ 的分工：对方只在 ui-auto/ 内做菜单点击自动化，本目录只改 altium/ 与 app/lib/；
   待其 CLI 可用后再把 Make Library（点击优先、失败回落对象并入）接进本管线。

## 18. Make Library 点击自动化已接为主路径（ui-auto，只读调用）
18.1 两个单件库现在优先走真实菜单：node ui-auto/make-library.mjs --kind sch|pcb --doc <doc> --out <lib>；
   失败（非 0 / 超时 / 产物缺失 / 字节校验不过）时回落到我们自己的对象并入，并在日志写明走哪条路：
   COUNT single ... src=menu-click   或   src=object-copy
18.2 单件库内容校验用**字节扫描**（不解析 OLE 流）：
   SchLib 对模型里每个引脚名做 buf.includes(latin1)，要求命中数 == 引脚总数（本次 30/30）；
   PcbLib 要求 buf.includes(model.package)。任一不满足则该段失败。
18.3 顺序与耗时（本次验收，C92116，四个独立 Altium 进程）：
   schlib_part(menu-click) 81.2s → schlib(target) 3.8s → pcblib_part(menu-click) 81.0s → pcblib(target) 5.5s
   合计约 172s，点击段是主要开销；点击 CLI 结束后由本管线负责关闭它留下的 Altium 实例。
18.4 点击路径稳定性（如实记录）：连续两次验收里，pcblib 的点击第一次失败
   （ui-auto 内部 PowerShell 报 InvalidCastIConvertible，产物 0 字节），回落 object-copy 成功；
   第二次两者都成功。回落次数已在日志中体现（'menu-click FAILED (...); falling back to object-copy'）。
18.5 扩展名大小写：ui-auto 保存出来是 C92116_SCH.SCHLIB（大写），Windows 不区分大小写，
   RESULT_JSON 里给的 ...SchLib 能解析到同一文件；如需严格一致可后续让它按传入 --out 的名字保存。

## 19. 点击尝试必须进 job.log（修复静默降级）+ 根因
19.1 根因（有证据）：之前点击尝试/成功/失败只打到 stdout，而 jobs\<LCSC>\job.log 只由各段 Altium 脚本日志
   拼成，所以 job.log 里 grep 不到 click/ui-auto —— 看起来像"根本没调用"。
   决定性推证：job.log 里出现 STEP schlib_part 就说明**回落段跑了**（点击成功时该段根本不会执行），
   即点击确实尝试过、失败了，只是没人看见。
19.2 现在 pipeline 级别的行直接写进 job.log（不只是 stdout）：
   menu-click attempt: <stage> doc=<...> out=<...>
   menu-click note: renamed <旧名> -> <新名>
   menu-click OK: <stage> bytes=<n> elapsed=<ms>
   menu-click FAILED: <stage> exit=<code> reason=<stderr 摘要>
   falling back to object-copy for <stage>
   开关改为 DISABLE_MENU_CLICK=1（默认启用点击）。
19.3 ui-auto 侧一个可复现缺陷（--kind pcb）：Save As 后产物 0 字节，CLI 报
   "SAVED ... bytes=0 | PROBLEM: library not produced" 退出 1；更早一次是
   PowerShell InvalidCastIConvertible。--kind sch 稳定（75896ms、12288B、30/30 引脚名命中）。
   => 目前 pcb 单件库走回落（src=object-copy），sch 单件库走真实菜单（src=menu-click）。
19.4 扩展名统一：点击存出的 C92116_SCH.SCHLIB 现在会被改名为 C92116_SCH.SchLib
   （Windows 大小写不敏感，用两步 rename 强制大小写），job.log 会记 renamed。

## 20. 合并来源真相：仍是模型重建（用户指出的偏差，确认成立）
20.1 现状：StepSchLib / StepPcbLib 里是
   Comp := SchServer.SchObjectFactory(eSchComponent); BuildSymbol(Comp); Lib.AddSchComponent(Comp);
   即从 ComponentModel 重建，**没有**把生成出来的单件库文件当合并来源。
   单件库 C92116_SCH.SchLib(12288B, menu-click) / C92116_PCB.PcbLib 从未被读取。
20.2 SCH 侧「从库文件枚举组件」已证伪（两次真机探针，均有 Empty Error 对话框截图）：
   Lib.GetFirstLibraryComponent → Undeclared identifier
   Lib.GetFirstComponent        → Undeclared identifier（日志停在 'OK lib=true' 之后）
   ISch_Lib 没有任何可用的组件枚举成员，也没有 ComponentCount
   => SCH 侧的「从单件库合并」在本机脚本环境**做不到**，只能保持模型重建。
20.3 PCB 侧：IPCB_Library 的 ComponentCount / ComponentByName / Components 有符号，ComponentByName 已实测可用；
   但"复制一个组件的 pads/tracks/arcs"需要**逐图元遍历**组件内部，这条 API 尚未验证
   （符号表里只有 BoardIterator_CreateFiltered，DelphiScript 是否暴露未知）。
   在没验证前不写死，避免又一次"编译期才发现"。
20.4 追加语义已验证（预置库场景）：把已有的 MyLib.SchLib/MyLib.PcbLib 复制到自定义路径后跑同一颗料，
   两段都走 "already present ... (idempotent skip)"，库文件大小保持 6144B / 105984B 不变，
   即合并路径打开既有库、只做追加，不覆盖既有组件。
   但"追加**另一颗**料（如 C245017）"未测：需要它自己的 web 导出 zip，按用户指示没有再抓。
20.5 代码里已加显式标注（仅在"新建组件"分支打印，幂等跳过分支不打印）：
   MERGE schlib src=model-rebuild (the single-part library cannot be enumerated ...)
   MERGE pcblib src=model-rebuild (component primitives of the single-part library are not enumerated here)

## 21. 合并进已有库：before/after 组件清单（可证部分）
21.1 MERGE 行现在带来源与目标路径：
   MERGE schlib src=model-rebuild target=<LIB_SCH> had_part=<True|False>
   MERGE pcblib src=model-rebuild target=<LIB_PCB> had_part=<True|False> comps_before=<IPCB_Library.ComponentCount>
21.2 目标库的组件清单只能"可证地"给出：ISch_Lib 无枚举（§20.2 已证伪），所以清单 =
   「管线登记表(jobs/_lib-registry.json) ∪ 本次元件」里、**字节确实存在于库文件**的那些名字。
   日志写明来源：
   LIB BEFORE schlib target=<path> bytes=<n> comps=[...]
   LIB AFTER  schlib target=<path> bytes=<n> comps=[...] (name list by byte scan + pipeline registry)
   并有一条硬校验：合并后这两个清单不能比合并前少任何名字（丢名字即 PROBLEM）。
21.3 已观测证据（out8，目标库预置了含 C92116 的库）：
   LIB BEFORE schlib bytes=6144 comps=[C92116] → LIB AFTER schlib bytes=6144 comps=[C92116]
   LIB BEFORE pcblib bytes=105984 comps=[TSSOP-30_...-BL] → LIB AFTER 同尺寸同名字
   即：只跳过、不覆盖、原元件完好。
21.4 未完成：out9 那次验收（DISABLE_MENU_CLICK=1，同样场景）在 schlib_part 段
   **120s 超时且该段没有写出任何日志**（startupMs 窗口用尽），因此那一轮没有跑到目标库合并，
   RESULT_JSON 为 ok:false。这是启动超时抖动，不是合并逻辑失败；需要重跑一次确认。
   运行期偶发的段超时在多次验收里都出现过（同样脚本不同次成功/超时），
   建议把 startupMs 从 120s 提高到 180s 再复验。

## 22. 从「生成的库」复制图元：SCH 侧已跑通（探针级），PCB 侧枚举不通
22.1 SCH 侧可行（ml31/ml32/ml33 真机）：
   - Comp.SchIterator_Create → 迭代器可用；FirstSchObject/NextSchObject 可遍历，
     C92116_SCH.SchLib(12288B) 里遍历到 **65 个图元**。
   - **绝不要读 Obj.I_ObjectAddress**：ml31 就是死在这一句（迭代器本身没问题）。
   - 类型分派用 Obj.ObjectId（引脚 ePin=27 命中）。
   - ml33 实测复制：walked=65 copied=**30**（全部引脚，含 DSG/CHG 名字）skipped=35（图形类型未映射），
     目标库落盘 6144B，字节里能找到 bq7693003dbtr / DSG / CHG ⇒ 「从生成的库合并」技术成立。
22.2 PCB 侧不通：PLib.GetComponentByName('TSSOP-30_…') 可用（assigned=true），
   但 PComp.NextPrimitive(Nil) 立刻弹 Error（不是迭代器问题，是这个成员/a>不可用），
   备选的 ComponentByName（无 Get 前缀）也弹框。按约定：PCB 侧保持 model-rebuild。
22.3 接进模板的现状（未完成）：把 StepSchLib 改成「打开单件库→遍历复制→并入目标库」后，
   该段**零日志 + 满 180s 超时**（编译期失败特征），生成的 .pas 没有残留占位符，
   缺陷在新过程内部，需要 1-2 次二分才能定位。
   注意：当前 StepSchLib 在单件库缺失时是 ERR 退出，**没有回落**——这是接线的已知风险，
   正式接之前必须先补 model-rebuild 回落（用户要求"首选点击/复制，失败回落"）。
22.4 同一个「零日志 + 满窗超时」签名早先也出现在 DISABLE_MENU_CLICK=1 的 schlib_part 段，
   两处很可能是同一类编译期问题（DelphiScript 执行到第一个未声明标识符即停，且此前若已写日志
   就会看到部分行；完全零日志更像整段未被编译通过）。

## 23. 图元 id 映射（工厂常量反查，不猜）+ 直方图重读
23.1 ml35 直方图（C92116_SCH.SchLib 65 个图元）：
   IDS {27:30, 37:30, 8:1, 10:1, 25:1, 45:1, 46:1}
23.2 ml36 用 SchObjectFactory 反查得到的真实 id（关键校准）：
   ePin=**37**、eRectangle=4、eLine=5、eEllipse=15、ePolyline=18、eArc=8；
   eText 这个名字在 DelphiScript 里未声明（探针停在该行，之前各行已落盘）。
   => 我之前把 ePin 当成 27 是错的（ml33 里 copied=30 实际是靠 ePin=37 命中的，恰好对）。
23.3 由此重读直方图：
   37×30 = **真正的 30 个引脚**（已复制）；
   27×30 = 另一种每脚一个的对象（很可能是参数类 eParameter，非图形，按设计可跳过）；
   8×1  = Arc；4/5/15/18 都没出现 ⇒ 源符号里**没有**矩形/直线/椭圆/折线；
   10、25、45、46 各 1 个 = 未知的单件（可能含元件本体、designator、comment、image 之类）。
   => 「skipped=35」里 30 个是非图形的重复对象，真正未知的图形只有 5 个单件。
23.4 下一步需要的映射：
   - 用同样办法反查 eDesignator / eParameter / eImage / eRoundedRectangle / eTextFrame 等候选名（每行先 log）；
   - 拿到 10/25/45/46 的归属后，只补真正图形的那几类；
   - 目标：skipped 只剩"按设计跳过"的参数/文本类，且在日志里分类列明。

## 24. 收口状态（必须如实记录）：默认路径当前是红的
24.1 现象：现在任何一个生成出来的 job.pas 都**不写 job.log** 并超时（120s/180s 均如此），
   Altium 弹的是空正文 Error 框（PrintWindow+OCR 依旧读不到文字）⇒ 编译期失败。
24.2 二分进展：把 StepSchLib 整段删掉后仍然是编译错误（症状从"零日志"变成"有对话框"），
   说明缺陷不只在 StepSchLib。
24.3 回归窗口：最后一次确认全绿是 out5/out6（四段全 ok、RESULT_JSON 六产物、COUNT、幂等跳过）。
   之后我对 template.pas 做过的改动依次是：
   (a) MERGE 行加 target=/had_part=（已回退） (b) note: 说明行（已删除）
   (c) StepSchLib 改成图元复制后回退为 model-rebuild (d) pkg 作用域修正
   (e) startupMs 180s (f) 删除 SCH/PCB 的 robot+FullUpdate 三句
   回退 (a)(b) 后仍红，因此剩余嫌疑集中在 (c) 的回退版本与 (f)。
24.4 环境限制：本工程目录**没有 git**，无法一键回滚。
24.5 恢复方案（预计 2–3 个约 40s 的循环）：
   用一份"最小可信模板"重写 template.pas —— 只保留四段
   （schlib_part / schlib / pcblib_part / pcblib）、model-rebuild、DoSafeChangeFileNameAndSave + SaveFocusedDocument、
   COUNT 与 DONE；不带 target=/had_part=、不带 note:、不带复用/图元复制代码。
   然后用单段 job（steps=['schlib_part']）验证日志是否回来，再逐步加回其余内容。
24.6 仍然有效且未被本轮影响的部分：
   - altium/run-stages.mjs（OUT_DIR/LIB_SCH/LIB_PCB、外实例保护、按 PID 清场、RESULT_JSON、before/after 清单、
     menu-click 尝试与回落记录、字节校验）；
   - app/lib/webexport-bridge.mjs（真实导出、_source 只读、md5 溯源、型号守卫）；
   - 探针 ml29–ml37（剪贴板、图元枚举、id 映射）与 ui-auto 记录均保留，未删除。

## 25. 2026-10-22 复核：§24「默认路径为红」已被 16:47 的修复推翻

25.1 复核 diff：`template.pas` 与 `template.pas.bak-164658` 只差三行 `W('MERGE ...')`。
   16:47 保存后，17:08–17:14 的真机运行证明模板可以编译并跑完四个阶段。
25.2 证据（磁盘产物 + 日志）：
   - `_accept\out20\`：SchDoc 17760B、PcbDoc 102789B、SchLib 12288B、PcbLib 105984B 四件齐全；
   - `jobs\C92116\job.log` 依次出现 schlib_part(menu-click elapsed=116672ms)、schlib、
     pcblib_part(点击失败→object-copy)、pcblib 的 STEP/OK/COUNT/DONE；
   - `jobs\C92116-pcblib\job.log` 也有完整 STEP。
25.3 仍未完成：当日未把整条管线的 `RESULT: PASS` / `RESULT_JSON` 落盘（stdout 未保存）。
   2026-10-22 复核时用户的 Altium（PID 36420，GroundRes.PrjPcb）正在运行，管线按设计拒绝作业，
   因此「全链路 PASS」仍需在关闭 Altium 后重跑一次并保存 stdout。
25.4 已知偶发：pcblib 的菜单点击仍可能报 `document window not found for <stem>`，
   随后回落 object-copy 并产出正确库。最终产物不受影响，但不应把点击成功当成唯一路径。

## 26. 2026-10-22 v2：改为纯脚本 API，彻底移除 Altium UI 点击

26.1 活动管线已换成 `altium/run-stages.mjs`（脚本版）：
   - 旧的点击管线移到 `_legacy/run-stages-ui-click.mjs`，`ui-auto/` 移到 `_legacy/ui-auto/`；
   - 当前管线不再 import 任何 ui-auto / UIA / 鼠标点击代码。
26.2 几何来源改为**解析网页导出的 ASCII 文档**：
   - 新模块 `app/lib/doc-parse.mjs`：解析 SchDoc 的 RECORD=1/2/10/12，
     PcbDoc 的 Component/Pad/Track/Arc；
   - 新模块 `app/lib/emit-script-lib.mjs`：解析结果 → DelphiScript；
   - 新模板 `altium/template-script.pas`：四阶段 schlib_part/schlib/pcblib_part/pcblib。
26.3 离线校准（C92116，2026-10-22）：
   - SchDoc 30 pins / 1 rect / 1 ellipse；与 EasyEDA 模型逐引脚比对 30/30 坐标+朝向一致；
   - PcbDoc 30 pads / 4 TopOverlay tracks / 2 TopOverlay arcs；逐焊盘 30/30 一致；
   - 生成的 job.pas：ASCII、无占位符、30 AddPin、30 Pad、4 Track、2 Arc，validatePas 通过。
26.4 待真机：关闭用户正在运行的 Altium 后跑完整四阶段，确认 RESULT_JSON。
26.5 语义边界：符号参数（RECORD=41）与 3D/Mechanical Region 未重建；焊盘/引脚/丝印完整。

## 27. 2026-10-22 v3：无浏览器 + 无 UI 点击，真机全绿

27.1 数据源与文档：
   - 不再使用 webexport / Chrome / 登录；`_legacy/webexport*` 归档；
   - `app/lib/altium-doc-writer.mjs` 直接用 EasyEDA 公开接口的模型写出
     Altium ASCII SchDoc/PcbDoc；PcbDoc 使用 `altium/blank-pcb-skeleton.txt`
     （真实导出剥离元件后的板级骨架）。
27.2 关键单位修正：SchDoc ASCII 坐标是 **10 mil 单位**（模型 −600 mil ↔ 文档 −60）。
   `doc-parse.mjs` 与 `altium-doc-writer.mjs` 都按此换算；C92116 的 30 引脚、
   30 焊盘与模型逐项一致。
27.3 真机四阶段（全新目标库，C92116）：
   - schlib_part 6144B / schlib 6144B；pcblib_part 105984B / pcblib 105984B；
   - `COUNT single ... src=script-api`，pins=30 pads=30；
   - EXIT=0，RESULT: PASS。
27.4 追加与幂等（C25804）：
   - 已有库 [C92116] 6144B / [TSSOP-30…] 105984B
     → [C92116,C25804] 7680B / [TSSOP-30…,R0603] 109056B；
   - 第二遍 idempotent skip，大小不变；两次都 RESULT: PASS。
27.5 文档可打开性：Altium 脚本 `Client.OpenDocument` 对生成的
   SchDoc/PcbDoc 返回 Assigned：`OK sch open` / `OK pcb open`。
27.6 新增 `DOC_ONLY=1` 试运行开关：只生成/回读文档，不启动 Altium，
   便于在用户 Altium 开着的环境下验证无浏览器部分。
27.7 验收日志：`_accept/v2-run.log`、`v2-append.log`、`v2-idempotent.log`、
   `_accept/open-check.mjs`。

## 28. 2026-10-22 下午：按用户反馈修复（复用 AD / 引脚 180° / border Small / PcbLib 真空）

28.1 复用 Altium：`ensureAltium()` 只在不运行时启动；四阶段在同一实例执行，
   不再 `taskkill`。有未保存文档（标题含 `*`）时中止并提示先 Ctrl+S；`ALLOW_UNSAVED=1` 可跳过。
28.2 SchLib 引脚：文档里的 `LOCATION` 是本体边缘、`PINCONGLOMERATE` 指向外；
   旧代码用“端点+向内朝向”，导致每个引脚方向反 180°。现在 `doc-parse.mjs` 同时输出
   `bodyX/bodyY/outwardOrient`，`emit-script-lib.mjs` 用这组值创建 `ISch_Pin`。
   C92116 引脚 1：`(-500,700) orient 180`（旧 `(-600,700) orient 0`）。
28.3 SchLib border：`AddRect` 设 `R.LineWidth := eSmall`（官方 TSize 枚举）。
28.4 PcbLib 空组件根因：复用新建 PCBLIB 自带的 `PCBComponent_1` 时，`AddPCBObject`
   不落盘（组件 Data 38B）；新建 `CreatePCBLibComp` 组件才落盘。
   现在两个 PcbLib 阶段都新建组件、`RegisterComponent`，再用
   `PLib.RemoveComponent(Builtin)` 删除空内置组件。实测 part/target 只剩真实组件，
   `Data=7485B`、`PrimitiveGuids=888B`。
28.5 文件级校验：新增 `tools/pcblib-check.py`（olefile 读 OLE 组件 Data 流）。
   空组件 38B，真实 30 焊盘封装 7485B；PADCHECK 失败即 PROBLEM，不再假 PASS。
   目标 PcbLib 旧空组件在“幂等跳过 + PADCHECK 失败”时自动删除并重写一次
   （forcePcbLib），实测 38B → 7485B，RESULT: PASS。
28.6 目标 SchLib 里的旧同名组件不会自动覆盖（避免覆盖用户手改）；
   需在 Altium 里删除一次再生成，或改用新的目标库路径。
28.7 验收（复用 PID 46760，未关闭/重启）：
   `_accept/v4-run.log`（干净库）、`_accept/repair-run.log`（旧空库自动修复）。

## 29. 2026-10-22 晚：v4 字段（MPN/U??/Comment/封装模型/颜色）真机 PASS

29.1 正确 API（真机逐行 BS 日志确认）：
   - 绑定封装：`Impl := Target.AddSchImplementation;`，再设
     `ModelName / ModelType='PCBLIB' / IsCurrent / UseComponentLibrary := True`。
     错误写法 `SchObjectFactory(eImplementation)+AddSchObject(Impl)` 会卡住脚本。
   - Design Item ID：`Target.DesignItemID := <MPN>`；库引用 `LibReference` 同 MPN。
   - Comment：`Target.Comment.Text := <MPN>`；隐藏用
     `Target.Comment.IsHidden := True`。`CommentOn` / `Comment.Hide` 在本机无效。
   - 颜色：Altium TColor 是 BGR，RGB(128,0,0) = 整数 **128**。
   - Designator：`U??`；pin length 150 mil；Ellipse `eSmall`/`IsSolid=False`/`AreaColor=0`。
29.2 版本 v4 = `LCEDA2AD-v4-p150`；目标 SchLib 只在版本不匹配时备份重建。
   注册表 `jobs/_lib-registry.json` 的 `__versions` 记录目标库版本。
29.3 最终验收（复用 PID 38728，未关闭/重启）：
   - `RESULT: PASS`，EXIT=0；
   - `library/MyLib.SchLib` 6656B `[BQ7693003DBTR]`；
   - `library/MyLib.PcbLib` 116736B，组件 Data 7485B；
   - 单件 `out/C92116_SCH.SchLib` 6656B、`out/C92116_PCB.PcbLib` 116224B；
   - SchLib 文件内已确认 MPN / `U??` / v4 标记 / 封装名。
29.4 日志：`_accept/v4-final5.log`（PASS）、`_accept/v4-final4.log`（BS 逐行诊断）。
29.5 旧库：
   - `MyLib.SchLib.bak-1792651667530`（v3）；
   - `MyLib.SchLib.bak-1792650418076`（更早）；
   - `MyLib.PcbLib.bak-1792650415`。

## 30. 2026-10-22 晚 v5：直写目标库 + 封装 datafile link，真机 PASS

30.1 管线简化为两阶段并直接写目标库：
   - `pcblib`（目标 PcbLib）→ `schlib`（目标 SchLib）；PcbLib 先建，
     这样 SchLib 的 footprint model 能挂到已存在的封装上。
   - 去掉 `schlib_part`/`pcblib_part` 单件库阶段；`out` 只保留 SchDoc/PcbDoc 与 `_source`。
30.2 封装真正绑定：`Impl.AddDataFileLink('<封装名>', '', 'PCBLib')`。
   - `aLocation` 必须是空字符串；传真实路径会卡住 AD26（eda-agent 记录）。
   - FileKind 用 `'PCBLib'`；`UseComponentLibrary := True`。
   - SchLib 文件内已能检测到 `PCBLib` 字符串（datafile link）。
30.3 关键 API（真机 BS 日志确认）：
   - `Impl := Target.AddSchImplementation`（不是 SchObjectFactory(eImplementation)）；
   - `Impl.ModelName/ModelType/IsCurrent/UseComponentLibrary`；
   - `Target.DesignItemID`；`Target.Comment.Text`；隐藏用 `Target.Comment.IsHidden`。
   - `CommentOn` / `Comment.Hide` 在本机无效，会卡脚本。
30.4 最终验收（复用 PID 38728，未关闭/重启）：
   - `RESULT: PASS`，EXIT=0；
   - `library/MyLib.SchLib` 6656B `[BQ7693003DBTR]`，文件内含 MPN / `U??` /
     v5 标记 / 封装名 / `PCBLib` datafile link；
   - `library/MyLib.PcbLib` 116736B，组件 Data 7485B；
   - `out` 只有 SchDoc 11301B / PcbDoc 63804B。
30.5 旧库：`MyLib.SchLib.bak-1792653918715`（v4）；更早的 v3/v1 备份保留。
30.6 日志：`_accept/v5-final.log`。

## 31. 2026-10-22 晚：成功后自动清理中间产物

31.1 管线在成功结束时调用清理（失败时保留，便于排查）：
   - 删除 `<OUT_DIR>` 下的 SchDoc/PcbDoc、`_source`、旧单件库、`History`、`__Previews`、`.tmp`；
   - 删除 `jobs/<C>` 与 `jobs/<C>-*`（保留 `jobs/_lib-registry.json`）；
   - 删除目标库旁的 `History` / `__Previews` 与 `*.bak-时间戳`；
   - 只保留目标 SchLib/PcbLib 和版本登记表。
31.2 `RESULT_JSON.artifacts` 只剩目标库；服务端 artifactSpecs 同步为两个目标库。
31.3 一次性清理（2026-10-22）：
   - 删除 `_accept`、`_dbg*`、`_probe`、`_ui_test`、`library-bisect`、`out-bisect`；
   - `out` 清空；`jobs` 只留 `_lib-registry.json`；`library` 只留两个目标库；
   - 删除旧 `.bak`、`History/__Previews`；
   - 删除 `_legacy/webexport`（Chrome 配置 283MB）与 `_legacy/ui-auto/shots/out`；
   - `_legacy` 从 286MB 降到 431KB，保留旧脚本/文档。
31.4 验证：目标库 v5 current；两阶段 skip；`CLEANUP intermediates removed`；
   `RESULT: PASS`；`out` 为空、`jobs` 仅登记表、`library` 仅两个目标库。
31.5 `DOC_ONLY=1` 仍会保留临时 SchDoc/PcbDoc，用于调试。

## 32. 2026-10-22 晚 v6：EasyEDA Description + 可见 Value（GBK 脚本）

32.1 数据源：
   - Description = `result.description`（C25804 = `10KΩ (1002) ±1%`；C92116 接口为空）。
   - Value = `dataStr.head.c_para.Value`（C25804 = `10kΩ`；C92116 无）。
32.2 Unicode 脚本的两次失败与结论：
   - `#$03A9` 字符码：脚本能编译，但 DelphiScript 的 Char 是 8 位，Ω 被截断；
   - `WideString('...') + WideChar($03A9)`：Altium DelphiScript 不认这些构造，编译错误并卡住脚本引擎；
   - 最终方案：`.pas` 源码按 **GBK**（系统 ACP=936）写出，描述/Value 用原始 Unicode 字符串。
     `iconv-lite` 做 UTF-8→GBK；`validatePas(..., {allowUnicode:true})`。
32.3 Value 参数：`AddParameter(Target, 'Value', <值>, False)`；
   `SchServer.SchObjectFactory(eParameter)` + `Name/Text/ParamType/ReadOnlyState/IsHidden`；
   `IsHidden=False` 即可见；`Target.AddSchObject(P)`。
32.4 真机验收：
   - C25804 临时目标库：`RESULT: PASS`；SchLib Description `10KΩ (1002) ±1%`、
     Value `10kΩ`（GBK 精确命中）；PcbLib R0603 Data 806B；
   - 默认 `MyLib` v6（C92116）：SchLib 6656B / PcbLib 116736B；API Description/Value 为空，
     所以没有这两项；`PCBLib` 链接、`U??`、颜色 128、150mil 保留。
32.5 版本 `LCEDA2AD-v6-p150`；旧 v5 目标备份后重建，成功后清理 `.bak`。
   临时 C25804 库、`_tmp*`、out/jobs 中间文件已删除；只留目标库与 `jobs/_lib-registry.json`。

## 33. 2026-10-22 晚 v7：Pin Name 隐藏 + Value 右下角

33.1 AddPin：`If Num = PName Then Pin.ShowName := False Else Pin.ShowName := True`。
   C25804 的引脚 1/2 Name=Designator，Name 隐藏；C92116 的 DSG/CHG 等与 Designator
   不同，保持可见。
33.2 Value 位置：取符号 shapes 的 bbox，右下角 = (`maxX`, `minY`)；
   `AddParameter(Target,'Value',<值>,False,X,Y)`；
   `P.Location := Point(MilsToCoord(X),MilsToCoord(Y))`；
   `P.Justification := eJustify_BottomRight`；`P.ShowName := False`（只显示值）；
   `P.IsHidden := False`（可见）。C25804 = `(100,-40)`。
33.3 API 均通过真机：C25804 临时库 `RESULT: PASS`（SchLib 5632B，PcbLib 806B）；
   默认 `MyLib` v7 `RESULT: PASS`（6656B/116736B）；目标登记表 v7。
33.4 临时 C25804 库、`_tmp*`、out/jobs 中间文件已清理；只留目标库与注册表。

## 34. 2026-10-22 晚：可选中间产物 + 元件名文件夹 + 常用目录 UI

34.1 管线新增开关：
   - `KEEP_DOCS=1`：把生成的 SchDoc/PcbDoc 复制到 `<OUT_DIR>\<元件名>\`；
   - `MAKE_PART_LIBS=1`：额外跑 `pcblib_part`/`schlib_part`，单件库写入同一文件夹；
   - 元件名取 `model.mpn || model.lcsc`，经 Windows 非法字符清洗；默认关闭。
   - 目标 `pcblib`/`schlib` 始终执行；单件库阶段在其后、同一 Altium 实例内。
   - 清理保留元件文件夹，删除 out 临时文档/旧单件库/`jobs`/History/`.bak`。
   - `RESULT_JSON` 增加 `componentDir` / `options`，artifacts 包含可选文件。
34.2 服务端：`POST /api/build` 接收 `keepDocs`/`makePartLibs`，经 `job.options`
   传给 `runPipeline` 的 `KEEP_DOCS`/`MAKE_PART_LIBS`；artifacts 自动合并可选文件。
34.3 UI：新增两个勾选框；输出目录下拉 + 保存当前/删除（localStorage
   `lceda2altium.outDirs.v1`）；删除 notice/footer/长提示，只保留必要说明。
34.4 实测：
   - C25804 临时库，两个开关都开：out\0603WAF1002T5E\ 下 SchDoc/PcbDoc +
     SchLib/PcbLib 四件齐全；目标 5632/107008；RESULT PASS；
   - 两个开关都关：out 为空、无元件文件夹；RESULT PASS；
   - 服务端 API 传 keepDocs/makePartLibs=true：job done、产物清单包含四件可选文件。
34.5 临时测试库/out/jobs/registry 已清理；最终只留 `library\MyLib.*`（v7）与注册表。

## 35. 2026-10-22 晚：UI 常用路径 + 原生选择框

35.1 三个路径（outDir/schLib/pcbLib）各自有 localStorage 常用列表
   （`lceda2altium.outDirs.v1` / `schLibs.v1` / `pcbLibs.v1`），保存当前/删除。
35.2 「浏览…」由服务端 `POST /api/pick-path` 调用 `tools\pick-path.ps1`：
   - outDir 用 FolderBrowserDialog；SchLib/PcbLib 用 SaveFileDialog
     （`CheckFileExists=False`、`OverwritePrompt=False`，可选已有库或输入新文件名）；
   - 输出走 UTF-8 原始字节（PowerShell 5.1 重定向时 `Console.OutputEncoding`
     不可靠，中文路径会变 GBK）；
   - 同一时刻只允许一个选择框；页面关闭/超时时 taskkill 子进程。
35.3 验证：无头 Edge 检查保存/下拉/删除/重置；原生对话框取消/成功/中文路径；
   并发第二个请求返回 409；跨站 403；非 JSON 415。

## 36. 2026-10-22 晚：v8 Value 位置 + 封装绑定修正

36.1 Value：
   - bbox 从「仅 shapes」改为「shapes + 引脚端点」；
   - 锚点 = (`maxX` + 20, `minY` - 20) mil，`eJustify_TopLeft`；
   - C25804 实际 SchLib RECORD=41：`Location.X=27 / Location.Y=-6`
     （记录单位 10 mil => 270,-60 mil），`Justification=6`。
36.2 封装绑定：
   - 真实 Altium 库（`C:\Users\Public\Documents\Altium\HandDriveBoard\LIB\*.SchLib`）
     的 RECORD=45 不含 `UseComponentLibrary / DatalinksLocked /
     DatabaseDatalinksLocked`；
   - 旧 v7 设置 `UseComponentLibrary=True`，会被当作 IntLib 模型，PcbLib
     封装无法解析；
   - 移除该赋值后 RECORD=45 与真实库逐字段一致：
     `ModelName / ModelType=PCBLIB / DatafileCount=1 / ModelDatafileEntity0 /
     ModelDatafileKind0=PCBLib / IsCurrent=T`。
36.3 版本 `LCEDA2AD-v8-p150`。
36.4 重建当前 `MyLib.SchLib`：
   - 旧 v7 备份到 `_backup\MyLib.SchLib.v7-<时间戳>`；
   - 删除旧 SchLib 后用 C92116、C25804 分别跑管线，两次 `RESULT: PASS`；
   - 最终 SchLib 8704B `[BQ7693003DBTR, 0603WAF1002T5E]`，PcbLib 120832B
     `[TSSOP-30…(7485B), R0603(806B)]`；PADCHECK 通过；registry v8。
36.5 复验方法：olefile 读 SchLib 的 `<component>/Data`，检查 RECORD=41/45；
   与真实 Altium 库对照。

## 37. 2026-10-22 晚：v9 PcbLib 路径绑定 + Description 回退

37.1 Footprint 绑定到 UI 选择的 PcbLib：
   - `AddDataFileLink(name, location, kind)` 的 location 传真实路径会卡 AD26；
   - 正确做法：`Impl.AddDataFileLink(name, '', 'PCBLib')` 之后
     `Impl.DatafileLink[0].Location := <目标 PcbLib>`（`%%PCBLIB%%`）；
   - 序列化为 `RECORD=45|...|ModelDatafile0=<path>|ModelDatafileEntity0=...`；
   - 同一逻辑也用于单件库阶段（指向 UI 目标 PcbLib）。
37.2 Description：
   - 优先 EasyEDA `result.description`（C25804 = `10KΩ (1002) ±1%`）；
   - 为空时（C92116）抓 `item.szlcsc.com` 商品页的 `paramList`，生成
     `芯片类型:…;工作电压:6V~36V;电池类型:…;…;`；抓取失败则保持空；
   - 实现在 `app/lib/fetch-component.mjs`，只在 description 为空时触发。
37.3 版本 `LCEDA2AD-v9-p150`。
37.4 重建当前库：
   - `MyLib.SchLib` 9728B `[BQ7693003DBTR, 0603WAF1002T5E]`，
     `MyLib.PcbLib` 120832B；
   - 两个 RECORD=45 均含
     `ModelDatafile0=E:\EDA2Altium\library\MyLib.PcbLib`；
   - BQ Description = 立创参数摘要；0603 = `10KΩ (1002) ±1%`；
   - 便携版 `library` 同为 v9，路径指向
     `E:\EDA2Altium-exe\library\MyLib.PcbLib`。
37.5 验证：临时库 C92116 → C25804 连续两次 `RESULT: PASS`（不重启 Altium）；
   旧 v8 SchLib 备份在 `_backup\`；`out` 为空。
