{ ---------------------------------------------------------------------------
  Altium job for C14709 (BLM18PG121SN1D)

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
  Value (??, Chinese, ?±) survives; IsHidden=False makes it visible. }
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
    W('OK regions begin solid=5 outline=0 skipped=0');
    Contour := PCBServer.PCBContourFactory;
    If Assigned(Contour) Then
    Begin
        Contour.Clear;
        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);
        If Assigned(Region) Then
        Begin
            Region.Layer := eMechanical9;
            Contour.AddPoint(MMsToCoord(0.7999), MMsToCoord(-0.4));
            Contour.AddPoint(MMsToCoord(0.4999), MMsToCoord(-0.4));
            Contour.AddPoint(MMsToCoord(0.4999), MMsToCoord(0.4));
            Contour.AddPoint(MMsToCoord(0.7999), MMsToCoord(0.4));
            Region.SetOutlineContour(Contour);
            Target.AddPCBObject(Region);
        End;
    End;
    Contour := PCBServer.PCBContourFactory;
    If Assigned(Contour) Then
    Begin
        Contour.Clear;
        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);
        If Assigned(Region) Then
        Begin
            Region.Layer := eMechanical9;
            Contour.AddPoint(MMsToCoord(-0.4999), MMsToCoord(-0.4));
            Contour.AddPoint(MMsToCoord(-0.7999), MMsToCoord(-0.4));
            Contour.AddPoint(MMsToCoord(-0.7999), MMsToCoord(0.4));
            Contour.AddPoint(MMsToCoord(-0.4999), MMsToCoord(0.4));
            Region.SetOutlineContour(Contour);
            Target.AddPCBObject(Region);
        End;
    End;
    Contour := PCBServer.PCBContourFactory;
    If Assigned(Contour) Then
    Begin
        Contour.Clear;
        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);
        If Assigned(Region) Then
        Begin
            Region.Layer := eTopPaste;
            Contour.AddPoint(MMsToCoord(-0.2516), MMsToCoord(0.143));
            Contour.AddPoint(MMsToCoord(-0.2516), MMsToCoord(-0.1335));
            Contour.AddPoint(MMsToCoord(-0.5258), MMsToCoord(-0.4273));
            Contour.AddPoint(MMsToCoord(-1.0291), MMsToCoord(-0.4273));
            Contour.AddPoint(MMsToCoord(-1.0931), MMsToCoord(-0.3633));
            Contour.AddPoint(MMsToCoord(-1.0931), MMsToCoord(0.3727));
            Contour.AddPoint(MMsToCoord(-1.0291), MMsToCoord(0.4367));
            Contour.AddPoint(MMsToCoord(-0.5258), MMsToCoord(0.4367));
            Region.SetOutlineContour(Contour);
            Target.AddPCBObject(Region);
        End;
    End;
    Contour := PCBServer.PCBContourFactory;
    If Assigned(Contour) Then
    Begin
        Contour.Clear;
        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);
        If Assigned(Region) Then
        Begin
            Region.Layer := eTopPaste;
            Contour.AddPoint(MMsToCoord(0.264), MMsToCoord(0.1542));
            Contour.AddPoint(MMsToCoord(0.264), MMsToCoord(-0.1223));
            Contour.AddPoint(MMsToCoord(0.5382), MMsToCoord(-0.416));
            Contour.AddPoint(MMsToCoord(1.0415), MMsToCoord(-0.416));
            Contour.AddPoint(MMsToCoord(1.1055), MMsToCoord(-0.352));
            Contour.AddPoint(MMsToCoord(1.1055), MMsToCoord(0.384));
            Contour.AddPoint(MMsToCoord(1.0415), MMsToCoord(0.448));
            Contour.AddPoint(MMsToCoord(0.5382), MMsToCoord(0.448));
            Region.SetOutlineContour(Contour);
            Target.AddPCBObject(Region);
        End;
    End;
    Contour := PCBServer.PCBContourFactory;
    If Assigned(Contour) Then
    Begin
        Contour.Clear;
        Region := PCBServer.PCBObjectFactory(eRegionObject, eNoDimension, eCreate_Default);
        If Assigned(Region) Then
        Begin
            Region.Layer := eMechanical8;
            Contour.AddPoint(MMsToCoord(-1.284299), MMsToCoord(0.0));
            Contour.AddPoint(MMsToCoord(-1.2959), MMsToCoord(0.058321));
            Contour.AddPoint(MMsToCoord(-1.328936), MMsToCoord(0.107763));
            Contour.AddPoint(MMsToCoord(-1.378378), MMsToCoord(0.140799));
            Contour.AddPoint(MMsToCoord(-1.436699), MMsToCoord(0.1524));
            Contour.AddPoint(MMsToCoord(-1.49502), MMsToCoord(0.140799));
            Contour.AddPoint(MMsToCoord(-1.544462), MMsToCoord(0.107763));
            Contour.AddPoint(MMsToCoord(-1.577498), MMsToCoord(0.058321));
            Contour.AddPoint(MMsToCoord(-1.589099), MMsToCoord(0.0));
            Contour.AddPoint(MMsToCoord(-1.577498), MMsToCoord(-0.058321));
            Contour.AddPoint(MMsToCoord(-1.544462), MMsToCoord(-0.107763));
            Contour.AddPoint(MMsToCoord(-1.49502), MMsToCoord(-0.140799));
            Contour.AddPoint(MMsToCoord(-1.436699), MMsToCoord(-0.1524));
            Contour.AddPoint(MMsToCoord(-1.378378), MMsToCoord(-0.140799));
            Contour.AddPoint(MMsToCoord(-1.328936), MMsToCoord(-0.107763));
            Contour.AddPoint(MMsToCoord(-1.2959), MMsToCoord(-0.058321));
            Region.SetOutlineContour(Contour);
            Target.AddPCBObject(Region);
        End;
    End;
    W('OK regions added');
