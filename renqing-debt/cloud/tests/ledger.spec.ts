import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789"; // 人情债本体 + KV
const NO_KV = "http://127.0.0.1:8787"; // 占位页，没绑 KV

const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");
const authed = (browser: Browser) =>
  browser.newContext({ httpCredentials: { username: USER, password: PASS }, baseURL: APP });

const ledger = (records: unknown[]) => ({ version: 2, events: [], records, tags: {}, settings: {} });

/**
 * 所有测试共用同一个本地 KV，所以要自己准备起点——
 * 否则前面接口测试存进去的账本会变成 UI 测试的初始状态，笔数对不上。
 */
async function withEmptyLedger(browser: Browser) {
  const ctx = await authed(browser);
  await ctx.request.put(APP + "/api/ledger", {
    headers: { "Content-Type": "application/json" },
    data: ledger([]),
  });
  return ctx;
}

/* ---------- 接口层 ---------- */

test("账本接口也在登录墙后面", async ({ request }) => {
  const res = await request.get(APP + "/api/ledger");
  expect(res.status()).toBe(401);
});

test("还没有账本时返回 204，不是错误", async ({ request }) => {
  // 每个测试文件用各自的 KV 实例，这里是干净的
  const res = await request.get(APP + "/api/ledger", { headers: { Authorization: basic() } });
  expect([204, 200]).toContain(res.status());
});

test("存进去能读回来，一个字节不差", async ({ request }) => {
  const body = ledger([{ id: "r1", name: "二舅", amount: 200, dir: "in" }]);
  const put = await request.put(APP + "/api/ledger", {
    headers: { Authorization: basic(), "Content-Type": "application/json" },
    data: body,
  });
  expect(put.status()).toBe(200);

  const get = await request.get(APP + "/api/ledger", { headers: { Authorization: basic() } });
  expect(get.status()).toBe(200);
  expect(await get.json()).toEqual(body);
});

// 挡住空 body 和明显不是账本的东西：一次网络抽风不该把整本账覆盖成 "undefined"
test("不像账本的东西存不进去", async ({ request }) => {
  for (const junk of ["", "undefined", "null", '{"nope":1}', "[]"]) {
    const res = await request.fetch(APP + "/api/ledger", {
      method: "PUT",
      headers: { Authorization: basic(), "Content-Type": "application/json" },
      data: junk,
    });
    expect(res.status(), `PUT ${JSON.stringify(junk)} 应被拒`).toBe(400);
  }
});

// 和「忘配 SESSION_SECRET」同理：少配一个绑定，不能变成静默的数据丢失
test("没绑 KV 时明说存不了，不假装成功", async ({ request }) => {
  const res = await request.get(NO_KV + "/api/ledger", { headers: { Authorization: basic() } });
  expect(res.status()).toBe(501);
});

/* ---------- 端到端：本票的核心验收 ---------- */

test("私有云态：记一笔，刷新页面，那笔还在", async ({ browser }) => {
  const ctx = await withEmptyLedger(browser);
  const page = await ctx.newPage();
  await page.goto("/");

  // 形态由 Worker 注入的标记决定，不靠 URL 参数
  await expect(page.locator("#mode-badge")).toHaveText("私有云态");

  const before = Number(await page.locator("#s-count").textContent());
  await page.fill("#f-name", "二舅");
  await page.fill("#f-amount", "2000");
  await page.click("#btn-add");
  await expect(page.locator("#s-count")).toHaveText(String(before + 1));

  // 存到云端了才算数
  await expect(page.locator("#cloud-status")).toContainText("已存到云端");

  // 这一下是本票的全部意义：刷新之后账还在（试玩态在这里会还原）
  await page.reload();
  await expect(page.locator("#s-count")).toHaveText(String(before + 1));
  await expect(page.locator("#rows").getByText("二舅")).toHaveCount(1);

  await ctx.close();
});

