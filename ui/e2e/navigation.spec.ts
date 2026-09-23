import { test, expect } from '@playwright/test';

const testPassword = process.env.AI_OS_TEST_PASSWORD;
if (!testPassword) throw new Error('Set AI_OS_TEST_PASSWORD before running browser tests.');

test.describe('AI OS Navigation & Core UI E2E Test Suite', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to base URL and perform authentication with Quick Profile (Alex)
    await page.goto('/');

    // Check if login modal is present and visible
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

  test('Login / Initial Authentication', async ({ page }) => {
    // Verify that after login, default view (Executive Boardroom) is visible
    const dashboardView = page.locator('#view-dashboard');
    await expect(dashboardView).toBeVisible();
    await expect(dashboardView).toHaveCSS('display', 'block');
  });

  test('Unified Navigation Views Verification', async ({ page }) => {
    const viewsToTest = [
      {
        name: 'Executive Boardroom',
        tabSelector: '#tab-dashboard',
        viewSelector: '#view-dashboard',
        expectedDisplay: 'block',
        isDevDropdown: false,
      },
      {
        name: 'MVP Showcase',
        tabSelector: '#tab-mvp-showcase',
        viewSelector: '#view-mvp-showcase',
        expectedDisplay: 'block',
        isDevDropdown: false,
      },
      {
        name: 'Agent Work',
        tabSelector: '#tab-agentic-goals',
        viewSelector: '#view-agentic-goals',
        expectedDisplay: 'block',
        isDevDropdown: false,
      },
      {
        name: 'Sources & Monitoring',
        tabSelector: '#tab-monitoring',
        viewSelector: '#view-monitoring',
        expectedDisplay: 'block',
        isDevDropdown: false,
      },
      {
        name: 'Pixel Office',
        tabSelector: '#tab-habitat',
        viewSelector: '#view-habitat',
        expectedDisplay: 'flex',
        isDevDropdown: false,
      },
      {
        name: 'Agent Customization Studio',
        tabSelector: '#tab-customization',
        viewSelector: '#view-customization',
        expectedDisplay: 'flex',
        isDevDropdown: true,
      },
      {
        name: 'Developer Database Studio',
        tabSelector: '#tab-ingestion',
        viewSelector: '#view-ingestion',
        expectedDisplay: 'flex',
        isDevDropdown: true,
      },
      {
        name: 'Agent Activity Log',
        tabSelector: '#tab-agent-logs',
        viewSelector: '#view-agent-logs',
        expectedDisplay: 'block',
        isDevDropdown: true,
      },
    ];

    for (const view of viewsToTest) {
      if (view.isDevDropdown) {
        // Hover over the Developer dropdown to expose menu items
        const devDropdown = page.locator('.dev-dropdown');
        await devDropdown.hover();
      }

      const tabButton = page.locator(view.tabSelector);
      await expect(tabButton).toBeVisible();
      await tabButton.click();

      const viewContainer = page.locator(view.viewSelector);
      await expect(viewContainer).toBeVisible();
      await expect(viewContainer).toHaveCSS('display', view.expectedDisplay);
    }

    await page.locator('#tab-agentic-goals').click();
    await page.locator('#agent-work-board-mode').click();
    await expect(page.locator('#agent-work-board-panel')).toBeVisible();
    await expect(page.locator('#col-pending')).toBeVisible();
  });

  test('Canvas Sizing Verification on Pixel Office view', async ({ page }) => {
    // Navigate to Pixel Office view
    const habitatTab = page.locator('#tab-habitat');
    await expect(habitatTab).toBeVisible();
    await habitatTab.click();

    const habitatView = page.locator('#view-habitat');
    await expect(habitatView).toBeVisible();

    // Verify #robot-canvas visibility and dimensions
    const robotCanvas = page.locator('#robot-canvas');
    await expect(robotCanvas).toBeVisible();

    const boundingBox = await robotCanvas.boundingBox();
    expect(boundingBox).not.toBeNull();
    expect(boundingBox!.width).toBeGreaterThan(100);
    expect(boundingBox!.height).toBeGreaterThan(100);

    const dimensions = await robotCanvas.evaluate((canvas: HTMLCanvasElement) => ({
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
    }));

    expect(dimensions.clientWidth).toBeGreaterThan(0);
    expect(dimensions.clientHeight).toBeGreaterThan(0);
  });

  test('Language Toggle Verification', async ({ page }) => {
    const langFiBtn = page.locator('#lang-fi');
    const langEnBtn = page.locator('#lang-en');

    await expect(langFiBtn).toBeVisible();
    await expect(langEnBtn).toBeVisible();

    // Listen for network request to /api/user/customization when clicking FI
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/api/user/customization') && req.method() === 'POST'),
      langFiBtn.click(),
    ]);

    // Verify FI button active class
    await expect(langFiBtn).toHaveClass(/active/);
    await expect(langEnBtn).not.toHaveClass(/active/);

    // Verify payload of the network request
    const postData = JSON.parse(request.postData() || '{}');
    expect(postData.language).toBe('fi');

    // Verify localStorage item os_language
    const savedLangFi = await page.evaluate(() => localStorage.getItem('os_language'));
    expect(savedLangFi).toBe('fi');

    // Click EN button and verify
    await langEnBtn.click();
    await expect(langEnBtn).toHaveClass(/active/);
    await expect(langFiBtn).not.toHaveClass(/active/);

    const savedLangEn = await page.evaluate(() => localStorage.getItem('os_language'));
    expect(savedLangEn).toBe('en');
  });
});
