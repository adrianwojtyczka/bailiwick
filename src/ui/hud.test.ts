import { describe, expect, it } from 'vitest';
import { BuildingType, buildingInfo } from '../sim/data/buildings';
import { Ware } from '../sim/data/wares';
import type { Building } from '../sim/entities/types';
import { Simulation } from '../sim/simulation';
import { inputRows, panelSignature } from './hud';

const PLAYER = 1;

function newGame(seed = 4242): Simulation {
  return Simulation.create({
    width: 64,
    height: 64,
    seed,
    players: [{ name: 'You', colour: '#c4832b' }],
  });
}

function headquarters(sim: Simulation) {
  return sim.buildings.require(sim.players[0]!.headquarters);
}

/**
 * The panel is rebuilt when this changes and left alone when it does not, so
 * everything the panel shows has to be in here. Miss something and the panel
 * goes on quietly describing a world that has moved on — a ground panel still
 * offering to place a flag on a node that already has one.
 */
describe('the panel signature', () => {
  it('says nothing at all about an empty selection', () => {
    expect(panelSignature(newGame(), -1)).toBe('');
  });

  it('stays put while nothing under the point changes', () => {
    const sim = newGame();
    const point = headquarters(sim).point;
    expect(panelSignature(sim, point)).toBe(panelSignature(sim, point));
  });

  it('moves when a flag goes up on the selected point', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    let placed: number | undefined;
    let before: string | undefined;
    for (const point of sim.world.grid.pointsWithin(hq.point, 6)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const signature = panelSignature(sim, point);
      if (!sim.placeFlag(PLAYER, point).ok) continue;
      placed = point;
      before = signature;
      break;
    }

    expect(placed).toBeDefined();
    // This is the case the player reported: the selection never moves, so
    // without the signature the panel would still be offering to place a flag.
    expect(panelSignature(sim, placed!)).not.toBe(before);
  });

  it('moves when a crate arrives at the selected flag', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const flag = sim.flags.require(sim.world.flag[hq.flagPoint]!);

    const before = panelSignature(sim, hq.flagPoint);
    flag.wares.push({ ware: 0, destination: 0 });
    expect(panelSignature(sim, hq.flagPoint)).not.toBe(before);
  });

  it('follows a store as its stock changes', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    const before = panelSignature(sim, hq.point);
    hq.stock[0] = (hq.stock[0] ?? 0) + 1;
    expect(panelSignature(sim, hq.point)).not.toBe(before);
  });

  it('follows a site as its materials come in', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    const before = panelSignature(sim, hq.point);
    hq.status = 4;
    expect(panelSignature(sim, hq.point)).not.toBe(before);
  });
});

/**
 * What the panel lists under a working building. A mine used to show its status
 * and nothing else, which with one food to a mine would have left "Waiting for
 * materials" standing over a coal mine without ever saying the material was
 * bread.
 */
describe('the rows a building shows', () => {
  const rowsFor = (type: BuildingType, inputs: number[]) =>
    inputRows(buildingInfo(type), { inputs } as Building);

  it('names the food a mine wants, and what it is holding', () => {
    expect(rowsFor(BuildingType.CoalMine, [2])).toEqual([{ ware: Ware.Bread, count: 2 }]);
    expect(rowsFor(BuildingType.IronMine, [0])).toEqual([{ ware: Ware.Meat, count: 0 }]);
    expect(rowsFor(BuildingType.GoldMine, [4])).toEqual([{ ware: Ware.Fish, count: 4 }]);
    expect(rowsFor(BuildingType.GraniteMine, [1])).toEqual([{ ware: Ware.Fish, count: 1 }]);
  });

  it('still lists a workshop’s recipe, ware by ware', () => {
    expect(rowsFor(BuildingType.Bakery, [3, 1])).toEqual([
      { ware: Ware.Flour, count: 3 },
      { ware: Ware.Water, count: 1 },
    ]);
  });

  it('has nothing to say about a building that takes nothing in', () => {
    expect(rowsFor(BuildingType.Woodcutter, [])).toEqual([]);
    expect(rowsFor(BuildingType.Barracks, [])).toEqual([]);
  });
});
