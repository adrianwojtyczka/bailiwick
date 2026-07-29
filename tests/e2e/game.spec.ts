import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end tests against the committed build in the repository root — the
 * same files GitHub Pages serves. They drive the game the way a player does:
 * tapping the canvas, not reaching into its internals.
 */

/** A fixed seed keeps the island identical between runs. */
const TEST_SEED = 4242;

async function startNewGame(page: Page, seed = TEST_SEED): Promise<void> {
  await page.goto(`/?seed=${seed}`);
  await expect(page.locator('.title__name')).toHaveText('Bailiwick');

  await page.getByRole('button', { name: 'New game' }).click();
  await expect(page.locator('canvas.map')).toBeVisible();
  await expect(page.locator('.hud__bar')).toBeVisible();
}

/** The centre of the canvas, where the headquarters starts out. */
async function canvasCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas.map').boundingBox();
  if (!box) throw new Error('the map canvas has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Taps outwards from the centre until a tap is accepted.
 *
 * Where exactly a building fits depends on the terrain and on the viewport, so
 * rather than hard-coding a pixel this sweeps a ring of candidates near the
 * headquarters — much as a player would try a few spots.
 */
async function tapUntilAccepted(page: Page): Promise<{ dx: number; dy: number } | null> {
  const centre = await canvasCentre(page);
  const cancel = page.getByRole('button', { name: 'Cancel' });

  const offsets: { dx: number; dy: number }[] = [];
  for (const radius of [70, 110, 150, 190]) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      offsets.push({
        dx: Math.round(Math.cos(angle) * radius),
        // Rows are squashed vertically, so reach further up and down.
        dy: Math.round(Math.sin(angle) * radius * 0.62),
      });
    }
  }

  for (const offset of offsets) {
    await page.mouse.click(centre.x + offset.dx, centre.y + offset.dy);
    await page.waitForTimeout(120);

    // Placing a building leaves build mode, so Cancel disappearing is the one
    // signal that cannot be misread. Watching the ticker for a refusal instead
    // was wrong in both directions: it holds the last message until another
    // replaces it or it ages out, so a success after a refusal read as another
    // refusal, and a first tap with the ticker still empty read as a success.
    if (!(await cancel.isVisible())) return offset;
  }

  return null;
}

test('the title screen offers a new game', async ({ page }) => {
  await page.goto('/');


  await expect(page.locator('.title__name')).toHaveText('Bailiwick');
  await expect(page.locator('.title__scene svg')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New game' })).toBeEnabled();
  // Nothing has been played yet, so there is nothing to continue.
  await expect(page.getByRole('button', { name: /^Continue/ })).toBeDisabled();
});

test('a new game starts with a stocked headquarters', async ({ page }) => {
  await startNewGame(page);

  // Stock lives on the headquarters panel now that the top bar is gone.
  const centre = await canvasCentre(page);
  await page.mouse.click(centre.x, centre.y);

  const panel = page.locator('.panel');
  await expect(panel).toContainText('Board: 24');
  await expect(panel).toContainText('Stone: 18');
  await expect(panel).toContainText('Settlers waiting');
});

test('the build menu lists what can be built', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: 'Build' }).click();

  const names = page.locator('.card__name');
  await expect(names.first()).toBeVisible();

  const listed = await names.allTextContents();
  expect(listed).toContain("Woodcutter's hut");
  expect(listed).toContain('Sawmill');
  expect(listed).toContain('Quarry');
});

test('choosing a building shows where it will fit', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: 'Build' }).click();
  await page.locator('.card', { hasText: "Woodcutter's hut" }).click();

  await expect(page.locator('.panel__title')).toContainText('woodcutter');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
});

test('a woodcutter can be placed and starts building', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: 'Build' }).click();
  await page.locator('.card', { hasText: "Woodcutter's hut" }).click();

  // Away from the headquarters, which occupies the centre.
  expect(await tapUntilAccepted(page)).not.toBeNull();

  // The site is selected after placing. Until a road reaches it, it reports
  // that rather than a bare "under construction" — the road is the next thing
  // the player has to do.
  await expect(page.locator('.panel__status')).toHaveText(
    /Under construction|No road connects this to your network/,
  );
});

test('tapping the headquarters describes it', async ({ page }) => {
  await startNewGame(page);

  const centre = await canvasCentre(page);
  await page.mouse.click(centre.x, centre.y);

  await expect(page.locator('.panel__title')).toContainText('Headquarters');
  await expect(page.locator('.panel')).toContainText('Settlers waiting');
});

