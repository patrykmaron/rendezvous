-- Baseline: codifies the ClickHouse objects that were originally created by
-- hand (introspected via SHOW CREATE TABLE on 2026-07-17). Every statement is
-- idempotent, so applying this to the live service is a no-op that records
-- version 1; applying it to a fresh service recreates the full schema.
-- Engines are written as plain MergeTree/SummingMergeTree — ClickHouse Cloud
-- maps them to SharedMergeTree automatically.
--
-- Data load (separate, one-time): the raw table was populated from the
-- Foursquare OS Places H3 dataset (open_h3.foursquare.os_places_h3_8 via
-- DuckDB -> fsq_places_gb_full.parquet -> clickhouse client), 4,438,857 rows.

CREATE TABLE IF NOT EXISTS rendezvous.foursquare_places_raw
(
    `fsq_place_id` Nullable(String),
    `name` Nullable(String),
    `latitude` Nullable(Float64),
    `longitude` Nullable(Float64),
    `address` Nullable(String),
    `locality` Nullable(String),
    `region` Nullable(String),
    `postcode` Nullable(String),
    `admin_region` Nullable(String),
    `post_town` Nullable(String),
    `po_box` Nullable(String),
    `country` Nullable(String),
    `date_created` Nullable(String),
    `date_refreshed` Nullable(String),
    `date_closed` Nullable(String),
    `tel` Nullable(String),
    `website` Nullable(String),
    `email` Nullable(String),
    `facebook_id` Nullable(Int64),
    `instagram` Nullable(String),
    `twitter` Nullable(String),
    `fsq_category_ids` Array(Nullable(String)),
    `fsq_category_labels` Array(Nullable(String)),
    `placemaker_url` Nullable(String),
    `unresolved_flags` Array(Nullable(String)),
    `geom` Nullable(String),
    `bbox` Tuple(
        xmin Nullable(Float64),
        ymin Nullable(Float64),
        xmax Nullable(Float64),
        ymax Nullable(Float64)),
    `cellId` Nullable(Int64)
)
ENGINE = MergeTree
ORDER BY (ifNull(cellId, 0), ifNull(fsq_place_id, ''))
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS rendezvous.places
(
    `fsq_place_id` String,
    `name` String,
    `latitude` Float64,
    `longitude` Float64,
    `address` String,
    `locality` LowCardinality(String),
    `region` LowCardinality(String),
    `postcode` LowCardinality(String),
    `admin_region` LowCardinality(String),
    `post_town` LowCardinality(String),
    `country` LowCardinality(String),
    `date_created` Nullable(Date),
    `date_refreshed` Nullable(Date),
    `date_closed` Nullable(Date),
    `tel` String,
    `website` String,
    `category_ids` Array(String),
    `category_labels` Array(String),
    `unresolved_flags` Array(String),
    `source_cell_id` Nullable(Int64),
    `h3_7` UInt64 MATERIALIZED geoToH3(latitude, longitude, 7),
    `h3_8` UInt64 MATERIALIZED geoToH3(latitude, longitude, 8),
    `primary_category` LowCardinality(String) MATERIALIZED if(empty(category_labels), '', category_labels[1]),
    `display_area` LowCardinality(String) MATERIALIZED coalesce(nullIf(trimBoth(locality), ''), nullIf(trimBoth(post_town), ''), nullIf(trimBoth(region), ''), nullIf(trimBoth(admin_region), ''), concat('Area ', toString(geoToH3(latitude, longitude, 8)))),
    `is_closed` UInt8 MATERIALIZED toUInt8(isNotNull(date_closed)),
    `has_quality_warning` UInt8 MATERIALIZED toUInt8(notEmpty(unresolved_flags))
)
ENGINE = MergeTree
ORDER BY (h3_7, h3_8, primary_category, fsq_place_id)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS rendezvous.mv_raw_to_places TO rendezvous.places
AS SELECT
    ifNull(fsq_place_id, '') AS fsq_place_id,
    ifNull(name, '') AS name,
    assumeNotNull(latitude) AS latitude,
    assumeNotNull(longitude) AS longitude,
    ifNull(address, '') AS address,
    ifNull(locality, '') AS locality,
    ifNull(region, '') AS region,
    ifNull(postcode, '') AS postcode,
    ifNull(admin_region, '') AS admin_region,
    ifNull(post_town, '') AS post_town,
    ifNull(country, '') AS country,
    toDateOrNull(ifNull(date_created, '')) AS date_created,
    toDateOrNull(ifNull(date_refreshed, '')) AS date_refreshed,
    toDateOrNull(ifNull(date_closed, '')) AS date_closed,
    ifNull(tel, '') AS tel,
    ifNull(website, '') AS website,
    arrayMap(value -> ifNull(value, ''), fsq_category_ids) AS category_ids,
    arrayMap(value -> ifNull(value, ''), fsq_category_labels) AS category_labels,
    arrayMap(value -> ifNull(value, ''), unresolved_flags) AS unresolved_flags,
    cellId AS source_cell_id
FROM rendezvous.foursquare_places_raw
WHERE (latitude IS NOT NULL) AND (longitude IS NOT NULL)
  AND ((latitude >= -90) AND (latitude <= 90))
  AND ((longitude >= -180) AND (longitude <= 180))
  AND notEmpty(ifNull(fsq_place_id, ''));

CREATE TABLE IF NOT EXISTS rendezvous.area_category_counts
(
    `h3_8` UInt64,
    `category_label` LowCardinality(String),
    `place_count` UInt64
)
ENGINE = SummingMergeTree
ORDER BY (h3_8, category_label)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS rendezvous.mv_places_to_area_category_counts TO rendezvous.area_category_counts
AS SELECT
    h3_8,
    category_label,
    count() AS place_count
FROM rendezvous.places
ARRAY JOIN category_labels AS category_label
WHERE (is_closed = 0) AND notEmpty(category_label)
GROUP BY h3_8, category_label;
