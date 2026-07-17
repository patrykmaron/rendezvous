# 0010. Bundler module resolution and TypeScript 5 across shared packages

**Status:** Accepted
**Date:** 2026-07-17

## Context

The shared tsconfig base uses `moduleResolution: NodeNext`, which requires `.js` extensions on relative imports. In practice, `@workspace/db` is never executed by plain Node from source — every consumer compiles it: Turbopack (Next 16 `transpilePackages`), esbuild (Trigger.dev, tsx), drizzle-kit. Empirically, **Turbopack fails to resolve `.js`-extension specifiers to `.ts` files inside transpiled workspace packages** (`Module not found: Can't resolve '../env.js'`). Separately, `packages/tasks` had `typescript: "latest"`, which resolved to the TypeScript 7 native preview — it broke automatic `@types/node` discovery and triggered peer-dependency warnings; its `tsc` emit build was also misconfigured (config file outside `rootDir`) and its output was vestigial anyway.

## Decision

- Shared raw-TS packages (`packages/db`, `packages/tasks`) override to **`module: Preserve` + `moduleResolution: Bundler`** and use **extensionless relative imports** — the resolution model that matches how the code is actually consumed.
- **TypeScript is pinned to `^5.x` in every workspace**; no `"latest"`. The TS 7 preview can be adopted deliberately, repo-wide, when it's ready.
- `packages/tasks` is **typecheck-only** (`tsc --noEmit`, no build/dev scripts) — Trigger.dev's own bundler is the only real build path, matching how `packages/ui` ships.

## Consequences

- One import style works identically under Turbopack, esbuild, tsx, and `tsc --noEmit`.
- These packages are not directly runnable by plain Node from source — irrelevant, since no consumer does that.
- New shared packages must copy this tsconfig pattern rather than inheriting NodeNext from the base config.