test('the game can be paused and resumed', async ({ page }) => {
  await startNewGame(page);

  await page.getByRole('button', { name: '1×' }).click();
  await expect(page.getByRole('button', { name: '2×' })).toBeVisible();

  await page.getByRole('button', { name: '2×' }).click();
  await expect(page.getByRole('button', { name: '4×' })).toBeVisible();

  await page.getByRole('button', { name: '4×' }).click();
  await expect(page.getByRole('button', { name: 'Paused' })).toBeVisible();

  await page.getByRole('button', { name: 'Paused' }).click();
  await expect(page.getByRole('button', { name: '1×' })).toBeVisible();
});

test('a game can be saved and then continued from the title screen', async ({ page }) => {
  await startNewGame(page);
  await page.waitForTimeout(1200);

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save game' }).click();
  await expect(page.locator('.hud__ticker')).toContainText('saved');

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Quit to title' }).click();
  // Quitting asks now; the save has just been taken, so decline.
  await page.getByRole('button', { name: 'Quit without saving' }).click();
  await expect(page.locator('.title__name')).toBeVisible();

  await page.getByRole('button', { name: 'Load a save' }).click();
  await page.locator('.title__button--save').first().click();

  await expect(page.locator('canvas.map')).toBeVisible();

  const centre = await canvasCentre(page);
  await page.mouse.click(centre.x, centre.y);
  await expect(page.locator('.panel__title')).toContainText('Headquarters');
});

test('the map pans when dragged', async ({ page }) => {
  await startNewGame(page);
  await page.waitForTimeout(600);

  const centre = await canvasCentre(page);
  const before = await page.locator('canvas.map').screenshot();

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x - 160, centre.y - 120, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await page.locator('canvas.map').screenshot();
  expect(Buffer.compare(before, after)).not.toBe(0);
});

test('the page works offline once the service worker has cached it', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('.title__name')).toBeVisible();

  // Give the worker a moment to install and precache.
  await page.waitForTimeout(2500);
  await context.setOffline(true);
  await page.reload();

  await expect(page.locator('.title__name')).toHaveText('Bailiwick');
  await context.setOffline(false);
});

test('the panel follows the world without re-tapping the node', async ({ page }) => {
  await startNewGame(page);

  // Find a node the ground panel offers a flag on, and take it.
  const centre = await canvasCentre(page);
  const panel = page.locator('.panel');
  const placeFlag = page.getByRole('button', { name: 'Place a flag' });

  let found = false;
  for (const radius of [70, 110, 150, 190, 230]) {
    for (let step = 0; step < 8 && !found; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      await page.mouse.click(
        centre.x + Math.round(Math.cos(angle) * radius),
        centre.y + Math.round(Math.sin(angle) * radius * 0.62),
      );
      await page.waitForTimeout(120);
      found = await placeFlag.isVisible();
    }
    if (found) break;
  }
  expect(found).toBe(true);

  await placeFlag.click();

  // The selection has not moved, so the panel used to sit there describing bare
  // ground and offering to place a second flag. It must describe the flag now.
  await expect(panel.locator('.panel__title')).toHaveText('Flag');
  await expect(page.getByRole('button', { name: 'Lay a road from here' })).toBeVisible();
  await expect(placeFlag).toHaveCount(0);
});

test('demolishing asks before it acts', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: 'Build' }).click();
  await page.locator('.card', { hasText: "Woodcutter's hut" }).click();
  expect(await tapUntilAccepted(page)).not.toBeNull();

  // The site is selected after placing, so its panel is already up.
  const demolish = page.getByRole('button', { name: 'Demolish', exact: true });
  await expect(demolish).toBeVisible();

  // One press arms it and says so; nothing is destroyed yet.
  await demolish.click();
  const confirm = page.getByRole('button', { name: 'Really demolish?' });
  await expect(confirm).toBeVisible();
  await expect(page.locator('.panel__title')).toContainText('Woodcutter');

  // The second press does the deed, and the panel stops describing a building.
  await confirm.click();
  await expect(page.locator('.panel__title')).not.toContainText('Woodcutter');
});

