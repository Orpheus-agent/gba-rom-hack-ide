"""Phase 8A-3 - Health + version smoke tests.

Uses FastAPI's TestClient - runs the ASGI app in-process without
needing Postgres / Qdrant / network.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tile_intel.app import create_app


def test_health_returns_ok() -> None:
    client = TestClient(create_app())
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["schema_version"] == 1
    assert body["api_version"] == 1


def test_version_exposes_contract() -> None:
    client = TestClient(create_app())
    response = client.get("/v1/version")
    assert response.status_code == 200
    body = response.json()
    assert body["api_version"] == 1
    assert body["schema_version"] == 1
    assert isinstance(body["package_version"], str)
    # test_mode defaults False; the test harness can flip it via env.
    assert isinstance(body["test_mode"], bool)
