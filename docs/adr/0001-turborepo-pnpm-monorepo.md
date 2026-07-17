# 0001. Use a Turborepo + pnpm monorepo based on the shadcn/ui template

**Status:** Accepted
**Date:** 2026-07-17

## Context

Rendezvous is a hackathon project with several deliverables that share code: a Next.js web app, Trigger.dev background tasks, a database layer used by both, and a UI component library. Time is the scarcest resource; repo plumbing must be a solved problem, not a project.

## Decision

We will use a single Turborepo + pnpm workspace monorepo, bootstrapped from the shadcn/ui monorepo template (`apps/*`, `packages/*`). Shared code lives in `@workspace/*` packages; lint/TS configs are themselves workspace packages. The template also fixes the UI stack: shadcn/ui components on Base UI primitives, Tailwind CSS v4, Phosphor icons.

Alternatives considered: separate repos (rejected — cross-repo versioning overhead is fatal at hackathon pace), a plain pnpm workspace without Turborepo (workable, but Turborepo's task graph and caching come free with the template).

## Consequences

- One `pnpm install`, one `pnpm lint/typecheck/build` across everything; `--filter` scopes to a workspace.
- Workspace packages can ship raw TypeScript and let consumers compile (see [0003](0003-shared-db-package-raw-ts.md)).
- We inherit the template's conventions (flat eslint configs, shared tsconfig bases) and follow them for new packages.
- Next.js is 16.x (pre-release line) — its shipped docs in `node_modules/next/dist/docs` are the reference, not prior knowledge.
