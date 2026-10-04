import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';

const EVIDENCE = path.resolve('docs/evidence/fix-R2');
const SEED_IDS = Array.from({ length: 12 }, (_, i) => `h_${String(i + 1).padStart(2, '0')}`);

async function createSynced(page: Page, name: string): Promise<void> {
  const pushed = page.waitForResponse(
    async (r) => r.url().includes('/api/sync/push') && r.ok() && (await r.text()).includes('"status":"applied"')
  );
  await page.getByTestId('new-household-btn').click();
  await page.getByTestId('new-household-name').fill(name);
  await page.getByTestId('new-household-phone').fill('555-0100');
  await page.getByTestId('new-household-status').selectOption('new');
  await page.getByTestId('save-new-household').click();
  await pushed;
}

async function expectOnlySeed(page: Page): Promise<void> {
  await expect(page.locator('.household-card')).toHaveCount(12, { timeout: 15000 });
  for (const id of SEED_IDS) {
    await expect(page.getByTestId(`household-card-${id}`)).toBeVisible();
  }
  await expect(page.locator('.household-card').filter({ hasText: 'Ghost' })).toHaveCount(0);
}

test.describe('fix-R2: reset epoch', () => {
  test('A and B synced, server reset, both end with only the 12 seed records', async ({ browser, request }) => {
    const ghostA = `Ghost A ${Date.now()}`;
    const ghostB = `Ghost B ${Date.now()}`;
    const ctxA = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const ctxB = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await pageA.goto('/');
      await pageB.goto('/');
      await expect(pageA.getByTestId('connection-pill')).toContainText('Synced');
      await expect(pageB.getByTestId('connection-pill')).toContainText('Synced');

      // Both devices create records and see each other's: these become ghosts after the reset.
      await createSynced(pageA, ghostA);
      await createSynced(pageB, ghostB);
      for (const page of [pageA, pageB]) {
        await expect(page.locator('.household-card').filter({ hasText: ghostA })).toHaveCount(1, { timeout: 10000 });
        await expect(page.locator('.household-card').filter({ hasText: ghostB })).toHaveCount(1, { timeout: 10000 });
      }

      const reset = await request.post('http://localhost:3001/api/dev/reset');
      expect(reset.ok()).toBe(true);

      await expectOnlySeed(pageA);
      await expectOnlySeed(pageB);
      for (const page of [pageA, pageB]) {
        await expect(page.getByTestId('server-reset-notice')).toContainText(
          'The server was reset. 0 unsynced changes need review.'
        );
        await expect(page.getByTestId('outbox-counter')).not.toBeVisible();
      }

      await pageA.screenshot({ path: path.join(EVIDENCE, 'after-reset-pageA.png'), fullPage: true });
      await pageB.screenshot({ path: path.join(EVIDENCE, 'after-reset-pageB.png'), fullPage: true });

      // The notice goes away only when the user dismisses it; the data stays clean after a reload.
      await pageA.getByTestId('server-reset-dismiss').click();
      await expect(pageA.getByTestId('server-reset-notice')).not.toBeVisible();
      await pageA.reload();
      await expectOnlySeed(pageA);
      await expect(pageA.getByTestId('server-reset-notice')).not.toBeVisible();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
