# /corpus/ - operator-supplied test ROMs

This directory holds the operator's own, legally supplied Pokémon-family GBA
ROM files used to verify the introspection engine against real binaries.

**Hard rule: this directory is git-ignored. The project NEVER commits,
bundles, or distributes ROM or extracted-asset files.** Only this README
and `.gitkeep` are tracked.

## What to put here

The corpus gate requires coverage of up to five classes. The build
will design and test to the universal contract regardless of which classes
the operator supplies; classes that are missing get explicitly logged as
operator-facing notes, and synthetic structural fixtures
(labeled as such, never faked detectors) are used in their absence.

| Class           | Example                                                 |
|-----------------|---------------------------------------------------------|
| `vanilla/`      | Unmodified Pokémon FireRed (BPRE) or Emerald (BPEE)     |
| `heavyHack/`    | Pokémon Unbound, Radical Red, Crystal Clear, etc.       |
| `cfru/`         | Any CFRU-based build (custom-engine framework)          |
| `decomp/`       | A `pokefirered` or `pokeemerald` decomp build's ROM     |
| `customFork/`   | Custom engine fork / expansion-framework build          |

You only need each class once; multiple ROMs per class are fine. Filenames
may be anything - the engine identifies them by content, not by name.

## File layout (suggested)

```
/corpus/
  vanilla/
    firered.gba
  heavyHack/
    unbound-2.1.1.1.gba
  decomp/
    pokefirered-master.gba
  ...
```

The engine walks `/corpus/` recursively at corpus-verification time. You can
nest however you like; only `.gba` (and optionally `.zip` of a built project)
files are considered.

## Operator notes

- ROMs you drop here are read-only as far as the engine is concerned. The
  patch-first export pipeline emits IPS/UPS/xDelta/semantic
  diffs to `/artifacts/`, never mutating the original bytes.
- If you delete a corpus ROM and re-run, the engine reports the missing
  class as an operator-facing note and continues with
  whatever's still present.
