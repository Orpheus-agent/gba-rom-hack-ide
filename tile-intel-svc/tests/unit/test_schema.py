"""Phase 8A-5 - Schema creation + cross-dialect portability.

Verifies the SQLAlchemy models declare cleanly + create_all works
against SQLite (proxy for cross-dialect portability - Postgres has
already been verified via `alembic upgrade head` in dev).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import inspect

from tile_intel.domain.models import (
    AdjacencyObservation,
    AdjacencyRule,
    Behavior,
    EmbeddingsLookup,
    Metatile,
    MetatileTag,
    Palette,
    TagTaxonomy,
    Template,
    Tile,
    Tileset,
)
from tile_intel.storage.base import make_inmemory_factory


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


def test_all_14_tables_exist(factory):
    """The Phase 8 plan promises 14 application tables; the
    inspector should see all of them after create_all."""
    inspector = inspect(factory.engine)
    table_names = set(inspector.get_table_names())
    expected = {
        "tilesets",
        "tiles",
        "metatiles",
        "palettes",
        "behaviors",
        "tag_taxonomy",
        "metatile_tags",
        "tile_tags",
        "adjacency_observations",
        "adjacency_rules",
        "adjacency_patterns",
        "templates",
        "template_usage",
        "embeddings_lookup",
    }
    missing = expected - table_names
    assert not missing, f"Missing tables: {missing}"
    assert len(expected) == 14


def test_tileset_crud_round_trip(factory):
    """Insert a tileset + tile + metatile + palette; read them back."""
    with factory.session() as session:
        ts = Tileset(
            slug="test-frlg-primary-pallet",
            display_name="Test Pallet",
            family="frlg",
            is_secondary=False,
            is_compressed=True,
            scope="global",
            source="pret-firered",
            source_commit="abc1234567",
            license_spdx="MIT",
            attribution="pret",
            content_hash=b"\x00" * 32,
            raw_bytes_size=1024,
        )
        session.add(ts)
        session.flush()
        ts_id = ts.id
        session.add(
            Palette(
                tileset_id=ts_id,
                palette_index=0,
                colors_bgr555=b"\x00" * 32,
                median_cut_5=["#000000", "#111111"],
                dominant_hue=None,
                luminance_avg=12,
            )
        )
        session.add(
            Tile(
                tileset_id=ts_id,
                tile_index=0,
                pixel_bytes=b"\x00" * 64,
                content_hash=b"\x01" * 32,
                palette_neutral_hash=b"\x02" * 32,
                phash=b"\x00" * 8,
                is_blank=True,
                is_horizontal_symm=True,
                is_vertical_symm=True,
            )
        )
        session.add(
            Metatile(
                tileset_id=ts_id,
                metatile_index=0,
                behavior_id=0,
                terrain_type=0,
                encounter_type=0,
                layer_type=0,
                attr_raw=b"\x00\x00\x00\x00",
                composition=[
                    {"layer": 0, "quad": 0, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0}
                ],
                rendered_hash=b"\x03" * 32,
                phash=b"\x00" * 8,
                is_walkable=True,
                is_surfable=False,
                is_encounter_grass=False,
            )
        )
    with factory.session() as session:
        ts = session.query(Tileset).filter_by(slug="test-frlg-primary-pallet").one()
        assert ts.family == "frlg"
        assert len(ts.palettes) == 1
        assert ts.palettes[0].median_cut_5 == ["#000000", "#111111"]
        assert len(ts.tiles) == 1
        assert ts.tiles[0].is_blank is True
        assert len(ts.metatiles) == 1
        assert ts.metatiles[0].composition[0]["tileIndex"] == 0


def test_unique_constraints(factory):
    """The plan calls out several unique constraints - verify a
    representative one fires (tileset slug). The rest follow the
    same SQL idiom."""
    with factory.session() as session:
        session.add(
            Tileset(
                slug="dup",
                display_name="A",
                family="frlg",
                is_secondary=False,
                is_compressed=False,
                scope="global",
                source="pret-firered",
                content_hash=b"\x00" * 32,
                raw_bytes_size=0,
            )
        )
    with pytest.raises(Exception):
        with factory.session() as session:
            session.add(
                Tileset(
                    slug="dup",  # collision
                    display_name="B",
                    family="frlg",
                    is_secondary=False,
                    is_compressed=False,
                    scope="global",
                    source="pret-firered",
                    content_hash=b"\x01" * 32,
                    raw_bytes_size=0,
                )
            )


def test_taxonomy_self_reference(factory):
    """tag_taxonomy.parent_id is a self-FK; verify a parent / child
    pair persists and reads back via the relationship."""
    with factory.session() as session:
        terrain = TagTaxonomy(slug="terrain", axis="terrain", display_name="Terrain", is_leaf=False)
        session.add(terrain)
        session.flush()
        session.add(
            TagTaxonomy(
                slug="terrain.grass",
                parent_id=terrain.id,
                axis="terrain",
                display_name="Grass",
                is_leaf=False,
            )
        )
    with factory.session() as session:
        child = session.query(TagTaxonomy).filter_by(slug="terrain.grass").one()
        assert child.parent is not None
        assert child.parent.slug == "terrain"


def test_metatile_tags_many_to_many(factory):
    """The classification surface is many-to-many between metatiles
    and tags. Verify the join table behaves."""
    with factory.session() as session:
        ts = Tileset(
            slug="mt-tag-ts",
            display_name="x",
            family="frlg",
            is_secondary=False,
            is_compressed=False,
            scope="global",
            source="pret-firered",
            content_hash=b"\x00" * 32,
            raw_bytes_size=0,
        )
        session.add(ts)
        session.flush()
        mt = Metatile(
            tileset_id=ts.id,
            metatile_index=0,
            behavior_id=0,
            terrain_type=0,
            encounter_type=0,
            layer_type=0,
            attr_raw=b"\x00",
            composition=[],
            rendered_hash=b"\x00" * 32,
            phash=b"\x00" * 8,
            is_walkable=True,
            is_surfable=False,
            is_encounter_grass=False,
        )
        session.add(mt)
        session.flush()
        tag = TagTaxonomy(slug="terrain.grass.tall", axis="terrain", display_name="Tall grass", is_leaf=True)
        session.add(tag)
        session.flush()
        session.add(
            MetatileTag(
                metatile_id=mt.id,
                tag_id=tag.id,
                confidence=0.85,
                source="clip",
            )
        )
    with factory.session() as session:
        mt = session.query(Metatile).first()
        assert mt is not None
        assert len(mt.tags) == 1
        assert mt.tags[0].source == "clip"
        assert float(mt.tags[0].confidence) == pytest.approx(0.85)


def test_adjacency_observation_and_rule(factory):
    """Observations + rules tables - both keyed on metatile IDs.
    Demonstrate the rule's JSON columns serialise correctly."""
    with factory.session() as session:
        ts = Tileset(
            slug="adj-ts",
            display_name="x",
            family="frlg",
            is_secondary=False,
            is_compressed=False,
            scope="global",
            source="pret-firered",
            content_hash=b"\x00" * 32,
            raw_bytes_size=0,
        )
        session.add(ts)
        session.flush()
        m_a = Metatile(
            tileset_id=ts.id,
            metatile_index=0,
            behavior_id=0,
            terrain_type=0,
            encounter_type=0,
            layer_type=0,
            attr_raw=b"\x00",
            composition=[],
            rendered_hash=b"\xaa" * 32,
            phash=b"\x00" * 8,
            is_walkable=True,
            is_surfable=False,
            is_encounter_grass=False,
        )
        m_b = Metatile(
            tileset_id=ts.id,
            metatile_index=1,
            behavior_id=0,
            terrain_type=0,
            encounter_type=0,
            layer_type=0,
            attr_raw=b"\x00",
            composition=[],
            rendered_hash=b"\xbb" * 32,
            phash=b"\x01" * 8,
            is_walkable=True,
            is_surfable=False,
            is_encounter_grass=False,
        )
        session.add_all([m_a, m_b])
        session.flush()
        session.add(
            AdjacencyObservation(
                metatile_a=m_a.id,
                metatile_b=m_b.id,
                direction=2,  # east
                frequency=47,
                source_corpus="pret-frlg-pallet-town",
                scope="global",
            )
        )
        session.add(
            AdjacencyRule(
                metatile_a=m_a.id,
                direction=2,
                legal_neighbors=[
                    {"metatile_b": m_b.id, "probability": 0.91, "freq": 47},
                ],
                hard_legal_set=[m_b.id],
                total_observations=47,
                entropy=0.45,
                scope="global",
            )
        )
    with factory.session() as session:
        obs = session.query(AdjacencyObservation).one()
        assert obs.direction == 2
        assert obs.frequency == 47
        rule = session.query(AdjacencyRule).one()
        assert rule.hard_legal_set == [obs.metatile_b]
        assert rule.legal_neighbors[0]["probability"] == 0.91


