# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Browser prototype of a Settlers 3/4-style economy game: isometric 2D, sprites, TypeScript + Vite + PixiJS 8. UI text is in Russian. Design spec: `docs/superpowers/specs/2026-10-06-settlers-prototype-design.md`.

## Commands

```bash
npm run dev            # Vite dev server
npm test               # Vitest, all tests (tests/*.test.ts)
npx vitest run tests/world.test.ts          # single file
npx vitest run -t "builds a site"           # single test by name
npm run typecheck      # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm run build          # typecheck + vite build
```

Append `?seed=N` to the dev URL for a reproducible map (the seed is logged to the console). `window.world` exposes the live `World` for poking from DevTools, e.g. `world.placeBuilding('sawmill', x, y)` or calling `world.step()` in a loop to fast-forward.

## Architecture

Three layers with one-way dependencies: `ui → render → sim`. `src/sim` must stay free of DOM/Pixi imports so it runs headless in Vitest.

### Simulation (`src/sim`)
- `World` (`world.ts`) owns everything and advances with `step()` at a fixed 10 ticks/s (`TICKS_PER_SECOND`). It is deterministic: all randomness goes through the seeded `Rng` (`rng.ts`). Never use `Math.random` in sim code.
- Tile coordinates are integers, and a tile's center is the integer point. Settlers store float `x/y` plus `px/py` (the position at the previous tick) so the renderer can interpolate.
- `GameMap` (`map.ts`) is flat typed arrays indexed by `idx(x, y)`: `terrain`, `tree` (0 means none, 1..`TREE_MATURE` are growth stages, and any tree blocks movement), `building`, and `door` (both hold building ids, 0 means none).
- Every building has a **door tile** (`doorOf`: `(x+w-1, y+h)`, in front of the lower-left wall). It is walkable but not buildable. All pickups and drops happen there. For the castle, `output` is the warehouse stock.
- **Settlers run a task queue** (`Settler.tasks`, union type `Task` in `types.ts`). `updateSettler` executes the head task each tick. An empty queue calls `idle()`, which holds per-profession behavior (woodcutter goes for trees, builder looks for sites, carrier goes home). Workers are carriers converted by the `become` task.
- **Reservation invariant:** jobs reserve resources up front (`outReserved` on the source, `inbound` on the destination, `reservedTrees`, `builderId`, `workerRequested`). Any job that can fail must go through `abort()`, which walks the *remaining* tasks and releases what they hold. When you add a task type that reserves something, add its release to `abort()`. `tests/world.test.ts` checks that counters never go negative and that planks are conserved.
- **Logistics:** `dispatch()` runs every `DISPATCH_EVERY` ticks and hands work only to idle carriers, in this priority: worker requests, then demands (sites need planks, sawmills need logs; each matched to the nearest supply), then surplus from producers carried to the castle. Distances use straight lines; A* (`pathfinding.ts`, 8-way, no corner cutting, `adjacent` mode for blocked targets such as trees) runs lazily inside the `goto` task, and the route is recomputed when the next tile becomes blocked.
- Tunables (timings, caps, costs, start resources) live in `config.ts`, and building definitions are in `BUILDINGS`.

### Rendering (`src/render`)
- Isometric projection is in `iso.ts`: tile center `(x, y)` maps to screen `((x-y)*32, (x+y)*16)`. Depth equals `x + y`. `objects` is a single `sortableChildren` container keyed by `zIndex`. Buildings use the depth of their footprint center plus 0.25, the door pile and flag use the door tile's depth minus 0.05, and settlers use their interpolated depth.
- `GameRenderer.sync()` reconciles by **polling sim state every frame** (tree stage cache per tile, view maps keyed by building and settler id). The sim emits no events, so new sim state only needs a matching branch in `sync*`.
- All art is procedural: painters in `sprites.ts` draw with Canvas 2D, and `SpriteAtlas` (`atlas.ts`) packs them into one 2× resolution canvas texture with `defaultAnchor` set per frame. Building painters draw around the **footprint center as origin** and use the `P(dx, dy, z)` helper (tile-unit offsets plus pixel height); their canvas size and anchor live in `BUILDING_CANVAS`. Construction progress is shown by cropping the building texture from the top (`bottomPart`). To add a sprite, write a painter and register it in the `SpriteAtlas` constructor.
- `Sprite.anchor` is taken from `texture.defaultAnchor` only at construction time. After you swap a texture with a different anchor, copy the anchor explicitly.
- Pixi gotcha: `container.removeChildren(begin)` throws when the range is empty. This once froze the whole game loop, because an exception inside the ticker stops it.

### UI and loop (`src/ui`, `src/main.ts`)
- `main.ts` runs a fixed-step accumulator (`speed` multiplies real time, at most 20 ticks per frame) and passes `acc / TICK_MS` to the renderer as the interpolation alpha.
- `GameState` (`ui/state.ts`) is the shared mutable UI state (placing mode, selection, hover, speed). `InputController` handles the camera, placement, and selection. `Hud` is plain DOM rebuilt on a throttle.
- Placement: `World.canPlace` checks the footprint and door (it is used for the green/red ghost). `World.placeBuilding` additionally requires an A* path from the castle door.
