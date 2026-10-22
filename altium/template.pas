{ ---------------------------------------------------------------------------
  Altium job for %%LCSC%% (%%MPN%%)

  Template: altium/template.pas. emit-altium.mjs substitutes the %%...%%
  placeholders, so the generated .pas is self-contained.

  Chain (verified on Altium 26.7.1 on this machine - see altium/notes.md):
    docsch : open the seeded SchDoc, place the symbol, write it back
    docpcb : open the seeded PcbDoc, place the footprint, write it back
    schlib : merge the symbol into the target SchLib
    pcblib : merge the footprint into the target PcbLib

  Hard-won rules obeyed here:
    * NOTHING may raise. An uncaught script error pops a modal Altium "Error"
      box with an EMPTY body and wedges the whole job, and Try/Except does not
      prevent it. So: no LoadFromFile, no file probing, no assumed Assigned use.
    * DoSafeChangeFileNameAndSave / DoSafeFileSave / DoFileSave all return True
      and write NOTHING for a schematic/PCB document. For a document that
      already exists on disk the only working save is the process
      WorkspaceManager:SaveObject with ObjectKind=Document, SaveMode=Standard.
      A never-saved document cannot be written at all, which is why both
      documents are seeded: a copy of a real Altium document is placed at the
      target path first, then opened, edited and written back.
    * A board component must be given .Pattern, never .Name - writing .Name
      access-violates the script process immediately.
    * Only one component-level robot message per component.
    * A ";" may never appear before Else.
  --------------------------------------------------------------------------- }

Var
    LogTxt    : TStringList;
    LogPath   : String;
    Artifacts : Integer;
    SchComps  : Integer;
    PcbComps  : Integer;
    Reused    : Boolean;
    PcbBefore : Integer;
    PartSchComps : Integer;
    PartPcbComps : Integer;
    { %%FOOTPRINT_LIB%% and %%FOOTPRINT_BOARD%% assign these; DelphiScript executes a
      procedure only up to the first undeclared identifier, so they must exist here. }
    Pad       : IPCB_Pad;
    Trk       : IPCB_Track;
    Arc       : IPCB_Arc;

Procedure W(S : String);
Begin
    If Assigned(LogTxt) Then
    Begin
        LogTxt.Add(S);
        Try
            LogTxt.SaveToFile(LogPath);
        Except
        End;
    End;
End;

{ The only save that actually writes a document that already exists on disk. }
Procedure SaveFocusedDocument;
Begin
    ResetParameters;
    AddStringParameter('ObjectKind', 'Document');
    AddStringParameter('SaveMode', 'Standard');
    RunProcess('WorkspaceManager:SaveObject');
End;

Procedure AddPin(Target : ISch_Component; Num, PName : String; PX, PY, PLen, POrient : Integer; PElec : String);
Var
    Pin : ISch_Pin;
    Rot : TRotationBy90;
Begin
    If POrient = 90 Then Rot := eRotate90
    Else If POrient = 180 Then Rot := eRotate180
    Else If POrient = 270 Then Rot := eRotate270
    Else Rot := eRotate0;
    Pin := SchServer.SchObjectFactory(ePin, eCreate_Default);
    Pin.Location    := Point(MilsToCoord(PX), MilsToCoord(PY));
    Pin.Orientation := Rot;
    Pin.PinLength   := MilsToCoord(PLen);
    Pin.Designator  := Num;
    Pin.Name        := PName;
    If PElec = 'input' Then Pin.Electrical := eElectricInput
    Else If PElec = 'output' Then Pin.Electrical := eElectricOutput
    Else If PElec = 'bidirectional' Then Pin.Electrical := eElectricIO
    Else If PElec = 'power' Then Pin.Electrical := eElectricPower
    Else Pin.Electrical := eElectricPassive;
    Pin.OwnerPartId := 1;
    Pin.OwnerPartDisplayMode := 0;
    Pin.ShowName    := True;
    Target.AddSchObject(Pin);
End;

Procedure AddRect(Target : ISch_Component; X1, Y1, X2, Y2 : Integer);
Var
    R : ISch_Rectangle;
