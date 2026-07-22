"""Phase 8F-2 - Template-frequency by biome tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.models import Template, TemplateUsage
from tile_intel.grammar import (
    derive_biomes_for_tags,
    list_biomes_for_templates,
    templates_by_biome,
)
from tile_intel.storage.base import make_inmemory_factory

# ---------------------------------------------------------------------------
# Pure-function tests
# ---------------------------------------------------------------------------


def test_grass_tag_implies_forest_route_and_town():
    out = derive_biomes_for_tags(["terrain.grass.tall"])
    assert "biome.route" in out
    assert "biome.forest" in out
    assert "biome.plains" in out


def test_cave_tag_implies_cave_dungeon():
    out = derive_biomes_for_tags(["terrain.cave.floor"])
    assert "biome.cave" in out
    assert "biome.dungeon" in out


def test_water_ocean_tag_implies_beach():
    out = derive_biomes_for_tags(["terrain.water.ocean"])
    assert "biome.beach" in out
    assert "biome.tropical" in out


def test_non_terrain_tags_are_ignored():
    out = derive_biomes_for_tags(["traversal.walkable", "structure.filler"])
    assert out == []


def test_multiple_tags_dedupe_biomes():
    out = derive_biomes_for_tags(
        ["terrain.grass.tall", "terrain.water.pond"]
    )
    # Both contain biome.route, but it appears once.
    assert out.count("biome.route") == 1


def test_unknown_terrain_family_returns_empty():
    out = derive_biomes_for_tags(["terrain.alien"])
    # No mapping in TERRAIN_TO_BIOMES → empty.
    assert out == []


# ---------------------------------------------------------------------------
# DB integration
# ---------------------------------------------------------------------------


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


@pytest.fixture
def client(factory):
    return TestClient(create_app(storage_factory=factory))


def _add_template(
    session,
    slug: str,
    role: str,
    required_tags: list[str],
    usage: int = 5,
) -> Template:
    """Hand-build a Template + TemplateUsage row to avoid plumbing
    through the full 8F-1 corpus pipeline in every test."""

    t = Template(
        slug=slug,
        display_name=slug,
        role=role,
        width=3,
        height=3,
        cells=[[{} for _ in range(3)] for _ in range(3)],
        anchor_x=0,
        anchor_y=0,
        required_tags=required_tags,
        scope="global",
    )
    session.add(t)
    session.flush()
    session.add(
        TemplateUsage(
            template_id=t.id,
            map_corpus="pret-firered",
            occurrence_count=usage,
        )
    )
    return t


def test_templates_by_biome_returns_only_matching(factory):
    with factory.session() as session:
        _add_template(
            session,
            "tpl-grass",
            "uniform_terrain.grass.tall",
            ["terrain.grass.tall"],
            usage=10,
        )
        _add_template(
            session,
            "tpl-cave",
            "uniform_terrain.cave.floor",
            ["terrain.cave.floor"],
            usage=3,
        )

    rows = templates_by_biome(factory, "biome.cave")
    assert {r.template_slug for r in rows} == {"tpl-cave"}
    rows = templates_by_biome(factory, "biome.forest")
    assert {r.template_slug for r in rows} == {"tpl-grass"}


def test_templates_by_biome_sorts_by_usage_descending(factory):
    with factory.session() as session:
        _add_template(session, "tpl-low", "uniform_terrain.grass.tall",
                      ["terrain.grass.tall"], usage=1)
        _add_template(session, "tpl-high", "uniform_terrain.grass.tall",
                      ["terrain.grass.tall"], usage=99)
        _add_template(session, "tpl-mid", "uniform_terrain.grass.tall",
                      ["terrain.grass.tall"], usage=15)
    rows = templates_by_biome(factory, "biome.forest")
    assert [r.template_slug for r in rows] == ["tpl-high", "tpl-mid", "tpl-low"]


def test_templates_by_biome_respects_limit(factory):
    with factory.session() as session:
        for i in range(10):
            _add_template(
                session, f"tpl-{i}", "uniform_terrain.grass.tall",
                ["terrain.grass.tall"], usage=i,
            )
    rows = templates_by_biome(factory, "biome.forest", limit=3)
    assert len(rows) == 3


def test_templates_by_biome_unknown_biome_returns_empty(factory):
    with factory.session() as session:
        _add_template(session, "tpl-x", "uniform_terrain.grass.tall",
                      ["terrain.grass.tall"], usage=1)
    rows = templates_by_biome(factory, "biome.mars")
    assert rows == []


def test_list_biomes_for_templates(factory):
    with factory.session() as session:
        _add_template(session, "tpl-grass", "uniform_terrain.grass.tall",
                      ["terrain.grass.tall"], usage=5)
        _add_template(session, "tpl-cave", "uniform_terrain.cave.floor",
                      ["terrain.cave.floor"], usage=5)
    coverage = list_biomes_for_templates(factory)
    # tpl-grass contributes to forest/route/plains, tpl-cave to
    # cave/dungeon.  Each should appear >= 1.
    assert coverage["biome.forest"] >= 1
    assert coverage["biome.cave"] >= 1
    assert "biome.tropical" not in coverage  # no water tags ingested


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def test_http_templates_by_biome(client, factory):
    with factory.session() as session:
        _add_template(
            session, "tpl-grass", "uniform_terrain.grass.tall",
            ["terrain.grass.tall"], usage=10,
        )
    response = client.get(
        "/v1/grammar/templates/by-biome", params={"biome": "biome.forest"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["biome"] == "biome.forest"
    assert len(body["templates"]) == 1
    assert body["templates"][0]["template_slug"] == "tpl-grass"
    assert body["templates"][0]["total_usage"] == 10
    assert "biome.forest" in body["templates"][0]["biomes"]


def test_http_templates_by_biome_validates_limit(client):
    response = client.get(
        "/v1/grammar/templates/by-biome",
        params={"biome": "biome.forest", "limit": 0},
    )
    assert response.status_code == 400


def test_http_biome_coverage(client, factory):
    with factory.session() as session:
        _add_template(session, "tpl-grass", "uniform_terrain.grass.tall",
                      ["terrain.grass.tall"], usage=5)
        _add_template(session, "tpl-water", "uniform_terrain.water.ocean",
                      ["terrain.water.ocean"], usage=2)
    response = client.get("/v1/grammar/templates/biome-coverage")
    assert response.status_code == 200, response.text
    body = response.json()
    assert "biome.forest" in body["biomes"]
    assert "biome.beach" in body["biomes"]
    assert body["biomes"]["biome.forest"] == 1  # tpl-grass only
