# Working on Bailiwick

A web remake of *The Settlers II*: offline-capable, saves kept on the device and
exportable, playable on a phone. TypeScript and SCSS in `src/`, the built game
committed at the repository root so GitHub Pages serves it as-is.

`README.md` describes the game, how it is put together, and what is built so far
— read it first, and keep its "What is in, and what is next" section honest as
features land.

This file is about *working* on the project: the rules the code holds itself to,
the traps that have already cost time, and how a round of work is expected to be
done.

## How work arrives, and how it is finished

The user plays the game, notices things, and sends a list — often with a save
file (`*.bwsave.gz`) and sometimes a screenshot. Each list is a round. A round
is finished when it is committed **directly on `main`** with the rebuilt root
artifacts and pushed. No pull request unless asked.

The method that has made these rounds trustworthy, in order:

1. **Reproduce before fixing.** Load the save in a scratch probe and get a
   number out: *66 steps through a wall*, *6 crates in one tick*, *4 of the 12
   nodes two out from the rival hall*. A fix with no before-figure is a guess.
2. **Fix.**
3. **Prove every new test discriminates.** Write a shell script that breaks the
   fix in the source — one deliberate breakage at a time — and checks a test
   goes red for each. Weak tests have slipped through before, and this is what
   catches them. Recent rounds ran 12/12, 9/10 and 13/13; when a breakage is
   *not* caught, either strengthen the test or say plainly that it is untested.
4. **Measure, and report the after-figures next to the before.**
5. **Full gate, then commit and push.**

```sh
npm run typecheck && npm run lint && npm test
npm run build            # the committed root artifacts must be rebuilt
npm run test:e2e         # 42 cases, Chromium, ~3 minutes
git add -A && git commit && git push -u origin main
```

CI fails if the committed build does not match `src/`, so `npm run build` is
part of every commit that touches source.

### Probes

Scratch probes go in the session scratchpad, never in the repo, and run under
`npx vite-node`. Loading a save takes a little ceremony because the snapshot
carries typed arrays as base64:

```ts
const raw = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
const d = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const i32 = (s: string) => {
  const c = new Uint8Array(Buffer.from(s, 'base64'));
  return new Int32Array(c.buffer, c.byteOffset, c.byteLength / 4);
};
const m = raw.map;
const sim = Simulation.fromSnapshot({ ...raw, map: { ...m,
  object: d(m.object), objectData: d(m.objectData), resource: d(m.resource),
  resourceAmount: d(m.resourceAmount), resourceKnown: d(m.resourceKnown),
  owner: d(m.owner), roads: d(m.roads),
  building: i32(m.building), flag: i32(m.flag) } } as never);
```

`private` is a compile-time fiction, so a probe can reach in — and can even
replace a private method on the instance to model a proposed rule against the
real save before writing any of it. That is how a plan gets predicted numbers.

An ASCII map of `world.owner` over a window of the lattice is worth more than
any amount of reasoning about borders. Print one.

## The rules the code holds itself to

**The simulation is deterministic.** `src/sim/**` may not touch the DOM, read a
clock, or call `Math.random` — ESLint enforces all three. A game is a pure
function of its seed and its command log. `simulation.test.ts` holds a golden
hash (`sim.hash()` after 1000 ticks of seed 4242) — if it moves, a rule moved
with it. Update it deliberately, never reflexively.

**Nobody is ever moved without walking.** No settler is teleported, ever — not
out of a demolished building, not onto a flag, not into a store. If a man needs
to be somewhere else, he is given a path and walks it. This has been broken and
fixed more than once; a unit test now watches every step of a long real game.

**Everyone goes flag → door or door → flag.** A building is entered and left
only by its own flag. `pathAcross` is the single implementation; `pathOutOf` and
`pathInTo` are thin wrappers over it, and nothing else may route to or from a
building's node.

**Goods cross a doorstep in somebody's hands.** A store has one doorway one man
wide (`takeTheDoorway`), and one porter (`storePorter`). Crates go in and out one
at a time, both directions competing for the same door.

**Territory is derived, never patched.** `redrawTerritory` is the only place
ownership is decided. It runs three passes in this order:

1. **pressure** — every building covering a node pushes `radius − distance + 1`;
   the player pushing hardest in total holds it. Ties go to the incumbent, then
   the older claim (`Building.mannedAt`), then the lower player id.
