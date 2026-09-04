import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789";

const authed = (browser: Browser) =>
  browser.newContext({ httpCredentials: { username: USER, password: PASS }, baseURL: APP });

// 自留地里人情债住在 /renqing/，根是卡片墙。子路径下那条 `./api/ledger`
// 会解析成 /renqing/api/ledger——所以接口地址必须由 Worker 注入，软件别自己猜。
test("子路径部署：账本接口地址由 Worker 给，不靠相对路径", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/");

  expect(await page.evaluate(() => (window as any).__LEDGER_API__)).toBe("/api/ledger");
  await expect(page.locator("#mode-badge")).toHaveText("私有云态");
  await ctx.close();
});

test("子路径部署：记一笔真能存上，刷新还在", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/");

  const before = Number(await page.locator("#s-count").textContent());
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/ledger") && r.request().method() === "PUT" && r.status() === 200,
  );
  await page.fill("#f-name", "子路径下记的");
  await page.fill("#f-amount", "520");
  await page.click("#btn-add");
  await saved;

  await page.reload();
  await expect(page.locator("#s-count")).toHaveText(String(before + 1));
  await expect(page.locator("#rows").getByText("子路径下记的")).toHaveCount(1);
  await ctx.close();
});

test("子路径部署：历史版本也走得通", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/");
  await expect(page.locator("#btn-history")).toBeVisible();
  await page.click("#btn-history");
  // 断言**终态出现了什么**，而不是「没出现错误」。
  // 面板刚打开时显示「正在读…」，那时当然不含错误字样——
  // 用 not.toContainText 的话断言会在真正的失败发生之前就通过（假绿）。
  await expect(page.locator("#history-list")).toContainText(/第 \d+ 版|还没有历史版本/);
  await ctx.close();
});

// 你在自己家里，不需要一个门牌指向展厅
test("自留地里的品牌条指回自留地首页", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/");

  const back = page.locator("#back-link");
  await expect(back).toHaveText("我的自留地");
  expect(new URL(await back.getAttribute("href") ?? "", APP).pathname).toBe("/");
  expect(new URL((await page.locator("#site-bar .brand").getAttribute("href")) ?? "", APP).pathname).toBe("/");
  await ctx.close();
});

// 公开分发的那份没有注入，必须保持原样——站点的 e2e 一直钉着这条
test("没有云端标记时，品牌条仍指向站点作品墙", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/?mode=demo"); // 显式退回试玩态，不走云端分支
  await expect(page.locator("#back-link")).toHaveText("作品墙");
  expect(await page.locator("#back-link").getAttribute("href")).toBe("https://vibe-all.com/apps/");
  await ctx.close();
});
