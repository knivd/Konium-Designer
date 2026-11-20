"""Emit src/app/menus/ad17.gen.ts from the AD17 resource trees (see gen.py for filtering)."""
import sys, os, re, json
sys.path.insert(0, os.path.dirname(__file__))
import gen
from gen import pls, trees, root, caption, prune, expand

OUT = sys.argv[3]

# AD17 process launcher → Konium command (implemented ones; the rest become planned 'ad:' commands)
MAP = {
  # File
  'PLWorkspaceManager:NewSchematic': 'file.newSch', 'PLWorkspaceManager:NewPCB': 'file.newPcb', 'PLWorkspaceManager:NewSchematicLib': 'file.newSchLib',
  'PLWorkspaceManager:NewPCBLib': 'file.newPcbLib', 'PLWorkspaceManager:NewProject_Dialog': 'file.newProject',
  'PLWorkspaceManager:OpenAnything': 'file.open', 'PLWorkspaceManager:CloseDocument': 'file.close', 'PLWorkspaceManager:OpenProject': 'file.openProject',
  'PLWorkspaceManager:SaveDocument': 'file.save', 'PLWorkspaceManager:SaveDocumentAs': 'file.saveAs', 'PLWorkspaceManager:SaveDocumentAsCopy': 'file.saveCopyAs',
  'PLWorkspaceManager:SaveAll': 'file.saveAll', 'PLWorkspaceManager:SaveFocusedProject': 'wm.saveProject',
  # Edit
  'PLSch:Undo': 'edit.undo', 'PLSch:Redo': 'edit.redo', 'PLPCB:Undo': 'edit.undo', 'PLPCB:Redo': 'edit.redo',
  'PLSch:Cut': 'edit.cut', 'PLSch:Copy': 'edit.copy', 'PLSch:Paste': 'edit.paste', 'PLPCB:Cut': 'edit.cut', 'PLPCB:Copy': 'edit.copy', 'PLPCB:Paste': 'edit.paste',
  'PLSch:Clear': 'edit.delete', 'PLPCB:Clear': 'edit.delete', 'PLPCB:DeleteObjects': 'edit.deleteTool', 'PLSch:DeleteObjects': 'edit.deleteTool',
  'PLSch:RubberStamp': 'edit.rubberStamp', 'PLPCB:RubberStamp': 'edit.rubberStamp', 'PLSCH:RubberStamp': 'edit.rubberStamp', 'PLPCB:Rubberstamp': 'edit.rubberStamp',
  'PLSch:SelectObjectsInsideArea': 'select.insideArea', 'PLSch:SelectObjectsOutsideArea': 'select.outsideArea',
  'PLSch:SelectObjectsTouchingArea': 'select.touchingRect', 'PLSch:SelectObjectsTouchingLine': 'select.touchingLine',
  'PLSch:SelectAllObjects': 'edit.selectAll', 'PLSch:ToggleSelection': 'select.toggle',
  'PLSch:DeSelectObjectsInsideArea': 'deselect.insideArea', 'PLSch:DeSelectObjectsOutsideArea': 'deselect.outsideArea',
  'PLSch:DeSelectObjectsTouchingArea': 'deselect.touchingRect', 'PLSch:DeSelectObjectsTouchingLine': 'deselect.touchingLine',
  'PLSch:DeSelectAllObjects': 'edit.deselectAll', 'PLSch:DeSelectAllDocuments': 'edit.deselectAllDocs',
  'PLPCB:SelectInsideArea': 'select.insideArea', 'PLPCB:SelectOutsideArea': 'select.outsideArea', 'PLPCB:SelectTouchingRectangle': 'select.touchingRect',
  'PLPCB:SelectTouchingLine': 'select.touchingLine', 'PLPCB:SelectAll': 'edit.selectAll', 'PLPCB:SelectBoard': 'select.board', 'PLPCB:SelectNet': 'select.net',
  'PLPCB:SelectConnectedCopper': 'select.connectedCopper', 'PLPCB:SelectAllOnLayer': 'select.allOnLayer', 'PLPCB:SelectFreeObjects': 'select.freeObjects',
  'PLPCB:SelectAllLocked': 'select.allLocked', 'PLPCB:ToggleSelection': 'select.toggle',
  'PLPCB:DeSelectInsideArea': 'deselect.insideArea', 'PLPCB:DeSelectOutsideArea': 'deselect.outsideArea', 'PLPCB:DeSelectTouchingRectangle': 'deselect.touchingRect',
  'PLPCB:DeSelectTouchingLine': 'deselect.touchingLine', 'PLPCB:DeSelectAll': 'edit.deselectAll', 'PLPCB:DeSelectAllOnLayer': 'deselect.allOnLayer',
  'PLPCB:DeSelectFreeObjects': 'deselect.freeObjects',
  'PLSch:DragObject': 'edit.drag', 'PLSch:MoveObject': 'edit.move', 'PLSch:MoveSelectedObjects': 'edit.moveSelection', 'PLSch:OffsetSelection': 'edit.moveSelectionXY',
  'PLSch:DragSelectedObjects': 'edit.dragSelection', 'PLSch:RotateSelectedObjectsCCW': 'edit.rotateSelection', 'PLSch:RotateSelectedObjectsCW': 'edit.rotateSelectionCw',
  'PLPCB:MoveObject': 'edit.move', 'PLPCB:MoveDrag': 'edit.drag', 'PLPCB:MoveComponent': 'pcb.moveComponent', 'PLPCB:MoveSelection': 'edit.moveSelection',
  'PLPCB:OffsetSelection': 'edit.moveSelectionXY', 'PLPCB:RotateSelectedObjects': 'pcb.rotateSelectionBy',
  'PLSch:JumpOrigin': 'jump.origin', 'PLSch:JumpNewLocation': 'jump.location', 'PLSch:JumpComponent': 'jump.component',
  'PLPCB:JumpAbsoluteOrigin': 'jump.origin', 'PLPCB:JumpNewLocation': 'jump.location', 'PLPCB:JumpComponent': 'jump.component', 'PLPCB:JumpSelection': 'view.fitSelection',
  'PLPCB:JumpErrorMarker': 'jump.errorMarker',
  'PLSch:FindSimilarObjects': 'edit.findSimilar', 'PLPCB:FindSimilarObjects': 'edit.findSimilar', 'PLSch:FindSimilarObjectsUnderCursor': 'edit.findSimilar',
  'PLSch:AlignObjectsLeft': 'align.left', 'PLSch:AlignObjectsRight': 'align.right', 'PLSch:AlignObjectsTop': 'align.top', 'PLSch:AlignObjectsBottom': 'align.bottom',
  'PLSch:AlignObjectsCenterHorizontal': 'align.hCentre', 'PLSch:AlignObjectsCenterVertical': 'align.vCentre',
  'PLSch:AlignObjectsSpaceEquallyHorizontal': 'align.distributeH', 'PLSch:AlignObjectsSpaceEquallyVertical': 'align.distributeV', 'PLSch:AlignObjectsToGrid': 'align.toGrid',
  'PLPCB:AlignComponentsLeft': 'align.left', 'PLPCB:AlignComponentsRight': 'align.right', 'PLPCB:AlignComponentsTop': 'align.top', 'PLPCB:AlignComponentsBottom': 'align.bottom',
  'PLPCB:AlignComponentsCenterHorizontal': 'align.hCentre', 'PLPCB:AlignComponentsCenterVertical': 'align.vCentre',
  'PLPCB:AlignComponentsSpreadHorizontal': 'align.distributeH', 'PLPCB:AlignComponentsSpreadVertical': 'align.distributeV', 'PLPCB:MoveComponentsToGrid': 'align.toGrid',
  'PLSch:SelectedObjectsLeft': 'edit.nudgeLeft', 'PLSch:SelectedObjectsRight': 'edit.nudgeRight', 'PLSch:SelectedObjectsUp': 'edit.nudgeUp', 'PLSch:SelectedObjectsDown': 'edit.nudgeDown',
  'PLSch:ShiftSelectedObjectsLeft': 'edit.nudgeLeft10', 'PLSch:ShiftSelectedObjectsRight': 'edit.nudgeRight10', 'PLSch:ShiftSelectedObjectsUp': 'edit.nudgeUp10', 'PLSch:ShiftSelectedObjectsDown': 'edit.nudgeDown10',
  'PLPCB:MoveSelectionLeft': 'edit.nudgeLeft', 'PLPCB:MoveSelectionRight': 'edit.nudgeRight', 'PLPCB:MoveSelectionUp': 'edit.nudgeUp', 'PLPCB:MoveSelectionDown': 'edit.nudgeDown',
  'PLPCB:MoveSelectionLeft10': 'edit.nudgeLeft10', 'PLPCB:MoveSelectionRight10': 'edit.nudgeRight10', 'PLPCB:MoveSelectionUp10': 'edit.nudgeUp10', 'PLPCB:MoveSelectionDown10': 'edit.nudgeDown10',
  'PLSch:PlaceWireWithContext': 'place.wire', 'PLSch:PlaceBusWithContext': 'place.bus', 'PLSch:PlacePartSchPlacePart': 'place.part',
  'PLSch:ChangeSingleObjectWithContext': 'ctx.properties', 'PLPCB:PopupRightMouseProperties': 'ctx.properties',
  'PLPCB:FindSimilarObjectsUnderCursor': 'edit.findSimilar', 'PLPCB:RepourPolygon': 'tools.repourSelected', 'PLPCB:RepourAllPolygons': 'tools.repour',
  'PLPCB:ShelveSelectedPolygons': 'tools.shelveSelected', 'PLPCB:ShelveAllPolygons': 'tools.shelve', 'PLPCB:MoveSinglePolygon': 'pcb.movePolygon',
  'PLPCB:PolygonEditShape': 'pcb.polygonVertices', 'PLPCB:MoveSingleComponent': 'pcb.moveThisComponent',
  'PLPCB:PopupRightMouseViewArea': 'view.area', 'PLPCB:PopupRightMouseZoomIn': 'view.zoomIn', 'PLPCB:PopupRightMouseZoomOut': 'view.zoomOut',
  'PLPCB:PopupRightMouseFitSelected': 'view.fitSelection', 'PLPCB:ToggleComponentDesignator': 'pcb.toggleDesignator', 'PLPCB:ToggleComponentComment': 'pcb.toggleComment',
  'PLPCB:PopupShowConnectionsOnSingleComponent': 'ad:PCB:PopupShowConnectionsOnSingleComponent',
  'PLSCH:SchObjectInspector': 'view.panel.properties', 'PLPCB:PCBObjectInspector': 'view.panel.properties',
  'PLSch:MoveSelectionLeftSmall': 'edit.nudgeLeft', 'PLSch:MoveSelectionRightSmall': 'edit.nudgeRight', 'PLSch:MoveSelectionUpSmall': 'edit.nudgeUp', 'PLSch:MoveSelectionDownSmall': 'edit.nudgeDown',
  'PLSch:MoveSelectionLeftLarge': 'edit.nudgeLeft10', 'PLSch:MoveSelectionRightLarge': 'edit.nudgeRight10', 'PLSch:MoveSelectionUpLarge': 'edit.nudgeUp10', 'PLSch:MoveSelectionDownLarge': 'edit.nudgeDown10',
  # View
  'PLSch:ZoomDocument': 'view.fit', 'PLSch:ZoomAll': 'view.fitObjects', 'PLSch:ZoomSelected': 'view.fitSelection', 'PLSch:ZoomWindow': 'view.area',
  'PLSch:ZoomIn': 'view.zoomIn', 'PLSch:ZoomOut': 'view.zoomOut', 'PLSch:ZoomPan': 'view.centre', 'PLSch:ZoomRedraw': 'view.redraw', 'PLSch:Fullscreen': 'view.fullScreen',
  'PLSch:ToggleSnapGrid': 'view.grid', 'PLSch:ToggleSnapGridReverse': 'view.gridReverse', 'PLSch:ToggleUnit': 'view.units', 'PLSch:ToggleVisibleGrid': 'view.visibleGrid',
  'PLPCB:ViewFitDocument': 'view.fitObjects', 'PLPCB:LibViewFitAllObjects': 'view.fitObjects', 'PLPCB:LibViewFitDocument': 'view.fit', 'PLPCB:ViewFitBoard': 'view.fitBoard', 'PLPCB:ViewFitSheet': 'view.fit',
  'PLPCB:ViewArea': 'view.area', 'PLPCB:ViewSelectedObjects': 'view.fitSelection', 'PLPCB:ViewZoomIn': 'view.zoomIn', 'PLPCB:ViewZoomOut': 'view.zoomOut', 'PLPCB:LibViewZoomOut': 'view.zoomOut',
  'PLPCB:ViewPan': 'view.centre', 'PLPCB:PopupZoomPan': 'view.centre', 'PLPCB:ViewRefresh': 'view.redraw', 'PLPCB:FlipBoard': 'view.flip', 'PLPCB:Fullscreen': 'view.fullScreen',
  'PLPCB:ToggleUnits': 'view.units', 'PLPCB:ShowAllNets': 'pcb.showAllConnections', 'PLPCB:HideAllNets': 'pcb.hideAllConnections',
  'PLPCB:ZoomIn': 'view.zoomIn', 'PLPCB:ZoomOut': 'view.zoomOut', 'PLPCB:ZoomAll': 'view.fitObjects', 'PLPCB:ZoomRedraw': 'view.redraw',
  'PLPCB:NextSignalLayer': 'pcb.nextSignal', 'PLPCB:PreviousSignalLayer': 'pcb.prevSignal', 'PLPCB:NextLayer': 'pcb.layerUp', 'PLPCB:PreviousLayer': 'pcb.layerDown',
  'PLPCB:ToggleSingleLayerMode': 'pcb.singleLayer', 'PLPCB:ToggleRoutingMode': 'route.cycleMode', 'PLPCB:ClearFilter': 'pcb.clearHighlight', 'PLSCH:ClearFilter': 'pcb.clearHighlight',
  'PLPCB:NextComponent': 'plib.next', 'PLPCB:PreviousComponent': 'plib.prev', 'PLPCB:FirstComponent': 'plib.first', 'PLPCB:LastComponent': 'plib.last',
  'PLPCB:BoardLayers': 'pcb.viewConfigurations', 'PLPCB:BoardLayersLib': 'pcb.viewConfigurations', 'PLPCB:ShowHide': 'pcb.viewOptions', 'PLPCB:LayerStackManager': 'pcb.layerStackManager',
  'PLClient:ToggleClientStatusBar': 'view.statusBar', 'PLClient:CustomizeResources': 'dxp.customize', 'PLClient:SetupPreferences': 'tools.preferences',
  'PLClient:HelpShortcutKeys': 'help.shortcuts', 'PLClient:HelpAbout': 'help.about', 'PLClient:ToggleFloatingPanels': 'view.togglePanels', 'PLClient:ShowFloatingPanels': 'view.togglePanels',
  'PLClient:NextTab': 'window.next', 'PLClient:PreviousTab': 'window.prev', 'PLClient:NavigateHome': 'view.home', 'PLClient:NavigateHomePCB': 'view.home',
  'PLWorkspaceManager:CloseAllDocumentsInWorkspace': 'window.closeAll', 'PLWorkspaceManager:CloseWorkspace': 'window.closeAll',
  # Project
  'PLWorkspaceManager:CompileProject': 'tools.erc', 'PLWorkspaceManager:BuildProject': 'tools.recompile', 'PLWorkspaceManager:CompileFocusedProject': 'wm.compileProject',
  'PLWorkspaceManager:BuildFocusedProject': 'wm.recompileProject', 'PLWorkspaceManager:CloseProject': 'project.close',
  # Projects panel (the focused project, document or folder) and Messages panel
  **{f'PLWorkspaceManager:{a}': b for a, b in [
    ('OpenAllDocumentsInFocusedProject', 'wm.openProjectDocs'), ('HideAllDocumentsInFocusedProject', 'wm.hideProjectDocs'),
    ('CloseAllDocumentsInFocusedProject', 'wm.closeProjectDocs'), ('CloseFocusedProject', 'wm.closeProject'),
    ('OpenFocusedDocument', 'wm.openDoc'), ('HideFocusedDocument', 'wm.hideDoc'), ('CloseFocusedDocument', 'wm.closeDoc'),
    ('SaveFocusedDocument', 'wm.saveDoc'), ('SaveFocusedDocumentAs', 'wm.saveDocAs'),
    ('OpenFocusedCategory', 'wm.openCategory'), ('HideFocusedCategory', 'wm.hideCategory'), ('CloseFocusedCategory', 'wm.closeCategory'),
    ('SaveFocusedCategory', 'wm.saveCategory'), ('CompileAll', 'wm.compileAll'), ('BuildAll', 'wm.recompileAll'),
    ('OpenAllDocumentsInWorkspace', 'wm.openAll'), ('InsertExistingProject', 'file.openProject'), ('SetupPreferences', 'tools.preferences'),
    ('Messages_CrossProbe', 'msg.crossProbe'), ('Messages_CrossProbeNext', 'msg.next'), ('Messages_CrossProbePrevious', 'msg.prev'),
    ('CrossProbeNextMessage', 'msg.next'), ('CrossProbePreviousMessage', 'msg.prev'),
    ('Messages_ClearAll', 'msg.clearAll'), ('Messages_ClearSelected', 'msg.clearSelected'), ('Messages_ClearCategory', 'msg.clearClass'),
    ('Messages_SaveAll', 'msg.save'), ('Messages_SaveSelected', 'msg.saveSelected'), ('Messages_CopyToClipboard', 'msg.copy'),
  ]},
  # Place
  'PLSch:PlaceBus': 'place.bus', 'PLSch:PlaceWire': 'place.wire', 'PLSch:PlaceNetLabel': 'place.netLabel', 'PLSch:PlacePort': 'place.port', 'PLSch:PlacePowerPort': 'place.power',
  'PLSch:PlacePart': 'place.part', 'PLSch:PlaceJunction': 'place.junction', 'PLSch:PlaceNoERCGeneric': 'place.noErc', 'PLSch:PlaceAnnotation': 'place.text',
  'PLSch:PlaceTextFrame': 'place.textFrame', 'PLSch:PlaceGNDPowerPort': 'place.gnd', 'PLSch:PlaceVCCPowerPort': 'place.vcc',
  'PLManRoute:PlaceLine': 'place.track', 'PLManRoute:Track': 'route.interactive', 'PLManRoute:AdvancedRouting': 'route.interactive', 'PLPCB:PlacePad': 'place.pad',
  'PLPCB:PlaceVia': 'place.via', 'PLPCB:PlaceFill': 'place.fill', 'PLPCB:PlaceArcEdge': 'place.arc', 'PLPCB:PlaceComponent': 'place.component',
  'PLPCB:PlacePolygonPlane': 'place.polygon', 'PLManRoute:AdvancedDiffPairRoute': 'route.diffPair', 'PLPCB:InteractiveLengthTuningSmartUnion': 'route.length',
  # Design
  'PLSch:CompareAndUpdateOther1': 'design.updatePcb', 'PLPCB:CompareAndUpdateOther': 'design.updateSch', 'PLPCB:CompareAndUpdateMe': 'design.importChanges',
  'PLPCB:DesignRules': 'design.rules', 'PLMakeLib:MakeLibrary': 'design.makePcbLib',
  # Tools
  'PLWorkspaceManager:ConfigureAnnotate': 'tools.annotate', 'PLWorkspaceManager:ConfigureAnnotateReset': 'tools.resetDesignators',
  'PLWorkspaceManager:ConfigureAnnotateResetDup': 'tools.resetDuplicates', 'PLWorkspaceManager:ConfigureAnnotateQuiet': 'tools.annotateQuietly',
  'PLWorkspaceManager:ConfigureAnnotateAll': 'tools.forceAnnotate',
  'PLSch:RubberStampLib': 'edit.rubberStamp', 'PLPCB:LibMoveDrag': 'edit.drag', 'PLPCB:LibMoveSelection': 'edit.moveSelection',
  'PLPCB:JumpComponentReference': 'jump.origin', 'PLPCB:ViewZoomLast': 'view.zoomLast', 'PLSch:ZoomLast': 'view.zoomLast',
  'PLPCB:ViewAroundPoint': 'view.aroundPoint', 'PLSch:ZoomPoint': 'view.aroundPoint',
  'PLWorkspaceManager:SimpleBomForDocument': 'reports.simpleBom', 'PLPCB:ReportNetlistStatus': 'reports.netlistStatus',
  'PLPCB:SelectOffGridPads': 'select.offGridPads', 'PLPCB:SetOrigin': 'pcb.setOrigin', 'PLPCB:ResetOrigin': 'pcb.resetOrigin', 'PLPCB:JumpCurrentOrigin': 'jump.currentOrigin',
  'PLSch:Zoom050': 'view.zoom50', 'PLSch:Zoom100': 'view.zoom100', 'PLSch:Zoom200': 'view.zoom200', 'PLSch:Zoom400': 'view.zoom400',
  'PLSCH:CrossProbe': 'tools.crossProbe', 'PLPCB:CrossProbe': 'tools.crossProbe', 'PLPCB:IncreaseMaskLevel': 'ad:PCB:IncreaseMaskLevel',
  'PLPCB:RunGridPropertiesEditor': 'ad:PCB:RunGridPropertiesEditor',
  'PLSch:SetupPreferences': 'tools.preferences', 'PLPCB:SetupPreferences': 'tools.preferences',
  'PLPCB:DesignRuleCheck': 'tools.drc', 'PLPCB:ResetErrorMarkers': 'tools.resetMarkers',
  'PLPCB:RunPolygonManager': 'tools.polygonManager', 'PLPCB:ShelvePolygons': 'tools.shelve', 'PLPCB:RestorePolygons': 'tools.restore',
  'PLPCB:RepourPolygonsNoContext': 'tools.repourSelected', 'PLPCB:RepourAllPolygonsNoContext': 'tools.repour',
  'PLPCB:RepourPolygonsWithContext': 'tools.repourSelected', 'PLPCB:RepourAllPolygonsWithContext': 'tools.repour', 'PLPCB:ShelveSelectedPolygonsWithContext': 'tools.shelve',
  'PLPCB:MovePolygonVerticesWithContext': 'pcb.polygonVertices', 'PLPCB:EditPolygonShapeWithContext': 'pcb.polygonVertices',
  'PLPCB:CreateComponent': 'tools.newFootprint', 'PLPCB:RemoveComponent': 'tools.removeFootprint', 'PLPCB:RenameComponent': 'tools.footprintProperties',
  # Toolbar-only launchers
  'PLSch:PlacePowerPort_GNDPowerPort': 'place.gnd', 'PLSch:PlacePowerPort_VCCPowerPort': 'place.vcc', 'PLSch:PlacePartBrowseLibrary': 'place.part',
  'PLPCB:BrowseComponents': 'place.component', 'PLSch:ClearFilter': 'pcb.clearHighlight', 'PLPCB:Change3DView': 'pcb.viewConfigurations',
  'PLPCB:PlaceString': 'place.text', 'PLManRoute:AdvancedMultiRoute': 'route.multi', 'PLWorkspaceManager:NewAnything': 'file.new',
  # Context-menu variants of commands Konium has
  **{f'PLSch:AlignObjects{a}WithContext': f'align.{b}' for a, b in [('Left', 'left'), ('Right', 'right'), ('Top', 'top'), ('Bottom', 'bottom'), ('CenterHorizontal', 'hCentre'),
     ('CenterVertical', 'vCentre'), ('SpaceEquallyHorizontal', 'distributeH'), ('SpaceEquallyVertical', 'distributeV'), ('ToGrid', 'toGrid')]},
  **{f'PLPCB:PopupAlignComponents{a}': f'align.{b}' for a, b in [('Left', 'left'), ('Right', 'right'), ('Top', 'top'), ('Bottom', 'bottom'), ('CenterHorizontal', 'hCentre'),
     ('CenterVertical', 'vCentre'), ('SpreadHorizontal', 'distributeH'), ('SpreadVertical', 'distributeV')]},
  'PLPCB:PopupMoveComponentsToGrid': 'align.toGrid', 'PLPCB:PopupOptionsPreferences': 'tools.preferences', 'PLPCB:PopupOptionsColors': 'pcb.viewConfigurations',
  'PLPCB:PopupOptionsShowHide': 'pcb.viewOptions',
  **{f'PLSch:SetupPreferences{a}': 'tools.preferences' for a in ['Schematic', 'GraphicalEditing', 'Compiler', 'Autofocus', 'Grids', 'Units', 'BreakWire', 'DefaultPrimitives', 'Navigation']},
  # Reports
  'PLWorkspaceManager:BomForDocument': 'reports.bom', 'PLSch:MeasureDistance': 'reports.measure', 'PLPCB:MeasureDistance': 'reports.measure',
  # Layout modes (1 / 2 / 3), layers and colours (L, Ctrl+L), keyboard cursor, zoom steps
  'PLPCB:ViewSwitchTo2D': 'view.mode2d', 'PLPCB:ViewSwitchTo3D': 'view.mode3d', 'PLPCB:SetPCBViewModeEditOutline': 'view.modePlanning',
  'PLPCB:PopupOptionsLibraryLayers': 'pcb.viewConfigurations',
  'PLPCB:MoveCursorLeft': 'cursor.left', 'PLPCB:MoveCursorRight': 'cursor.right', 'PLPCB:MoveCursorUp': 'cursor.up', 'PLPCB:MoveCursorDown': 'cursor.down',
  'PLPCB:MoveCursorLeft10': 'cursor.left10', 'PLPCB:MoveCursorRight10': 'cursor.right10', 'PLPCB:MoveCursorUp10': 'cursor.up10', 'PLPCB:MoveCursorDown10': 'cursor.down10',
  'PLSch:CursorLeft': 'cursor.left', 'PLSch:CursorRight': 'cursor.right', 'PLSch:CursorUp': 'cursor.up', 'PLSch:CursorDown': 'cursor.down',
  'PLSch:ShiftCursorLeft': 'cursor.left10', 'PLSch:ShiftCursorRight': 'cursor.right10', 'PLSch:ShiftCursorUp': 'cursor.up10', 'PLSch:ShiftCursorDown': 'cursor.down10',
  'PLPCB:SmallZoomIn': 'view.zoomInSmall', 'PLPCB:SmallZoomOut': 'view.zoomOutSmall', 'PLPCB:LargeZoomOut': 'view.zoom400pcb', 'PLPCB:PrevSignalLayer': 'pcb.prevSignal',
  'PLPCB:PopupZoomIn': 'view.zoomIn', 'PLPCB:PopupZoomOut': 'view.zoomOut', 'PLPCB:PopupZoomPan': 'view.centre', 'PLPCB:PopupZoomRedraw': 'view.redraw',
  'PLPCB:PopupZoomCurrent': 'view.redraw', 'PLPCB:PopupZoomAll': 'view.fitObjects', 'PLPCB:PopupZoomBoard': 'view.fitBoard', 'PLPCB:PopupZoomSelected': 'view.fitSelection',
  'PLPCB:PopupZoomLast': 'view.zoomLast', 'PLPCB:PopupZoomWindow': 'view.area', 'PLPCB:PopupZoomPoint': 'view.aroundPoint',
  'PLPCB:PopupRightMouseZoomIn': 'view.zoomIn', 'PLPCB:PopupRightMouseZoomOut': 'view.zoomOut', 'PLPCB:DeleteObjectsFocused': 'edit.delete',
  'PLPCB:JumpComponentReference': 'jump.origin',
  # Schematic library editor
  'PLSch:PlacePin': 'place.pin', 'PLSch:CreateComponent': 'schlib.newComponent', 'PLSch:DeleteComponentFromLibrary': 'schlib.removeComponent',
  'PLSch:ChangeComponentName': 'schlib.renameComponent', 'PLSch:AddComponentPart': 'schlib.newPart', 'PLSch:RemoveComponentPart': 'schlib.removePart',
  'PLSch:NextComponentPart': 'schlib.nextPart', 'PLSch:PreviousComponentPart': 'schlib.prevPart',
  'PLSch:FirstComponentLibraryEditor': 'schlib.first', 'PLSch:NextComponentLibraryEditor': 'schlib.next',
  'PLSch:PreviousComponentLibraryEditor': 'schlib.prev', 'PLSch:LastComponentLibraryEditor': 'schlib.last',
  'PLSch:EditComponentPart': 'schlib.componentProperties', 'PLSCH:RubberStampLib': 'edit.rubberStamp',
  # Workspace panels
  'PLSCH:SchLibObjectInspector': 'view.panel.properties', 'PLSCH:SchExpressionFilter': 'view.panel.filter', 'PLSCH:SchLibExpressionFilter': 'view.panel.filter',
  'PLSCH:SchObjectList': 'view.panel.list', 'PLSCH:SchLibObjectList': 'view.panel.list', 'PLClient:SwitchDocumentAndPanel': 'view.switchPanelFocus',
  # Mixed Sim: new model, netlist and subcircuit files; a netlist's Simulate menu; the Simulation Sources toolbar
  'PLWorkspaceManager:NewMixedSimModel': 'file.newSimModel', 'PLWorkspaceManager:NewMixedSimNetlist': 'file.newSimNetlist', 'PLWorkspaceManager:NewMixedSimCircuit': 'file.newSimSubcircuit',
  'PLADVSIM:RunSimulation': 'sim.run', 'PLADVSIM:RunDialog_AnalysesSetup': 'sim.analysesSetup',
  **{f'PLSIM:PlaceSimulationSources{a}': f'sim.source.{b}' for a, b in [('+5VoltsDC', 'p5'), ('-5VoltsDC', 'n5'), ('+12VoltsDC', 'p12'), ('-12VoltsDC', 'n12'),
     ('1kHzSineWave', 'sin1k'), ('10kHzSineWave', 'sin10k'), ('100kHzSineWave', 'sin100k'), ('1MHzSineWave', 'sin1M'),
     ('1kHzPulse', 'pulse1k'), ('10kHzPulse', 'pulse10k'), ('100kHzPulse', 'pulse100k'), ('1MHzPulse', 'pulse1M')]},
  # SimView (the results): its view and the chart tabs
  'PLSimView:FitWaveforms': 'simview.fit', 'PLSimView:ZoomAll': 'simview.fit', 'PLSimView:ZoomInAtCenter': 'simview.zoomIn', 'PLSimView:OutAtCenter': 'simview.zoomOut',
  'PLSimView:ZoomInAtCursor': 'simview.zoomIn', 'PLSimView:ZoomOutAtCursor': 'simview.zoomOut', 'PLSimView:ZoomRedraw': 'view.redraw', 'PLSimView:Fullscreen': 'view.fullScreen',
  'PLSimView:SetCurrentAnalysisNext': 'simview.nextChart', 'PLSimView:SetCurrentAnalysisPrev': 'simview.prevChart', 'PLSimView:CopyToClipAsText': 'simview.copyText',
  'PLSimView:Copy': 'simview.copyText', 'PLSimView:AbortSimulation': 'sim.abort', 'PLSimView:CopyToClip': 'simview.copyImage',
  'PLSimView:AddWaveToPlot': 'simview.addWave', 'PLSimView:EditWaveform': 'simview.editWave', 'PLSimView:FormatWave': 'simview.waveOptions',
  'PLSimView:AddYAxis': 'simview.addYAxis', 'PLSimView:RemoveYAxis': 'simview.removeYAxis', 'PLSimView:YAxisSettings': 'simview.yAxisSettings', 'PLSimView:PlotSettings': 'simview.plotOptions',
  'PLSimView:SetupDocumentOptions': 'simview.documentOptions', 'PLSimView:ModifyWaveColors': 'simview.brightness',
  'PLSimView:RemoveWave': 'simview.removeWave', 'PLSimView:Clear': 'simview.removeWave', 'PLSimView:CursorA': 'simview.cursorA', 'PLSimView:CursorB': 'simview.cursorB',
  'PLSimView:Cursor_Minimum': 'simview.cursorMin', 'PLSimView:Cursor_Maximum': 'simview.cursorMax', 'PLSimView:Cursor_PeakRight': 'simview.cursorPeakRight',
  'PLSimView:Cursor_PeakLeft': 'simview.cursorPeakLeft', 'PLSimView:Cursor_TroughRight': 'simview.cursorTroughRight', 'PLSimView:Cursor_TroughLeft': 'simview.cursorTroughLeft',
  'PLSimView:NewChart': 'simview.newChart', 'PLSimView:DeleteChart': 'simview.deleteChart', 'PLSimView:DuplicateChart': 'simview.duplicateChart',
  'PLSimView:SourceDataChart': 'simview.sourceData', 'PLSimView:CreateFFTChart': 'simview.fft', 'PLSimView:ChartSettings': 'simview.chartOptions',
  'PLSimView:AddPlot': 'simview.newPlot', 'PLSimView:RemovePlot': 'simview.deletePlot', 'PLSimView:StoreWaveform': 'simview.store', 'PLSimView:RecallWaveform': 'simview.recall',
  'PLSimView:ExportChart': 'simview.exportChart', 'PLSimView:ExportPlot': 'simview.exportPlot', 'PLSimView:ExportWaveform': 'simview.exportWave',
  'PLSimView:ImportWaveforms': 'simview.import', 'PLSimView:TSimDataPanel': 'view.panel.simdata',
  # The CAM editor (CAMtastic)
  'PLWorkspaceManager:NewCAM': 'file.newCam',
  'PLCAMTASTIC:QuickFileImport': 'cam.quickLoad', 'PLCAMTASTIC:FileImport': 'cam.importGerber', 'PLCAMTASTIC:DrillFileImport': 'cam.importDrill',
  'PLCAMTASTIC:GerberWrite': 'cam.exportGerber', 'PLCAMTASTIC:DrillSave': 'cam.exportDrill', 'PLCAMTASTIC:DrillSaveEasy': 'cam.exportDrill',
  'PLCAMTASTIC:EditUndo': 'edit.undo', 'PLCAMTASTIC:EditRedo': 'edit.redo', 'PLCAMTASTIC:EditErase': 'edit.delete', 'PLCAMTASTIC:SelmenuAll': 'edit.selectAll',
  'PLCAMTASTIC:ZoomAll': 'view.fit', 'PLCAMTASTIC:ZoomIn': 'view.zoomIn', 'PLCAMTASTIC:ZoomOut': 'view.zoomOut', 'PLCAMTASTIC:Redraw': 'view.redraw',
  'PLCAMTASTIC:ZoomWindow': 'view.area', 'PLCAMTASTIC:ZoomPrevious': 'view.zoomLast', 'PLCAMTASTIC:Fullscreen': 'view.fullScreen',
  'PLCAMTASTIC:ViewLayersAllOn': 'cam.layersAllOn', 'PLCAMTASTIC:ViewLayersAllOff': 'cam.layersAllOff', 'PLCAMTASTIC:ViewLayersIsolate': 'cam.layersIsolate',
  'PLCAMTASTIC:ViewLayersTurn': 'cam.layerToggle', 'PLCAMTASTIC:TablesLayerSort': 'cam.layersSort',
  'PLCAMTASTIC:CamLayerControl': 'cam.layerTable', 'PLCAMTASTIC:TablesLayerType': 'cam.layerTable', 'PLCAMTASTIC:TablesLayersOrder': 'cam.layerTable', 'PLCAMTASTIC:EditApertures': 'cam.apertures',
  'PLCAMTASTIC:InfoQuery': 'cam.query', 'PLCAMTASTIC:InfoMeasure': 'reports.measure',
  'PLCAMTASTIC:InspectReportsDrill': 'cam.reportDrill', 'PLCAMTASTIC:InspectReportsAperture': 'cam.reportApertures', 'PLCAMTASTIC:InfoStatus': 'cam.reportStatus',
  'PLSimView:ScrollHorizontalLineUp': 'simview.panLeft', 'PLSimView:ScrollHorizontalLineDown': 'simview.panRight',
  'PLSimView:ScrollHorizontalPageup': 'simview.pageLeft', 'PLSimView:ScrollHorizontalPageDown': 'simview.pageRight',
  'PLSimView:ScrollHorizontalTop': 'simview.panStart', 'PLSimView:ScrollHorizontalBottom': 'simview.panEnd',
  # The netlist editor (a text editor): the Edit commands act on its text
  'PLTextEdit:Undo': 'edit.undo', 'PLTextEdit:Redo': 'edit.redo', 'PLTextEdit:Cut': 'edit.cut', 'PLTextEdit:Copy': 'edit.copy', 'PLTextEdit:Paste': 'edit.paste',
  'PLTextEdit:ToggleCommandStatusBar': 'ad:Client:ToggleCommandStatusBar',
  'PLTextEdit:SelectAll': 'edit.selectAll', 'PLTextEdit:Find': 'text.find', 'PLTextEdit:FindNext': 'text.findNext', 'PLTextEdit:GotoLineNumber': 'text.gotoLine',
}

