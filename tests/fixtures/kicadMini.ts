/** A small KiCad project for the tests (kicad50, kicadRoundTrip155). */
/* A two-resistor design: R1 (top) and R2 (bottom) share MID, R2's other pin is GND (a pour), R1's pin 1 is left open. */
export const ROOT = '11111111-0000-0000-0000-000000000001';
const font = '(effects (font (size 1.27 1.27)))';
const sym = (ref: string, n: number, x: number, y: number, value: string) => `
  (symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (in_bom yes) (on_board yes) (uuid "aaaaaaaa-0000-0000-0000-00000000000${n}")
    (property "Reference" "${ref}" (at ${x + 2} ${y} 0) ${font})
    (property "Value" "${value}" (at ${x + 4} ${y} 0) ${font})
    (property "Footprint" "Resistor_SMD:R_0603" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) hide))
    (instances (project "mini" (path "/${ROOT}" (reference "${ref}") (unit 1)))))`;
export const SCH = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "${ROOT}") (paper "A4")
 (lib_symbols
  (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
   (property "Reference" "R" (at 2.032 0 90) ${font})
   (property "Value" "R" (at 0 0 90) ${font})
   (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
   (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
   (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${font}) (number "1" ${font}))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${font}) (number "2" ${font}))))
  (symbol "power:GND" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
   (property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) hide))
   (property "Value" "GND" (at 0 -3.81 0) ${font})
   (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none))))
   (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) hide (name "GND" ${font}) (number "1" ${font})))))
 (wire (pts (xy 100 103.81) (xy 100 106.19)) (stroke (width 0) (type default)) (uuid "bbbbbbbb-0000-0000-0000-000000000001"))
 (label "MID" (at 100 105 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "bbbbbbbb-0000-0000-0000-000000000002"))
 ${sym('R1', 1, 100, 100, '10k')}
 ${sym('R2', 2, 100, 110, '4k7')}
 (symbol (lib_id "power:GND") (at 100 113.81 0) (unit 1) (in_bom yes) (on_board yes) (uuid "aaaaaaaa-0000-0000-0000-000000000009")
   (property "Reference" "#PWR01" (at 100 120 0) (effects (font (size 1.27 1.27)) hide))
   (property "Value" "GND" (at 100 118 0) ${font})
   (instances (project "mini" (path "/${ROOT}" (reference "#PWR01") (unit 1)))))
)`;

const pad = (n: string, x: number, net: string, side = 'F') => `(pad "${n}" smd roundrect (at ${x} 0) (size 0.8 0.9) (layers "${side}.Cu" "${side}.Paste" "${side}.Mask") (roundrect_rratio 0.25) (net ${net}))`;
const fp = (ref: string, n: number, side: 'F' | 'B', x: number, y: number, pads: string, value = ref === 'R1' ? '10k' : '4k7') => `
 (footprint "Resistor_SMD:R_0603" (layer "${side}.Cu") (at ${x} ${y}) (path "/aaaaaaaa-0000-0000-0000-00000000000${n}")
   (property "Reference" "${ref}" (at 0 -1.5 0) (layer "${side}.SilkS") (effects (font (size 1 1) (thickness 0.15))${side === 'B' ? ' (justify mirror)' : ''}))
   (property "Value" "${value}" (at 0 1.5 0) (layer "${side}.Fab") (effects (font (size 1 1) (thickness 0.15))))
   (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (stroke (width 0.05) (type solid)) (layer "${side}.CrtYd"))
   (fp_line (start -0.2 ${side === 'B' ? '' : '-'}0.6) (end 0.2 ${side === 'B' ? '' : '-'}0.6) (stroke (width 0.12) (type solid)) (layer "${side}.SilkS"))
   ${pads}
   (model "\${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`;
export const PCB = `(kicad_pcb (version 20240108) (generator "pcbnew")
 (general (thickness 1.6))
 (paper "A4")
 (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen") (44 "Edge.Cuts" user) (49 "F.Fab" user))
 (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "prepreg") (thickness 0.2) (material "FR4") (epsilon_r 4.4))
   (layer "In1.Cu" (type "copper") (thickness 0.0175)) (layer "dielectric 2" (type "core") (thickness 1.3) (material "FR4") (epsilon_r 4.5)) (layer "B.Cu" (type "copper") (thickness 0.035))))
 (net 0 "") (net 1 "/MID") (net 2 "GND") (net 3 "unconnected-(R1-Pad1)")
 ${fp('R1', 1, 'F', 120, 80, `${pad('1', -0.8, '3 "unconnected-(R1-Pad1)"')} ${pad('2', 0.8, '1 "/MID"')}`)}
 ${fp('R2', 2, 'B', 125, 80, `${pad('1', -0.8, '1 "/MID"', 'B')} ${pad('2', 0.8, '2 "GND"', 'B')}`)}
 (footprint "MountingHole:Slot" (layer "F.Cu") (at 105 90) (attr through_hole board_only exclude_from_bom)
   (property "Reference" "H1" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)) hide))
   (property "Value" "Slot" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
   (pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask")))
 (gr_rect (start 100 70) (end 140 95) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
 (gr_circle (center 132 88) (end 133 88) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
 (segment (start 120.8 80) (end 122.5 80) (width 0.25) (layer "F.Cu") (net 1))
 (via (at 122.5 80) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
 (segment (start 122.5 80) (end 124.2 80) (width 0.25) (layer "B.Cu") (net 1))
 (segment (start 110 80) (end 112 80) (width 0.2) (layer "In1.Cu") (net 0))
 (arc (start 110 85) (mid 111 84) (end 112 85) (width 0.2) (layer "F.Cu") (net 0))
 (zone (net 2) (net_name "GND") (layer "B.Cu") (hatch edge 0.5) (priority 1) (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
   (polygon (pts (xy 101 71) (xy 139 71) (xy 139 94) (xy 101 94)))
   (polygon (pts (xy 130 90) (xy 134 90) (xy 134 92) (xy 130 92)))
   (filled_polygon (layer "B.Cu") (pts (xy 125.5 79) (xy 139 79) (xy 139 94) (xy 125.5 94))))
 (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (hatch edge 0.5) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
   (polygon (pts (xy 102 88) (xy 108 88) (xy 108 93) (xy 102 93))))
 (gr_text "MINI\\nBOARD" (at 110 75 0) (layer "F.SilkS") (effects (font (size 1.5 1.5) (thickness 0.2))))
)`;
export const PRO = JSON.stringify({ board: { design_settings: { rules: { min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.5, min_through_hole_diameter: 0.3, min_hole_to_hole: 0.25 } } },
  net_settings: { classes: [{ name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }, { name: 'Power', clearance: 0.3, track_width: 0.5, via_diameter: 0.8, via_drill: 0.4 }],
    netclass_patterns: [{ netclass: 'Power', pattern: 'GN?' }] }, text_variables: { REV: 'B' } });