def test_embeddings_lookup_indexes(factory):
    """The embeddings_lookup table is hit twice per query
    (entity -> uuid + uuid -> metadata). Verify the row inserts and the
    indexes exist."""
    with factory.session() as session:
        session.add(
            EmbeddingsLookup(
                uuid_str=str(uuid.uuid4()),
                collection="metatiles_v1",
                entity_kind="metatile",
                entity_id=42,
                model="open-clip-vit-b-32",
                model_version="1.0.0",
                dim=512,
            )
        )
    with factory.session() as session:
        rec = session.query(EmbeddingsLookup).one()
        assert rec.collection == "metatiles_v1"
        assert rec.dim == 512

    inspector = inspect(factory.engine)
    index_names = {idx["name"] for idx in inspector.get_indexes("embeddings_lookup")}
    assert "idx_emb_lookup_entity" in index_names
    assert "idx_emb_lookup_collection_model" in index_names


def test_behaviors_seed_table(factory):
    """behaviors table is the pret-enum seed; verify upsert + read."""
    with factory.session() as session:
        session.add(
            Behavior(
                id=2,
                family="frlg",
                name="MB_TALL_GRASS",
                category="encounter",
                walkable=True,
                has_encounter=True,
                description="Tall grass - wild Pokemon encounters.",
            )
        )
    with factory.session() as session:
        b = session.query(Behavior).filter_by(id=2).one()
        assert b.name == "MB_TALL_GRASS"
        assert b.walkable is True