# Dynamic lists AD fills at run time; Konium supplies its own items
DYNAMIC = [
  (r'OpenRecentDocument_', '@recentDocuments'), (r'OpenRecentProject_', '@recentProjects'), (r'ViewToolsMenuToolbar_', '@toolbars'),
  (r'ViewToolsMenuPanelCategory_', '@panels'), (r'ViewWindow_', '@windows'), (r'GenerateFabricationOutput_', '@fabOutputs'),
  (r'GenerateAssemblyOutput_', '@assemblyOutputs'), (r'GenerateReport_', '@reports'), (r'NewContext_', '@newContext'),
  (r'JumpLocationMark_', '@jumpLocationMarks'), (r'SetLocationMark_', '@setLocationMarks'),
  (r'CreateNetListForDocument_', '@netlistDocument'), (r'CreateNetList_', '@netlistProject'),
  (r'MemoryStore_', '@memoryStore'), (r'MemoryRecall_', '@memoryRecall'), (r'MemoryStorePlus_', '@memoryStorePlus'), (r'MemoryRecallPlus_', '@memoryRecallPlus'),
  (r'MemoryApply_', '@memoryApply'), (r'MemoryClear_', '@memoryClear'), (r'SetNetColors_%', '@netColours'), (r'CurrentLayerSets_', '@layerSets'),
  (r'PLPCB:CreateExportList_', '@exports'), (r'PLWorkspaceManager:Simulate_', '@simulators'),
]
# Links to AD's extension manager (adding importers and exporters): out of scope
DROP_LINKS = {'PLPcb:AddExporter', 'PLPCB:AddExporter'}
DROP_DYNAMIC = re.compile(r'(Import|Export|Underlined|Favorite|History|ShowHidden|MoveAcrossFlatPort|HelpLink|ComponentLink|DatasheetLink|MergeActions)', re.I)

