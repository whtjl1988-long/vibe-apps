import { defineConfig } from "@playwright/test";

// e2e 跑在 wrangler dev 起的本地 Worker 上，不连真 Cloudflare、不碰真账本。
// 起三份：8787 配了会话密钥、8788 故意没配（钉住「忘了配密钥时不能悄悄
// 降级成谁都能进」）、8789 是人情债本体 + KV（测私有云态的账本读写）。
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  // 串行。账本测试共用同一个本地 KV，而账本现在有乐观锁——并行跑的用例
  // 会互相撞版本号，红得毫无信息量。慢一点换确定性。
  workers: 1,
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
    {
      // 第三份：assets 是人情债本体 + 绑了 KV，用来测私有云态的账本读写
      command:
        "node scripts/prepare-test-app.mjs && npx wrangler dev -c wrangler.app.toml --port 8789",
      url: "http://127.0.0.1:8789",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
