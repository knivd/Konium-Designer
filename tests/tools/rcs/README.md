# AD17 menu generator

Builds `src/app/menus/ad17.gen.ts` (menus, accelerators, popup keys, default shortcuts) from an
Altium Designer 17 `System` folder's resource files (`advsch.rcs`, `AdvPcb.rcs`, `WorkspaceManager.rcs`,
`dxp.rcs` …), which a licensed installation provides. The resource files are not part of this
repository; only the menu structure taken from them is.

    python3 -I tests/tools/rcs/emit.py <AD17 System folder> x src/app/menus/ad17.gen.ts

- `rcs.py` — tokeniser and parser for the resource format (process launchers, trees, insertions).
- `gen.py` — scope filter: simulation, signal integrity, FPGA/HDL, vault/VCS, scripting and other
  out-of-scope items are dropped; separators tidied.
- `emit.py` — maps AD process launchers to Konium commands (`MAP`); unmapped ones become
  planned `ad:` commands shown greyed; writes the TypeScript data.