# Captions AD replaces at run time ("Report &1" is the output's name)
CAPTION_AT_RUN_TIME = {'PLWorkspaceManager:BomForDocument': 'Bill of &Materials', 'PLWorkspaceManager:SimpleBomForDocument': '&Simple BOM'}
# Captions AD 17.1 shows per editor where the resource file has another (from screen grabs)
SCOPED_CAPTION = {
  ('pcblib', 'PLPCB:RunComponentBodyManager'): 'Manage 3D Bodies for Library...',
  ('pcblib', 'PLPCB:ManageSingleComponentBodies'): 'Manage 3D &Bodies for Current Component...',
  ('pcb', 'PLPCB:RunComponentBodyManager'): 'Manage 3D Bodies for Components on Board...',
}
# Items an AD 17.1 install adds from its own extensions (not in these resource files): after the
# named link, (caption, command id) — they show greyed until Konium has them.
INJECT_AFTER = {
  'MNWorkspaceManager_New20': [('&Draftsman Document', 'file.newDraftsman')],
  'MNPCBLib_Tools15': [('&IPC Compliant Footprint Wizard...', 'ad:IPCFootprintWizard:Run'),
                       ('IPC Compliant Footprints Batch generator...', 'ad:IPCFootprintWizard:BatchGenerator')],
}