test('a bare flag comes up on one press', async ({ page }) => {
  await startNewGame(page);

  const centre = await canvasCentre(page);
  const panel = page.locator('.panel');
  const placeFlag = page.getByRole('button', { name: 'Place a flag' });

  let found = false;
  for (const radius of [70, 110, 150, 190, 230]) {
    for (let step = 0; step < 8 && !found; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      await page.mouse.click(
        centre.x + Math.round(Math.cos(angle) * radius),
        centre.y + Math.round(Math.sin(angle) * radius * 0.62),
      );
      await page.waitForTimeout(120);
      found = await placeFlag.isVisible();
    }
    if (found) break;
  }
  expect(found).toBe(true);
  await placeFlag.click();
  await expect(panel.locator('.panel__title')).toHaveText('Flag');

  // A flag with no building behind it costs nothing to put back, so it goes at
  // once — no question in the way of every little change to a road network.
  await page.getByRole('button', { name: 'Remove flag', exact: true }).click();
  await expect(panel.locator('.panel__title')).not.toHaveText('Flag');
  await expect(placeFlag).toBeVisible();
});

test('a barracks says how many soldiers hold it', async ({ page }) => {
  // Placing, connecting, building and then marching a man out to it: this one
  // plays a slice of a real game rather than poking at a panel.
  test.setTimeout(240_000);
  await startNewGame(page);

  const centre = await canvasCentre(page);
  const panel = page.locator('.panel');

  await page.getByRole('button', { name: 'Build' }).click();
  await page.locator('.card', { hasText: 'Barracks' }).click();
  const placed = await tapUntilAccepted(page);
  expect(placed).not.toBeNull();

  await expect(panel.locator('.panel__title')).toHaveText('Barracks');

  // Connect it. The barracks flag sits a node off its door, so sweep the
  // neighbourhood of the spot that took the building until a flag answers,
  // then run the road back to the headquarters in one tap.
  const near = [-26, -13, 0, 13, 26];
  const road = page.getByRole('button', { name: 'Lay a road from here' });
  let laid = false;

  for (const dx of near) {
    for (const dy of near) {
      await page.mouse.click(centre.x + placed!.dx + dx, centre.y + placed!.dy + dy);
      await page.waitForTimeout(90);
      if (!(await road.isVisible())) continue;

      await road.click();
      // The headquarters flag is a node south-east of the middle of the map.
      for (const home of [
        { hx: 13, hy: 8 },
        { hx: 26, hy: 16 },
        { hx: 13, hy: 16 },
        { hx: 0, hy: 0 },
      ]) {
        await page.mouse.click(centre.x + home.hx, centre.y + home.hy);
        await page.waitForTimeout(120);
        if (!(await road.isVisible())) break;
      }
      laid = true;
      break;
    }
    if (laid) break;
  }
  expect(laid).toBe(true);

  // Run it forward: building it, then walking a man out to it, takes a while.
  // The button carries the speed it is running at, so each press is the next.
  await page.getByRole('button', { name: '1\u00d7' }).click();
  await page.getByRole('button', { name: '2\u00d7' }).click();
  await expect(page.getByRole('button', { name: '4\u00d7' })).toBeVisible();

  // Select the barracks again and watch it fill.
  await page.mouse.click(centre.x + placed!.dx, centre.y + placed!.dy);
  await expect(panel.locator('.panel__title')).toHaveText('Barracks');

  // The ground is claimed by men, not by roofs: it stands empty first.
  await expect(panel).toContainText('Garrison: 0 of 2', { timeout: 120_000 });
  await expect(panel).toContainText('Waiting for soldiers');

  // Then a man arrives, and the panel says who he is. One man, not two: an
  // outpost facing nobody is held by the fewest the rule allows, so the rest of
  // the army is free to go where it is needed.
  await expect(panel).toContainText('Garrison: 1 of 2', { timeout: 120_000 });
  await expect(panel).toContainText('Private: 1');
  await expect(panel).toContainText('Working');
});

test('continuing resumes the game you saved, not an older one', async ({ page }) => {
  await startNewGame(page);
  const centre = await canvasCentre(page);

  // Something to look for afterwards. Placing it also moves the world well past
  // anything an autosave could hold this early.
  await page.getByRole('button', { name: 'Build' }).click();
  await page.locator('.card', { hasText: "Woodcutter's hut" }).click();
  const where = await tapUntilAccepted(page);
  expect(where).not.toBeNull();
  await expect(page.locator('.panel__title')).toContainText('Woodcutter');

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save game' }).click();
  await expect(page.locator('.hud__ticker')).toContainText('saved');

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Quit to title' }).click();
  await page.getByRole('button', { name: 'Quit without saving' }).click();
  await expect(page.locator('.title__name')).toBeVisible();

  // Continue read the autosave slot alone, so it came back to a game from
  // before the hut went down — or, this early, to no game at all.
  const resume = page.getByRole('button', { name: /^Continue/ });
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(page.locator('canvas.map')).toBeVisible();

  // The view is centred on the headquarters again, so the same offset lands on
  // the same node: the hut has to be standing there.
  await page.mouse.click(centre.x + where!.dx, centre.y + where!.dy);
  await expect(page.locator('.panel__title')).toContainText('Woodcutter');
});

