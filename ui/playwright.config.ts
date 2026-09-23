import { defineConfig, devices } from '@playwright/test';

const testPassword = process.env.AI_OS_TEST_PASSWORD ?? '';
const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const temporaryDirectory = process.env.TEMP ?? process.env.TMPDIR ?? process.env.TMP ?? '.';
const backendPython = process.env.AI_OS_PYTHON
  ?? (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : 'python');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `"${backendPython}" -m kernel.main`,
      cwd: '..',
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: true,
      timeout: 120000,
      env: {
        AI_OS_USERS_FILE: `${temporaryDirectory}/ai-os-e2e-users-${testRunId}.json`,
        AI_OS_BOOTSTRAP_PASSWORD: testPassword,
        KERNEL_DB_PATH: `${temporaryDirectory}/ai-os-e2e-${testRunId}.db`,
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: true,
      timeout: 120000,
    },
  ],
});