# Toolbar tooltips: AD17 shows a button's Description (with its shortcut), by "scope|command"
TIPS = {}
COLLECT_TIPS = False
# Dropdowns with neither caption nor hint, named after their picture
DROP_NAMES = {'ieeeimage.bmp': 'IEEE Symbols', 'drawingtools.bmp': 'Utility Tools', 'snapgrid.bmp': 'Grids'}

SCOPE_OF = {'sch': 'sch', 'pcb': 'pcb', 'pcblib': 'pcblib', 'schlib': 'schlib', 'global': 'global', 'dxp': 'global', 'simview': 'simview', 'simtext': 'simtext', 'cam': 'cam'}
planned = {}      # id → (label, scopes)
shortcuts = {}    # (combo, id) → scopes

KEYMAP = {'PgUp': 'PageUp', 'PgDn': 'PageDown', 'Left': 'ArrowLeft', 'Right': 'ArrowRight', 'Up': 'ArrowUp', 'Down': 'ArrowDown',
  'Ins': 'Insert', 'Del': 'Delete', 'Esc': 'Escape', 'Multiply': '*', 'Plus': '+', 'Minus': '-', 'Add': '+', 'Subtract': '-', 'TAB': 'Tab', 'Bksp': 'Backspace'}
def combo(s):
    s = s.strip()
    if not s or re.search(r'(Click|Hold|Dbl|Wheel)', s, re.I): return None
    parts = [p for p in re.split(r'\+(?=.)', s)]
    mods, key = parts[:-1], parts[-1]
    key = KEYMAP.get(key, key)
    if len(key) == 1 and key.isalpha(): key = key.upper()
    order = [m for m in ('Ctrl', 'Alt', 'Shift') if m in mods]
    printable = len(key) == 1 and not key.isalnum()
    if printable and 'Shift' in order and parts[-1] != 'Multiply': order.remove('Shift')
    return '+'.join(order + [key])

