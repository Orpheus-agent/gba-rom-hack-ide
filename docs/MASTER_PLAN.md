# MASTER PLAN - The Decomp Pivot

> **Mission (unchanged north star):** *Click anything in the game and edit everything related to it, in plain English, visually - not binary.* It should feel like a modern game engine, not a reverse-engineering dashboard. A child should be able to make a town, place NPCs, change starters, build encounters, and test the game - without ever seeing a hex address, pointer, or internal engine name.
>
> **The one change that makes it possible:** stop editing the compiled ROM as raw bytes. Edit the game's **human-readable source** (a decompilation project) and compile it to a real `.gba`. This is why HexManiacAdvance and Porymap "just work" and the platform doesn't.
>
> *(This is the durable master plan. Old Phase-2…9 plans are retired but left untouched for history.)*

---

## 1. Context - why we are resetting

At this point the platform can edit **tiles only**, even those render ~40% grey/black, and the AI produces "a mad-lib version of FireRed." Every prior "massive overhaul" was declared complete and wasn't. Four root causes, all evidence-backed by a functional + test audit:

1. **Wrong foundation - binary ROM patching.** Editing a compiled ROM means hand-writing a bespoke *detector* + *encoder* (find bytes, rewrite, repoint, manage free space) for every data type. It's the hardest possible way to build "edit anything," and it's why only tiles work. Community consensus: decomp "allows changes difficult or impossible with binary hacking," with no repointing or corruption; binary's *only* edge is lower setup.
2. **Reinvented mature tools from scratch** - a binary semantic engine (HMA), a tile/map renderer (Porymap), a headless emulator (mGBA) - all at once, badly.
3. **Green tests masked broken features.** 77 agent tools / 18 tested; **every test runs against fake `0xff` ROMs**, `corpus/` is empty, tool tests mock the apply step, **zero** end-to-end tests, the emulator throws on boot, the Python/Qdrant/CLIP sidecar is unused scaffolding.
4. **The AI edits binary.** An LLM generating byte patches is fighting its nature; an LLM editing C/JSON/PNG text is playing to its strength.

**The latent asset that de-risks everything:** the codebase already contains an abandoned decomp path - `app/backend/src/detect/decomp.ts`, `app/backend/src/scan/decomp.ts` (parses maps/trainers/dialogue from source), `patch-applier.ts`'s `replace_in_file` handler, and `build/detect.ts` + `build/runner.ts` (shells out to `make`). The pivot **activates and hardens what exists**; it does not rebuild the app.

---

## 2. The decision

