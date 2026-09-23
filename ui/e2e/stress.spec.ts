import { test, expect } from '@playwright/test';

const testPassword = process.env.AI_OS_TEST_PASSWORD;
if (!testPassword) throw new Error('Set AI_OS_TEST_PASSWORD before running browser tests.');

test.describe('AI OS Empirical Stress & Edge Case Test Suite', () => {
  let pageErrors: Error[] = [];

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => {
      console.error('Page Error caught:', err);
      pageErrors.push(err);
    });

    await page.goto('/');

    const loginModal = page.locator('#login-modal');
    if (await loginModal.isVisible()) {
      const alexProfileBtn = page.locator('#login-modal button.chip-btn[data-user="alex"]');
      await expect(alexProfileBtn).toBeVisible();
      await alexProfileBtn.click();
      await page.locator('#login-password').fill(testPassword);
      await page.locator('#login-form button[type="submit"]').click();
      await expect(loginModal).not.toBeVisible();
    }
  });

  test.afterEach(() => {
    expect(pageErrors, `Encountered unexpected page errors: ${pageErrors.map(e => e.message).join('; ')}`).toHaveLength(0);
  });

  test('Rapid Tab Switching Stress Test (Pixel Office & all views)', async ({ page }) => {
    const tabs = [
      { id: '#tab-dashboard', view: '#view-dashboard', display: 'block', dev: false },
      { id: '#tab-mvp-showcase', view: '#view-mvp-showcase', display: 'block', dev: false },
      { id: '#tab-agentic-goals', view: '#view-agentic-goals', display: 'block', dev: false },
      { id: '#tab-monitoring', view: '#view-monitoring', display: 'block', dev: false },
      { id: '#tab-habitat', view: '#view-habitat', display: 'flex', dev: false },
      { id: '#tab-customization', view: '#view-customization', display: 'flex', dev: true },
      { id: '#tab-ingestion', view: '#view-ingestion', display: 'flex', dev: true },
      { id: '#tab-agent-logs', view: '#view-agent-logs', display: 'block', dev: true },
    ];

    // Rapidly switch between Pixel Office (#tab-habitat) and each other view 3 times in quick succession
    for (let loop = 0; loop < 3; loop++) {
      for (const targetTab of tabs) {
        // Switch to target view
        if (targetTab.dev) {
          await page.locator('.dev-dropdown').hover();
        }
        await page.locator(targetTab.id).click();
        await page.waitForTimeout(30); // 30ms rapid click pace

        // Rapidly switch back to Pixel Office
        await page.locator('#tab-habitat').click();
        await page.waitForTimeout(30);
      }
    }

    // After rapid switching burst, allow 100ms for final canvas resize tick
    await page.waitForTimeout(100);

    // Verify Pixel Office view and canvas state
    const habitatView = page.locator('#view-habitat');
    await expect(habitatView).toBeVisible();
    await expect(habitatView).toHaveCSS('display', 'flex');

    const robotCanvas = page.locator('#robot-canvas');
    await expect(robotCanvas).toBeVisible();

    const box = await robotCanvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);

    const canvasDims = await robotCanvas.evaluate((canvas: HTMLCanvasElement) => ({
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      width: canvas.width,
      height: canvas.height,
    }));

    expect(canvasDims.clientWidth).toBeGreaterThan(0);
    expect(canvasDims.clientHeight).toBeGreaterThan(0);
    expect(canvasDims.width).toBeGreaterThan(0);
    expect(canvasDims.height).toBeGreaterThan(0);
  });

  test('Window Resize during Canvas Rendering Stress Test', async ({ page }) => {
    // Navigate to Pixel Office
    await page.locator('#tab-habitat').click();
    await page.waitForTimeout(100);

    const robotCanvas = page.locator('#robot-canvas');
    await expect(robotCanvas).toBeVisible();

    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 800, height: 600 },
      { width: 375, height: 667 }, // mobile viewport edge case
      { width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(100); // Allow resize event and requestAnimationFrame loop to execute

      const box = await robotCanvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);

      const dims = await robotCanvas.evaluate((c: HTMLCanvasElement) => ({
        clientWidth: c.clientWidth,
        clientHeight: c.clientHeight,
        width: c.width,
        height: c.height,
      }));

      expect(dims.clientWidth).toBeGreaterThan(0);
      expect(dims.clientHeight).toBeGreaterThan(0);
      expect(dims.width).toBeGreaterThan(0);
      expect(dims.height).toBeGreaterThan(0);
    }
  });

  test('Language Toggle Persistence and Backend Synchronization', async ({ page }) => {
    const langFiBtn = page.locator('#lang-fi');
    const langEnBtn = page.locator('#lang-en');

    await expect(langFiBtn).toBeVisible();
    await expect(langEnBtn).toBeVisible();

    // 1. Toggle to Finnish (FI)
    const [fiResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/user/customization') && res.request().method() === 'POST'),
      langFiBtn.click(),
    ]);

    expect(fiResponse.status()).toBe(200);

    // Verify UI active state and local storage
    await expect(langFiBtn).toHaveClass(/active/);
    await expect(langEnBtn).not.toHaveClass(/active/);
    const fiStorage = await page.evaluate(() => localStorage.getItem('os_language'));
    expect(fiStorage).toBe('fi');

    // 2. Reload page to verify persistence across reloads
    await page.reload();

    // Handle login modal if re-prompted
    const loginModal = page.locator('#login-modal');
    if (await loginModal.isVisible()) {
      await page.locator('#login-modal button.chip-btn[data-user="alex"]').click();
      await page.locator('#login-password').fill(testPassword);
      await page.locator('#login-form button[type="submit"]').click();
    }

    const langFiBtnReloaded = page.locator('#lang-fi');
    const langEnBtnReloaded = page.locator('#lang-en');
    await expect(langFiBtnReloaded).toHaveClass(/active/);
    await expect(langEnBtnReloaded).not.toHaveClass(/active/);

    const fiStorageReloaded = await page.evaluate(() => localStorage.getItem('os_language'));
    expect(fiStorageReloaded).toBe('fi');

    // 3. Toggle back to English (EN)
    const [enResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/user/customization') && res.request().method() === 'POST'),
      langEnBtnReloaded.click(),
    ]);

    expect(enResponse.status()).toBe(200);
    await expect(langEnBtnReloaded).toHaveClass(/active/);
    await expect(langFiBtnReloaded).not.toHaveClass(/active/);

    const enStorage = await page.evaluate(() => localStorage.getItem('os_language'));
    expect(enStorage).toBe('en');

    // 4. Reload page to verify EN persistence
    await page.reload();
    if (await page.locator('#login-modal').isVisible()) {
      await page.locator('#login-modal button.chip-btn[data-user="alex"]').click();
      await page.locator('#login-password').fill(testPassword);
      await page.locator('#login-form button[type="submit"]').click();
    }

    await expect(page.locator('#lang-en')).toHaveClass(/active/);
    await expect(page.locator('#lang-fi')).not.toHaveClass(/active/);
    const enStorageReloaded = await page.evaluate(() => localStorage.getItem('os_language'));
    expect(enStorageReloaded).toBe('en');
  });
});
