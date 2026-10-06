# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Browser prototype of a Settlers 3/4-style economy game: isometric 2D, sprites, TypeScript + Vite + PixiJS 8. UI text is in Russian. Design spec: `docs/superpowers/specs/2026-10-06-settlers-prototype-design.md`. Long-term plan toward Settlers 4 parity, with phases and known tech debt: `docs/ROADMAP.md` — check it before starting a new feature and keep it current.

## Workflow

Once a change is verified (tests and typecheck pass, and the game has been checked in the browser when rendering or UI changed), commit and push to `origin main` without asking. Update `README.md` (player-facing, in Russian) and this file in the same commit whenever the change affects them.

## Scalability is a hard requirement

The target is Settlers 4 scale, so every change must scale along three axes:
- **Content:** a new building, profession, resource or recipe is a data entry in `config.ts` (plus a sprite), never a new `if (type === ...)` branch in sim logic. If a feature cannot be expressed as data, extend the data model (a new `Behavior`, a new rule table) rather than special-casing a type.
- **Players:** everything that belongs to someone carries an `owner` (`PlayerId`); logic filters by owner and never assumes a single player. `LOCAL_PLAYER` is only a default for UI-facing calls.
- **Size:** no hard-coded map dimensions or population assumptions; per-tick work must stay roughly proportional to active entities, not to map area or to entities squared. Measure with the hour-long probe before and after.

## Commands

```bash
npm run dev            # Vite dev server
npm test               # Vitest, all tests (tests/*.test.ts)
npx vitest run tests/world.test.ts          # single file
npx vitest run -t "builds a site"           # single test by name
npm run typecheck      # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm run build          # typecheck + vite build
npm run sim:probe      # economy health: standard opening, 60 min on 4 seeds (--seeds= --minutes= --size=)
npm run sim:bench      # sim performance: 256×256 map, 1000 settlers (--size= --settlers= --ticks=)
```

Run `sim:probe` before and after any change to economy logic or balance, and `sim:bench` before and after anything that touches per-tick work. Reference numbers (Apple Silicon, phase 0): 256×256 with 1000 settlers ≈ 1.1 ms/tick, 3000 settlers ≈ 2.9 ms/tick; a 64×64 hour of play ≈ 0.004 ms/tick.

Append `?seed=N` to the dev URL for a reproducible map (the seed is logged to the console) and `?size=N` for another map size; `?load=1` restores the browser save slot. `window.world` exposes the live `World` for poking from DevTools, e.g. `world.placeBuilding('sawmill', x, y)` or calling `world.step()` in a loop to fast-forward.

## Architecture

Three layers with one-way dependencies: `ui → render → sim`. `src/sim` must stay free of DOM/Pixi imports so it runs headless in Vitest.

