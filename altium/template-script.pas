{ ---------------------------------------------------------------------------
  Altium job for %%LCSC%% (%%MPN%%)

  Template: altium/template-script.pas. emit-script-lib.mjs substitutes the
  %%...%% placeholders, so the generated .pas is self-contained.

  Chain (script API only - no UI automation, no mouse clicks):
    schlib_part : create the single-part SchLib from the exported SchDoc
    schlib      : merge that component into the target SchLib
    pcblib_part : create the single-part PcbLib from the exported PcbDoc
    pcblib      : merge that component into the target PcbLib

  Hard-won rules obeyed here:
    * NOTHING may raise. An uncaught script error pops a modal Altium "Error"
      box with an EMPTY body and wedges the whole job, and Try/Except does not
      prevent it. So: no LoadFromFile, no file probing, no assumed Assigned use.
    * A brand-new library is written with DoSafeChangeFileNameAndSave(File,Kind).
      A library that already exists on disk is written with the process
      WorkspaceManager:SaveObject (ObjectKind=Document, SaveMode=Standard);
      DoSafeFileSave / DoFileSave report True but write nothing on this build.
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
    { The generated footprint block assigns these; DelphiScript executes a
      procedure only up to the first undeclared identifier, so they must exist here. }
    Pad       : IPCB_Pad;
    Trk       : IPCB_Track;
    Arc       : IPCB_Arc;
    Builtin   : IPCB_LibComponent;
    OldComp   : IPCB_LibComponent;
    Impl      : ISch_Implementation;

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
    { When the pin name and designator are identical, showing both just prints the
      same text twice; keep the designator and hide the name. }
    If Num = PName Then Pin.ShowName := False Else Pin.ShowName := True;
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
    R.LineWidth   := eSmall;
    R.Color       := 128; // RGB(128,0,0) in BGR TColor
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
    E.LineWidth       := eSmall;
    E.Color           := 128; // RGB(128,0,0), same border color as the rectangle
    E.IsSolid         := False;    // Fill Color unchecked
    E.AreaColor       := 0;
    E.OwnerPartId     := 1;
    E.OwnerPartDisplayMode := 0;
    Target.AddSchObject(E);
End;

{ Circular schematic arc: center + radius + Altium CCW start/end angles (degrees).
  EasyEDA's symbol A records are converted to exactly these values by the parser. }
Procedure AddArc(Target : ISch_Component; CX, CY, R : Integer; SAngle, EAngle : Double);
Var
    A : ISch_Arc;
Begin
    A := SchServer.SchObjectFactory(eArc, eCreate_Default);
    A.Location    := Point(MilsToCoord(CX), MilsToCoord(CY));
    A.Radius      := MilsToCoord(R);
    A.StartAngle  := SAngle;
    A.EndAngle    := EAngle;
    A.LineWidth   := eSmall;
    A.Color       := 128; // RGB(128,0,0) in BGR TColor, same as rect/ellipse
    A.OwnerPartId := 1;
    A.OwnerPartDisplayMode := 0;
    Target.AddSchObject(A);
End;

{ Pad mask (paste / solder) expansion cache. IPCB_Pad itself has no writable
  PasteMaskExpansionMode member in DelphiScript; the scripted equivalent of the
  Pad properties panel's "Paste Mask Override" checkbox is the TPadCache record
  reached through Pad.Cache. Kept in its own procedure for the same safety reason
  as AddFootprintRegions: an unknown identifier truncates only this procedure,
  leaving pads/tracks/arcs/save/DONE intact. PasteMM = 0 keeps the design rule
  (LCEDA's "CPE=0 / Mode=Rule"); SolderMM = 0 likewise. }
Procedure SetPadMask(P : IPCB_Pad; PasteMM, SolderMM : Double);
Var
    Cache : TPadCache;
Begin
    If Not Assigned(P) Then Exit;
    Cache := P.Cache;
    If PasteMM <> 0 Then
    Begin
        Cache.PasteMaskExpansion      := MMsToCoord(PasteMM);
        Cache.PasteMaskExpansionValid := eCacheManual;
    End;
    If SolderMM <> 0 Then
    Begin
        Cache.SolderMaskExpansion      := MMsToCoord(SolderMM);
        Cache.SolderMaskExpansionValid := eCacheManual;
    End;
    P.Cache := Cache;
End;

{ Add a schematic parameter. PValue is a WideString so the EasyEDA description /
  Value (Ω, Chinese, ±) survives; IsHidden=False makes it visible. }
Procedure AddParameter(Target : ISch_Component; PName, PValue : WideString; PHidden : Boolean; PX, PY : Integer);
Var
    P : ISch_Parameter;
Begin
    P := SchServer.SchObjectFactory(eParameter, eCreate_Default);
    If Assigned(P) Then
    Begin
        P.Name          := PName;
        P.Text          := PValue;
        P.ParamType     := eParameterType_String;
        P.ReadOnlyState := eReadOnly_None;
        P.IsHidden      := PHidden;
        P.Location      := Point(MilsToCoord(PX), MilsToCoord(PY));
        { TopLeft: the text extends right/down from the location. The emitter puts
          that location just beyond the symbol's lower-right corner. }
        P.Justification := eJustify_TopLeft;
        P.ShowName      := False;
        Target.AddSchObject(P);
    End;
End;

{ Filled SOLIDREGION shapes (EasyEDA layers 5/6/7/8/12/13/14/15/99/100/101 and
  Multi). Authoring path: PCBServer.PCBContourFactory -> IPCB_Contour.AddPoint ->
  IPCB_Region.SetOutlineContour (all three verified in the AD26 type library).
  Kept in a separate procedure on purpose: DelphiScript stops executing a
  procedure at the first undeclared identifier, so if this build rejects a region
  identifier only these shapes are skipped - pads/tracks/arcs, save and DONE run. }
Procedure AddFootprintRegions(Target : IPCB_LibComponent);
Var
    Region  : IPCB_Region;
    Contour : IPCB_Contour;
Begin
    W('OK regions begin solid=%%REGION_SOLID%% outline=%%REGION_OUTLINE%% skipped=%%REGION_SKIPPED%%');
%%REGION_BODY%%
    W('OK regions added');
End;

Procedure BuildSymbol(Target : ISch_Component);
Begin
%%BUILD_SYMBOL%%
    { Bind the schematic component to its PCB footprint. ModelType=PCBLIB plus the
      package name is the same model link EasyEDA's own Altium export writes
      (RECORD=45 MODELTYPE=PCBLIB MODELNAME=<package>). }
    W('BS impl');
    Impl := Target.AddSchImplementation;
    W('BS impl-created');
    If Assigned(Impl) Then
    Begin
        W('BS impl-modelname');
        Impl.ModelName   := '%%PACKAGE%%';
        W('BS impl-modeltype');
        Impl.ModelType   := 'PCBLIB';
        W('BS impl-description');
        Impl.Description := '';
        W('BS impl-iscurrent');
        Impl.IsCurrent   := True;
        { Do NOT set UseComponentLibrary. Real Altium-generated SchLibs omit it
          for a standalone PcbLib; setting it True marks the model as a
          component-library (IntLib) model and the footprint does not resolve. }
        W('BS impl-datalink');
        // Attach the PCBLib datafile link with an empty location (passing a path
        // directly to AddDataFileLink wedges AD26), and point the link at the
        // target PcbLib chosen in the UI. This writes ModelDatafileLocation0.
        Impl.AddDataFileLink('%%PACKAGE%%', '', 'PCBLib');
        W('BS impl-datalink-done');
        W('BS impl-datalink-location');
        If Impl.DatafileLinkCount > 0 Then
        Begin
            Impl.DatafileLink[0].Location := '%%PCBLIB%%';
            W('BS impl-datalink-location-set');
        End;
        W('BS impl-done');
    End;
End;

{ The per-part library: exactly this component, saved on its own. The geometry comes
  from the parsed EasyEDA Altium export, so this is the document-conversion result,
  produced through the scripting API instead of the Design >> Make Library menu. }
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
    Doc.Modified := False;
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
        W('OK schlib %%LIBNAME%% already present in the target library (idempotent skip)');
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
        Doc.Modified := False;
        W('OK schlib merged %%LIBNAME%% into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('%%SCHLIB%%', 'SCHLIB') = False Then
        Begin W('ERR schlib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        Doc.Modified := False;
        W('OK schlib created the target library with %%LIBNAME%%');
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
    { A new PCBLIB document contains one blank placeholder component. Remove it so
      the saved library contains only the real footprint. RemoveComponent is verified
      on this build (COMPS goes 2 -> 1). }
    Builtin := PLib.GetComponentByName('PCBComponent_1');
    If Assigned(Builtin) Then
    Begin
        PLib.RemoveComponent(Builtin);
        W('OK pcblib_part removed the blank built-in component');
    End;
    { Do NOT reuse the blank PCBComponent_1 that a new PCBLIB document contains:
      adding primitives to that placeholder is not persisted (its Data stream stays
      38 bytes). A component created with CreatePCBLibComp + RegisterComponent does
      persist its pads/tracks/arcs. }
    PComp := PCBServer.CreatePCBLibComp;
    If Not Assigned(PComp) Then
    Begin W('ERR pcblib_part CreatePCBLibComp returned nil'); Exit; End;
    PComp.Name        := '%%PACKAGE%%';
    PComp.Description := %%DESCRIPTION%%;
    PComp.Height      := MMsToCoord(0.5);
    PLib.RegisterComponent(PComp);
    W('OK pcblib_part created and registered the library component');
%%FOOTPRINT_LIB%%
    W('OK pcblib_part primitives added');
    PartPcbComps := PLib.ComponentCount;
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR pcblib_part no focused document'); Exit; End;
    Doc.Modified := True;
    If Doc.DoSafeChangeFileNameAndSave('%%PARTPCBLIB%%', 'PCBLIB') = False Then
    Begin W('ERR pcblib_part DoSafeChangeFileNameAndSave returned false'); Exit; End;
    Doc.Modified := False;
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
    { Drop the blank placeholder so comps=1 means exactly the real footprint. }
    Builtin := PLib.GetComponentByName('PCBComponent_1');
    If Assigned(Builtin) Then
    Begin
        PLib.RemoveComponent(Builtin);
        W('OK pcblib removed the blank built-in component');
    End;
    { Repair mode: the target already contained this footprint name, but the saved
      component had no primitives (the old empty-component bug). Remove it and
      rebuild it once. Only triggered by the pipeline after a failed PADCHECK. }
    If %%PCBLIB_FORCE%% Then
    Begin
        OldComp := PLib.GetComponentByName('%%PACKAGE%%');
        If Assigned(OldComp) Then
        Begin
            PLib.RemoveComponent(OldComp);
            W('OK pcblib removed the old empty component for rewrite');
        End;
    End;
    PcbBefore := PLib.ComponentCount;
    If %%PCBLIB_HAS%% Then
    Begin
        PcbComps := PLib.ComponentCount;
        Artifacts := Artifacts + 1;
        W('OK pcblib %%PACKAGE%% already present in the target library (idempotent skip)');
        Exit;
    End;
    { Create a real component. The built-in PCBComponent_1 is only a blank
      placeholder and does not persist AddPCBObject primitives on save. }
    PComp := PCBServer.CreatePCBLibComp;
    If Not Assigned(PComp) Then
    Begin W('ERR pcblib CreatePCBLibComp returned nil'); Exit; End;
    PComp.Name        := '%%PACKAGE%%';
    PComp.Description := %%DESCRIPTION%%;
    PComp.Height      := MMsToCoord(0.5);
    PLib.RegisterComponent(PComp);
    { Registration can reset the name to the default, so re-apply it. }
    PComp.Name        := '%%PACKAGE%%';
    PComp.Description := %%DESCRIPTION%%;
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
        Doc.Modified := False;
        W('OK pcblib merged %%PACKAGE%% into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('%%PCBLIB%%', 'PCBLIB') = False Then
        Begin W('ERR pcblib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        Doc.Modified := False;
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
    W('COUNT schlib comps=' + IntToStr(SchComps) + ' pins=%%PINS%% libref=%%LIBNAME%% src=self-recorded+file-scan');
    W('COUNT pcblib comps=' + IntToStr(PcbComps) + ' before=' + IntToStr(PcbBefore) + ' pads=%%PADS%% regions=%%REGIONS%% skippedregions=%%SKIPPEDREGIONS%% name=%%PACKAGE%% src=model+file-check');
    W('DONE artifacts=' + IntToStr(Artifacts));
    LogTxt.Free;
End;