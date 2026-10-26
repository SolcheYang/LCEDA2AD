{ ---------------------------------------------------------------------------
  Altium job for C19272232 (BQ25756RRVR)

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

{ Add a schematic parameter. PValue is a WideString so the EasyEDA description /
  Value (??, Chinese, ?¡À) survives; IsHidden=False makes it visible. }
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

Procedure BuildSymbol(Target : ISch_Component);
Begin
    W('BS libref');
    Target.LibReference         := 'BQ25756RRVR';
    W('BS designitemid');
    Target.DesignItemID         := 'BQ25756RRVR';
    W('BS description');
    Target.ComponentDescription := '';
    W('BS designator');
    Target.Designator.Text      := 'U??';
    W('BS commenttext');
    Target.Comment.Text         := 'BQ25756RRVR';
    W('BS commenthidden');
    Target.Comment.IsHidden     := True;
    AddRect(Target, -600, -950, 600, 950);
    AddEllipse(Target, -550, 900, 15, 15);
    AddPin(Target, '1', 'SCL', -600, 850, 150, 180, 'unspecified');
    AddPin(Target, '2', 'SDA', -600, 750, 150, 180, 'unspecified');
    AddPin(Target, '3', 'INT#', -600, 650, 150, 180, 'unspecified');
    AddPin(Target, '4', 'STAT1', -600, 550, 150, 180, 'unspecified');
    AddPin(Target, '5', 'STAT2', -600, 450, 150, 180, 'unspecified');
    AddPin(Target, '6', 'PG#', -600, 350, 150, 180, 'unspecified');
    AddPin(Target, '7', 'CE#', -600, 250, 150, 180, 'unspecified');
    AddPin(Target, '8', 'TS', -600, 150, 150, 180, 'unspecified');
    AddPin(Target, '9', 'ICHG', -600, 50, 150, 180, 'unspecified');
    AddPin(Target, '10', 'ILIM_HIZ', -600, -50, 150, 180, 'unspecified');
    AddPin(Target, '11', 'FBG', -600, -150, 150, 180, 'unspecified');
    AddPin(Target, '12', 'FB', -600, -250, 150, 180, 'unspecified');
    AddPin(Target, '13', 'SRN', -600, -350, 150, 180, 'unspecified');
    AddPin(Target, '14', 'SRP', -600, -450, 150, 180, 'unspecified');
    AddPin(Target, '15', 'NC', -600, -550, 150, 180, 'unspecified');
    AddPin(Target, '16', 'NC', -600, -650, 150, 180, 'unspecified');
    AddPin(Target, '17', 'PGND', -600, -750, 150, 180, 'unspecified');
    AddPin(Target, '18', 'SW2', -600, -850, 150, 180, 'unspecified');
    AddPin(Target, '19', 'HIDRV2', 600, -850, 150, 0, 'unspecified');
    AddPin(Target, '20', 'BTST2', 600, -750, 150, 0, 'unspecified');
    AddPin(Target, '21', 'LODRV2', 600, -650, 150, 0, 'unspecified');
    AddPin(Target, '22', 'PGND', 600, -550, 150, 0, 'unspecified');
    AddPin(Target, '23', 'DRV_SUP', 600, -450, 150, 0, 'unspecified');
    AddPin(Target, '24', 'REGN', 600, -350, 150, 0, 'unspecified');
    AddPin(Target, '25', 'LODRV1', 600, -250, 150, 0, 'unspecified');
    AddPin(Target, '26', 'BTST1', 600, -150, 150, 0, 'unspecified');
    AddPin(Target, '27', 'HIDRV1', 600, -50, 150, 0, 'unspecified');
    AddPin(Target, '28', 'SW1', 600, 50, 150, 0, 'unspecified');
    AddPin(Target, '29', 'ACN', 600, 150, 150, 0, 'unspecified');
    AddPin(Target, '30', 'ACP', 600, 250, 150, 0, 'unspecified');
    AddPin(Target, '31', 'NC', 600, 350, 150, 0, 'unspecified');
    AddPin(Target, '32', 'VAC', 600, 450, 150, 0, 'unspecified');
    AddPin(Target, '33', 'VAC', 600, 550, 150, 0, 'unspecified');
    AddPin(Target, '34', 'ACUV', 600, 650, 150, 0, 'unspecified');
    AddPin(Target, '35', 'ACOV', 600, 750, 150, 0, 'unspecified');
    AddPin(Target, '36', 'FSW_SYNC', 600, 850, 150, 0, 'unspecified');
    AddPin(Target, '37', 'PGND', 0, -950, 150, 270, 'unspecified');
    { Bind the schematic component to its PCB footprint. ModelType=PCBLIB plus the
      package name is the same model link EasyEDA's own Altium export writes
      (RECORD=45 MODELTYPE=PCBLIB MODELNAME=<package>). }
    W('BS impl');
    Impl := Target.AddSchImplementation;
    W('BS impl-created');
    If Assigned(Impl) Then
    Begin
        W('BS impl-modelname');
        Impl.ModelName   := 'TQFN-36_L6.0-W5.0-P0.50-BL-EP-1';
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
        Impl.AddDataFileLink('TQFN-36_L6.0-W5.0-P0.50-BL-EP-1', '', 'PCBLib');
        W('BS impl-datalink-done');
        W('BS impl-datalink-location');
        If Impl.DatafileLinkCount > 0 Then
        Begin
            Impl.DatafileLink[0].Location := 'E:\GroundRes\Hardware\ADpro\GroundRes\Lib\GroundRes.PcbLib';
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
    If Doc.DoSafeChangeFileNameAndSave('E:\EDA2Altium-exe\out\C19272232_SCH.SchLib', 'SCHLIB') = False Then
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
        Doc := Client.OpenDocument('SCHLIB', 'E:\GroundRes\Hardware\ADpro\GroundRes\Lib\GroundRes_Digital.SchLib');
        If Not Assigned(Doc) Then
        Begin W('ERR schlib cannot open the target library'); Exit; End;
        Client.ShowDocument(Doc);
    End
    Else
        CreateNewDocumentFromDocumentKind('SCHLIB');
    Lib := SchServer.GetCurrentSchDocument;
    If Not Assigned(Lib) Then
    Begin W('ERR schlib no current library'); Exit; End;
    If True Then
    Begin
        SchComps := 1;
        Artifacts := Artifacts + 1;
        W('OK schlib BQ25756RRVR already present in the target library (idempotent skip)');
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
        W('OK schlib merged BQ25756RRVR into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('E:\GroundRes\Hardware\ADpro\GroundRes\Lib\GroundRes_Digital.SchLib', 'SCHLIB') = False Then
        Begin W('ERR schlib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        Doc.Modified := False;
        W('OK schlib created the target library with BQ25756RRVR');
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
    PComp.Name        := 'TQFN-36_L6.0-W5.0-P0.50-BL-EP-1';
    PComp.Description := '';
    PComp.Height      := MMsToCoord(0.5);
    PLib.RegisterComponent(PComp);
    W('OK pcblib_part created and registered the library component');
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(3.500001);
        Pad.TopYSize := MMsToCoord(4.500001);
        Pad.X        := MMsToCoord(0.0);
        Pad.Y        := MMsToCoord(-0.000099);
        Pad.Name     := '37';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-1.7502);
        Pad.Name     := '36';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-1.250099);
        Pad.Name     := '35';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-0.750199);
        Pad.Name     := '34';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-0.250101);
        Pad.Name     := '33';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(0.249799);
        Pad.Name     := '32';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(0.749899);
        Pad.Name     := '31';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(1.249799);
        Pad.Name     := '30';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(1.7499);
        Pad.Name     := '29';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.249899);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '28';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.750101);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '27';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.249901);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '26';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.7501);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '25';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.2499);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '24';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.2499);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '23';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.7501);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '22';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.249901);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '21';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.749801);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '20';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.249899);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '19';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(1.7499);
        Pad.Name     := '18';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(1.249799);
        Pad.Name     := '17';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(0.749899);
        Pad.Name     := '16';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(0.249799);
        Pad.Name     := '15';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-0.250101);
        Pad.Name     := '14';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-0.750199);
        Pad.Name     := '13';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-1.250099);
        Pad.Name     := '12';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-1.7502);
        Pad.Name     := '11';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.249899);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '10';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.750101);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '9';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.249901);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '8';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.7501);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '7';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.2499);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '6';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.2499);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '5';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.7501);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '4';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.249901);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '3';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.750101);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '2';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.249899);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '1';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(2.499901);
        Trk.X2    := MMsToCoord(-2.631201);
        Trk.Y2    := MMsToCoord(2.499901);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.631001);
        Trk.Y1    := MMsToCoord(2.499901);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(2.499901);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(-2.500099);
        Trk.X2    := MMsToCoord(-2.631201);
        Trk.Y2    := MMsToCoord(-2.500099);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.6311);
        Trk.Y1    := MMsToCoord(-2.500099);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(-2.500099);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(2.499901);
        Trk.X2    := MMsToCoord(-3.000101);
        Trk.Y2    := MMsToCoord(2.131101);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(-2.1312);
        Trk.X2    := MMsToCoord(-3.000101);
        Trk.Y2    := MMsToCoord(-2.500099);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.9999);
        Trk.Y1    := MMsToCoord(-2.500099);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(-2.1312);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.9999);
        Trk.Y1    := MMsToCoord(2.131101);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(2.499901);
        PComp.AddPCBObject(Trk);
        Arc := PCBServer.PCBObjectFactory(eArcObject, eNoDimension, eCreate_Default);
        Arc.Layer      := eTopOverlay;
        Arc.LineWidth  := MMsToCoord(0.299999);
        Arc.XCenter    := MMsToCoord(-2.999999);
        Arc.YCenter    := MMsToCoord(-3.000101);
        Arc.Radius     := MMsToCoord(0.150099);
        Arc.StartAngle := 0.0;
        Arc.EndAngle   := 360.0;
        PComp.AddPCBObject(Arc);
    W('OK pcblib_part primitives added');
    PartPcbComps := PLib.ComponentCount;
    Doc := Client.CurrentView.OwnerDocument;
    If Not Assigned(Doc) Then
    Begin W('ERR pcblib_part no focused document'); Exit; End;
    Doc.Modified := True;
    If Doc.DoSafeChangeFileNameAndSave('E:\EDA2Altium-exe\out\C19272232_PCB.PcbLib', 'PCBLIB') = False Then
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
        Doc := Client.OpenDocument('PCBLIB', 'E:\GroundRes\Hardware\ADpro\GroundRes\Lib\GroundRes.PcbLib');
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
        OldComp := PLib.GetComponentByName('TQFN-36_L6.0-W5.0-P0.50-BL-EP-1');
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
        W('OK pcblib TQFN-36_L6.0-W5.0-P0.50-BL-EP-1 already present in the target library (idempotent skip)');
        Exit;
    End;
    { Create a real component. The built-in PCBComponent_1 is only a blank
      placeholder and does not persist AddPCBObject primitives on save. }
    PComp := PCBServer.CreatePCBLibComp;
    If Not Assigned(PComp) Then
    Begin W('ERR pcblib CreatePCBLibComp returned nil'); Exit; End;
    PComp.Name        := 'TQFN-36_L6.0-W5.0-P0.50-BL-EP-1';
    PComp.Description := '';
    PComp.Height      := MMsToCoord(0.5);
    PLib.RegisterComponent(PComp);
    { Registration can reset the name to the default, so re-apply it. }
    PComp.Name        := 'TQFN-36_L6.0-W5.0-P0.50-BL-EP-1';
    PComp.Description := '';
    W('OK pcblib component registered');
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(3.500001);
        Pad.TopYSize := MMsToCoord(4.500001);
        Pad.X        := MMsToCoord(0.0);
        Pad.Y        := MMsToCoord(-0.000099);
        Pad.Name     := '37';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-1.7502);
        Pad.Name     := '36';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-1.250099);
        Pad.Name     := '35';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-0.750199);
        Pad.Name     := '34';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(-0.250101);
        Pad.Name     := '33';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(0.249799);
        Pad.Name     := '32';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(0.749899);
        Pad.Name     := '31';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(1.249799);
        Pad.Name     := '30';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.999999);
        Pad.Y        := MMsToCoord(1.7499);
        Pad.Name     := '29';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.249899);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '28';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.750101);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '27';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.249901);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '26';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.7501);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '25';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.2499);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '24';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.2499);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '23';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.7501);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '22';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.249901);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '21';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.749801);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '20';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.249899);
        Pad.Y        := MMsToCoord(2.5);
        Pad.Name     := '19';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(1.7499);
        Pad.Name     := '18';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(1.249799);
        Pad.Name     := '17';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(0.749899);
        Pad.Name     := '16';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(0.249799);
        Pad.Name     := '15';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-0.250101);
        Pad.Name     := '14';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-0.750199);
        Pad.Name     := '13';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-1.250099);
        Pad.Name     := '12';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.999999);
        Pad.Y        := MMsToCoord(-1.7502);
        Pad.Name     := '11';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(2.249899);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '10';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.750101);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '9';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(1.249901);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '8';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.7501);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '7';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(0.2499);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '6';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.2499);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '5';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-0.7501);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '4';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.249901);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '3';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-1.750101);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '2';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Pad := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
        Pad.Mode     := ePadMode_Simple;
        Pad.Layer    := eTopLayer;
        Pad.TopShape := eRectangular;
        Pad.TopXSize := MMsToCoord(0.299999);
        Pad.TopYSize := MMsToCoord(0.700001);
        Pad.X        := MMsToCoord(-2.249899);
        Pad.Y        := MMsToCoord(-2.5);
        Pad.Name     := '1';
        Pad.HoleSize := MMsToCoord(0.0);
        PComp.AddPCBObject(Pad);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(2.499901);
        Trk.X2    := MMsToCoord(-2.631201);
        Trk.Y2    := MMsToCoord(2.499901);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.631001);
        Trk.Y1    := MMsToCoord(2.499901);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(2.499901);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(-2.500099);
        Trk.X2    := MMsToCoord(-2.631201);
        Trk.Y2    := MMsToCoord(-2.500099);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.6311);
        Trk.Y1    := MMsToCoord(-2.500099);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(-2.500099);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(2.499901);
        Trk.X2    := MMsToCoord(-3.000101);
        Trk.Y2    := MMsToCoord(2.131101);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(-3.000101);
        Trk.Y1    := MMsToCoord(-2.1312);
        Trk.X2    := MMsToCoord(-3.000101);
        Trk.Y2    := MMsToCoord(-2.500099);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.9999);
        Trk.Y1    := MMsToCoord(-2.500099);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(-2.1312);
        PComp.AddPCBObject(Trk);
        Trk := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
        Trk.Layer := eTopOverlay;
        Trk.Width := MMsToCoord(0.254);
        Trk.X1    := MMsToCoord(2.9999);
        Trk.Y1    := MMsToCoord(2.131101);
        Trk.X2    := MMsToCoord(2.9999);
        Trk.Y2    := MMsToCoord(2.499901);
        PComp.AddPCBObject(Trk);
        Arc := PCBServer.PCBObjectFactory(eArcObject, eNoDimension, eCreate_Default);
        Arc.Layer      := eTopOverlay;
        Arc.LineWidth  := MMsToCoord(0.299999);
        Arc.XCenter    := MMsToCoord(-2.999999);
        Arc.YCenter    := MMsToCoord(-3.000101);
        Arc.Radius     := MMsToCoord(0.150099);
        Arc.StartAngle := 0.0;
        Arc.EndAngle   := 360.0;
        PComp.AddPCBObject(Arc);
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
        W('OK pcblib merged TQFN-36_L6.0-W5.0-P0.50-BL-EP-1 into the existing target library');
    End
    Else
    Begin
        If Doc.DoSafeChangeFileNameAndSave('E:\GroundRes\Hardware\ADpro\GroundRes\Lib\GroundRes.PcbLib', 'PCBLIB') = False Then
        Begin W('ERR pcblib DoSafeChangeFileNameAndSave returned false'); Exit; End;
        Doc.Modified := False;
        W('OK pcblib created the target library with TQFN-36_L6.0-W5.0-P0.50-BL-EP-1');
    End;
    Artifacts := Artifacts + 1;
End;

Procedure RunJob;
Begin
    Artifacts := 0;
    SchComps  := 0;
    PcbComps  := 0;
    LogPath   := 'E:\EDA2Altium-exe\jobs\C19272232-pcblib\job.log';
    LogTxt    := TStringList.Create;
    StepPcbLib;

    W('COUNT schlib comps=' + IntToStr(SchComps) + ' pins=37 libref=BQ25756RRVR src=self-recorded+file-scan');
    W('COUNT pcblib comps=' + IntToStr(PcbComps) + ' before=' + IntToStr(PcbBefore) + ' pads=37 name=TQFN-36_L6.0-W5.0-P0.50-BL-EP-1 src=model+file-check');
    W('DONE artifacts=' + IntToStr(Artifacts));
    LogTxt.Free;
End;