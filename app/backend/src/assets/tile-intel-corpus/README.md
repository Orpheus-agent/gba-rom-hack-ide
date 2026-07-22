# Tile-Intel corpus directory

This directory holds the JSON Intermediate Representation (IR) files
produced by `scripts/build-tile-intel-corpus.mjs`. Each file is one
source's mined contents (tilesets + adjacency observations), with
the canonical shape defined in `app/shared/src/tile-intel-ir.ts`.

The Python sidecar at `tile-intel-svc/` ingests these files via the
`POST /v1/ingest/json-corpus` endpoint (Phase 8B-2) into Postgres +
Qdrant.

## Why no JSONs in git

The mined files are heavy - `pret-firered.json` alone is ~75 MB,
and the full set across pret-firered + pret-emerald + cfru + dpe
+ curated community packs is several hundred MB. They're trivially
reproducible from the on-disk source clones, so we keep them out
of git.

## Regenerating

From the repo root:

```
# All sources (slow, full coverage):
node scripts/build-tile-intel-corpus.mjs

# Just one source:
node scripts/build-tile-intel-corpus.mjs --source pret-firered

# Fast iteration during development:
node scripts/build-tile-intel-corpus.mjs --source pret-firered --max-maps 5
```

The script auto-detects the user's existing source clones:
- `C:\path\to\pokefirered-master\pokefirered-master\`
- `C:\path\to\pokeemerald-master\pokeemerald-master\`
- `C:\path\to\Complete-Fire-Red-Upgrade-master\...\`
- `C:\path\to\Dynamic-Pokemon-Expansion-master\...\`

…or you can pass any path via `--pret-firered <path>` etc.

The script is **idempotent**: running it twice on the same source
tree produces byte-identical output (modulo the `generatedAtUtc`
timestamp).