End;

Procedure BuildSymbol(Target : ISch_Component);
Begin
    W('BS libref');
    Target.LibReference         := 'BLM18PG121SN1D';
    W('BS designitemid');
    Target.DesignItemID         := 'BLM18PG121SN1D';
    W('BS description');
    Target.ComponentDescription := '电感值:3.3nH;精度:±5%;额定电流:850mA;直流电阻(DCR):59mΩ;';
    W('BS designator');
    Target.Designator.Text      := 'L??';
    W('BS commenttext');
    Target.Comment.Text         := 'BLM18PG121SN1D';
    W('BS commenthidden');
    Target.Comment.IsHidden     := True;
    AddLine(Target, -169, 1, -169, 7);
    AddLine(Target, -169, 7, -168, 14);
    AddLine(Target, -168, 14, -166, 20);
    AddLine(Target, -166, 20, -163, 25);
    AddLine(Target, -163, 25, -159, 31);
    AddLine(Target, -159, 31, -154, 35);
    AddLine(Target, -154, 35, -148, 39);
    AddLine(Target, -148, 39, -142, 41);
    AddLine(Target, -142, 41, -136, 43);
    AddLine(Target, -136, 43, -129, 43);
    AddLine(Target, -129, 43, -122, 43);
    AddLine(Target, -122, 43, -116, 41);
    AddLine(Target, -116, 41, -110, 39);
    AddLine(Target, -110, 39, -104, 35);
    AddLine(Target, -104, 35, -99, 31);
    AddLine(Target, -99, 31, -95, 25);
    AddLine(Target, -95, 25, -92, 20);
    AddLine(Target, -92, 20, -90, 14);
    AddLine(Target, -90, 14, -89, 7);
    AddLine(Target, -89, 7, -89, 1);
    AddLine(Target, -84, 1, -84, 7);
    AddLine(Target, -84, 7, -83, 14);
    AddLine(Target, -83, 14, -81, 20);
    AddLine(Target, -81, 20, -78, 25);
    AddLine(Target, -78, 25, -74, 31);
    AddLine(Target, -74, 31, -69, 35);
    AddLine(Target, -69, 35, -63, 39);
    AddLine(Target, -63, 39, -57, 41);
    AddLine(Target, -57, 41, -51, 43);
    AddLine(Target, -51, 43, -44, 43);
    AddLine(Target, -44, 43, -38, 43);
    AddLine(Target, -38, 43, -31, 41);
    AddLine(Target, -31, 41, -25, 39);
    AddLine(Target, -25, 39, -19, 35);
    AddLine(Target, -19, 35, -15, 31);
    AddLine(Target, -15, 31, -11, 25);
    AddLine(Target, -11, 25, -7, 20);
    AddLine(Target, -7, 20, -5, 14);
    AddLine(Target, -5, 14, -4, 7);
    AddLine(Target, -4, 7, -4, 1);
    AddLine(Target, 1, 1, 1, 7);
    AddLine(Target, 1, 7, 2, 14);
    AddLine(Target, 2, 14, 4, 20);
    AddLine(Target, 4, 20, 7, 25);
    AddLine(Target, 7, 25, 11, 31);
    AddLine(Target, 11, 31, 16, 35);
    AddLine(Target, 16, 35, 21, 39);
    AddLine(Target, 21, 39, 27, 41);
    AddLine(Target, 27, 41, 34, 43);
    AddLine(Target, 34, 43, 41, 43);
    AddLine(Target, 41, 43, 47, 43);
    AddLine(Target, 47, 43, 54, 41);
    AddLine(Target, 54, 41, 60, 39);
    AddLine(Target, 60, 39, 65, 35);
    AddLine(Target, 65, 35, 70, 31);
    AddLine(Target, 70, 31, 74, 25);
    AddLine(Target, 74, 25, 77, 20);
    AddLine(Target, 77, 20, 79, 14);
    AddLine(Target, 79, 14, 80, 7);
    AddLine(Target, 80, 7, 80, 1);
    AddLine(Target, 87, 1, 87, 7);
    AddLine(Target, 87, 7, 88, 14);
    AddLine(Target, 88, 14, 90, 20);
    AddLine(Target, 90, 20, 93, 25);
    AddLine(Target, 93, 25, 97, 31);
    AddLine(Target, 97, 31, 102, 35);
    AddLine(Target, 102, 35, 108, 39);
    AddLine(Target, 108, 39, 114, 41);
    AddLine(Target, 114, 41, 120, 43);
    AddLine(Target, 120, 43, 127, 43);
    AddLine(Target, 127, 43, 133, 43);
    AddLine(Target, 133, 43, 140, 41);
    AddLine(Target, 140, 41, 146, 39);
    AddLine(Target, 146, 39, 152, 35);
    AddLine(Target, 152, 35, 156, 31);
    AddLine(Target, 156, 31, 160, 25);
    AddLine(Target, 160, 25, 164, 20);
    AddLine(Target, 164, 20, 166, 14);
    AddLine(Target, 166, 14, 167, 7);
    AddLine(Target, 167, 7, 167, 1);
    AddPin(Target, '2', '2', 170, 0, 150, 0, 'unspecified');
    AddPin(Target, '1', '1', -170, 0, 150, 180, 'unspecified');
    { Bind the schematic component to its PCB footprint. ModelType=PCBLIB plus the
      package name is the same model link EasyEDA's own Altium export writes
      (RECORD=45 MODELTYPE=PCBLIB MODELNAME=<package>). }
    W('BS impl');
    Impl := Target.AddSchImplementation;
    W('BS impl-created');
    If Assigned(Impl) Then
    Begin
        W('BS impl-modelname');
        Impl.ModelName   := 'L0603';
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
        Impl.AddDataFileLink('L0603', '', 'PCBLib');
        W('BS impl-datalink-done');
        W('BS impl-datalink-location');
        If Impl.DatafileLinkCount > 0 Then
        Begin
            Impl.DatafileLink[0].Location := 'E:\GroundRes\Hardware\ADpro\MagSensor_DEMO\MagSensor\PcbLib1.PcbLib';
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
    If Doc.DoSafeChangeFileNameAndSave('E:\EDA2Altium-exe\out\C14709_SCH.SchLib', 'SCHLIB') = False Then
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
    If True Then
    Begin
        Doc := Client.OpenDocument('SCHLIB', 'E:\GroundRes\Hardware\ADpro\MagSensor_DEMO\MagSensor\Schlib1.SchLib');
        If Not Assigned(Doc) Then
        Begin W('ERR schlib cannot open the target library'); Exit; End;
        Client.ShowDocument(Doc);
    End
    Else
        CreateNewDocumentFromDocumentKind('SCHLIB');
    Lib := SchServer.GetCurrentSchDocument;
    If Not Assigned(Lib) Then
    Begin W('ERR schlib no current library'); Exit; End;
    If False Then
    Begin
        SchComps := 1;
        Artifacts := Artifacts + 1;
        W('OK schlib BLM18PG121SN1D already present in the target library (idempotent skip)');
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
    If True Then
    Begin
        SaveFocusedDocument;
        Doc.Modified := False;
        W('OK schlib merged BLM18PG121SN1D into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('E:\GroundRes\Hardware\ADpro\MagSensor_DEMO\MagSensor\Schlib1.SchLib', 'SCHLIB') = False Then
        Begin W('ERR schlib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        Doc.Modified := False;
        W('OK schlib created the target library with BLM18PG121SN1D');
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
    PComp.Name        := 'L0603';
    PComp.Description := '电感值:3.3nH;精度:±5%;额定电流:850mA;直流电阻(DCR):59mΩ;';
    PComp.Height      := MMsToCoord(0.5);
    PLib.RegisterComponent(PComp);
    W('OK pcblib_part created and registered the library component');
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.800001);
        Pad.TopYSize := MMsToCoord(0.863999);
        Pad.X        := MMsToCoord(-0.6999);
        Pad.Y        := MMsToCoord(0.0);
        Pad.Name     := '1';
        Pad.HoleSize := MMsToCoord(0.0);
        Pad.Rotation := 180.0;
        SetPadMask(Pad, -100.0, 0.0508);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.800001);
        Pad.TopYSize := MMsToCoord(0.863999);
        Pad.X        := MMsToCoord(0.6999);
        Pad.Y        := MMsToCoord(0.0);
        Pad.Name     := '2';
        Pad.HoleSize := MMsToCoord(0.0);
        Pad.Rotation := 180.0;
        SetPadMask(Pad, -100.0, 0.0508);
        PComp.AddPCBObject(Pad);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(-1.27);
        Trk.Y1    := MMsToCoord(-0.651401);
        Trk.X2    := MMsToCoord(-1.424099);
        Trk.Y2    := MMsToCoord(-0.499001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(-1.424099);
        Trk.Y1    := MMsToCoord(-0.499001);
        Trk.X2    := MMsToCoord(-1.424099);
        Trk.Y2    := MMsToCoord(0.517401);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(-1.424099);
        Trk.Y1    := MMsToCoord(0.517401);
        Trk.X2    := MMsToCoord(-1.27);
        Trk.Y2    := MMsToCoord(0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(1.27);
        Trk.Y1    := MMsToCoord(0.650001);
        Trk.X2    := MMsToCoord(1.424201);
        Trk.Y2    := MMsToCoord(0.499001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(1.424201);
        Trk.Y1    := MMsToCoord(0.499001);
        Trk.X2    := MMsToCoord(1.424201);
        Trk.Y2    := MMsToCoord(-0.517401);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(1.424201);
        Trk.Y1    := MMsToCoord(-0.517401);
        Trk.X2    := MMsToCoord(1.27);
        Trk.Y2    := MMsToCoord(-0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(-1.271999);
        Trk.Y1    := MMsToCoord(0.650001);
        Trk.X2    := MMsToCoord(-0.509999);
        Trk.Y2    := MMsToCoord(0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(1.272101);
        Trk.Y1    := MMsToCoord(-0.650001);
        Trk.X2    := MMsToCoord(0.510101);
        Trk.Y2    := MMsToCoord(-0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(-1.271999);
        Trk.Y1    := MMsToCoord(-0.650001);
        Trk.X2    := MMsToCoord(-0.509999);
        Trk.Y2    := MMsToCoord(-0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(1.272101);
        Trk.Y1    := MMsToCoord(0.650001);
        Trk.X2    := MMsToCoord(0.510101);
        Trk.Y2    := MMsToCoord(0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(0.8);
        Trk.Y1    := MMsToCoord(-0.3999);
        Trk.X2    := MMsToCoord(-0.8);
        Trk.Y2    := MMsToCoord(-0.3999);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(-0.8);
        Trk.Y1    := MMsToCoord(-0.3999);
        Trk.X2    := MMsToCoord(-0.8);
        Trk.Y2    := MMsToCoord(0.4001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(-0.8);
        Trk.Y1    := MMsToCoord(0.4001);
        Trk.X2    := MMsToCoord(0.8);
        Trk.Y2    := MMsToCoord(0.4001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(0.8);
        Trk.Y1    := MMsToCoord(0.4001);
        Trk.X2    := MMsToCoord(0.8);
        Trk.Y2    := MMsToCoord(-0.3999);
        PComp.AddPCBObject(Trk);
        AddFootprintRegions(PComp);
    W('OK pcblib_part primitives added');
    PartPcbComps := PLib.ComponentCount;
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR pcblib_part no focused document'); Exit; End;
    Doc.Modified := True;
    If Doc.DoSafeChangeFileNameAndSave('E:\EDA2Altium-exe\out\C14709_PCB.PcbLib', 'PCBLIB') = False Then
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
    If True Then
    Begin
        Doc := Client.OpenDocument('PCBLIB', 'E:\GroundRes\Hardware\ADpro\MagSensor_DEMO\MagSensor\PcbLib1.PcbLib');
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
    If False Then
    Begin
        OldComp := PLib.GetComponentByName('L0603');
        If Assigned(OldComp) Then
        Begin
            PLib.RemoveComponent(OldComp);
            W('OK pcblib removed the old empty component for rewrite');
        End;
    End;
    PcbBefore := PLib.ComponentCount;
    If True Then
    Begin
        PcbComps := PLib.ComponentCount;
        Artifacts := Artifacts + 1;
        W('OK pcblib L0603 already present in the target library (idempotent skip)');
        Exit;
    End;
    { Create a real component. The built-in PCBComponent_1 is only a blank
      placeholder and does not persist AddPCBObject primitives on save. }
    PComp := PCBServer.CreatePCBLibComp;
    If Not Assigned(PComp) Then
    Begin W('ERR pcblib CreatePCBLibComp returned nil'); Exit; End;
    PComp.Name        := 'L0603';
    PComp.Description := '电感值:3.3nH;精度:±5%;额定电流:850mA;直流电阻(DCR):59mΩ;';
    PComp.Height      := MMsToCoord(0.5);
    PLib.RegisterComponent(PComp);
    { Registration can reset the name to the default, so re-apply it. }
    PComp.Name        := 'L0603';
    PComp.Description := '电感值:3.3nH;精度:±5%;额定电流:850mA;直流电阻(DCR):59mΩ;';
    W('OK pcblib component registered');
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.800001);
        Pad.TopYSize := MMsToCoord(0.863999);
        Pad.X        := MMsToCoord(-0.6999);
        Pad.Y        := MMsToCoord(0.0);
        Pad.Name     := '1';
        Pad.HoleSize := MMsToCoord(0.0);
        Pad.Rotation := 180.0;
        SetPadMask(Pad, -100.0, 0.0508);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.800001);
        Pad.TopYSize := MMsToCoord(0.863999);
        Pad.X        := MMsToCoord(0.6999);
        Pad.Y        := MMsToCoord(0.0);
        Pad.Name     := '2';
        Pad.HoleSize := MMsToCoord(0.0);
        Pad.Rotation := 180.0;
        SetPadMask(Pad, -100.0, 0.0508);
        PComp.AddPCBObject(Pad);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(-1.27);
        Trk.Y1    := MMsToCoord(-0.651401);
        Trk.X2    := MMsToCoord(-1.424099);
        Trk.Y2    := MMsToCoord(-0.499001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(-1.424099);
        Trk.Y1    := MMsToCoord(-0.499001);
        Trk.X2    := MMsToCoord(-1.424099);
        Trk.Y2    := MMsToCoord(0.517401);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(-1.424099);
        Trk.Y1    := MMsToCoord(0.517401);
        Trk.X2    := MMsToCoord(-1.27);
        Trk.Y2    := MMsToCoord(0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(1.27);
        Trk.Y1    := MMsToCoord(0.650001);
        Trk.X2    := MMsToCoord(1.424201);
        Trk.Y2    := MMsToCoord(0.499001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(1.424201);
        Trk.Y1    := MMsToCoord(0.499001);
        Trk.X2    := MMsToCoord(1.424201);
        Trk.Y2    := MMsToCoord(-0.517401);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.1524);
        Trk.X1    := MMsToCoord(1.424201);
        Trk.Y1    := MMsToCoord(-0.517401);
        Trk.X2    := MMsToCoord(1.27);
        Trk.Y2    := MMsToCoord(-0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(-1.271999);
        Trk.Y1    := MMsToCoord(0.650001);
        Trk.X2    := MMsToCoord(-0.509999);
        Trk.Y2    := MMsToCoord(0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(1.272101);
        Trk.Y1    := MMsToCoord(-0.650001);
        Trk.X2    := MMsToCoord(0.510101);
        Trk.Y2    := MMsToCoord(-0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(-1.271999);
        Trk.Y1    := MMsToCoord(-0.650001);
        Trk.X2    := MMsToCoord(-0.509999);
        Trk.Y2    := MMsToCoord(-0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.152001);
        Trk.X1    := MMsToCoord(1.272101);
        Trk.Y1    := MMsToCoord(0.650001);
        Trk.X2    := MMsToCoord(0.510101);
        Trk.Y2    := MMsToCoord(0.650001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(0.8);
        Trk.Y1    := MMsToCoord(-0.3999);
        Trk.X2    := MMsToCoord(-0.8);
        Trk.Y2    := MMsToCoord(-0.3999);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(-0.8);
        Trk.Y1    := MMsToCoord(-0.3999);
        Trk.X2    := MMsToCoord(-0.8);
        Trk.Y2    := MMsToCoord(0.4001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(-0.8);
        Trk.Y1    := MMsToCoord(0.4001);
        Trk.X2    := MMsToCoord(0.8);
        Trk.Y2    := MMsToCoord(0.4001);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eMechanical6;
        Trk.Width := MMsToCoord(0.0508);
        Trk.X1    := MMsToCoord(0.8);
        Trk.Y1    := MMsToCoord(0.4001);
        Trk.X2    := MMsToCoord(0.8);
        Trk.Y2    := MMsToCoord(-0.3999);
        PComp.AddPCBObject(Trk);
        AddFootprintRegions(PComp);
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
    If True Then
    Begin
        SaveFocusedDocument;
        Doc.Modified := False;
        W('OK pcblib merged L0603 into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('E:\GroundRes\Hardware\ADpro\MagSensor_DEMO\MagSensor\PcbLib1.PcbLib', 'PCBLIB') = False Then
        Begin W('ERR pcblib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        Doc.Modified := False;
        W('OK pcblib created the target library with L0603');
    End;
    Artifacts := Artifacts + 1;
End;

Procedure RunJob;
Begin
    Artifacts := 0;
    SchComps  := 0;
    PcbComps  := 0;
    LogPath   := 'E:\EDA2Altium-exe\jobs\C14709-schlib\job.log';
    LogTxt    := TStringList.Create;
    StepSchLib;

    W('COUNT schlib comps=' + IntToStr(SchComps) + ' pins=2 libref=BLM18PG121SN1D src=self-recorded+file-scan');
    W('COUNT pcblib comps=' + IntToStr(PcbComps) + ' before=' + IntToStr(PcbBefore) + ' pads=2 regions=5 skippedregions=0 name=L0603 src=model+file-check');
    W('DONE artifacts=' + IntToStr(Artifacts));
    LogTxt.Free;
End;