### Simulation (`src/sim`)
- `World` (`world.ts`) holds all state and the public API and advances with `step()` at a fixed 10 ticks/s (`TICKS_PER_SECOND`). Logic lives in sibling modules that take the world as first argument: `buildings.ts` (creation, workshop recipes, territory), `settlers.ts` (task execution, per-behavior idle logic, `abort`), `logistics.ts` (dispatcher, demand), `nature.ts` (trees, planting, gather rules). Fields those modules mutate are public on `World` under "Internal state shared by the sim modules".
- It is deterministic: all randomness goes through the seeded `Rng` (`rng.ts`). Never use `Math.random` in sim code.
- Tile coordinates are integers, and a tile's center is the integer point. Settlers store float `x/y` plus `px/py` (the position at the previous tick) so the renderer can interpolate.
- `GameMap` (`map.ts`) is flat typed arrays indexed by `idx(x, y)`: `terrain`, `tree` (0 means none, 1..`TREE_MATURE` are growth stages, and any tree blocks movement), `stone` (units left in a deposit; blocks while > 0), `owner` (player id, 0 = nobody), `building`, and `door` (both hold building ids, 0 means none).
- Every building has a **door tile** (`doorOf`: `(x+w-1, y+h)`, in front of the lower-left wall). It is walkable but not buildable. All pickups and drops happen there. For warehouses (`storage: true`, e.g. the castle), `output` is the stock.
- **Settlers run a task queue** (`Settler.tasks`, union type `Task` in `types.ts`). `updateSettler` executes the head task each tick. An empty queue calls `idle()`, which switches on the profession's `Behavior` from the `PROFESSIONS` table (carrier, builder, gather, plant, workshop, garrison). Workers are carriers converted by the `become` task.
- **Reservation invariant:** jobs reserve resources up front (`outReserved` on the source, `inbound` on the destination, `reservedTargets`, `reservedPlots`, `builderId`, `workerRequested`). Any job that can fail must go through `abort()`, which walks the *remaining* tasks and releases what they hold. When you add a task type that reserves something, add its release to `abort()`. `tests/world.test.ts` checks that counters never go negative and that planks and stone are conserved.
- **Connectivity invariant:** anything that turns a walkable tile into a blocked one at runtime (forester planting, natural tree spread, building footprints via `canPlace`) must first pass `staysConnected` (`pathfinding.ts`): a conservative local check that blocking the tile does not cut any route. `regions.ts` relies on it: walkable regions are a union-find that never needs splitting, so `findPath` rejects unreachable goals in O(1) instead of flooding the map. Anything that makes a tile walkable at runtime must call `markWalkable` (harvest already does).
- **Tile change tracking:** every runtime write to `map.tree` or `map.stone` must be followed by `map.touch(i)`, which bumps the tile's chunk version; the renderer re-scans only changed chunks.
- `findPath` reuses per-map scratch buffers (cost follows nodes explored, not map area) and counts work in `pathStats` for the bench.
- **Failure handling:** a `goto` with no route calls `routeFailed`: the job's target building gets `unreachableUntil` (logistics, builders and storage lookup skip it via `isReachable`), the job is aborted and the settler waits `PATH_FAIL_BACKOFF` ticks instead of retrying every tick. `abort()` sends goods in hand back to the nearest warehouse (`drop` with `back: true`); only if that trip fails too is the unit counted in `stats.lost`. Builders without material for `BUILDER_STALL_TICKS` move to a site that has some.
- **Logistics:** `dispatch()` runs every `DISPATCH_EVERY` ticks, per player, and hands work only to that player's idle carriers, in this priority: worker requests, then demands (`demand()`: site materials from `cost`, workshop inputs from `recipe.inputs`; each matched to the nearest supply), then producers' surplus carried to the nearest warehouse. Distances use straight lines; A* (`pathfinding.ts`, 8-way, no corner cutting, `adjacent` mode for blocked targets such as trees) runs lazily inside the `goto` task, and the route is recomputed when the next tile becomes blocked.
- **Buildings are data** (`BUILDINGS` in `config.ts`): `cost`, `worker`, `storage` (warehouse), `recipe` (workshop inputs → outputs per `ticks`, run by `updateBuilding` while the worker is inside), `territory` (radius). **Gatherers** share one code path: a profession's `gather` def (resource, radius, timings) plus `GATHER_RULES` in `nature.ts` (which tile qualifies and what working it does). A new gathering profession is a `PROFESSIONS` entry plus, for a new resource, a rule.
- **Territory:** `map.owner` holds the owning player per tile. `recomputeTerritory()` rebuilds it from scratch out of buildings with a `territory` radius (worker-less ones like the castle once done, others once their worker has moved in via `become`; earlier buildings win overlaps) and bumps `territoryVersion`, which the renderer polls to redraw the dimming and border. `canPlace` requires the footprint and door to be owned; `isGatherTarget` and `canPlant` only accept owned tiles, so gatherers and foresters never work outside the border.
- Building costs are multi-resource (`cost: Partial<Stock>`); always read them through `costOf()` / `totalCost()`. Construction takes one work shift per delivered unit of any material.
- **Save/load** (`save.ts`): `saveWorld` snapshots everything to plain JSON (map layers as base64, `Rng.state`, buildings in id order); `World.load` restores it, and `tests/save.test.ts` asserts a loaded world continues bit-for-bit like the original. When you add simulation state, add it to `SaveData` and bump `SAVE_VERSION` if old saves can no longer load. Keep sim state plain data (no closures, class instances or functions) so it stays serializable.
- Tunables (timings, caps, costs, start resources) live in `config.ts`.

### Rendering (`src/render`)
- Isometric projection is in `iso.ts`: tile center `(x, y)` maps to screen `((x-y)*32, (x+y)*16)`. Depth equals `x + y`. `objects` is a single `sortableChildren` container keyed by `zIndex`. Buildings use the depth of their footprint center plus 0.25, the door pile and flag use the door tile's depth minus 0.05, and settlers use their interpolated depth.
- `GameRenderer.sync()` reconciles by **polling sim state every frame** (view maps keyed by building and settler id; trees/deposits only in chunks whose `chunkVersion` changed; territory only in chunks whose owners changed). The sim emits no events, so new sim state only needs a matching branch in `sync*`.
- **Culling by chunk** (`CHUNK` = 16 tiles): ground, territory overlay and static objects (trees, rocks, deposits, buildings) are registered per chunk via `addStatic`/`removeStatic` and sit in the scene only while their chunk intersects the camera's `viewRect`; settlers join `objects` only while on screen. Per-frame sorting and drawing therefore follow the screen, not the map. New world objects must go through `addStatic` rather than `objects.addChild`.
- All art is procedural: painters in `sprites.ts` draw with Canvas 2D, and `SpriteAtlas` (`atlas.ts`) packs them into one 2× resolution canvas texture with `defaultAnchor` set per frame. Building painters draw around the **footprint center as origin** and use the `P(dx, dy, z)` helper (tile-unit offsets plus pixel height); their canvas size and anchor live in `BUILDING_CANVAS`. Construction progress is shown by cropping the building texture from the top (`bottomPart`). To add a sprite, write a painter and register it in the `SpriteAtlas` constructor.
- `Sprite.anchor` is taken from `texture.defaultAnchor` only at construction time. After you swap a texture with a different anchor, copy the anchor explicitly.
- Pixi gotcha: `container.removeChildren(begin)` throws when the range is empty. This once froze the whole game loop, because an exception inside the ticker stops it.

### UI and loop (`src/ui`, `src/main.ts`)
- `main.ts` runs a fixed-step accumulator (`speed` multiplies real time, at most 20 ticks per frame) and passes `acc / TICK_MS` to the renderer as the interpolation alpha.
- `GameState` (`ui/state.ts`) is the shared mutable UI state (placing mode, selection, hover, speed). `InputController` handles the camera, placement, and selection. `Hud` is plain DOM rebuilt on a throttle.
- Placement: `World.canPlace` checks the footprint and door (it is used for the green/red ghost). `World.placeBuilding` additionally requires an A* path from the castle door.
