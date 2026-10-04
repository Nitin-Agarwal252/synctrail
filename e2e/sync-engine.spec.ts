import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Phase 4: Sync Engine & Connectivity', () => {
  test.beforeAll(() => {
    const videoDir = path.resolve('docs/evidence/phase-4/videos');
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
  });

  test('Scenario 1: Happy path across two contexts A and B with video recording', async ({
    browser,
  }) => {
    const familyName = `Sync Family ${Date.now()}`;
    const videoDir = path.resolve('docs/evidence/phase-4/videos');

    // Context A with video recording enabled
    const contextA = await browser.newContext({
      baseURL: 'http://localhost:3000',
      recordVideo: {
        dir: videoDir,
        size: { width: 1280, height: 720 },
      },
    });

    const contextB = await browser.newContext({
      baseURL: 'http://localhost:3000',
    });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // 1. Load both contexts online
      await pageA.goto('http://localhost:3000/');
      await pageA.waitForLoadState('networkidle');

      await pageB.goto('http://localhost:3000/');
      await pageB.waitForLoadState('networkidle');

      // Wait for initial sync
      await expect(pageA.getByTestId('connection-pill')).toContainText('Synced');
      await expect(pageB.getByTestId('connection-pill')).toContainText('Synced');

      // Switch B to "Dev" so changes have distinct authors
      await pageB.getByTestId('user-switcher').selectOption('Dev');

      // 2. Context A creates a household while online
      await pageA.getByTestId('new-household-btn').click();
      await pageA.getByTestId('new-household-name').fill(familyName);
      await pageA.getByTestId('new-household-phone').fill('555-0100');
      await pageA.getByTestId('new-household-status').selectOption('new');
      await pageA.getByTestId('save-new-household').click();

      // Wait for A to sync to server
      await expect(pageA.getByTestId('outbox-counter')).not.toBeVisible();

      // Verify Context B sees the new record live via WebSocket hint + pull
      const cardB = pageB.locator('.household-card').filter({ hasText: familyName });
      await expect(cardB).toBeVisible({ timeout: 10000 });

      // 3. Kill network on Context A
      await contextA.setOffline(true);
      await pageA.evaluate(() => window.dispatchEvent(new Event('offline')));
      // Allow connectivity detector + heartbeat failure to propagate to UI state
      await pageA.waitForTimeout(1500);

      await expect(pageA.getByTestId('connection-pill')).toContainText('Offline · saved on this device', { timeout: 8000 });
      await expect(pageA.getByTestId('offline-banner')).toBeVisible();

      // 4. Context A edits phone number while offline
      const cardA = pageA.locator('.household-card').filter({ hasText: familyName });
      await cardA.click();
      await pageA.getByTestId('detail-phone-input').fill('555-9999');
      await pageA.getByTestId('detail-phone-input').press('Enter');

      // Verify outbox shows waiting on A
      await expect(pageA.getByTestId('outbox-counter')).toBeVisible();

      // Context B still has old phone
      await cardB.click();
      await expect(pageB.getByTestId('detail-phone-input')).toHaveValue('555-0100');

      // 5. Context A reconnects
      await contextA.setOffline(false);
      await pageA.evaluate(() => window.dispatchEvent(new Event('online')));

      // Context A automatically syncs and empties outbox
      await expect(pageA.getByTestId('connection-pill')).toContainText('Synced', { timeout: 10000 });
      await expect(pageA.getByTestId('outbox-counter')).not.toBeVisible();

      // 6. Context B receives live update via WS hint + pull
      await expect(pageB.getByTestId('detail-phone-input')).toHaveValue('555-9999', {
        timeout: 10000,
      });
      await expect(pageB.getByTestId('history-strip')).toContainText('Meera set phone → 555-9999');
    } finally {
      await contextA.close(); // Closes and finalizes video file in docs/evidence/phase-4/videos/
      await contextB.close();
    }
  });

  test('Scenario 6: Interrupted sync with large backlog', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const page = await context.newPage();

    try {
      await page.goto('http://localhost:3000/');
      await page.waitForLoadState('networkidle');

      // Go offline to accumulate backlog
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));

      // Queue 60 ops (exceeds single batch size of 50) directly into Dexie outbox
      await page.evaluate(async () => {
        return new Promise<void>((resolve, reject) => {
          // @ts-expect-error accessing indexedDB directly in browser context
          const req = indexedDB.open('synctrail_db');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const idb = req.result;
            const tx = idb.transaction('outbox', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            const store = tx.objectStore('outbox');

            for (let i = 0; i < 60; i++) {
              store.add({
                opId: `bulk_e2e_op_${Date.now()}_${i}`,
                deviceId: 'dev_e2e',
                userId: 'Meera',
                recordId: `bulk_e2e_rec_${Date.now()}_${i}`,
                type: 'create',
                fields: { name: `Backlog Family ${i}` },
                baseHlc: null,
                hlc: `2026-10-04T12:00:00.000Z-${String(i).padStart(4, '0')}-dev_e2e`,
              });
            }
          };
        });
      });

      // Reload to reflect queued ops in UI
      await page.reload();
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));

      // Wait for outbox counter to report waiting ops
      await expect(page.getByTestId('outbox-counter')).toBeVisible({ timeout: 5000 });

      // Reconnect and allow sync to drain the 60-op backlog across batches
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));

      // All ops should drain cleanly and outbox should reach 0
      await expect(page.getByTestId('connection-pill')).toContainText('Synced', { timeout: 15000 });
      await expect(page.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 15000 });
    } finally {
      await context.close();
    }
  });

  test('Edge Case #16: Remote change while user is editing preserves active input', async ({
    browser,
  }) => {
    const preserveName = `Preserve Family ${Date.now()}`;
    const contextA = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const contextB = await browser.newContext({ baseURL: 'http://localhost:3000' });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto('http://localhost:3000/');
      await pageB.goto('http://localhost:3000/');
      await pageB.getByTestId('user-switcher').selectOption('Dev');
      await expect(pageB.getByTestId('user-switcher')).toHaveValue('Dev');

      // Create a test household
      await pageA.getByTestId('new-household-btn').click();
      await pageA.getByTestId('new-household-name').fill(preserveName);
      await pageA.getByTestId('new-household-phone').fill('111-2222');
      await pageA.getByTestId('save-new-household').click();

      // Wait for B to receive record
      const cardB = pageB.locator('.household-card').filter({ hasText: preserveName });
      await expect(cardB).toBeVisible({ timeout: 10000 });

      // A opens record and focuses on the phone input, typing a draft
      const cardA = pageA.locator('.household-card').filter({ hasText: preserveName });
      await cardA.click();
      await pageA.getByTestId('detail-phone-input').focus();
      await pageA.getByTestId('detail-phone-input').fill('A typing in progress...');

      // B modifies the phone field remotely
      await cardB.click();
      await pageB.getByTestId('detail-phone-input').fill('Dev new phone');
      await pageB.getByTestId('detail-phone-input').press('Enter');

      // Wait for B to push
      await expect(pageB.getByTestId('outbox-counter')).not.toBeVisible();

      // Wait for A to pull change
      await pageA.waitForTimeout(2000);

      // Verify A's active input was preserved!
      await expect(pageA.getByTestId('detail-phone-input')).toHaveValue('A typing in progress...');

      // Verify inline notice appeared on A
      await expect(pageA.getByTestId('remote-change-note')).toContainText(
        'Dev changed this while you were editing'
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