SNAP = re.compile(r'PLPCB:PopupSnapGrid(\d+)(Mil|mm)$')
def cmd_for(plid, scope):
    if plid in MAP: return MAP[plid]
    m = SNAP.match(plid)
    if m:
        v = m.group(1)
        if m.group(2) == 'mm': v = str(int(v) / 1000).rstrip('0').rstrip('.') + 'mm'
        else: v = v + 'mil'
        return 'grid.set:' + v
    m = re.match(r'PL([A-Za-z0-9]+):(.*)', plid)
    cid = 'ad:' + (m.group(1) + ':' + m.group(2) if m else plid)
    return cid

def strip(c): return c.replace('&&', '\x00').replace('&', '').replace('\x00', '&').strip()

def node(c, scope):
    if c['kind'] == 'separator': return 0
    if c['kind'] == 'linkrepeat':
        plid = c.get('plid', '')
        for pat, name in DYNAMIC:
            if re.search(pat, plid): return [name]
        return None
    if c['kind'] == 'tree':
        kids = []
        for k in c['children']:
            x = node(k, scope)
            if x is not None: kids.append(x)
            for cap, cid in INJECT_AFTER.get(k.get('id', ''), []):
                lab, scopes = planned.get(cid, (strip(cap), set()))
                scopes.add(SCOPE_OF[scope]); planned[cid] = (lab, scopes)
                kids.append([cap, cid])
        kids = tidy(kids)
        if not any(k != 0 for k in kids): return None
        out = [caption(c).strip(), kids]
        if c.get('popup') and len(c['popup']) == 1: out.append(c['popup'].upper())
        return out
    plid = c.get('plid', '')
    if plid in DROP_LINKS: return None
    if plid == 'PLClient:SelectLayout': return ['Desktop La&youts', [['@layouts']]]
    pl = pls.get(plid, {})
    cap = SCOPED_CAPTION.get((scope, plid)) or CAPTION_AT_RUN_TIME.get(plid) or caption(c).strip()
    if not cap: return None
    cid = cmd_for(plid, scope)
    sc = SCOPE_OF[scope]
    if COLLECT_TIPS and (pl.get('description') or '').strip():
        TIPS.setdefault(sc + '|' + cid, pl['description'].strip())
    if cid.startswith('ad:'):
        lab, scopes = planned.get(cid, (strip(cap), set()))
        scopes.add(sc); planned[cid] = (lab, scopes)
    for k in ('shortcut1', 'shortcut2', 'shortcut3'):
        cb = combo(pl.get(k, '') or '')
        if cb: shortcuts.setdefault((cb, cid), set()).add(sc)
    return [cap, cid]

