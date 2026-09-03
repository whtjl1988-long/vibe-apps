import { defineConfig } from "@playwright/test";

// e2e 跑在 wrangler dev 起的本地 Worker 上，用 wrangler.test.toml 里的假凭据。
// 不连真 Cloudflare、不碰真账本。
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8787" },
  webServer: {
    command: "npx wrangler dev -c wrangler.test.toml --port 8787",
    url: "http://127.0.0.1:8787",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