2. **the edge sweep** — `settleTheEdges` rubs off nodes with fewer than three
   neighbours of their own owner, over the whole map.
3. **the keeps** — `keepBuildingsTheirGround` gives each building back a ring it
   is guaranteed whatever the pressure: `LARGE_KEEP` (2) for a hall, fortress or
   farm, `KEEP` (1) for anything holding ground, and its node and flag for
   everything else. Last of the three, so nothing undoes them.

Two nodes for a large building is what keeps its first ring well inside its own
ground, so no border line can ever run against its wall. One node for a post is
the least that survives the edge sweep, and is what stops a captured post being
razed by the border it has just redrawn.

`redrawTerritory` only re-derives the *area it is given*. Ground outside that
area still reflects an older arrangement — tests asserting global consistency
after one redraw are wrong.

**A building is as old as the day it became its owner's.** `mannedAt` is set
when a post is first manned and reset when it is captured; it is *not* reset
when a post is emptied in a fight and filled again. A headquarters always claims
with `mannedAt: 0` — manned since the beginning, in every case.

## Traps that have already cost time

- **Entity ids are recycled** by `EntityPool`. A stale id in a set or a map will
  quietly attach to whatever is created next. Clean up on destruction.
- **Derived state is rebuilt on load, not saved**: `world.buildingSize`,
  `world.outpost`, `frontierPosts`, `busyDoorways`. Anything derived that is
  added must be rebuilt in `fromSnapshot`.
- **Only *newer* save versions are refused.** Older ones load with defaults
  filled in by `fromSnapshot` — say in the field's doc comment what nought means
  for a save that predates it. `SAVE_VERSION` is 9.
- **Order within a tick matters.** `update()` runs settlers, battles, doorways,
  captures, buildings, roads, growth; a sweep every 40 ticks re-aims stranded
  crates and reconciles reservations. A test that depends on which of two things
  happens first in a tick is a test that will rot — call the method directly.
- **`baseNear` in the test file paints ownership** onto every site it tries
  before settling on one, so the map afterwards is partly the harness's doing.
  Select points by *distance*, not by who currently holds them.
- **`holdIt` restores the garrison it found.** A building planted with an empty
  garrison comes back empty; set the men before calling it.
- **Reservations are a cache of a fact the world already holds.** One missed
  release strands a site for ever. `reconcileIncoming` recounts the truth every
  40 ticks and makes the invariant self-repairing — do not fight it.
- **A stale map in a probe reads as a bug.** A probe that snapshots every
  building's door once and then demolishes one will report the men leaving that
  razed site as walking through a wall. Rebuild such maps each tick.

## Where things are

```
src/sim/simulation.ts        ~5,800 lines; nearly every round lands here
src/sim/simulation.test.ts   ~6,000 lines; the bulk of the suite
src/sim/core/                lattice, seeded RNG, entity pools, hashing
src/sim/world/               generation, terrain, placement rules
src/sim/transport/           flag graph, routing, road planning
src/sim/data/                wares, buildings, professions as tables
src/render/ src/ui/ src/platform/ src/game/   everything outside the sim
tests/e2e/game.spec.ts       42 Playwright cases against the built game
```

The map is a lattice of points with six neighbours (odd-r offset, cube-coordinate
distance via `world.grid.distance`), not a grid of tiles. `TICKS_PER_SECOND` is
20 and the base speed is a quarter, so five ticks a second, 200 ms apiece, with
sub-tick `alpha` for drawing.

Chromium for the e2e tests is pre-installed at `/opt/pw-browsers`; never run
`playwright install`. The e2e island fingerprint compares two runs against each
other (same seed identical, different seed apart) rather than against a stored
literal, so it needs no re-recording when a border rule changes — but it will
catch a change that alters what the opening map looks like.

## House style

The code is commented the way the existing code is commented: comments say *why*
a rule exists and what went wrong without it, in plain English, not what the
next line does. Test names are sentences about behaviour ("keeps a manned post
its first ring, and settles the rest on pressure"). Commit messages are prose,
with the before-and-after figures in them.

Match the surrounding code rather than importing a house style from elsewhere.
When a rule is replaced, rewrite the test that encoded the old one instead of
leaving it to pass vacuously — and say in the report that it was rewritten and
why.

Report honestly. If a test could not be made to discriminate, say so. If a
consequence of a change is visible in play — a post's own flag now standing on
the border line, say — say that too, rather than letting the user find it.