def tidy(kids):
    out = []
    for k in kids:
        if k == 0 and (not out or out[-1] == 0): continue
        if k != 0 and len(k) == 1 and k in out:                          # one run-time list stands for AD's repeated entries
            if out and out[-1] == 0: out.pop()
            continue
        out.append(k)
    while out and out[-1] == 0: out.pop()
    return out

def tree_kids(tid, scope):
    t = root(tid)
    return [x for x in (node(k, scope) for k in t['children']) if x is not None]

MENUBAR = {}
POPUPS = {}
CONTEXT = {}
# The popup holders (Help › Popups) stay out of the menu bar
for scope, tid in [('sch', 'MNSchematicMenu'), ('pcb', 'MNPCBMenu'), ('pcblib', 'MNPCBLibMenu'), ('schlib', 'MNSchLibMenu'), ('global', 'MNNoDocument'), ('dxp', 'MNSystemMenu'),
                   ('simview', 'MNSimViewMenu'), ('simtext', 'MNTextAdvSimFileMenu'), ('cam', 'MNCAMTASTIC_Menu')]:
    MENUBAR[scope] = tree_kids(tid, scope)

def popup_tree(tid, scope):
    t = trees.get(tid)
    if not t: return None
    t = dict(t); t['children'] = expand(t)
    gen.is_excluded_orig = gen.is_excluded
    t['children'] = prune(t['children'])
    return node(t, scope)

POPUP_IDS = {
  'sch': ['MNSchematic_HelpPopupsOptionsZoom10', 'MNSchematic_PopupOptions'],
  'pcb': ['MNPCB_ZoomPopup', 'MNPCB_OptionsPopup', 'MNPCB_SnapGridPopup', 'MNPCB_NetListPopup'],
  'pcblib': ['MNPCB_ZoomPopup', 'MNPCB_OptionsPopup', 'MNPCB_SnapGridPopup'],
  'schlib': ['MNSchematic_HelpPopupsOptionsZoom10', 'MNSchematic_PopupOptions'],
  'simview': ['PUSimView_ZoomMenu'],
}
for scope, ids in POPUP_IDS.items():
    POPUPS[scope] = [p for p in (popup_tree(i, scope) for i in ids) if p]
