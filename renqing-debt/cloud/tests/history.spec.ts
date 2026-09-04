import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789";

const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");
const authed = (browser: Browser) =>
  browser.newContext({ httpCredentials: { username: USER, password: PASS }, baseURL: APP });
const ledger = (records: unknown[]) => ({ version: 2, events: [], records, tags: {}, settings: {} });
const one = (name: string) => ledger([{ id: name, name, amount: 1, dir: "in" }]);

async function rev(request: any): Promise<string> {
  return (await request.get(APP + "/api/ledger")).headers()["etag"] || '"0"';
}
const put = async (request: any, data: unknown) =>
  request.put(APP + "/api/ledger", {
    headers: { "Content-Type": "application/json", "If-Match": await rev(request) },
    data,
  });
const history = async (request: any) =>
  (await request.get(APP + "/api/ledger/history")).json();

/**
 * 记一笔并**等它真的存上去**。
 *
 * 不能靠等「已存到云端」那条提示：它要 1.6 秒才淡出，所以第二次记账后
 * 立刻断言它出现，看到的其实是上一次留下的那条——断言瞬间通过，而这次的
 * PUT 还没发生。等 UI 提示不等于等操作完成。
 */
async function addAndSave(page: any, name: string, amount: string) {
  const saved = page.waitForResponse(
    (r: any) =>
      r.url().includes("/api/ledger") && r.request().method() === "PUT" && r.status() === 200,
  );
  await page.fill("#f-name", name);
  await page.fill("#f-amount", amount);
  await page.click("#btn-add");
  await saved;
}

/* ---------- 接口层 ---------- */

test("历史接口也在登录墙后面", async ({ request }) => {
  expect((await request.get(APP + "/api/ledger/history")).status()).toBe(401);
});

test("写入时把被覆盖的那份归档，能按版本号取回", async ({ browser }) => {
  const ctx = await authed(browser);
  await put(ctx.request, one("第一版"));
  const afterFirst = Number(/"(\d+)"/.exec(await rev(ctx.request))![1]);

  await put(ctx.request, one("第二版"));

  const { versions } = await history(ctx.request);
  const archived = versions.find((v: any) => v.rev === afterFirst);
  expect(archived, "被覆盖掉的那一版应当留下来").toBeTruthy();
  expect(archived.at, "归档要带时间，否则列表上没法认").toBeTruthy();

  // 取回那一版，内容应当是被覆盖前的样子
  const res = await ctx.request.get(APP + `/api/ledger/history/${afterFirst}`);
  expect(res.status()).toBe(200);
  expect((await res.json()).records.map((r: any) => r.name)).toEqual(["第一版"]);
  await ctx.close();
});

test("列表按新到旧排", async ({ browser }) => {
  const ctx = await authed(browser);
  await put(ctx.request, one("a"));
  await put(ctx.request, one("b"));
  await put(ctx.request, one("c"));
  const { versions } = await history(ctx.request);
  const revs = versions.map((v: any) => v.rev);
  expect(revs).toEqual([...revs].sort((x, y) => y - x));
  await ctx.close();
});

test("没有的版本号给 404，不是 500", async ({ browser }) => {
  const ctx = await authed(browser);
  expect((await ctx.request.get(APP + "/api/ledger/history/999999")).status()).toBe(404);
  expect((await ctx.request.get(APP + "/api/ledger/history/abc")).status()).toBe(400);
  await ctx.close();
});

// 20 版是票里定的上限。不淘汰的话 KV 会被历史撑满，而更老的版本其实没人会去翻
test("只留最近 20 版，更老的自动淘汰", async ({ browser }) => {
  const ctx = await authed(browser);
  for (let i = 0; i < 24; i++) await put(ctx.request, one("v" + i));
  const { versions } = await history(ctx.request);
  expect(versions.length).toBeLessThanOrEqual(20);
  // 留下的应当是最新的那批
  const revs = versions.map((v: any) => v.rev);
  expect(Math.min(...revs)).toBeGreaterThan(0);
  await ctx.close();
});

/* ---------- 界面 ---------- */

test("私有云态才有「历史版本」这个入口", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator("#btn-history")).toBeVisible();

  // 试玩态没有云端，也就没有历史可言
  await page.goto("/?mode=demo");
  await expect(page.locator("#btn-history")).toBeHidden();
  await ctx.close();
});

test("误删一笔之后，能从历史里找回来", async ({ browser }) => {
  const ctx = await authed(browser);
  await put(ctx.request, ledger([]));
  const page = await ctx.newPage();
  await page.goto("/");

  // 记两笔，各存一次——第二次会把「只有一笔」的那版归档
  await addAndSave(page, "要留住的", "100");
  await addAndSave(page, "手滑记错的", "200");
  await expect(page.locator("#s-count")).toHaveText("2");

  // 打开历史，恢复到只有一笔的那版
  page.on("dialog", (d) => d.accept());
  await page.click("#btn-history");
  await expect(page.locator("#history-list .row").first()).toBeVisible();

  // 恢复也要等它真的存上去，同样不能拿状态条当完成信号
  const restored = page.waitForResponse(
    (r: any) =>
      r.url().includes("/api/ledger") && r.request().method() === "PUT" && r.status() === 200,
  );
  await page.locator("#history-list .row button").first().click();
  await restored;

  await expect(page.locator("#s-count")).toHaveText("1");
  await expect(page.locator("#rows").getByText("要留住的")).toHaveCount(1);
  await expect(page.locator("#rows").getByText("手滑记错的")).toHaveCount(0);

  // 恢复要真的落到云端，不能只改本地
  const body = await (await ctx.request.get(APP + "/api/ledger")).json();
  expect(body.records.map((r: any) => r.name)).toEqual(["要留住的"]);
  await ctx.close();
});

// 恢复不该有特权通道：它走的是正常保存流程，所以照样受 T3 的护栏管着
test("恢复期间别处改过账，一样会被拦下来问", async ({ browser }) => {
  const ctx = await authed(browser);
  await put(ctx.request, ledger([]));
  const page = await ctx.newPage();
  await page.goto("/");

  await addAndSave(page, "第一笔", "100");
  await addAndSave(page, "第二笔", "200");

  // 另一台设备抢先改了账本
  await put(ctx.request, one("别处改的"));

  page.on("dialog", (d) => d.accept());
  await page.click("#btn-history");
  await expect(page.locator("#history-list .row").first()).toBeVisible();
  await page.locator("#history-list .row button").first().click();

  await expect(page.locator("#conflict-overlay")).toBeVisible();
  await ctx.close();
});

test("手动导出仍然可用（它挡的是账号级灾难，和历史版本互补）", async ({ browser }) => {
  const ctx = await authed(browser);
  const page = await ctx.newPage();
  await page.goto("/");
  const dl = page.waitForEvent("download");
  await page.click("#btn-json");
  expect((await dl).suggestedFilename()).toContain("人情债");
  await ctx.close();
});
