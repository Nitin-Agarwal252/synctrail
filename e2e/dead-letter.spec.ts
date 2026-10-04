import { test, expect } from '@playwright/test';
import * as path from 'path';

const EVIDENCE = path.resolve('docs/evidence/fix-R1');

test.describe('fix-R1: dead-letter, nothing lost silently', () => {
  test('edit after server reset ends in the dead-letter list, not lost', async ({ browser, request }) => {
    const familyName = `Reset Family ${Date.now()}`;
    const newPhone = `555-${String(Date.now()).slice(-4)}`;
    const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const page = await context.newPage();

    try {
      await page.goto('/');
      await expect(page.getByTestId('connection-pill')).toContainText('Synced');

      // 1. Device A creates a record and syncs it.
      await page.getByTestId('new-household-btn').click();
      await page.getByTestId('new-household-name').fill(familyName);
      await page.getByTestId('new-household-phone').fill('555-0100');
      await page.getByTestId('new-household-status').selectOption('new');
      const createPushed = page.waitForResponse(
        async (r) =>
          r.url().includes('/api/sync/push') &&
          r.ok() &&
          (await r.text()).includes('"status":"applied"')
      );
      await page.getByTestId('save-new-household').click();
      await createPushed;
      await expect(page.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('dead-letter-banner')).not.toBeVisible();

      // 2. A goes offline, then the server is reset: the record no longer exists server-side.
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(page.getByTestId('connection-pill')).toContainText('Offline', { timeout: 8000 });
      const reset = await request.post('http://localhost:3001/api/dev/reset');
      expect(reset.ok()).toBe(true);

      // 3. Still offline, A edits the record it last saw.
      await page.locator('.household-card').filter({ hasText: familyName }).click();
      await page.getByTestId('detail-phone-input').fill(newPhone);
      await page.getByTestId('detail-phone-input').press('Enter');
      await expect(page.getByTestId('outbox-counter')).toBeVisible();

      // 4. A reconnects. The server answers rejected:unknown-record for the edit.
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));

      const banner = page.getByTestId('dead-letter-banner');
      await expect(banner).toContainText("1 change couldn't be saved", { timeout: 15000 });
      await expect(page.getByTestId('outbox-counter')).not.toBeVisible();

      await banner.click();
      const list = page.getByTestId('dead-letter-list');
      await expect(list).toBeVisible();
      const items = list.locator('.dead-letter-item');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText(`set phone = "${newPhone}"`);
      await expect(items.first()).toContainText('unknown-record');
      await expect(items.first().getByRole('button', { name: 'Copy JSON' })).toBeVisible();
      await expect(items.first().getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(items.first().getByRole('button', { name: 'Discard' })).toBeVisible();

      // The op is still held on the device with its full payload.
      const stored = await page.evaluate(
        () =>
          new Promise<{ reason: string; value: unknown }[]>((resolve, reject) => {
            const open = indexedDB.open('synctrail_db');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction('deadOps', 'readonly');
              const all = tx.objectStore('deadOps').getAll();
              all.onsuccess = () =>
                resolve(
                  (all.result as { reason: string; op: { value: unknown } }[]).map((d) => ({
                    reason: d.reason,
                    value: d.op.value,
                  }))
                );
            };
          })
      );
      expect(stored).toEqual([{ reason: 'unknown-record', value: newPhone }]);

      await page.screenshot({ path: path.join(EVIDENCE, 'dead-letter-after-reset.png'), fullPage: true });
    } finally {
      await context.close();
    }
  });
});
