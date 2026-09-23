import { test, expect } from '@playwright/test';

const testPassword = process.env.AI_OS_TEST_PASSWORD;
if (!testPassword) throw new Error('Set AI_OS_TEST_PASSWORD before running browser tests.');

test.describe('Sources and Monitoring', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const loginModal = page.locator('#login-modal');
    if (await loginModal.isVisible()) {
      await page.locator('#login-modal button.chip-btn[data-user="alex"]').click();
      await page.locator('#login-password').fill(testPassword);
      await page.locator('#login-form button[type="submit"]').click();
      await expect(loginModal).not.toBeVisible();
    }
  });

  test('opens the connector workspace and safe RSS form', async ({ page }) => {
    await page.locator('#tab-monitoring').click();
    await expect(page.locator('#view-monitoring')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sources & Monitoring' })).toBeVisible();
    await expect(page.locator('#connector-instance-list')).toContainText(/No external sources|connected source/i);

    await page.getByRole('button', { name: 'Connect RSS feed' }).click();
    await expect(page.getByRole('heading', { name: 'Connect an RSS or Atom feed' })).toBeVisible();
    await expect(page.locator('#connector-feed-url')).toBeVisible();
    await expect(page.locator('#connector-modal')).toContainText('Local/private network addresses');
  });
});
