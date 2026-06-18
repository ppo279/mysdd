import { defineConfig, devices } from '@playwright/test'

// E2E 配置 —— 仅覆盖 spec.md 中的 AC-01 / AC-02
// 依赖 dev 服务：后端 3001、前端 5173（由 webServer 在缺省时拉起）。
const FRONTEND_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const BACKEND_URL = process.env.E2E_API_BASE ?? 'http://localhost:3001'

export default defineConfig({
  testDir: './e2e/tests',
  // AC-01/02 涉及文件 IO（创建工作区落盘），放宽超时；不并行：避免共享 WORKSPACE_BASE 写入竞争。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: FRONTEND_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:backend',
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:frontend',
      url: FRONTEND_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})