test("换台设备（另一个浏览器上下文）看到的是同一本账", async ({ browser }) => {
  const first = await withEmptyLedger(browser);
  const p1 = await first.newPage();
  await p1.goto("/");
  await p1.fill("#f-name", "跨设备验证");
  await p1.fill("#f-amount", "888");
  await p1.click("#btn-add");
  await expect(p1.locator("#cloud-status")).toContainText("已存到云端");
  const count = await p1.locator("#s-count").textContent();
  await first.close();

  // 全新上下文 = 全新的 localStorage，只有云端那本账能解释它看到的内容
  const second = await authed(browser);
  const p2 = await second.newPage();
  await p2.goto("/");
  await expect(p2.locator("#s-count")).toHaveText(count!);
  await expect(p2.locator("#rows").getByText("跨设备验证")).toHaveCount(1);
  await second.close();
});

test("私有云态不碰 localStorage", async ({ browser }) => {
  const ctx = await withEmptyLedger(browser);
  const page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#f-name", "不落盘");
  await page.fill("#f-amount", "100");
  await page.click("#btn-add");
  await expect(page.locator("#cloud-status")).toContainText("已存到云端");

  expect(await page.evaluate(() => localStorage.getItem("renqing-debt/v1"))).toBeNull();
  await ctx.close();
});

/* ---------- 出错时别让人白记 ---------- */

// 拉不到账本却照常启动的话，人看到的是一本空账，记一笔就把云端真账覆盖了。
// 宁可整个挡住，也不能让这件事发生。
test("读不到账本时挡住页面，不让人往一本假空账里记", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.route("**/api/ledger", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500 }) : route.continue(),
  );
  await page.goto("/");

  await expect(page.locator("#cloud-block")).toBeVisible();
  await expect(page.locator("#cloud-block")).toContainText("先别记账");
  await ctx.close();
});

// 「以为记上了、其实没记」是这个系统能犯的最坏的错
test("存不上时明确说出来，而且提示不会自己消失", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/");

  await page.route("**/api/ledger", (route) =>
    route.request().method() === "PUT" ? route.fulfill({ status: 500 }) : route.continue(),
  );
  await page.fill("#f-name", "存不上的一笔");
  await page.fill("#f-amount", "50");
  await page.click("#btn-add");

  const status = page.locator("#cloud-status");
  await expect(status).toContainText("没存上");
  await expect(status).toContainText("这一笔还没进云端");
  // 失败提示不该像成功提示那样自动淡出
  await page.waitForTimeout(2200);
  await expect(status).toBeVisible();
  await ctx.close();
});

// debounce 那 400 毫秒是个丢数据的窗口：记完马上切走或关掉页面，
// UI 明明显示笔数 +1，云端却什么都没收到。这条把窗口钉死。
// 关键是让 pagehide 发生在 debounce **之前**——所以点击和派发放在同一次
// evaluate 里同步执行，否则测的就只是 debounce 自己完成了。
test("记一笔后立刻关页面，那一笔也不会丢", async ({ browser }) => {
  const ctx = await withEmptyLedger(browser);
  const page = await ctx.newPage();
  await page.goto("/");
  await page.fill("#f-name", "关得快");
  await page.fill("#f-amount", "700");

  await page.evaluate(() => {
    document.getElementById("btn-add").click();
    window.dispatchEvent(new Event("pagehide")); // 同步，debounce 还没到
  });
  // 立刻关掉页面：debounce 的 timer 随页面上下文一起消失，
  // 于是只有 keepalive 那次请求能把这一笔送出去。
  // （等一会儿再关的话，debounce 自己就完成了，这条测试就测不到 flushNow——
  //   这正是它第一版的毛病，被变异测试抓了出来。）
  await page.close();
  await ctx.close();
  await new Promise((r) => setTimeout(r, 900)); // 等 keepalive 落地

  const check = await authed(browser);
  const res = await check.request.get(APP + "/api/ledger");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.records.map((r: any) => r.name)).toContain("关得快");
  await check.close();
});