CONTEXT['sch'] = popup_tree('PUSCHMENU', 'sch')
CONTEXT['schlib'] = popup_tree('PUSCHMENU', 'schlib')
CONTEXT['pcb'] = popup_tree('MNPCB_FreeSpace', 'pcb')
CONTEXT['pcb_object'] = popup_tree('MNPCB_Primitive', 'pcb')
CONTEXT['pcblib'] = popup_tree('PUPCBLibMenu_FreeSpace', 'pcblib')
CONTEXT['pcblib_object'] = popup_tree('PUPCBLibMenu_Primitive', 'pcblib')
# Projects and Messages panels
for name, tid in [('wm_project', 'MNWorkspaceManagerMenu_PopupProject'), ('wm_document', 'MNWorkspaceManagerMenu_Document'),
                  ('wm_category', 'MNWorkspaceManagerMenu_Category'), ('wm_workspace', 'MNWorkspaceManagerMenu_Workspace'),
                  ('wm_messages', 'MNWorkspaceManagerMenu_MessageList')]:
    CONTEXT[name] = popup_tree(tid, 'global')

# Shortcuts from each editor's shortcut table (keys with no menu item: layer stepping, nudges …)
for scope, tid in [('sch', 'HTSchematicHotKeys'), ('pcb', 'HTPCBHotKeys'), ('pcblib', 'HTPCBLibHotKeys'), ('schlib', 'HTSchLibHotKeys'), ('simview', 'HTSimViewHotKeyTable'), ('cam', 'HTCAMTASTIC_HotKeys')]:
    t = trees.get(tid)
    if not t: continue
    def walk(n):
        for c in n.get('children', []):
            if c['kind'] == 'link':
                plid = c.get('plid', ''); pl = pls.get(plid)
                if not pl or gen.EXCLUDE_PL.search(plid): continue
                cid = cmd_for(plid, scope)
                for k in ('shortcut1', 'shortcut2', 'shortcut3'):
                    cb = combo(pl.get(k, '') or '')
                    if cb:
                        shortcuts.setdefault((cb, cid), set()).add(scope)
                        if cid.startswith('ad:') and cid not in planned: planned[cid] = (strip(caption(c)) or plid, {scope})
            elif c['kind'] == 'tree': walk(c)
    walk(t)

# Toolbars: [label, scope, items]; a dropdown is [hint, children]
TOOLBAR_IDS = [
  ('sch.standard', 'TLSchematicTools', 'sch'), ('sch.wiring', 'TLWiringTools', 'sch'), ('sch.utilities', 'TLSchUtilities', 'sch'),
  ('pcb.standard', 'TLPCBToolbar', 'pcb'), ('pcb.wiring', 'TLPCBWiring', 'pcb'), ('pcb.utilities', 'TLPCBUtilities', 'pcb'),
  ('pcblib.standard', 'TLPCBLibToolbar', 'pcblib'), ('pcblib.placement', 'TLPCBLibPlacementTools', 'pcblib'),
  ('schlib.standard', 'TLSchLibTools', 'schlib'), ('schlib.utilities', 'TLSchLibUtilities', 'schlib'), ('schlib.mode', 'TLModeToolbar', 'schlib'), ('global.standard', 'TLNoDocument', 'global'),
  ('sch.simSources', 'TLSimulationSources', 'sch'),
  ('simview.standard', 'TLSimViewToolBar', 'simview'), ('simview.waves', 'TLWaveTools', 'simview'), ('simview.cursor', 'TLCursorTools', 'simview'),
  ('simtext.standard', 'TLEditSimTools', 'simtext'),
  ('cam.standard', 'TLMainToolbar', 'cam'), ('cam.utilities', 'TLCAMUtilities', 'cam'),
]
# The Simulation Sources toolbar: its tree lives in a resource these files don't include; its
# buttons are SimSupport's launchers, in the order that file defines them [est: the toolbar's order]
if 'TLSimulationSources' not in trees:
    trees['TLSimulationSources'] = {'kind': 'tree', 'id': 'TLSimulationSources', 'caption': 'Simulation Sources',
        'children': [{'kind': 'link', 'id': f'TBSimSources{i}', 'plid': k} for i, k in enumerate(k for k in pls if k.startswith('PLSIM:PlaceSimulationSources'))]}
def hinted(t):
    t = dict(t)
    if t['kind'] == 'tree':
        if not t.get('caption'): t['caption'] = t.get('hint', '') or DROP_NAMES.get((t.get('image') or '').lower(), '')
        t['children'] = [hinted(c) for c in t['children']]
    return t
# Toolbars named without the other suite's product names
TOOLBAR_NAMES = {'cam.standard': 'CAM Standard'}
TOOLBARS = {}
COLLECT_TIPS = True
for bid, tid, scope in TOOLBAR_IDS:
    t = trees.get(tid)
    if not t: continue
    t = hinted(dict(t, children=expand(t)))
    t['children'] = prune(t['children'])
    kids = [x for x in (node(k, scope) for k in t['children']) if x is not None]
    kids = [k for k in kids if k == 0 or not (isinstance(k[1], str) and k[1] in ('ad:WorkspaceManager:ShowEPM',))]
    TOOLBARS[bid] = [TOOLBAR_NAMES.get(bid, t.get('caption', bid)), scope, tidy(kids)]


# Konium speaks British English: captions, hints and tooltips are spelt the British way (the
# accelerator stays on the same letter). Command ids keep AD's names.
UK = {
  'color': 'colour', 'colors': 'colours', 'colored': 'coloured', 'coloring': 'colouring', 'colorize': 'colourise',
  'center': 'centre', 'centers': 'centres', 'centered': 'centred', 'centering': 'centring',
  'gray': 'grey', 'grays': 'greys', 'grayed': 'greyed', 'grayscale': 'greyscale',
  'favorite': 'favourite', 'favorites': 'favourites', 'neighbor': 'neighbour', 'neighbors': 'neighbours',
  'organize': 'organise', 'customize': 'customise', 'customized': 'customised', 'analyze': 'analyse', 'analyzed': 'analysed', 'analyzer': 'analyser',
  'synchronize': 'synchronise', 'synchronized': 'synchronised', 'synchronizer': 'synchroniser', 'optimize': 'optimise', 'optimized': 'optimised',
  'optimizer': 'optimiser', 'equalize': 'equalise', 'localization': 'localisation', 'localized': 'localised', 'initialize': 'initialise',
  'minimize': 'minimise', 'maximize': 'maximise', 'minimized': 'minimised', 'maximized': 'maximised', 'normalize': 'normalise',
  'recognize': 'recognise', 'summarize': 'summarise', 'prioritize': 'prioritise', 'finalize': 'finalise', 'categorize': 'categorise',
  'visualize': 'visualise', 'capitalize': 'capitalise', 'capitalized': 'capitalised', 'serialize': 'serialise', 'utilize': 'utilise', 'millimeter': 'millimetre', 'millimeters': 'millimetres',
  'centimeter': 'centimetre', 'centimeters': 'centimetres', 'meter': 'metre', 'meters': 'metres', 'labeling': 'labelling', 'labeled': 'labelled',
  'canceled': 'cancelled', 'canceling': 'cancelling', 'modeling': 'modelling', 'modeled': 'modelled', 'behavior': 'behaviour',
  'behaviors': 'behaviours', 'honor': 'honour', 'analog': 'analogue', 'catalog': 'catalogue', 'license': 'licence', 'toward': 'towards',
}
def uk(text):
    if not isinstance(text, str): return text
    def one(m):
        tok = m.group(0); w = tok.replace('&', ''); to = UK.get(w.lower())
        if not to or w == w.upper(): return tok
        out = to.upper() if w.isupper() else (to[0].upper() + to[1:] if w[0].isupper() else to)
        k = tok.find('&')
        if k >= 0 and '&&' not in tok:
            L = w[k].lower(); cands = [i for i, ch in enumerate(out) if ch.lower() == L]
            i = min(cands, key=lambda i: abs(i - k)) if cands else min(k, len(out) - 1)   # Analy&ze → Analy&se
            out = out[:i] + '&' + out[i:]
        return out
    text = text.replace('Analy&ze', 'Anal&yse')   # Y is free in the Project menu (S is Show Differences)
    return re.sub(r'[A-Za-z&]+', one, text)
