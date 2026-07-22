# Symbol data

This directory holds the JSON tables that let the editor show
`FLAG_HIDE_OAK_IN_HIS_LAB` instead of `flag_0x2B`.

## What ships here, and what does not

**Shipped (checked in):**

| File | What it is | Why it ships |
| --- | --- | --- |
| `gen3-universal.json` | Hand-written vocabulary for the Gen-3 *engine*: tile-behavior bytes, `applymovement` command bytes, script opcodes, msgbox shapes, weather, map types, battle scenes, AI flag bits, each with an editor-authored plain-English description. | It is the tool's own opcode/vocabulary table, the same way a disassembler ships an instruction table. It contains no game content: no stats, no encounters, no dialogue, no map list. |
| `npc-graphics.json` | `graphicsId` byte to a display label and a picker category, so the object-event inspector can show a name instead of a raw 0-255 number. | Small symbol table of editor-authored UI labels keyed by offset. No extracted game data, and there is no generator for it. |

**Not shipped (you generate these):**

- `firered-vanilla.json`
- `emerald-vanilla.json`
- `firered-cfru.json`
- `firered-cfru-dpe.json`
- `emerald-expansion.json`

These are bulk extractions of game content: map lists, wild encounter
tables, species / move / item / ability rosters, flag and var and song
tables, region-map sections. That is game data, not tooling, so this
repository ships the extractor rather than the extract, exactly like the
ROM itself.

## Generating them

Point the generators at your own legally-obtained decomp checkout:

```bash
# flags / vars / songs / species / moves / abilities / items / objectGfx
node scripts/build-symbols.mjs --pret /path/to/pokefirered

# vanilla FRLG ground truth (maps, region map sections, wild encounters)
node scripts/build-vanilla-frlg-truth.mjs --pret /path/to/pokefirered
```

Run `node scripts/build-symbols.mjs --help` for the exact flags.

## Degrading without them

Nothing crashes when these files are absent. `lib/symbols/index.ts`
discovers them with `import.meta.glob`, so a missing file simply means
that ROM family has no database: every resolver returns `null`, every
`list*` returns `[]`, and `isSymbolDatabaseAvailable()` returns `false`
so the UI can render an empty state that points back at this file. Vite's
glob is resolved at startup, so restart the dev server after generating them.