test('quitting asks before it throws anything away', async ({ page }) => {
  await startNewGame(page);

  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  await page.getByRole('button', { name: 'Quit to title' }).click();

  // Three answers, and none of them taken yet.
  await expect(page.getByRole('button', { name: 'Save and quit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quit without saving' })).toBeVisible();
  await expect(page.locator('canvas.map')).toBeVisible();

  // Cancel goes back to the ordinary menu rather than out of the game.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save game' })).toBeVisible();
  await expect(page.locator('canvas.map')).toBeVisible();

  // Save and quit leaves by way of a save, so the list has one to load.
  await page.getByRole('button', { name: 'Quit to title' }).click();
  await page.getByRole('button', { name: 'Save and quit' }).click();
  await expect(page.locator('.title__name')).toBeVisible();

  await page.getByRole('button', { name: 'Load a save' }).click();
  await expect(page.locator('.title__button--save').first()).toBeVisible();
});

test('the title screen scrolls when it does not fit', async ({ page }) => {
  // A short screen — a small phone, or a tall one in landscape, or any phone
  // with the address bar showing. On a roomy handset the menu happens to fit
  // and there is nothing to reach for; this is the case that bit.
  await page.setViewportSize({ width: 400, height: 460 });
  await page.goto('/');
  await expect(page.locator('.title__name')).toHaveText('Bailiwick');

  const title = page.locator('.title');
  const room = await title.evaluate((element) => ({
    scroll: element.scrollHeight,
    client: element.clientHeight,
  }));

  // More here than fits, and the box it lives in must be what scrolls. With
  // only a min-height it grew past a parent that clips instead, so the buttons
  // below the fold could not be reached at all.
  expect(room.scroll).toBeGreaterThan(room.client);

  await title.evaluate((element) => element.scrollTo(0, 200));
  expect(await title.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  // And the thing the player came for is reachable once it has scrolled.
  await expect(page.getByRole('button', { name: 'New game' })).toBeVisible();
});

test('the title illustration is shown whole', async ({ page }) => {
  // A short screen: the case where a bounded flex column squeezed the scene
  // into a strip instead of scrolling.
  await page.setViewportSize({ width: 400, height: 460 });
  await page.goto('/');
  await expect(page.locator('.title__name')).toHaveText('Bailiwick');

  const scene = page.locator('.title__scene svg');
  await expect(scene).toBeVisible();

  const framing = await scene.evaluate((node) => {
    const svg = node as SVGSVGElement;
    const box = svg.getBBox();
    const view = svg.viewBox.baseVal;
    const drawn = svg.getBoundingClientRect();
    // The frame around it, which is what a bounded flex column crushes: the
    // svg keeps its own size and `overflow: hidden` simply cuts it off.
    const frame = (svg.parentElement as HTMLElement).getBoundingClientRect();
    return {
      left: box.x - view.x,
      top: box.y - view.y,
      right: view.x + view.width - (box.x + box.width),
      bottom: view.y + view.height - (box.y + box.height),
      width: drawn.width,
      height: drawn.height,
      frameHeight: frame.height,
    };
  });

  // Nothing cropped: every edge of the drawing sits inside the frame. Four
  // units used to be shaved off each side.
  expect(framing.left).toBeGreaterThanOrEqual(0);
  expect(framing.top).toBeGreaterThanOrEqual(0);
  expect(framing.right).toBeGreaterThanOrEqual(0);
  expect(framing.bottom).toBeGreaterThanOrEqual(0);

  // And no dead margin either: the frame was a fifth taller than the artwork,
  // which showed as a band of empty parchment above the mountains.
  for (const slack of [framing.left, framing.top, framing.right, framing.bottom]) {
    expect(slack).toBeLessThanOrEqual(2);
  }

  // Drawn at its own shape: the artwork is exactly 2:1.
  expect(framing.width).toBeGreaterThan(0);
  expect(framing.height).toBeCloseTo(framing.width / 2, 0);

  // And the frame shows all of it. A bounded flex column shrinks its children
  // before it overflows, and this one clips rather than scales — on a short
  // screen the box collapsed to two pixels and the picture vanished, while the
  // svg inside went on reporting its full size.
  expect(framing.frameHeight).toBeGreaterThanOrEqual(framing.height);
});