**Re-found the platform on a decompilation source project.** A "project" becomes a working copy of **`pokefirered-expansion`** (FireRed decomp + Emerald-Expansion's modern mechanics: Fairy type, Gen-9 species, modern battle engine - all in editable source). The platform reads that source into the existing typed manifest, edits the source files in plain English via the AI, and compiles to a real `.gba` you can boot and ship as a patch.

---

## 3. Architecture - keep / adapt / replace

The pivot is a **data-plumbing swap behind an unchanged UI**. Verified file-by-file.

**KEEP as-is (format-agnostic, already correct):**
- Frontend shell + chat: `app/frontend/src/App.tsx`, `WorkspaceShell.tsx`, `MainPanel.tsx`, `NavigatorTree.tsx`, `AgentPanel.tsx`, `state/agent.ts`, `api.ts`.
- Click-anything inspector machinery (currently **dead code - just needs mounting**): `InspectorDock.tsx`, `lib/inspectorRegistry.ts`, `inspectorPanels/*`.
- Pickers & naming: `EntityPicker.tsx`, `lib/displayName.ts`; undo UI `UndoRedoButtons.tsx`.
- Backend spine: `projects/*`, `events/op-log.ts`, `events/undo.ts`, `agent/mcp-server.ts`, `agent/spawner.ts`, `agent/patch-store.ts`, `agent/tools/*`, `build/detect.ts`, `build/runner.ts`, `events/build-artifacts.ts`.
- The latent decomp core: `detect/decomp.ts`, `scan/decomp.ts`, `patch-applier.ts` (`replace_in_file`), `scan/index.ts` dispatch.

**ADAPT:**
- `AgentPanel.tsx` `summarizeEdit()` → dispatch on edit kind so diffs render for source edits.
- `MapEditor.tsx` → drop `/binary-rom` imports + sprite-cache; keep selection/markers/keyboard nav; route paint to source-writing APIs.
- `project open` UX → "Open game project" (a decomp dir) primary; quarantine "binary ROM mode" behind a flag.

**REPLACE (Phase 3) / RETIRE (binary detours):**
- Replace `mapEditorScene.ts` + `lib/binaryRomTiles.ts` with a renderer that composes from tileset **PNGs + metatile JSON** (new `lib/sourceMapTiles.ts`).
- Retire/quarantine (legacy binary mode only): `scan/binary-rom*.ts`, `engine/` introspection, `events/patch-gen.ts` + `share-package.ts`, `tile-intel/*` + Python sidecar + Docker/Qdrant/CLIP, the stub `engine/src/emulator/*`.

---

## 4. Resources

The operator supplies: **a cloned FireRed decomp**, **a working build of it**, **Porymap**, a devkitARM toolchain, CFRU + DPE sources, and their own legally obtained base ROM. None of these ship with this repository.

- **Decomp base:** `git clone https://github.com/cawtds/pokefirered-expansion`. Verify license + confirm it compiles.
- **Toolchain:** devkitARM + `agbcc` (or the base's `modern` GCC path). Phase 0.1 resolves which.
- **Porymap:** official release, pointed at the cloned project dir.
- **No new download for:** everything else. CFRU/DPE are *binary* frameworks, not decomp - reference-only.

---

## 5. Phase 0 - PROOF SLICE (trust gate; nothing scales until verified on the user's machine)

- **0.0** Save this plan as a durable repo file (done); leave old plan docs untouched.
- **0.1 Build works.** Clone the decomp; get `make` to produce a `.gba` with devkitARM (resolve agbcc vs modern). *Gate: clean checkout compiles to a bootable ROM.*
- **0.2 Open + read real names.** Platform opens the decomp dir; manifest shows correct species count, real map names (no "Unnamed area #N"), trainers/items by name. Harden `scan/decomp.ts` where short.
- **0.3 Plain-English edit → real source change.** User types an edit; agent edits real source via `replace_in_file`; diff card shows human-readable before/after.
- **0.4 Build from the UI.** One click runs `make`; compiler errors surface in plain English.
- **0.5 Boot & see it.** User boots the produced `.gba` and sees the change in-game.

**Exit gate:** user confirms open → edit → build → boot. Then **STOP and report.**

---

## 6. Phases 1–4 (scale only what Phase 0 proves)

- **Phase 1 - Decomp default; retire binary detours.** "Open game project" primary; quarantine binary mode. Harden `scan/decomp.ts` to populate every domain from source. **Mount `InspectorDock`** + wire click-anything → inspector. First-class "Build & Play" button.
- **Phase 2 - Plain-English editing across core domains, in-context.** Source-edit tools (plain-English → diff → build-verify) for species/learnsets, trainers/teams, encounters, items, starters, evolutions, types, dialogue. Edit **on the object** (click NPC → edit team + lines there). Enforce §7.
- **Phase 3 - Maps inside the platform.** PNG+JSON rendering (fixes grey tiles); paint writes source; "Open in Porymap" for power use.
- **Phase 4 - Full "make a game" surface + ship.** New maps/NPCs/cutscenes via plain English; PNG sprite/tile import; music via `mid2agb`; **ship as BPS patch** via build-diff. Flagship: rebuild **Convergence** on decomp end-to-end.

---

## 7. UX discipline - the user's failure list is law

No hex, offsets, pointers, banks, free-space, "repoint/expand/scan ROM," or internal engine names (`gMapHeader`, `map_012`, `FLAG_0x828`, `VAR_0x8004`), no raw JSON/script opcodes, no `4bpp`/`LZ77`/`BGR555`, no `species_id`/AI bitmasks in normal UX. Show: *Viridian Forest*, *Hidden Item*, *"NPC walks toward player"*, Pokémon by name + sprite. Editing is **in context**; diagnostics/IDs are advanced-mode only.

## 8. Verification discipline - kill the "unreliable narrator"

A feature counts as working only when: (1) it runs against the **real cloned decomp project**, not a synthetic fixture; (2) the change **compiles** to a real `.gba`; (3) a **boot/smoke check** or the user confirms it in-game. Drop synthetic-`0xff`-ROM tests as proof of feature-working. Per-phase exit gates are user-verifiable, not "tests green."

## 9. Convergence handling

Binary Convergence builds (`overnight-build/`, v01–v49) are **retired as a build target**. Their **design is preserved** as `convergence-design.md` (names, story, teams, encounters, map layouts) and re-applied on the decomp in Phase 4. The moves/rival/save bugs were binary-substrate symptoms that disappear on decomp.

## 10. Risks & open items

- **agbcc/toolchain setup** - Phase 0.1 is the first gate; resolve modern-GCC vs agbcc early.
- **License of `cawtds/pokefirered-expansion`** - verify before building on it.
- **`scan/decomp.ts` completeness** - Phase 0.2 validates and hardens it (no optimism without a real run).
- **In-app map rendering** (Phase 3) - Porymap covers maps until then, never a blocker.
- **Build time** - async "Build & Play" with live log; incremental builds.

---

## 11. Windows build toolchain - PROVEN (Phase 0.1, 2026-05-29)

The decomp `make modern` path builds a real `.gba` on this machine. One-time setup (the platform's "Build & Play" must eventually own all of this so the user never opens a terminal):

1. **devkitARM** - present (`C:\devkitPro`, `DEVKITARM=/opt/devkitpro/devkitARM`); provides `arm-none-eabi-gcc` **15.2** for the ROM.
2. **Host toolchain in devkitPro's MSYS2** (`C:\devkitPro\msys2`): `pacman -S gcc` (host gcc 15.2) + `zlib-devel`. (devkitPro's MSYS2 repos have **no host `libpng`** - only `nds-`/`3ds-` target variants.)
3. **libpng built from source** into `/usr/local` (multi-source script: SourceForge mirrors). Build the **library only** - its test programs fail to link on MSYS2 (libtool `_spawnv`/`.libs` quirk), which is harmless; copy `png.h`/`pngconf.h`/`pnglibconf.h` + `libpng.a` to `/usr/local` manually if `make install` balks.
4. **CRITICAL `preproc` patch (the wall):** devkitARM's Windows `arm-none-eabi-cpp` emits **CRLF**, and pret's `tools/preproc/asm_file.cpp::SkipWhitespaceAndEol()` skips `\t \n ` but **not `\r`** - so it mis-reads every C `enum {}` (first hit: `heal_locations.h`) as *"empty enum is invalid"* and the build dies at `data/event_scripts.s`. **Fix = add `|| m_buffer[m_pos] == '\r'` to that `while` loop.** Confirmed: patched `preproc` emits the 45 `HEAL_LOCATION` constants correctly. **This affects ALL pret decomps (firered/emerald/expansions) built on Windows with modern devkitARM.** The platform must ship/apply this patch automatically.
5. Build command: `make modern -j8` (no agbcc). Parallel build is fine **once preproc is patched** (the earlier "race" theory was wrong - it was this deterministic CRLF bug).

**Proof-slice substrate:** building a clean `git clone --depth 1` of `pret/pokefirered` (the stale `Downloads/*-master` ZIPs are unknown-vintage; always clone fresh). Modern-feature target (`pokefirered-expansion`) is Phase 1, after the loop is proven on base.

6. **GENERAL Windows CRLF fix (supersedes per-tool patching):** the CRLF originates in devkitARM's `arm-none-eabi-cpp` writing stdout in **text mode** - the *source files are LF* (`autocrlf` unset). pret tools handle it inconsistently (cawtds patched `preproc` but **not** `trainerproc`, and others may lurk). Cleanest fix = a **`cpp` wrapper** at `/usr/local/bin/arm-none-eabi-cpp` that runs the real cpp and pipes through `tr -d '\r'`, with `/usr/local/bin` ahead of devkitARM on PATH. One wrapper fixes *every* `cpp → tool` boundary with zero per-tool edits. The gcc driver compiling `.c` is unaffected (it uses internal cc1, not PATH cpp). **This is what the platform's "Build & Play" should install.**
7. **`pokefirered-expansion` build extras (PROVEN - 32 MiB ROM, SHA-1 `41f73e59…`):** the complete working recipe on Windows is:
   - `pacman -S python` (MSYS2 → `python3`) for its generators (`wild_encounters_to_header.py`, `make_scr_cmd_constants.py`).
   - The §6 CR-stripping cpp wrapper at `/usr/local/bin/arm-none-eabi-cpp` (its `trainerproc`/etc. aren't CRLF-aware).
   - **Force the wrapper into make:** `make modern -j8 CPP=/usr/local/bin/arm-none-eabi-cpp`. Putting the wrapper first on PATH is **not enough** - make's recipe shells resolved straight to the real `.exe`; the explicit `CPP=` override is what works.
   - libpng/zlib/gcc from §2–3 already in place.

---

## 12. Platform fix list (from live decomp testing, 2026-05-29)

Found by actually opening `pokefirered-pret` in the editor and driving an agent edit. The agent **correctly renamed "Pallet Town" → "Aurora Town" across 8 source files in plain English** (display-text scoped, internal symbol left intact, completeness verified) - the core "edit anything in plain English" capability *works on decomp*. Gaps surfaced:

1. **In-editor agent can't surface `AskUserQuestion` or plans (user-flagged, eventually-fix).** The MCP/CLI agent calls `AskUserQuestion` but there's no UI to render it → it auto-denies/defaults every time. Impact: it can't confirm scope with the user (here: "display-only rename, or also the internal `PALLET_TOWN` symbol + folders?") - it just picks a default. Needs a real question/plan-surfacing channel in the AgentPanel with a user response path. (It defaulted *conservatively and correctly* here, so the edit still succeeded - but that's not guaranteed.)
2. **Map canvas doesn't render decomp tiles** - shows only event markers; paint disabled ("Editing requires a binary-ROM project"); tile palette empty (0). Decomp tiles are PNG + metatile JSON; needs the in-app PNG/JSON renderer (replace `mapEditorScene.ts`/`binaryRomTiles.ts`). **Porymap renders these now** as the interim visual map editor.
3. **"Build & Play" not wired for the decomp toolchain** - the editor's build route must run `make modern -j8 CPP=/usr/local/bin/arm-none-eabi-cpp` with the MSYS2 + libpng env (§11), not plain `make`/agbcc. Until wired, the build step is run manually. This is the next thing to close the in-editor loop (plain-English edit → one-click build → boot).

---

## 13. APPROVED DIRECTION - Mission-control shell (2026-05-29, user-approved)

After researching 26 community tools, the user chose this: the platform is a **web, AI-assisted, story-navigable shell over the decomp source that USES proven tools instead of reinventing.** Keep the working decomp backend (open/scan/edit/build/agent); **throw out the bad, unnavigable UX** and rebuild around the user's flow (stated since day one): **open → navigate in story/natural order → see the world rendered as it is → click + plain-English to change anything.** Not ugly, not read-only.

**Per-surface decisions:**
- **Maps (visual world):** LAUNCH **Porymap** (huderlem, LGPL, Qt - user has it) as a subprocess on the project dir. Proven renderer; **do not reinvent the tile renderer** (cause of the 40% grey tiles). Optional later: read-only in-app map thumbnails from `map.json` + tileset PNGs for the navigator.
- **Scripts (the dead "No decoded steps" decoder):** adopt **Poryscript** (huderlem, MIT, Go) - edit readable `.pory`, compile to `.inc` on save.
- **Trainer teams (click NPC → edit):** `src/data/trainers.party` is human-readable (`=== TRAINER_X ===` blocks with `Name/Class` + per-Pokémon `Level/IVs/Moves/Ability/Item`). In-app dropdowns + AI; parse/rewrite the block (geefuoco/trainer_editor confirms the format). Link NPC→trainer via the object-event's script → `trainerbattle TRAINER_*`.
- **Pokémon/moves/items/encounters:** in-app editors over the JSON/`.h`/`.party` source + AI.
- **Tilesets/sprites:** Porytiles (MIT CLI) + PNG import - later.
- **Navigation + AI English-editing + Build&Play:** the platform's OWN value (no one else has it). Build the story-order navigator; harden the agent (fix AskUserQuestion surfacing, §12.1); wire one-click Build&Play (§11 recipe).

**Dropped/reference-only:** HexManiacAdvance (binary-only, GUI-only, no automation - irrelevant post-decomp). PorySuite-Z = pattern reference only (its EVENTide visual-event editor, byte-equality writes, and Porymap bidirectional integration), not adopted as base (PyQt6 desktop, FireRed-only, beta).

**Build order (working verticals, NO demos):**
1. **Trainer team editing** - click NPC → edit team in dropdowns → persists to `trainers.party`. (The exact wound from the 2026-05-29 screenshot.)
2. **Launch-Porymap** button - see/paint the world visually via the proven tool.
3. **Story-order navigation** - replace the unusable World Atlas.
4. **One-click Build & Play** (§11 recipe).
5. **Poryscript** script editing (kills "No decoded steps").
6. In-app Pokémon/move/item/encounter editors.

**Discipline:** each item ships as a *working, user-verifiable* vertical in the editor UI - not a `.gba` demo, not a plan, not a half-wired panel. Reuse existing tool logic/formats; the platform unifies + navigates + adds AI.

## 14. CURRENT STATE + CONTINUATION (2026-05-30, autonomous overnight run)

> Re-orient from THIS section ("Edit Everything via Substrates"). Work happened on a `trainer-team-editor` branch, committed after every vertical.

**§13 build-order status:** (1) Trainer teams ✓. (2) Maps ✓ - rendered tiles IN-APP (compositor, better than launching Porymap). (4) One-click Build & Play ✓. (6) Data editors → **ALL DONE: A1 Species ✓, A2 Moves ✓, A3 Learnsets ✓, A4 Encounters ✓, A5 Items ✓, A6 Abilities ✓, A7 Trainers (full list + party) ✓, A8 Type chart ✓.** (5) Readable scripts → **✓ DONE (#3)**. (3) Story-order nav → **✓ DONE (#2)**. → **All 4 mission-control items shipped + the entire A1–A8 Game-Data backlog complete. Remaining is polish / Substrate B (text-everywhere) / E (assets) / F (config) / G (audio) / H (agent-as-editor) per the substrate plan.**

**Tonight's mandate (user AFK):** finish #3 (readable scripts) ✓ and #2 (story-order nav), AND keep rolling the Game-Data engine (A4 Encounters, A3 Learnsets, A5 Items, A8 Types, …). Don't ask questions; pull answers from the plan files. Verify backend rigorously, typecheck frontend, commit each piece.

**Shipped this session (all on branch, pushed):** trainer `.party` editor; one-click Build & Play (`make modern` recipe + in-browser mGBA, see §11); real map-tile rendering (compositor `scan/tileset-render.ts`, handles `.4bpp`/`.png` fallback, shared graphics via `headers.h`, central `layouts.json`); **the full A1–A8 Game-Data editors** (A1 Species, A2 Moves, A3 Learnsets, A4 Wild Encounters, A5 Items, A6 Abilities, A7 Trainers-list+party, A8 Type chart); **#3 readable scripts** (decode wired into the inspector); **#2 story-order navigation** (region-section map tree); **decomp content creation** - Add NPC (`events/decomp-map-events.ts` appends to map.json), Add talking NPC + one-click "Make this a trainer" (`events/decomp-scripts.ts` appends a msgbox/`trainerbattle` script to `scripts.inc` + a `TRAINER_*` to `trainers.party`, binds via `setObjectEventFields`), surfaced as a toolbar `＋ Add NPC` button + right-click map menu. Plus two stale-test fixes (scan.test `__` ids; layouts.test message). **Verification state: typecheck clean (all 3 workspaces); backend `src/scan` suite 155/155 green; App.test 23/23; new unit tests scripts 16 / NavigatorTree 6 / VisualScriptEditor 11.** Pre-existing layouts.test red was fixed in passing.

**THE GAME-DATA ENGINE PATTERN (clone this for A3/A4/A7/A8):** the shared engine is `app/backend/src/scan/data/struct-block.ts` (`parseBlocks(text, idPrefix)` → `[{id, fields}]`; `editBlockInPlace(text, id, rawEdits)` edits field value-spans in place, **skips absent fields**, preserves everything unmodeled; `unquote()` joins `COMPOUND_STRING`/`_()`/`ITEM_NAME` literals). A new editor = a ~60-line schema file cloning **`scan/data/abilities.ts`** (simplest) or **`items.ts`** (has an enum dropdown + a raw-string field):
- Backend `scan/data/<x>.ts`: `read<X>s()` via `parseBlocks(text,'<PREFIX>_')` + `unquote`/`parseInt`; `edit<X>()` builds `rawEdits` (`_(JSON.stringify(s))` for `_`-strings, `COMPOUND_STRING(...)` / `ITEM_NAME(...)` for those wrappers, `String(n)` for ints, **raw verbatim** for expression fields like item `price`), then `editBlockInPlace` + atomic `.tmp`→rename. Optional `<x>Enums()` returns distinct on-disk enum values for dropdowns.
- Op-log: add an `OpKind` in `events/op-log.ts` (have `edit_species|edit_move|edit_ability|edit_item`).
- Routes in `routes/projects.ts`: `GET /api/projects/:id/decomp-<x>` (list; for items also returns `pockets`), `PATCH …/decomp-<x>/:<x>Id` (calls `edit<X>` + `recordOp`). Mirror the `decomp-items` block (~line 886).
- Frontend: `api.ts` (interface + get/edit fns) + a `Decomp<X>View.tsx` (clone `DecompItemsView.tsx`) + gate in `MainPanel.tsx` (add an `<X>Panel` wrapper: `!manifest.binaryRom` → decomp view) + add `['<viewkey>','Label']` to the decomp leaf array in `NavigatorTree.tsx` (~line 396).
- **Verify recipe:** write `app/backend/src/_v<x>.ts` → `npm --prefix app exec --workspace @rom-editor/backend -- tsx src/_v<x>.ts` → confirm parse count + an edit round-trips + reverts + an untouched field is preserved → delete temp file. Then `npm --prefix app run typecheck` (rebuild shared first if you changed `app/shared`: `npm --prefix app run build --workspace @rom-editor/shared`).

**Remaining data editors - CONFIRMED formats in pokefirered-expansion (`C:/path/to/pokefirered-expansion`):**
- **A1–A8 ALL DONE - each on the shared engine, verified on the real project + typecheck + commit:** A1 `species.ts`, A2 `moves.ts`, **A3 `learnsets.ts`** (gen_9 active via `P_LVL_UP_LEARNSETS`, 1104 learnsets, edit level+move in place), **A4 `encounters-edit.ts`** (read already worked via `scan/encounters.ts`→wild_encounters.json/469 tables; in-place JSON slot edit), A5 `items.ts`, A6 `abilities.ts`, **A7 `DecompTrainersView.tsx`** (no new backend - reused `/decomp-trainer` routes which already accept `{trainerId}`; lists 664 trainers → party editor with species/move/item name datalists + add/remove mon; binary `TrainerInspector` branch hidden for decomp), **A8 `typechart.ts`** (21×21 matrix grid, 6-char-aligned in-place cell edit). Decomp data editors reachable via Navigator → Game Data leaves (`species/moves/abilities/items/learnsets/types/spawns/trainers`) gated in `MainPanel.tsx` on `!manifest.binaryRom`.
- **Next (per the private development workspace's plan notes, not part of this snapshot):** Substrate B (text-everywhere search/edit), E (asset browser + palette), F (config/header/limits), G (audio song list + MIDI replace), H (agent-as-editor hardening for battle/move/ability EFFECT logic). Also polish: A8 type *names* (the `[TYPE_X]={.name}` info blocks lower in types_info.h - struct-block clone), A3 add/remove moves + TM/egg learnsets, A4 encounter-rate edit, region-primacy ordering for #2.

**#3 Readable scripts (✓ DONE):** `scan/scripts.ts` decodes decomp `.inc` macros → ScriptStep with a `raw` fallback. Three fixes killed "No decoded steps" on decomp: (1) step ids now use the shared `<label>__<index>` convention (were `<label>#<index>`, which never matched the frontend prefix `${scriptId}__`); (2) `parseScripts` now also scans **central `data/scripts/*.inc`** (nurse/PC/item-ball/trainer scripts maps reference by label) + dedups labels first-wins; (3) `VisualScriptEditor`/`ScriptStepsList` strip a trailing `__<n>` so a trigger's `scriptStepIds[0]` resolves, and binary-only Add/Delete are hidden on decomp (`!manifest.binaryRom` → read-only plain-English view; editing decomp scripts = agent / future decomp script-edit route). Verified on real project: 33585 steps / 8821 labels / 0 dup ids; SignLady=21, PkmnCenterNurse=9. **Flags/vars browser ("what gates this") confirmed working**: flags=882/vars=167 (from `include/constants/{flags,vars}.h`), and 420/882 flags now resolve ≥1 gating script step via `lib/flagReferences.ts` (matches `params.flag`/args by symbol name - enriched by the central-script scan). Files: `scan/scripts.ts`(+test), `components/script/VisualScriptEditor.tsx`, `components/inspector/ScriptStepsList.tsx`.

**#2 Story-order navigation (✓ DONE):** `NavigatorTree.tsx` previously listed maps flat/alphabetical (Route1, Route10, … Route2) split by category - the "unusable" World Atlas. Now decomp maps group by `metadata.region_map_section` into the game's areas, ordered by the canonical `MAPSEC_*` enum from `include/constants/region_map_sections.h`. Backend (`scan/decomp.ts::parseMapSectionOrder`) parses that enum into `manifest.mapSectionOrder` (new optional shared field, decomp-only); the Navigator builds story sections from it (`buildStoryOrderSections`), each area a collapsed branch clustering its town + interiors/gym, maps natural-sorted (overworld before interiors), placeless buckets (Dynamic/None) sunk last. Falls back to the old category grouping when `mapSectionOrder` absent (binary ROMs) - that path also upgraded to numeric-aware sort. Verified on real project: perfect Kanto order Pallet→Viridian→Pewter→Cerulean→Lavender→Vermilion→Celadon→Fuchsia→Cinnabar→Indigo Plateau; 6 unit tests in `NavigatorTree.test.tsx`. **Known minor cosmetic:** `MAPSEC_BATTLE_FRONTIER` (enum idx 58, a ported post-game complex with 46 maps) sorts above Pallet Town since Kanto sections start at idx 88 - a future "primary-region-first" refinement could anchor the start region. NOTE: shared type changes require `npm --prefix app run build --workspace @rom-editor/shared` before the frontend typecheck sees them.

**Verification discipline still law:** real cloned project, not fixtures; build-or-render to prove; no green-tests-on-fake-ROMs.