def test_template_with_tag_slot_cells(factory):
    """Templates can carry cells with tag-slot references (e.g.
    `{"tag_slug": "terrain.grass", "slot_name": "filler"}`) so one
    template adapts to multiple host tilesets."""
    with factory.session() as session:
        session.add(
            Template(
                slug="house.small.frlg",
                display_name="Small house facade",
                role="building",
                width=2,
                height=3,
                cells=[
                    [{"metatile_index": 100}, {"metatile_index": 101}],
                    [{"metatile_index": 102}, {"metatile_index": 103}],
                    [
                        {"tag_slug": "terrain.dirt", "slot_name": "filler"},
                        {"tag_slug": "terrain.dirt", "slot_name": "filler"},
                    ],
                ],
                anchor_x=0,
                anchor_y=0,
                required_tags=["biome.town"],
                scope="global",
            )
        )
    with factory.session() as session:
        t = session.query(Template).filter_by(slug="house.small.frlg").one()
        assert t.width == 2 and t.height == 3
        assert t.cells[2][0]["tag_slug"] == "terrain.dirt"
        assert t.required_tags == ["biome.town"]


def test_drop_all_clears_everything(factory):
    """drop_all should remove all 14 tables."""
    factory.drop_all()
    inspector = inspect(factory.engine)
    remaining = set(inspector.get_table_names())
    assert remaining == set()