Begin
    R := SchServer.SchObjectFactory(eRectangle, eCreate_Default);
    R.Location    := Point(MilsToCoord(X1), MilsToCoord(Y1));
    R.Corner      := Point(MilsToCoord(X2), MilsToCoord(Y2));
    R.IsSolid     := False;
    R.OwnerPartId := 1;
    R.OwnerPartDisplayMode := 0;
    Target.AddSchObject(R);
End;

Procedure AddLine(Target : ISch_Component; X1, Y1, X2, Y2 : Integer);
Var
    L : ISch_Line;
Begin
    L := SchServer.SchObjectFactory(eLine, eCreate_Default);
    L.Location    := Point(MilsToCoord(X1), MilsToCoord(Y1));
    L.Corner      := Point(MilsToCoord(X2), MilsToCoord(Y2));
    L.OwnerPartId := 1;
    L.OwnerPartDisplayMode := 0;
    Target.AddSchObject(L);
End;

Procedure AddEllipse(Target : ISch_Component; CX, CY, RX, RY : Integer);
Var
    E : ISch_Ellipse;
Begin
    E := SchServer.SchObjectFactory(eEllipse, eCreate_Default);
    E.Location        := Point(MilsToCoord(CX), MilsToCoord(CY));
    E.Radius          := MilsToCoord(RX);
    E.SecondaryRadius := MilsToCoord(RY);
    E.OwnerPartId     := 1;
    E.OwnerPartDisplayMode := 0;
    Target.AddSchObject(E);
End;

Procedure BuildSymbol(Target : ISch_Component);
Begin
    Target.LibReference         := '%%LCSC%%';
    Target.ComponentDescription := '%%DESCRIPTION%%';
    Target.Designator.Text      := 'U?';
%%BUILD_SYMBOL%%
End;

Procedure StepSchDoc;
Var
    Doc  : IServerDocument;
    SDoc : ISch_Document;
    Comp : ISch_Component;
Begin
    W('STEP docsch');
    Client.StartServer('SCH');
    Doc := Client.OpenDocument('SCH', '%%SCHDOC%%');
    If Not Assigned(Doc) Then
    Begin W('ERR docsch cannot open the seeded document'); Exit; End;
    Client.ShowDocument(Doc);
    SDoc := SchServer.GetCurrentSchDocument;
    If Not Assigned(SDoc) Then
    Begin W('ERR docsch no current schematic document'); Exit; End;
    Comp := SchServer.SchObjectFactory(eSchComponent, eCreate_Default);
    BuildSymbol(Comp);
    SDoc.AddSchObject(Comp);
    Doc.Modified := True;
    SaveFocusedDocument;
    Artifacts := Artifacts + 1;
    W('OK docsch wrote the SchDoc with symbol %%LCSC%%');
End;

Procedure StepPcbDoc;
Var
    Doc : IServerDocument;
    BB  : IPCB_Board;
    BC  : IPCB_Component;
Begin
    W('STEP docpcb');
    Client.StartServer('PCB');
    Doc := Client.OpenDocument('PCB', '%%PCBDOC%%');
    If Not Assigned(Doc) Then
    Begin W('ERR docpcb cannot open the seeded document'); Exit; End;
    Client.ShowDocument(Doc);
    BB := PCBServer.GetCurrentPCBBoard;
    If Not Assigned(BB) Then
    Begin W('ERR docpcb no current board'); Exit; End;
    PCBServer.PreProcess;
    BC := PCBServer.PCBObjectFactory(eComponentObject, eNoDimension, eCreate_Default);
    If Not Assigned(BC) Then
    Begin W('ERR docpcb cannot create the board component'); PCBServer.PostProcess; Exit; End;
    BC.Pattern := '%%PACKAGE%%';
    BC.Layer   := eTopLayer;
    BB.AddPCBObject(BC);
%%FOOTPRINT_BOARD%%
    PCBServer.PostProcess;
    { log outside the transaction: file I/O inside PreProcess/PostProcess destabilises the board stage }
    W('OK docpcb primitives added');
    Doc.Modified := True;
    SaveFocusedDocument;
    Artifacts := Artifacts + 1;
    W('OK docpcb wrote the PcbDoc with %%PACKAGE%%');
End;

