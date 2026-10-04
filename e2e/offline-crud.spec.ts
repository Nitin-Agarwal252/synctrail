import { test, expect, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

test.describe('Phase 3: Client Local-First (No Sync Yet)', () => {
  test.beforeAll(() => {
    const evidenceDir = path.resolve('docs/evidence/phase-3');
    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }
  });

  test('offline CRUD, reload persistence, and undo delete', async ({ page, context }) => {
    const familyName = `Offline Family ${Date.now()}`;

    // 1. Load app online to activate service worker and IndexedDB
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for Service Worker registration
    await page.waitForFunction(async () => {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        return Boolean(reg);
      }
      return true;
    });

    // 2. Go offline
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    // Verify offline UI indicators
    await expect(page.getByTestId('connection-pill')).toContainText('Offline · saved on this device');
    await expect(page.getByTestId('offline-banner')).toContainText(
      "You're offline. Changes are safe and will sync when you reconnect."
    );

    // 3. Create a new household offline
    await page.getByTestId('new-household-btn').click();
    await page.getByTestId('new-household-name').fill(familyName);
    await page.getByTestId('new-household-phone').fill('98300 11122');
    await page.getByTestId('new-household-status').selectOption('follow-up');
    await page.getByTestId('new-household-address').fill('14 North Cross Road');
    await page.getByTestId('new-household-notes').fill('Needs second visit, child under 5');
    await page.getByTestId('save-new-household').click();

    // Verify record in list (desktop shows both list & detail)
    const card = page.locator('.household-card').filter({ hasText: familyName });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Pending');
    await expect(page.getByTestId('outbox-counter')).toBeVisible();

    // 4. Select household to view detail
    await card.click();
    await expect(page.getByTestId('record-detail-screen')).toBeVisible();
    await expect(page.getByTestId('detail-name-input')).toHaveValue(familyName);
    await expect(page.getByTestId('detail-phone-input')).toHaveValue('98300 11122');
    await expect(page.getByTestId('detail-status-select')).toHaveValue('follow-up');

    // Verify history strip shows the creation op
    await expect(page.getByTestId('history-strip')).toContainText('Created by Meera (pending)');

    // 5. Edit field: update phone number (saves on blur / Enter)
    await page.getByTestId('detail-phone-input').fill('98300 99999');
    await page.getByTestId('detail-phone-input').press('Enter');

    // Verify outbox shows waiting count
    await expect(page.getByTestId('outbox-counter')).toBeVisible();
    await expect(page.getByTestId('history-strip')).toContainText('Meera set phone → 98300 99999 (pending)');

    // 6. Reload while still offline: data must survive reload via Service Worker & Dexie
    await page.reload();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByTestId('connection-pill')).toContainText('Offline · saved on this device');
    await expect(page.locator('.household-card').filter({ hasText: familyName })).toBeVisible();

    // Verify persisted edit on detail pane
    const reloadedCard = page.locator('.household-card').filter({ hasText: familyName });
    await reloadedCard.click();
    await expect(page.getByTestId('detail-phone-input')).toHaveValue('98300 99999');

    // 7. Delete household: triggers 8s Undo toast
    await page.getByTestId('delete-household-btn').click();
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Household deleted. Undo');

    // Deleted record is no longer visible in active list
    await expect(page.locator('.household-card').filter({ hasText: familyName })).not.toBeVisible();

    // Deleted filter chip shows deleted household
    await page.getByTestId('filter-deleted').click();
    await expect(page.locator('.household-card').filter({ hasText: familyName })).toBeVisible();

    // Click Undo on toast to restore
    await page.getByTestId('toast-action').click();

    // Verify restored
    await page.getByTestId('filter-all').click();
    await expect(page.locator('.household-card').filter({ hasText: familyName })).toBeVisible();
  });

  test('cold start offline after full browser restart', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synctrail-coldstart-'));
    const coldName = `Cold Family ${Date.now()}`;

    try {
      // Step 1: Launch browser context with persistent storage, load online
      const context1 = await chromium.launchPersistentContext(tempDir, {
        baseURL: 'http://localhost:3000',
      });
      const page1 = await context1.newPage();
      await page1.goto('http://localhost:3000/');
      await page1.waitForLoadState('networkidle');

      // Wait for Service Worker registration
      await page1.waitForFunction(async () => {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          return Boolean(reg);
        }
        return true;
      });

      // Create a household
      await page1.getByTestId('new-household-btn').click();
      await page1.getByTestId('new-household-name').fill(coldName);
      await page1.getByTestId('new-household-phone').fill('555-0199');
      await page1.getByTestId('save-new-household').click();

      await expect(page1.locator('.household-card').filter({ hasText: coldName })).toBeVisible();

      // Wait for sync to complete so record is persisted in IndexedDB snapshot
      await expect(page1.getByTestId('connection-pill')).toContainText('Synced', { timeout: 10000 });
      await expect(page1.getByTestId('outbox-counter')).not.toBeVisible();
      await page1.waitForTimeout(500);

      // Step 2: Fully close browser context
      await context1.close();

      // Step 3: Relaunch with the SAME storage directory in offline mode
      const context2 = await chromium.launchPersistentContext(tempDir, {
        baseURL: 'http://localhost:3000',
        offline: true,
      });
      const page2 = await context2.newPage();
      await page2.goto('http://localhost:3000/');

      // Step 4: Verify app shell and data load offline
      await expect(page2.getByText('SyncTrail · Survey')).toBeVisible();
      await expect(page2.getByTestId('connection-pill')).toContainText('Offline · saved on this device');
      await page2.getByTestId('search-input').fill(coldName);
      await expect(page2.locator('.household-card').filter({ hasText: coldName })).toBeVisible();

      await context2.close();
    } finally {
      // Clean up temp dir
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
  });

  test('visual verification: screens 1 and 2 at 360px and 1280px', async ({ page }) => {
    const visualName = `Visual Family ${Date.now()}`;

    // 1. Mobile 360px Viewport (Screen 1: Records list)
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Create a demo record to populate Screen 1
    await page.getByTestId('new-household-btn').click();
    await page.getByTestId('new-household-name').fill(visualName);
    await page.getByTestId('new-household-phone').fill('98300 11122');
    await page.getByTestId('new-household-status').selectOption('follow-up');
    await page.getByTestId('new-household-address').fill('14 North Cross Road');
    await page.getByTestId('new-household-notes').fill('Needs second visit, child under 5');
    await page.getByTestId('save-new-household').click();

    // After creation, on mobile it transitions to Screen 2. Navigate back to Screen 1.
    const backBtn = page.getByTestId('back-to-households');
    await expect(backBtn).toBeVisible();
    await backBtn.click();

    // Verify Screen 1 is displayed
    await expect(page.getByTestId('records-list-screen')).toBeVisible();
    const card = page.locator('.household-card').filter({ hasText: visualName });
    await expect(card).toBeVisible();

    // Capture Screen 1 at 360px
    await page.screenshot({
      path: 'docs/evidence/phase-3/screen1-records-360px.png',
      fullPage: true,
    });

    // Mobile 360px Viewport (Screen 2: Record Detail)
    await card.click();
    await expect(page.getByTestId('record-detail-screen')).toBeVisible();
    await expect(page.getByTestId('detail-name-input')).toHaveValue(visualName);

    // Capture Screen 2 at 360px
    await page.screenshot({
      path: 'docs/evidence/phase-3/screen2-detail-360px.png',
      fullPage: true,
    });

    // 2. Desktop 1280px Viewport (Master / Detail dual-pane)
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300); // Allow responsive reflow
    await expect(page.getByTestId('records-list-screen')).toBeVisible();
    await expect(page.getByTestId('record-detail-screen')).toBeVisible();

    // Capture Desktop Master/Detail at 1280px
    await page.screenshot({
      path: 'docs/evidence/phase-3/screen-master-detail-1280px.png',
      fullPage: true,
    });
  });
});
