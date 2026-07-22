# Design principles (the `PD n` shorthand)

Source comments across `engine/` and `app/backend/` refer to design
principles by number, as `PD 1`, `PD 13` and so on. This file is the
glossary. Each entry is stated the way the code actually applies it, so
you can check any citation against the module that carries it.

| Ref | Principle | What it means in code |
| --- | --- | --- |
| PD 1 | **No empty success** | A detector may report `detected` only with real, non-empty reconstructed data plus evidence. Anything else is a typed `not_detected` carrying a reason. Enforced at the ingest boundary by `assertNoEmptySuccess`. |
| PD 2 | **No fakery in summaries** | Human-facing summaries and labels must be substantive. Placeholder or filler text ("TODO", empty strings, invented descriptions) is rejected rather than surfaced. |
| PD 3 | **Everything is scored** | Every classification carries a numeric confidence in `[0,1]` alongside the evidence that produced it. There are no unquantified assertions. |
| PD 4 | **No fakery in names** | The editor never invents a name it does not know. Unnamed opcodes, tables and entities render as the raw constant or a synthetic id, never as a plausible-looking guess. |
| PD 5 | **Universality first** | No FireRed-only or Emerald-only code path. Detection and reconstruction work across the Gen-3 family and the hacks derived from it; game-specific knowledge lives in data tables, not in branches. |
| PD 8 | **ROM-wide accounting** | Every byte of an ingested ROM ends up classified into a known system or explicitly recorded as a scored `UNKNOWN` region. Bytes that are neither fall into `unaccounted`, which is tracked as a regression metric. |
| PD 11 | **Patch-first, non-destructive** | ROM editing never mutates input bytes in place. Operations return new byte arrays and are expressed as patches. |
| PD 12 | **No dead zones** | Whatever the engine finds is surfaced, including regions it cannot classify. Unknowns are shown with their score rather than hidden. |
| PD 13 | **Engine / editor single source of truth** | The editor backend does not re-implement detection, classification or coverage. Every path to ROM introspection goes through `runEngineOnRom` and the engine's canonical types. |
| PD 14 | **Visual surfaces, not raw dumps** | Engine output gets a rendered surface (tables, chips, maps, previews) rather than a JSON blob pasted into the UI. |
| PD 16 | **Hack-aware** | Hacks expand and relocate the vanilla tables. Detection reports what a table *is* structurally and shows every detector's status, so an unrecognised or extended table is visible rather than silently dropped. |