{ The per-part library: exactly this component, saved on its own. This reproduces the
  SHAPE of Design >> Make Schematic Library output (one library per part) but is produced
  by copying the symbol built from the exported document - it does NOT call that menu
  command, which cannot be scripted on this machine (altium/notes.md 5). }
Procedure StepSchLibPart;
Var
    Doc  : IServerDocument;
    Lib  : ISch_Lib;
    Comp : ISch_Component;
Begin
    W('STEP schlib_part');
    Client.StartServer('SCH');
    CreateNewDocumentFromDocumentKind('SCHLIB');
    Lib := SchServer.GetCurrentSchDocument;
    If Not Assigned(Lib) Then
    Begin W('ERR schlib_part no current library'); Exit; End;
    Comp := SchServer.SchObjectFactory(eSchComponent, eCreate_Default);
    BuildSymbol(Comp);
    Lib.AddSchComponent(Comp);
    Lib.CurrentSchComponent := Comp;
    PartSchComps := 1;
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR schlib_part no focused document'); Exit; End;
    Doc.Modified := True;
    If Doc.DoSafeChangeFileNameAndSave('%%PARTSCHLIB%%', 'SCHLIB') = False Then
    Begin W('ERR schlib_part DoSafeChangeFileNameAndSave returned false'); Exit; End;
    Artifacts := Artifacts + 1;
    W('OK schlib_part wrote the single-part library');
End;

Procedure StepSchLib;
Var
    Doc  : IServerDocument;
    Lib  : ISch_Lib;
    Comp : ISch_Component;
