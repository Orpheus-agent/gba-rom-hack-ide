# tile-intel-svc

Phase 8 tileset-intelligence sidecar for the ROM editor.

## What this is

A FastAPI service that runs on `127.0.0.1:58080` and provides the
editor's backend with semantic, geometric, and topological
understanding of Pokémon tilesets. The Node backend never imports
Python directly - it spawns this process via the
`TileIntelSupervisor` (Phase 8A-4) and talks REST/JSON.

The Python side **never parses Gen-3 ROM bytes**. The Node-side
`scripts/build-tile-intel-corpus.mjs` mines tilesets from the
user's on-disk pret/CFRU/DPE/Emerald source clones and emits the
canonical Tile-Intel IR JSON. The sidecar consumes only that IR.
This discipline is enforced by a CI parity check comparing the
Zod schema in `app/backend/src/tile-intel/ir-schema.ts` against
the Pydantic schema in `src/tile_intel/domain/ir.py`.

## Local install

Prereqs: Python 3.12+, [uv](https://github.com/astral-sh/uv), Docker
Desktop (for Postgres + Qdrant).

```
cd tile-intel-svc
uv sync --extra dev
```

### Windows: AppContainer path-virtualization quirk

On Windows, if `%APPDATA%` is being redirected to an AppContainer
sandbox (you'll see `C:\Users\<name>\AppData\Local\Packages\...\LocalCache\Roaming\...`
in error messages), uv's auto-downloaded Python install fails with
*"Missing expected target directory for Python minor version link"*.
Work around it by pointing uv at a non-sandboxed path before any
uv command:

```powershell
$env:UV_PYTHON_INSTALL_DIR = "$env:USERPROFILE\.uv\python"
uv sync --extra dev
```

The TS-side supervisor at `app/backend/src/tile-intel/supervisor.ts`
(Phase 8A-4) sets this automatically when spawning the sidecar.

That creates `.venv/`, downloads Python 3.12 if needed, installs
all dependencies. From the repo root, `docker compose up -d` brings
up Postgres + Qdrant on 127.0.0.1:15432 / 16333.

## Run the service

```
uv run uvicorn tile_intel.app:app --host 127.0.0.1 --port 58080
```

Then `curl http://127.0.0.1:58080/health` should return
`{"ok": true, "schema_version": 1, "api_version": 1}`.

In normal operation, the Node backend's `TileIntelSupervisor`
spawns this process lazily on first tile-intel tool call.

## Tests

```
uv run pytest -q
```

## Phase ladder

- **8A-3** (this commit): FastAPI skeleton, `/health` + `/v1/version`,
  Alembic baseline, predownload-models stub.
- **8A-5**: SQLAlchemy domain models + Alembic baseline migration
  + storage protocols (Postgres + SQLite-for-tests).
- **8B-2**: `POST /v1/ingest/json-corpus` (consumes the Node-emitted
  Tile-Intel IR).
- **8C / 8D / 8E / 8F / 8G**: semantic layer, embeddings, community
  ingest, grammar, generation.

See `docs/MASTER_PLAN.md`
for the full Phase 8 plan.
