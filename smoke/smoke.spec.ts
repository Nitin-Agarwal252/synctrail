import { test, expect } from '@playwright/test';

test('deployed app: health, app shell, records, live WebSocket, JSON 404', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  const body = await health.json();
  expect(body.ok).toBe(true);
  expect(typeof body.epoch).toBe('string');

  const missing = await request.get('/api/nope');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');

  const socket = page.waitForEvent('websocket');
  await page.goto('/');
  expect(new URL((await socket).url()).pathname).toBe('/ws');
  await expect(page.getByTestId('connection-pill')).toContainText('Synced', { timeout: 15000 });
  await expect(page.locator('.household-card').first()).toBeVisible();

  if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT, fullPage: true });
});