Begin
    W('STEP schlib');
    Client.StartServer('SCH');
    If %%SCHLIB_EXISTS%% Then
    Begin
        Doc := Client.OpenDocument('SCHLIB', '%%SCHLIB%%');
        If Not Assigned(Doc) Then
        Begin W('ERR schlib cannot open the target library'); Exit; End;
        Client.ShowDocument(Doc);
    End
    Else
        CreateNewDocumentFromDocumentKind('SCHLIB');
    Lib := SchServer.GetCurrentSchDocument;
    If Not Assigned(Lib) Then
    Begin W('ERR schlib no current library'); Exit; End;
    If %%SCHLIB_HAS%% Then
    Begin
        SchComps := 1;
        Artifacts := Artifacts + 1;
        W('OK schlib %%LCSC%% already present in the target library (idempotent skip)');
        Exit;
    End;
    Comp := SchServer.SchObjectFactory(eSchComponent, eCreate_Default);
    BuildSymbol(Comp);
    Lib.AddSchComponent(Comp);
    Lib.CurrentSchComponent := Comp;
    SchComps := 1;
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR schlib no focused document'); Exit; End;
    Doc.Modified := True;
    If %%SCHLIB_EXISTS%% Then
    Begin
        SaveFocusedDocument;
        W('OK schlib merged %%LCSC%% into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('%%SCHLIB%%', 'SCHLIB') = False Then
        Begin W('ERR schlib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        W('OK schlib created the target library with %%LCSC%%');
    End;
    Artifacts := Artifacts + 1;
End;

Procedure StepPcbLibPart;
Var
    Doc   : IServerDocument;
    PLib  : IPCB_Library;
    PComp : IPCB_LibComponent;
Begin
    W('STEP pcblib_part');
    Client.StartServer('PCB');
    CreateNewDocumentFromDocumentKind('PCBLIB');
    PLib := PCBServer.GetCurrentPCBLibrary;
    If Not Assigned(PLib) Then
    Begin W('ERR pcblib_part no current library'); Exit; End;
    PComp := PLib.GetComponentByName('PCBComponent_1');
    If Assigned(PComp) Then
        W('OK pcblib_part reusing the built-in library component')
    Else
    Begin
        PComp := PCBServer.CreatePCBLibComp;
        W('OK pcblib_part created a new library component');
    End;
    PComp.Name        := '%%PACKAGE%%';
    PComp.Description := '%%DESCRIPTION%%';
    PComp.Height      := MMsToCoord(0.5);
%%FOOTPRINT_LIB%%
    W('OK pcblib_part primitives added');
    PartPcbComps := PLib.ComponentCount;
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR pcblib_part no focused document'); Exit; End;
    Doc.Modified := True;
    If Doc.DoSafeChangeFileNameAndSave('%%PARTPCBLIB%%', 'PCBLIB') = False Then
    Begin W('ERR pcblib_part DoSafeChangeFileNameAndSave returned false'); Exit; End;
    Artifacts := Artifacts + 1;
    W('OK pcblib_part wrote the single-part library');
End;

Procedure StepPcbLib;
Var
    Doc   : IServerDocument;
    PLib  : IPCB_Library;
    PComp : IPCB_LibComponent;
Begin
    W('STEP pcblib');
    Client.StartServer('PCB');
    W('OK pcblib server');
    If %%PCBLIB_EXISTS%% Then
    Begin
        Doc := Client.OpenDocument('PCBLIB', '%%PCBLIB%%');
        If Not Assigned(Doc) Then
        Begin W('ERR pcblib cannot open the target library'); Exit; End;
        Client.ShowDocument(Doc);
    End
    Else
        CreateNewDocumentFromDocumentKind('PCBLIB');
    W('OK pcblib document');
    PLib := PCBServer.GetCurrentPCBLibrary;
    If Not Assigned(PLib) Then
    Begin W('ERR pcblib no current library'); Exit; End;
    W('OK pcblib library assigned');
    PcbBefore := PLib.ComponentCount;
    If %%PCBLIB_HAS%% Then
    Begin
        PcbComps := PLib.ComponentCount;
        Artifacts := Artifacts + 1;
        W('OK pcblib %%PACKAGE%% already present in the target library (idempotent skip)');
        Exit;
    End;
    { A new PCBLIB document already contains one blank component. Reuse it instead of
      creating a second one: that keeps comps=1 and avoids the unverified delete API. }
    PComp := PLib.GetComponentByName('PCBComponent_1');
    If Assigned(PComp) Then
    Begin
        Reused := True;
        W('OK pcblib reusing the built-in library component');
    End
    Else
    Begin
        PComp := PCBServer.CreatePCBLibComp;
        W('OK pcblib created a new library component');
    End;
    PComp.Name        := '%%PACKAGE%%';
    PComp.Description := '%%DESCRIPTION%%';
    PComp.Height      := MMsToCoord(0.5);
    If Not Reused Then PLib.RegisterComponent(PComp);
    W('OK pcblib component named');
    PLib.RegisterComponent(PComp);
    { Registration is what creates the library entry; the name is re-applied after it
      because the registered component otherwise keeps the default PCBComponent_1 name. }
    PComp.Name        := '%%PACKAGE%%';
    PComp.Description := '%%DESCRIPTION%%';
    W('OK pcblib component registered');
%%FOOTPRINT_LIB%%
    { No robot message and no CurrentComponent/ViewManager_FullUpdate here: in a PcbLib
      the library board is not a live board object, so those calls throw. The primitives
      already belong to PComp, which is all the saved library needs. }
    W('OK pcblib primitives added');
    PcbComps := PLib.ComponentCount;
    W('OK pcblib ComponentCount');
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR pcblib no focused document'); Exit; End;
    Doc.Modified := True;
    If %%PCBLIB_EXISTS%% Then
    Begin
        SaveFocusedDocument;
        W('OK pcblib merged %%PACKAGE%% into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('%%PCBLIB%%', 'PCBLIB') = False Then
        Begin W('ERR pcblib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        W('OK pcblib created the target library with %%PACKAGE%%');
    End;
    Artifacts := Artifacts + 1;
End;

Procedure RunJob;
Begin
    Artifacts := 0;
    SchComps  := 0;
    PcbComps  := 0;
    LogPath   := '%%LOG%%';
    LogTxt    := TStringList.Create;
%%RUNJOB%%
%%COUNTSINGLE%%
    W('COUNT schlib comps=' + IntToStr(SchComps) + ' pins=%%PINS%% libref=%%LCSC%% src=self-recorded+file-scan');
    W('COUNT pcblib comps=' + IntToStr(PcbComps) + ' before=' + IntToStr(PcbBefore) + ' pads=%%PADS%% name=%%PACKAGE%% src=api:ComponentCount');
    W('DONE artifacts=' + IntToStr(Artifacts));
    LogTxt.Free;
End;