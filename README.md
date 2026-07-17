<p align="center">
  <img alt="Rendezvous" width="100%" src="https://shieldcn.dev/header/graph.svg?title=Rendezvous&subtitle=Find+the+place+that+works+for+everyone&logo=ri%3AFaMapMarkedAlt&mode=dark" />
</p>

<p align="center">
  <img alt="ClickHouse" src="https://img.shields.io/badge/ClickHouse-FFCC01?style=for-the-badge&logo=clickhouse&logoColor=black" />
  <img alt="Trigger.dev" src="https://img.shields.io/badge/Trigger.dev-121317?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgdmlld0JveD0iMCAwIDEyMCAxMjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI%2BCjxwYXRoIGZpbGxSdWxlPSJldmVub2RkIiBjbGlwUnVsZT0iZXZlbm9kZCIgZD0iTTQxLjY4ODkgNTIuMjc5NUw2MC40MTk1IDIwTDEwNi44MzkgMTAwSDE0TDMyLjczMDUgNjcuNzE5NUw0NS45ODAxIDc1LjMzMTJMNDAuNTAwMyA4NC43NzU2SDgwLjMzODdMNjAuNDE5NSA1MC40NDc4TDU0LjkzOTYgNTkuODkyMkw0MS42ODg5IDUyLjI3OTVaIiBmaWxsPSJ1cmwoI3BhaW50MF9saW5lYXJfMTczXzExNykiLz4KPGRlZnM%2BCjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8xNzNfMTE3IiB4MT0iODkuMTY3NSIgeTE9IjEwMCIgeDI9Ijg4LjMwOTQiIHkyPSI0My41MjI1IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI%2BCjxzdG9wIHN0b3AtY29sb3I9IiM0MUZGNTQiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRTdGRjUyIi8%2BCjwvbGluZWFyR3JhZGllbnQ%2BCjwvZGVmcz4KPC9zdmc%2BCg%3D%3D" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" />
  <img alt="Drizzle" src="https://img.shields.io/badge/Drizzle-C5F74F?style=for-the-badge&logo=drizzle&logoColor=black" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" />
  <img alt="Turborepo" src="https://img.shields.io/badge/Turborepo-EF4444?style=for-the-badge&logo=turborepo&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-F69220?style=for-the-badge&logo=pnpm&logoColor=white" />
</p>

**Rendezvous** is a multiplayer AI planning agent that helps a group organise a day out in London — and answers with an interactive visual canvas, not a wall of text.

Everyone joins a room, drops their starting point, and adds their constraints in plain chat: transport preferences, budget, dietary needs, step-free access, "I can't leave before 6pm". Rendezvous then finds the meeting spot that is **fairest for the whole group** — because the geographic midpoint is rarely the fairest place to meet. A spot 20 minutes from everyone beats a spot 5 minutes from one person and 50 from another.

Built for the **ClickHouse & Trigger.dev Virtual Summer Hackathon 2026** — theme: *Beyond the Wall of Text*.

## How it works

Every response that matters is rendered, not written: travel-time contours, participant journey rays, fairness scores, candidate trade-off charts, venue clusters, and a final itinerary timeline on a shared canvas.

```mermaid
flowchart LR
    A[Group chat<br/>origins + constraints] --> B[(Postgres<br/>rooms · events · revisions)]
    B --> C{{Trigger.dev<br/>analysis workflow}}
    C --> D[(ClickHouse<br/>4.4M UK places · H3 grid)]
    C --> E[TfL Journey<br/>Planner API]
    E --> F[(ClickHouse<br/>route_observations)]
    D --> G[(ClickHouse<br/>candidate_scores)]
    F --> G
    G --> H[Plan snapshot<br/>ranked fair candidates]
    H --> I[Interactive canvas<br/>maps · charts · timelines]
```

The analysis funnel keeps routing cheap and ranking powerful:

1. **Generate candidate areas** in ClickHouse from the group's travel envelope, on the H3 hexagonal grid.
2. **Route each participant** to ~20–30 candidate centroids via the TfL Journey Planner API (Trigger.dev fans these out in parallel).
3. **Score in ClickHouse**: journey time spread, interchanges, walking, accessibility, and venue coverage per cell → a single fairness ranking.
4. **Fetch venues only for the finalists** from the 4.4M-row Foursquare OS Places dataset, matched to the group's food/activity constraints.

## Where ClickHouse and Trigger.dev do the heavy lifting

**ClickHouse Cloud** is the analytical core:

- `places` — a cleaned serving table of **4,438,857 UK Foursquare OS Places**, ordered by H3 cells (`geoToH3` materialized columns) for fast geospatial candidate generation.
- `area_category_counts` — a SummingMergeTree aggregate (2.5M rows) answering "which areas have the venue mix this group wants?" instantly.
- `route_observations` / `candidate_scores` — every journey result and the ranked fairness output of each analysis run.
- Incremental materialized views transform raw ingested data into serving tables on insert; schema is fully codified in versioned SQL migrations.

**Trigger.dev** orchestrates every analysis:

- A workflow per room revision: wait for replicated state → generate candidates → fan out route calculations in parallel → insert observations → rank in ClickHouse → write the plan snapshot back to Postgres.
- Progress streams to the canvas while it runs ("Comparing 30 candidate areas… calculating 120 journeys…").

**ClickHouse Managed Postgres** (via Drizzle ORM) is the transactional source of truth: rooms, participants, constraints, votes, messages, and an append-only `room_events` log with per-room revisions — the backbone for reproducible analyses and (via CDC) plan-evolution analytics.

## Monorepo layout

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 16 app — chat, shared canvas, API routes |
| `packages/db` | `@workspace/db` — Drizzle schema + Postgres client, ClickHouse client + SQL migrations for both databases |
| `packages/tasks` | `@workspace/tasks` — Trigger.dev workflows |
| `packages/ui` | `@workspace/ui` — shared shadcn/ui components (Base UI + Tailwind v4) |
| `packages/eslint-config` / `packages/typescript-config` | shared tooling configs |

## Getting started

Requires Node ≥ 20 and pnpm 10.

```bash
pnpm install

# one-time env setup
cp .env.example .env          # fill in database credentials
ln -s ../../.env apps/web/.env
ln -s ../../.env packages/tasks/.env

# apply database migrations
pnpm --filter @workspace/db db:migrate   # Postgres (Drizzle)
pnpm --filter @workspace/db ch:migrate   # ClickHouse

# verify both databases end-to-end
pnpm --filter @workspace/db smoke

# run it
pnpm dev                                  # Next.js app
npx trigger.dev@latest dev                # Trigger.dev worker (from packages/tasks)
```

`GET /api/health` reports live connectivity to both databases.

### Database workflows

```bash
pnpm --filter @workspace/db db:generate   # new Postgres migration from schema changes
pnpm --filter @workspace/db db:migrate    # apply Postgres migrations
pnpm --filter @workspace/db ch:migrate    # apply ClickHouse migrations (numbered SQL files)
pnpm --filter @workspace/db db:studio     # browse Postgres with Drizzle Studio
```

Applied migrations are immutable (enforced by Drizzle's journal and `clickhouse-migrations` checksums) — always add a new file.

## License

[Apache 2.0](LICENSE)
