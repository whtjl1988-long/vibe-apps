import { defineConfig } from "@playwright/test";

// e2e 跑在 wrangler dev 起的本地 Worker 上，不连真 Cloudflare、不碰真账本。
// 起两份：8787 配了会话密钥，8788 故意没配——后者用来钉住「忘了配密钥时
// 不能悄悄降级成谁都能进」。
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8787" },
  webServer: [
    {
      command: "npx wrangler dev -c wrangler.test.toml --port 8787",
      url: "http://127.0.0.1:8787",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npx wrangler dev -c wrangler.nosession.toml --port 8788",
      url: "http://127.0.0.1:8788",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