def uk_tree(v):
    """A menu spec: [caption, command] or [caption, children, key?]; separators 0; lists of them."""
    if isinstance(v, list):
        if v and isinstance(v[0], str):
            out = [uk(v[0])] + [uk_tree(x) if isinstance(x, list) else x for x in v[1:]]
            return out
        return [uk_tree(x) for x in v]
    if isinstance(v, dict): return {k: uk_tree(x) for k, x in v.items()}
    return v

# Konium's own Help items, ahead of About: reporting a bug, what's new, supporting it and getting it onto this computer
for kids in MENUBAR.values():
    for m in kids:
        if m != 0 and len(m) > 1 and strip(m[0]) == 'Help' and isinstance(m[1], list):
            at = next((i for i, k in enumerate(m[1]) if k != 0 and k[1] == 'help.about'), len(m[1]))
            m[1][at:at] = [['&Report a Bug...', 'help.reportBug'], ['&Contact the Author...', 'help.contact'], ["What's &New", 'help.whatsNew'], 0, ['&Support Konium...', 'help.support'], ['&Get Konium on This Computer...', 'help.getKonium'], 0]
MENUBAR, POPUPS, CONTEXT = uk_tree(MENUBAR), uk_tree(POPUPS), uk_tree(CONTEXT)
TOOLBARS = {k: [uk(v[0]), v[1], uk_tree(v[2])] for k, v in TOOLBARS.items()}
TIPS = {k: uk(v) for k, v in TIPS.items()}
planned = {k: (uk(v[0]), v[1]) for k, v in planned.items()}

# One key, one command in each editor: the resources give some keys to two commands (a menu item
# and its right-click twin, or two actions). The command the key ran keeps it (Konium's dispatch
# takes the first live one in this list's order), unless the other is the better use of the key;
# the other loses it in the editors named (None: everywhere). tests/fixes148b.test.ts checks none are left.
KEY_DROP = {
    ('Ctrl+N', 'ad:WorkspaceManager:NewOther'): None,                    # File › New (the menu, every kind) keeps it
    ('Ctrl+C', 'msg.copy'): None,                                        # the editors' Copy; Messages copies on its own when it has the focus
    ('Ctrl+PageDown', 'ad:Sch:ZoomAllClassic'): None,                   # View › Fit All Objects, the same view
    ('Ctrl+Tab', 'ad:Client:RunDesignExplorerSysCommandNextTab'): None,  # Window › Next Document, in every kind of tab
    ('Ctrl+Shift+Tab', 'ad:Client:RunDesignExplorerSysCommandPreviousTab'): None,
    ('Ctrl+Shift+V', 'align.distributeV'): {'sch'},                     # Smart Paste on a sheet (still Distribute in a library: commands.ts SHEET_ONLY)
    ('Ctrl+End', 'jump.origin'): None,                                   # Current Origin; Ctrl+Home stays the absolute origin
    ('Ctrl+Shift+G', 'ad:PCB:MoveComponentOriginToGrid'): None,          # Set Global Snap Grid (the G popup's), in both PCB editors
    ('Alt+Shift+I', 'ad:PCB:PopupAlignComponentsTopSideBySide'): None,   # the Edit › Align twins keep these
    ('Alt+Shift+L', 'ad:PCB:PopupAlignComponentsLeftSideBySide'): None,
    ('Alt+Shift+N', 'ad:PCB:PopupAlignComponentsBottomSideBySide'): None,
    ('Alt+Shift+R', 'ad:PCB:PopupAlignComponentsRightSideBySide'): None,
    ('Alt+ArrowLeft', 'ad:PCB:PopupRightMouseLibPrevComponent'): None,   # Tools › Prev Component (beside Next on Alt+Right)
    ('F12', 'ad:PCB:PCBLibExpressionFilter'): None,                      # the PCB filter's F12 opens the same panel in a library
}
for k, drop in KEY_DROP.items():
    if k not in shortcuts: continue
    if drop is None: del shortcuts[k]
    else:
        shortcuts[k] -= drop
        if not shortcuts[k]: del shortcuts[k]
# Ctrl+S also saves the documents without an editor of their own (Output Job, BOM document, Draftsman …)
shortcuts.setdefault(('Ctrl+S', 'file.save'), set()).add('inspect')

def ts(v, ind=0):
    return json.dumps(v, ensure_ascii=False)

lines = []
lines.append('/* eslint-disable */')
lines.append('// GENERATED from Altium Designer 17.1 resource files (advsch.rcs, AdvPcb.rcs, WorkspaceManager.rcs, dxp.rcs, SimView.RCS …)')
lines.append('// by tests/tools/rcs/emit.py: menu structure, captions with & accelerators, popup keys and default')
lines.append('// shortcuts. HDL simulation, signal integrity, FPGA, vault/VCS and scripting items are left out.')
lines.append('// Do not edit by hand; patch tests/tools/rcs/emit.py and regenerate.')
lines.append('')
lines.append('/** 0 = separator; [caption, command] ; [caption, children, popupKey?] ; ["@dynamic"] */')
lines.append('export type MenuSpec = 0 | [string] | [string, string] | [string, MenuSpec[], string?];')
lines.append('')
def emit_tree(name, v):
    lines.append(f'export const {name} = ' + json.dumps(v, ensure_ascii=False, indent=1).replace('\n ', '\n  ') + ' as const satisfies Record<string, unknown>;')
lines.append('export const MENUBAR: Record<string, MenuSpec[]> = ' + json.dumps(MENUBAR, ensure_ascii=False, separators=(',', ':')) + ';')
lines.append('')
lines.append('export const POPUPS: Record<string, MenuSpec[]> = ' + json.dumps(POPUPS, ensure_ascii=False, separators=(',', ':')) + ';')
lines.append('')
lines.append('export const CONTEXT: Record<string, MenuSpec> = ' + json.dumps(CONTEXT, ensure_ascii=False, separators=(',', ':')) + ';')
lines.append('')
lines.append('/** Toolbars: id → [caption, scope, items]; a dropdown button is [hint, children]. */')
lines.append('export const TOOLBARS: Record<string, [string, string, MenuSpec[]]> = ' + json.dumps(TOOLBARS, ensure_ascii=False, separators=(',', ':')).replace('],"', '],\n"') + ';')
lines.append('/** Toolbar tooltips: the Description AD17 shows for a button, by "scope|command". */')
lines.append('export const TIPS: Record<string, string> = ' + json.dumps(dict(sorted(TIPS.items())), ensure_ascii=False, separators=(',', ':')) + ';')
lines.append('')
lines.append('/** Commands Konium doesn\'t have yet, shown greyed as in a licence without the feature. */')
lines.append('export const PLANNED: Record<string, [label: string, scopes: string[]]> = ' + json.dumps({k: [v[0], sorted(v[1])] for k, v in sorted(planned.items())}, ensure_ascii=False, separators=(',', ':')).replace('],"', '],\n"') + ';')
lines.append('')
lines.append('/** Default shortcuts: [combo, command, scopes]. */')
lines.append('export const SHORTCUTS: [string, string, string[]][] = ' + json.dumps([[c, i, sorted(s)] for (c, i), s in sorted(shortcuts.items())], ensure_ascii=False, separators=(',', ':')).replace('],[', '],\n[') + ';')
open(OUT, 'w').write('\n'.join(lines) + '\n')
print('planned', len(planned), 'shortcuts', len(shortcuts))
