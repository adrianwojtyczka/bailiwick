# Bailiwick

A settlement-building real-time strategy game in the spirit of *The Settlers II*:
the economy is the army. Claim territory by building, lay the road network that
every good travels along, and grow a handful of huts into a province that feeds
itself — and then arms itself, because a frontier is only held by men a whole
chain of trades had to produce.

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
- **Attack** by tapping an enemy post and choosing how many men to send. Your
  nearby outposts answer: all their spare men within twelve nodes, two thirds
  within sixteen, a third within twenty, and nobody at all beyond — so reaching
  further into a neighbour's ground means building towards him first.
- Games save to the device and can be **exported as a file**. Nothing is
  uploaded anywhere.
- `?seed=12345` in the URL generates a specific island, so a map can be shared
  or revisited exactly.
- Every island is **the same country twice**: one long map, its eastern half the
  western half turned half a turn about the middle. You open in the west and the
  rival in the east, with identical ground, identical woods and identical ore —
  and one continuous island between you to march across.
- Every start has **a mountain with iron and coal in reach**, about a dozen
  nodes of each, a short expansion from the door. Where an island has a range of
  its own it keeps it; where it has none, one is raised.

### Getting started in the game

Your headquarters begins with boards, stone, tools and settlers. A woodcutter
needs trees within reach, a sawmill turns its logs into boards, and a quarry
works granite outcrops. Connect each new building to the network with a road, or
nothing will ever reach it. Pair every woodcutter with a forester, or the woods
around it will be gone within the hour.

There is a rival at the far end of the island, holding a province of his own
behind a ring of outposts — and, since the map is mirrored, holding exactly what
you hold. He will not come for you. But he is a hundred nodes away, and the
ground between is worth having, so a barracks on the frontier, and eventually
the swords, shields and beer to fill it, is how a province keeps growing.

Your mountain is a dozen or so nodes out, past the levelled apron the hall
stands on. Send a geologist from a flag near it: he marks what he finds, and a
coal mine and an iron mine on those marks are what turn ore into swords.

**Every mine keeps to its own food**, so the mountain is only as good as the
kitchens behind it:

| mine | eats | which means building |
|---|---|---|
| Coal | Bread | farm, mill, well, bakery |
| Iron | Meat | farm, well, pig farm, slaughterhouse |
| Gold | Fish | a fishery |
| Granite | Fish | a fishery |

A coal mine will not touch a fish however long it stands idle. The hall opens
with four loaves, four joints and eight fish — enough to work the first mine of
any kind while its chain is built, and no more.

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

**Both players are dealt the same country.** The map is one lattice turned half
a turn onto itself — the only transformation of this geometry that maps every
point to a point and every step to a step. It is not a copy stamped onto a
blank half, though: heights and terrain are *generated* symmetric, by blending
each noise field with its own reflection, because a stamp would leave a cliff
down the join. Trees, stone and ore, which are one thing to a node and have no
join to show, are stamped. What that buys is a guarantee rather than a hope —
every height, every triangle and every seam on one side has an exact twin on the
other, which a test asserts point by point.

**A border is pressure, not a patch.** Ground is derived afresh from the
buildings that hold it, never painted on when one is raised or flipped when one
is taken. Every building covering a node pushes with its reach less the walk,
and the player pushing hardest in total holds it — so two posts either side of a
stretch out-hold the one bigger building facing them, and a single captured
barracks does not out-hold a hall and the posts standing with it. On top of that
each building keeps a ring whatever the pressure: two nodes for a hall or a
fortress, so no border can run against its wall, one for anything else holding
ground, so a post is never razed by the border it has just redrawn. Whatever
falls outside a border when it moves is cleared — buildings, flags and the roads
between them — which is what makes taking a frontier post worth the men.

**No original Settlers II artwork is used.** Every sprite is drawn in code at
load time, in the parchment-and-ink palette of the title screen — which also
keeps the download to a single script and makes offline play immediate.

## What is in, and what is next

Playable now: the road and carrier network, construction sites that rise as
their materials arrive, settlers taking up trades, a population that grows as
the province does, saving and export, a rival province to take ground from, and
these chains —

- **Wood and stone** — woodcutters, foresters, sawmills, quarries.
- **Food** — wells, fisheries, farms sowing and reaping their own fields,
  mills, bakeries, pig farms, slaughterhouses, breweries, donkey breeders.
- **Mining** — geologists who go out and survey the rock, marking the one spot
  they struck, and the coal, iron, gold and granite mines sunk on what they
  find. Ore lies well inside a range, so the mountains have to be entered
  properly, and each mine eats its own food and no other: bread for coal, meat
  for iron, fish for gold and granite.
- **Metal and tools** — iron smelters, mints, armouries, and a metalworks that
  makes whichever tool the player is shortest of.
- **Territory** — outposts from a barracks to a fortress, each claiming the
  ground that lets a province reach the mountains.
- **Soldiers** — a sword, a shield and a beer make one man, trained in a store
  and marched out to whichever post is short. A gold coin carried to a post
  promotes the man who needs it most, private to general, so the gold chain is
  what makes a frontier hold.
- **War** — order an attack on any enemy post within twenty nodes and your men
  set out one at a time, queue at its flag, and fight whoever comes out of the
  door. Take the post and it is yours to man; take a headquarters and the
  province behind it falls with it, which is how a game is won or lost.

Still to come:

- **Hunters** — waiting on game animals, which the map does not yet carry.
- **Expansion** — shipyards, harbours, expeditions, catapults, fog of war.
- **Opponents** — a rival that builds and expands rather than holding the ring
  of outposts it wakes up with, plus statistics and scenario maps.

## Licence

MIT.
