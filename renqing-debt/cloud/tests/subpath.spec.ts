import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789";

// 显式带 Basic 头 = 命令行那条路的真实形态。
// 不用 httpCredentials：它要等 401 挑战才发凭据，而挑战头（WWW-Authenticate）
// 正是浏览器弹原生框的原因，已经去掉了。
const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");

const authed = (browser: Browser) =>
  browser.newContext({ extraHTTPHeaders: { Authorization: basic() }, baseURL: APP });

/**
 * 等 UI 真的可以操作了。
 *
 * 别拿 `#mode-badge` 当锚点——它在 `UI.init()` 里、`bind()` **之前**就被设上，
 * 断言通过时事件可能还没绑定，接下来的 click 就是空点（冷启动慢时必现，
 * 表现为「笔数不变、一个请求都没发」，极难看出来）。
 * 事项下拉是 `renderEventOptions()` 填的，那一步在 `bind()` 之后。
 */
/**
 * 等 UI 真的可以操作了。
 *
 * 锚点必须是「初始不成立、就绪后才成立」的：`#f-filter` 在 HTML 里是个空
 * `<select>`，由 `renderEventOptions()` 填，而那一步排在 `bind()` 之后。
 *
 * 别拿这些当锚点：`#mode-badge`（在 `bind()` 之前就被设上，那时点击还是空点）、
 * `#cloud-status` 隐藏（它初始就带 hidden，断言瞬间通过，等于没等）。
 */
async function ready(page: any) {
  await expect(page.locator("#f-filter option").first()).toBeAttached();
}

/**
 * 给这个文件准备干净账本。
 *
 * 不重置的话会踩到软件的**同名确认**：账本里已有同名的人时，记账不会直接落，
 * 而是弹确认框等人拍板（`UI.tryAdd` → `Checks.inspect` → `openConfirm`）。
 * 前几次跑留下的同名记录会让后面的用例卡在那个框上——表现为「笔数不变、
 * 一个请求都没发」，看起来像是点击失灵，其实是软件在正常地等回答。
 */
async function withCleanLedger(browser: Browser) {
  const ctx = await authed(browser);
  const cur = await ctx.request.get(APP + "/api/ledger");
  await ctx.request.put(APP + "/api/ledger", {
    headers: {
      "Content-Type": "application/json",
      "If-Match": cur.headers()["etag"] || '"0"',
    },
    data: { version: 2, events: [], records: [], tags: {}, settings: {} },
  });
  return ctx;
}

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
  const ctx = await withCleanLedger(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/");
  await ready(page);

  const before = Number(await page.locator("#s-count").textContent());

  await page.fill("#f-name", "子路径下记的");
  await page.fill("#f-amount", "520");
  await page.click("#btn-add");
  await expect(page.locator("#s-count")).toHaveText(String(before + 1));
  await expect(page.locator("#cloud-status")).toContainText("已存到云端");

  // 核心：刷新之后账还在，说明它真落到了云端而不是只在内存里
  await page.reload();
  await ready(page);
  await expect(page.locator("#s-count")).toHaveText(String(before + 1));
  await expect(page.locator("#rows").getByText("子路径下记的")).toHaveCount(1);
  await ctx.close();
});

test("子路径部署：历史版本也走得通", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/renqing/");
  await ready(page);
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
