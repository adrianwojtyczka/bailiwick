import { describe, expect, it } from 'vitest';
import { BuildingType } from '../sim/data/buildings';
import { Ware } from '../sim/data/wares';
import { Simulation } from '../sim/simulation';
import { planRoad } from '../sim/transport/pathfinding';
import { BuildSpace, canHostSize, evaluateBuildSpace } from '../sim/world/buildspace';
import { MapObject } from '../sim/world/terrain';
import { garrisonStrength, Rank, RANK_COUNT } from '../sim/data/ranks';
import { decodeSave, encodeSave, loadSimulation } from './save';

const PLAYER = 1;

function newGame(seed = 4242): Simulation {
  return Simulation.create({
    width: 64,
    height: 64,
    seed,
    players: [{ name: 'You', colour: '#c4832b' }],
  });
}

/** Plays a short opening so the save has entities, roads and wares in it. */
function playedGame(): Simulation {
  const sim = newGame();
  const hq = sim.buildings.require(sim.players[0]!.headquarters);

  let best: number | undefined;
  let bestTrees = 0;
  for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
    if (sim.world.grid.distance(hq.point, point) < 3) continue;
    const space = evaluateBuildSpace(sim.world, point, PLAYER);
    if (space === BuildSpace.None || !canHostSize(space, BuildSpace.Hut)) continue;

    const trees = sim.world.grid
      .pointsWithin(point, 6)
      .filter((near) => sim.world.object[near] === MapObject.Tree).length;
    if (trees > bestTrees) {
      bestTrees = trees;
      best = point;
    }
  }

  if (best !== undefined) {
    sim.placeBuilding(PLAYER, best, BuildingType.Woodcutter);
    const building = sim.buildings.find((candidate) => candidate.point === best);
    if (building) {
      const route = planRoad(sim.world, hq.flagPoint, building.flagPoint, PLAYER);
      if (route) sim.placeRoad(PLAYER, route);
    }
  }

  for (let i = 0; i < 4000; i += 1) sim.update();
  return sim;
}

describe('saving and loading', () => {
  it('restores a game to exactly the same state', async () => {
    const original = playedGame();
    const before = original.hash();

    const restored = await loadSimulation(await encodeSave(original, 'test'));

    expect(restored.hash()).toBe(before);
  });

  it('carries over the tick, the seed and the players', async () => {
    const original = playedGame();
    const restored = await loadSimulation(await encodeSave(original, 'test'));

    expect(restored.tick).toBe(original.tick);
    expect(restored.seed).toBe(original.seed);
    expect(restored.players).toEqual(original.players);
  });

  it('carries over the army, rank by rank', async () => {
    const original = playedGame();
    const home = original.buildings.require(original.players[0]!.headquarters);
    home.garrison[Rank.Private] = 3;
    home.garrison[Rank.Sergeant] = 2;
    home.garrison[Rank.General] = 1;

    const restored = await loadSimulation(await encodeSave(original, 'an army'));
    const there = restored.buildings.require(restored.players[0]!.headquarters);

    expect(there.garrison).toEqual(home.garrison);
    expect(garrisonStrength(there.garrison)).toBe(6);
  });

  it('carries over the map, the roads and the stores', async () => {
    const original = playedGame();
    const restored = await loadSimulation(await encodeSave(original, 'test'));

    expect(restored.buildings.count).toBe(original.buildings.count);
    expect(restored.flags.count).toBe(original.flags.count);
    expect(restored.roads.count).toBe(original.roads.count);
    expect(restored.settlers.count).toBe(original.settlers.count);
    expect(restored.storedWare(PLAYER, Ware.Board)).toBe(original.storedWare(PLAYER, Ware.Board));
    expect([...restored.world.roads]).toEqual([...original.world.roads]);
    expect([...restored.world.object]).toEqual([...original.world.object]);
    expect([...restored.world.owner]).toEqual([...original.world.owner]);
  });

  it('keeps running identically after a reload', async () => {
    const original = playedGame();
    const restored = await loadSimulation(await encodeSave(original, 'test'));

    // Divergence here would mean something stateful was left out of the save.
    for (let i = 0; i < 1500; i += 1) {
      original.update();
      restored.update();
    }

    expect(restored.hash()).toBe(original.hash());
  });

  it('regenerates terrain from the seed rather than storing it', async () => {
    const original = playedGame();
    const restored = await loadSimulation(await encodeSave(original, 'test'));

    expect([...restored.world.height]).toEqual([...original.world.height]);
    expect([...restored.world.terrainSouth]).toEqual([...original.world.terrainSouth]);
  });

  it('records the metadata the load menu shows', async () => {
    const original = playedGame();
    const { meta } = await decodeSave(await encodeSave(original, 'My province'));

    expect(meta.name).toBe('My province');
    expect(meta.tick).toBe(original.tick);
    expect(meta.savedAt).toBeGreaterThan(0);
  });

  it('compresses to something small enough to pass around', async () => {
    const bytes = await encodeSave(playedGame(), 'test');
    // A 64x64 province in well under a megabyte.
    expect(bytes.byteLength).toBeLessThan(200_000);
  });

  it('refuses a file that is not a save', async () => {
    await expect(loadSimulation(new TextEncoder().encode('not a save'))).rejects.toThrow();
  });
});

describe('saves from an older version', () => {
  /** Rewrites a current save as a version 1 file, dropping what v1 lacked. */
  async function asVersionOne(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const parsed = JSON.parse(await new Response(stream).text()) as Record<string, unknown>;

    parsed.version = 1;
    delete parsed.growingFields;
    const settlers = parsed.settlers as { items: Record<string, unknown>[] };
    for (const settler of settlers.items) {
      delete settler.surveyFrom;
      delete settler.rank;
    }
    const buildings = parsed.buildings as { items: Record<string, unknown>[] };
    for (const building of buildings.items) {
      delete building.garrison;
      delete building.garrisonRequested;
      delete building.exhaustedFor;
    }

    const out = new Blob([JSON.stringify(parsed)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  it('still loads, filling in what the older format left out', async () => {
    const original = playedGame();
    const old = await asVersionOne(await encodeSave(original, 'an old game'));

    const restored = await loadSimulation(old);

    // Everything the old format did carry survives intact.
    expect(restored.tick).toBe(original.tick);
    expect(restored.settlers.count).toBe(original.settlers.count);
    expect(restored.storedWare(PLAYER, Ware.Board)).toBe(
      original.storedWare(PLAYER, Ware.Board),
    );
    // And the fields it predates default to nothing rather than to undefined.
    for (const settler of restored.settlers.all()) {
      expect(settler.surveyFrom).toBe(0);
      expect(settler.rank).toBe(0);
    }

    // A save older than soldiers has no army — but a store still needs a
    // garrison of the right shape, or the first man trained goes nowhere.
    const home = restored.buildings.require(restored.players[0]!.headquarters);
    expect(home.garrison).toHaveLength(RANK_COUNT);
    expect(garrisonStrength(home.garrison)).toBe(0);
    expect(home.garrisonRequested).toBe(0);
  });

  it('refuses a save from a newer version it cannot understand', async () => {
    const bytes = await encodeSave(playedGame(), 'from the future');
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const parsed = JSON.parse(await new Response(stream).text()) as Record<string, unknown>;
    parsed.version = 999;

    const out = new Blob([JSON.stringify(parsed)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    const future = new Uint8Array(await new Response(out).arrayBuffer());

    await expect(loadSimulation(future)).rejects.toThrow(/newer version/);
  });
});
