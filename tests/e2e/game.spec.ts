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
async function tapUntilAccepted(page: Page): Promise<boolean> {
  const centre = await canvasCentre(page);
  const ticker = page.locator('.hud__ticker');

  const offsets: { dx: number; dy: number }[] = [];
  for (const radius of [70, 110, 150]) {
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

    const message = (await ticker.textContent())?.trim() ?? '';
    const refused =
      message.includes('cannot') || message.includes('No road') || message.includes('Nothing');
    if (!refused) return true;
  }

  return false;
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
  expect(await tapUntilAccepted(page)).toBe(true);

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
  for (const radius of [70, 110, 150]) {
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
