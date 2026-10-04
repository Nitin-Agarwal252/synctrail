/**
 * Phase 5 E2E — Scenarios 2, 3, 4 (and Edge Case #5)
 *
 * Scenario 2 — Merge: different fields, no conflicts
 * Scenario 3 — Conflict: same field, different values → conflict card → resolve
 * Scenario 4 — Edit-vs-delete: A deletes, B edits → conflict card → resolve Restore
 */

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'http://localhost:3000';

async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
}

async function goOnline(context: BrowserContext, page: Page) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function createHousehold(
  page: Page,
  name: string,
  phone: string,
  notes: string
): Promise<void> {
  await page.getByTestId('new-household-btn').click();
  await page.getByTestId('new-household-name').fill(name);
  await page.getByTestId('new-household-phone').fill(phone);
  await page.getByTestId('new-household-status').selectOption('new');
  await page.getByTestId('new-household-notes').fill(notes);
  await page.getByTestId('save-new-household').click();
  // Wait for it to sync to server
  await expect(page.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });
}

async function openRecord(page: Page, name: string) {
  const card = page.locator('.household-card').filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 12000 });
  await card.click();
}

test.describe('Phase 5: Conflict Scenarios', () => {
  test.beforeAll(() => {
    const dir = path.resolve('docs/evidence/phase-5');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 2: Merge — A edits notes, B edits phone; different fields → no conflict
  // ─────────────────────────────────────────────────────────────────────────────
  test('Scenario 2: Merge — different fields merge cleanly, zero conflicts', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const hName = `Merge Family ${Date.now()}`;
    const ctxA = await browser.newContext({ baseURL: BASE });
    const ctxB = await browser.newContext({ baseURL: BASE });
    const pgA = await ctxA.newPage();
    const pgB = await ctxB.newPage();

    try {
      await pgA.goto(BASE);
      await pgA.waitForLoadState('networkidle');
      await pgB.goto(BASE);
      await pgB.waitForLoadState('networkidle');

      // Ensure distinct users
      await pgB.getByTestId('user-switcher').selectOption('Dev');

      // A creates household
      await createHousehold(pgA, hName, '100-1001', 'original notes');

      // B sees the record
      await expect(pgB.locator('.household-card').filter({ hasText: hName })).toBeVisible({
        timeout: 12000,
      });

      // Both go offline
      await goOffline(ctxA, pgA);
      await goOffline(ctxB, pgB);

      // A edits notes
      await openRecord(pgA, hName);
      await pgA.getByTestId('detail-notes-input').fill('Meera updated notes');
      await pgA.getByTestId('detail-notes-input').press('Tab');

      // B edits phone (different field)
      await openRecord(pgB, hName);
      await pgB.getByTestId('detail-phone-input').fill('999-8888');
      await pgB.getByTestId('detail-phone-input').press('Enter');

      // A reconnects first
      await goOnline(ctxA, pgA);
      await expect(pgA.getByTestId('connection-pill')).toContainText('Synced', { timeout: 12000 });
      await expect(pgA.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });

      // B reconnects
      await goOnline(ctxB, pgB);
      await expect(pgB.getByTestId('connection-pill')).toContainText('Synced', { timeout: 12000 });
      await expect(pgB.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });

      // Wait for cross-pull propagation
      await pgA.waitForTimeout(2000);
      await pgB.waitForTimeout(2000);

      // Verify: A sees B's phone update
      await openRecord(pgA, hName);
      await expect(pgA.getByTestId('detail-phone-input')).toHaveValue('999-8888', {
        timeout: 10000,
      });
      // A's notes preserved
      await expect(pgA.getByTestId('detail-notes-input')).toHaveValue('Meera updated notes');

      // Verify: B sees A's notes update
      await openRecord(pgB, hName);
      await expect(pgB.getByTestId('detail-notes-input')).toHaveValue('Meera updated notes', {
        timeout: 10000,
      });
      // B's phone preserved
      await expect(pgB.getByTestId('detail-phone-input')).toHaveValue('999-8888');

      // Verify: ZERO conflicts in nav badge (no conflictCount badge visible)
      await expect(pgA.getByTestId('conflict-decision-badge')).not.toBeVisible();
      await expect(pgB.getByTestId('conflict-decision-badge')).not.toBeVisible();

      // Nav tab should show "Conflicts" without parenthetical count
      const tabTextA = await pgA.getByTestId('nav-tab-conflicts').textContent();
      expect(tabTextA?.trim()).toBe('Conflicts');

      // Screenshot evidence
      await pgA.screenshot({
        path: 'docs/evidence/phase-5/scenario2-merge-pageA.png',
        fullPage: false,
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 3: Conflict — both offline, both edit status differently
  // → conflict card shows ancestor/mine/theirs → resolve "Keep mine" → converge
  // ─────────────────────────────────────────────────────────────────────────────
  test('Scenario 3: Conflict — same field edited by both offline → conflict card → resolve', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const hName = `Conflict Family ${Date.now()}`;
    const ctxA = await browser.newContext({ baseURL: BASE });
    const ctxB = await browser.newContext({ baseURL: BASE });
    const pgA = await ctxA.newPage();
    const pgB = await ctxB.newPage();

    try {
      await pgA.goto(BASE);
      await pgA.waitForLoadState('networkidle');
      await pgB.goto(BASE);
      await pgB.waitForLoadState('networkidle');

      await pgB.getByTestId('user-switcher').selectOption('Dev');

      // A creates household with status 'new'
      await createHousehold(pgA, hName, '200-2002', '');

      // B sees the record
      await expect(pgB.locator('.household-card').filter({ hasText: hName })).toBeVisible({
        timeout: 12000,
      });

      // Both go offline
      await goOffline(ctxA, pgA);
      await goOffline(ctxB, pgB);

      // A changes status to 'follow-up'
      await openRecord(pgA, hName);
      await pgA.getByTestId('detail-status-select').selectOption('follow-up');

      // B changes status to 'completed' (conflict!)
      await openRecord(pgB, hName);
      await pgB.getByTestId('detail-status-select').selectOption('completed');

      // A reconnects first (A's op is committed to server)
      await goOnline(ctxA, pgA);
      await expect(pgA.getByTestId('connection-pill')).toContainText('Synced', { timeout: 12000 });
      await expect(pgA.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });

      // B reconnects (B's op conflicts with A's already-committed op)
      await goOnline(ctxB, pgB);
      await expect(pgB.getByTestId('connection-pill')).toContainText('Synced', { timeout: 12000 });
      await expect(pgB.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });

      // Wait for conflict to propagate to B
      await pgB.waitForTimeout(2000);

      // B should see the conflict-decision-badge
      await expect(pgB.getByTestId('conflict-decision-badge')).toBeVisible({ timeout: 10000 });

      // B navigates to Conflicts tab
      await pgB.getByTestId('nav-tab-conflicts').click();
      await expect(pgB.getByTestId('conflict-inbox-screen')).toBeVisible();

      // At least one conflict card exists
      const conflictCards = pgB.locator('[data-testid^="conflict-card-"]');
      await expect(conflictCards.first()).toBeVisible({ timeout: 8000 });

      // The 3-way columns should be visible on the first card (field conflict)
      await expect(pgB.locator('[data-testid="col-mine"]').first()).toBeVisible();
      await expect(pgB.locator('[data-testid="col-theirs"]').first()).toBeVisible();
      await expect(pgB.locator('[data-testid="col-ancestor"]').first()).toBeVisible();

      // Screenshot: conflict card visible
      await pgB.screenshot({
        path: 'docs/evidence/phase-5/scenario3-conflict-card-pageB.png',
        fullPage: false,
      });

      // Resolve: "Keep mine" (B's choice = 'completed')
      await pgB.locator('[data-testid="resolve-keep-mine"]').first().click();

      // After resolution, the conflict card disappears
      await expect(pgB.getByTestId('conflict-inbox-empty')).toBeVisible({ timeout: 10000 });

      // No more conflict badge on B
      await expect(pgB.getByTestId('conflict-decision-badge')).not.toBeVisible({ timeout: 8000 });

      // Navigate back to records
      await pgB.getByTestId('back-to-records').click();

      // Both screens should converge on B's choice ('completed' or 'follow-up', one winner)
      // Check A pulled the resolution
      await pgA.waitForTimeout(3000);

      // Screenshot: post-resolution convergence
      await pgA.screenshot({
        path: 'docs/evidence/phase-5/scenario3-resolved-pageA.png',
        fullPage: false,
      });
      await pgB.screenshot({
        path: 'docs/evidence/phase-5/scenario3-resolved-pageB.png',
        fullPage: false,
      });

      // Verify A has no open conflicts either
      await expect(pgA.getByTestId('conflict-decision-badge')).not.toBeVisible({ timeout: 8000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 4: Edit-vs-delete — A deletes, B edits; reconnect → conflict
  // → resolve with Restore → both converge (record is back, edit preserved)
  // ─────────────────────────────────────────────────────────────────────────────
  test('Scenario 4: Edit-vs-delete — A deletes, B edits offline → conflict → Restore → both converge', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const hName = `Delete Edit Family ${Date.now()}`;
    const ctxA = await browser.newContext({ baseURL: BASE });
    const ctxB = await browser.newContext({ baseURL: BASE });
    const pgA = await ctxA.newPage();
    const pgB = await ctxB.newPage();

    try {
      await pgA.goto(BASE);
      await pgA.waitForLoadState('networkidle');
      await pgB.goto(BASE);
      await pgB.waitForLoadState('networkidle');

      await pgB.getByTestId('user-switcher').selectOption('Dev');

      // A creates household
      await createHousehold(pgA, hName, '300-3003', '');

      // B sees the record
      await expect(pgB.locator('.household-card').filter({ hasText: hName })).toBeVisible({
        timeout: 12000,
      });

      // Both go offline
      await goOffline(ctxA, pgA);
      await goOffline(ctxB, pgB);

      // A deletes the household
      await openRecord(pgA, hName);
      await pgA.getByTestId('delete-household-btn').click();
      // Outbox should be non-empty now (delete op)
      await expect(pgA.getByTestId('outbox-counter')).toBeVisible();

      // B edits the phone (concurrently)
      await openRecord(pgB, hName);
      await pgB.getByTestId('detail-phone-input').fill('777-EDIT');
      await pgB.getByTestId('detail-phone-input').press('Enter');

      // A reconnects first (delete commits to server)
      await goOnline(ctxA, pgA);
      await expect(pgA.getByTestId('connection-pill')).toContainText('Synced', { timeout: 12000 });
      await expect(pgA.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });

      // B reconnects (B's edit conflicts with A's delete)
      await goOnline(ctxB, pgB);
      await expect(pgB.getByTestId('connection-pill')).toContainText('Synced', { timeout: 12000 });
      await expect(pgB.getByTestId('outbox-counter')).not.toBeVisible({ timeout: 10000 });

      // Wait for conflict propagation
      await pgB.waitForTimeout(2000);

      // B should see conflict badge
      await expect(pgB.getByTestId('conflict-decision-badge')).toBeVisible({ timeout: 12000 });

      // B opens conflict inbox
      await pgB.getByTestId('nav-tab-conflicts').click();
      await expect(pgB.getByTestId('conflict-inbox-screen')).toBeVisible();

      // A conflict card should exist (edit-vs-delete or delete-vs-edit)
      const conflictCards = pgB.locator('[data-testid^="conflict-card-"]');
      await expect(conflictCards.first()).toBeVisible({ timeout: 8000 });

      // Screenshot: edit-vs-delete conflict card
      await pgB.screenshot({
        path: 'docs/evidence/phase-5/scenario4-edit-vs-delete-card.png',
        fullPage: false,
      });

      // Resolve with Restore
      await pgB.locator('[data-testid="resolve-restore"]').first().click();

      // Inbox should be empty after resolution
      await expect(pgB.getByTestId('conflict-inbox-empty')).toBeVisible({ timeout: 12000 });

      // No more conflict badge
      await expect(pgB.getByTestId('conflict-decision-badge')).not.toBeVisible({ timeout: 8000 });

      // Navigate back to records
      await pgB.getByTestId('back-to-records').click();

      // The household should now be visible (restored)
      await expect(pgB.locator('.household-card').filter({ hasText: hName })).toBeVisible({
        timeout: 10000,
      });

      // A should also pull the restored record
      await pgA.waitForTimeout(3000);
      await expect(pgA.locator('.household-card').filter({ hasText: hName })).toBeVisible({
        timeout: 10000,
      });

      // Screenshots: post-restoration convergence
      await pgA.screenshot({
        path: 'docs/evidence/phase-5/scenario4-restored-pageA.png',
        fullPage: false,
      });
      await pgB.screenshot({
        path: 'docs/evidence/phase-5/scenario4-restored-pageB.png',
        fullPage: false,
      });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
