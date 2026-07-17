# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root via Turborepo (pnpm 10, Node >= 20):

```bash
pnpm dev          # start dev servers (turbo dev)
pnpm build        # build all workspaces
pnpm lint         # eslint across workspaces
pnpm typecheck    # tsc --noEmit across workspaces
pnpm format       # prettier --write
```

Scope any task to a single workspace with `--filter`, e.g. `pnpm --filter web dev` or `pnpm --filter @workspace/ui lint`.

There is no test framework configured in this repo.

### Adding shadcn/ui components

Run from the repo root, targeting the web app:

```bash
pnpm dlx shadcn@latest add <component> -c apps/web
```

Components land in `packages/ui/src/components/` (not in the app) and are imported as `@workspace/ui/components/<name>`.

## Next.js version warning

From AGENTS.md: **this is NOT the Next.js you know.** The installed version (16.x) has breaking changes — APIs, conventions, and file structure may differ from training data. Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next.js code, and heed deprecation notices.

## Architecture

Turborepo + pnpm workspace monorepo based on the shadcn/ui monorepo template:

- `apps/web` — Next.js App Router app (RSC enabled, React 19). App-local code uses `@/components`, `@/hooks`, `@/lib` aliases; shared UI comes from the ui package.
- `packages/ui` — shared `@workspace/ui` package holding all shadcn components, hooks, utils, and the global stylesheet. Consumed via subpath exports: `@workspace/ui/components/*`, `@workspace/ui/hooks/*`, `@workspace/ui/lib/*`, `@workspace/ui/globals.css`.
- `packages/eslint-config`, `packages/typescript-config` — shared lint/TS configs extended by each workspace.

Key stack details that differ from common defaults:

- **UI primitives are Base UI (`@base-ui/react`), not Radix.** Components follow the shadcn "base-lyra" style with `class-variance-authority` variants; see `packages/ui/src/components/button.tsx` for the canonical pattern (`data-slot` attribute, `cn()` from `@workspace/ui/lib/utils`).
- **Tailwind CSS v4** — no `tailwind.config` file; theme and CSS variables live in `packages/ui/src/styles/globals.css`.
- **Icons are Phosphor** (`@phosphor-icons/react`), per `components.json` (`iconLibrary: "phosphor"`).
- **Theming** via `next-themes` (`ThemeProvider` in `apps/web/components/theme-provider.tsx`); fonts are Geist (`--font-sans`), Geist Mono (`--font-mono`), and Lora (`--font-heading`) wired as CSS variables in `apps/web/app/layout.tsx`.
