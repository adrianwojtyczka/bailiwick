# Bailiwick

A settlement-building real-time strategy game in the spirit of *The Settlers II*:
you build an economy rather than an army. Claim territory by building, lay the
road network that every good travels along, and grow a handful of huts into a
province that feeds itself.

It runs entirely in the browser, works offline, and is built for a phone as much
as a desktop.

## Playing

Open `index.html` — the built game is committed at the repository root, so
GitHub Pages serves it directly and no build step is needed to play.

- **One finger** drags the map; **two fingers** pinch to zoom.
- **Tap** a point to inspect it — a building, a flag, or open ground.
- **Build** opens the catalogue. Choose a building and the map marks every spot
  it will fit; tap one to start the site. Holding a finger on the map opens the
  same menu where your thumb already is.
- **Lay a road** from any flag, then drag to where it should end. Goods only
  move along roads, and every stretch between two flags gets its own carrier.
- Games save to the device and can be **exported as a file**. Nothing is
  uploaded anywhere.
- `?seed=12345` in the URL generates a specific island, so a map can be shared
  or revisited exactly.

### Getting started in the game

Your headquarters begins with boards, stone, tools and settlers. A woodcutter
needs trees within reach, a sawmill turns its logs into boards, and a quarry
works granite outcrops. Connect each new building to the network with a road, or
nothing will ever reach it. Pair every woodcutter with a forester, or the woods
around it will be gone within the hour.

## Development

```sh
npm install
npm run dev          # development server with hot reload
npm run build        # writes index.html, assets/, sw.js into the repository root
npm test             # unit and simulation tests
npm run test:e2e     # browser tests against the built game
npm run typecheck    # tsc --noEmit
npm run lint
```

Sources live in `src/`; `npm run build` emits the playable game into the
repository root. Those artifacts are committed deliberately — that is what makes
the repository deployable to GitHub Pages as-is. CI checks that they match
`src/`, so rebuild and commit whenever you change the source.

## How it is put together

```
src/
  sim/         the simulation — no DOM, no clock, no Math.random
    core/      lattice geometry, seeded RNG, entity pools, state hashing
    world/     generation, terrain, placement rules
    transport/ flag network, routing, road planning
    data/      wares, buildings, professions as declarative tables
  render/      Canvas 2D renderer, camera, procedurally drawn sprites
  ui/          HUD, title screen, pointer and gesture handling
  platform/    saves, IndexedDB slots, export and import
  game/        fixed-timestep loop and the session tying it together
```

**The simulation is deterministic.** A game is a pure function of its seed and
the commands given to it: no wall-clock reads, no ambient randomness, no DOM.
That is what makes saves small — terrain is regenerated from the seed rather
than stored — and a golden fingerprint test guards it against regressions.

**The map is a lattice of points, not a grid of tiles.** Each point has six
neighbours; terrain lives on the triangles between them, and altitude simply
lifts a point up the screen. This is the geometry the original uses, and it is
why roads, slopes and building sites behave the way they do.

**Terrain is baked into chunk canvases** and blitted, so panning costs a handful
of image copies rather than redrawing a hundred thousand triangles. The renderer
sits behind an interface, leaving room for a WebGL terrain layer later.

**No original Settlers II artwork is used.** Every sprite is drawn in code at
load time, in the parchment-and-ink palette of the title screen — which also
keeps the download to a single script and makes offline play immediate.

## What is in, and what is next

Playable now: the road and carrier network, construction sites that rise as
their materials arrive, settlers taking up trades, a population that grows as
the province does, saving and export, and these chains —

- **Wood and stone** — woodcutters, foresters, sawmills, quarries.
- **Food** — wells, fisheries, farms sowing and reaping their own fields,
  mills, bakeries, pig farms, slaughterhouses, breweries, donkey breeders.
- **Mining** — geologists who go out and survey the rock, marking the one spot
  they struck, and the coal, iron, gold and granite mines sunk on what they
  find. Ore lies well inside a range, so the mountains have to be entered
  properly. Miners must be fed.
- **Metal and tools** — iron smelters, mints, armouries, and a metalworks that
  makes whichever tool the player is shortest of.
- **Territory** — outposts from a barracks to a fortress, each claiming the
  ground that lets a province reach the mountains.

Still to come:

- **Soldiers** — garrisons for the outposts, ranks bought with coin and beer,
  and attacking across a border. The outposts hold ground but stand empty.
- **Hunters** — waiting on game animals, which the map does not yet carry.
- **Expansion** — shipyards, harbours, expeditions, catapults, fog of war.
- **Opponents** — computer players, statistics, and scenario maps.

## Licence

MIT.
