import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789";

const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");
const authed = (browser: Browser) =>
  browser.newContext({ httpCredentials: { username: USER, password: PASS }, baseURL: APP });
const ledger = (records: unknown[]) => ({ version: 2, events: [], records, tags: {}, settings: {} });

async function rev(request: any): Promise<string> {
  const res = await request.get(APP + "/api/ledger");
  return res.headers()["etag"] || '"0"';
}
const put = async (request: any, data: unknown, r?: string) =>
  request.put(APP + "/api/ledger", {
    headers: { "Content-Type": "application/json", "If-Match": r ?? (await rev(request)) },
    data,
  });

/* ---------- 接口层 ---------- */

test("GET 带回版本号", async ({ request }) => {
  const res = await request.get(APP + "/api/ledger", { headers: { Authorization: basic() } });
  expect(res.headers()["etag"]).toMatch(/^"\d+"$/);
});

// 不带 If-Match 等于说「我不管现在是第几版，覆盖就是了」——那正是这道护栏要挡的
test("裸 PUT 被拒：必须说明基于第几版", async ({ request }) => {
  const res = await request.fetch(APP + "/api/ledger", {
    method: "PUT",
    headers: { Authorization: basic(), "Content-Type": "application/json" },
    data: ledger([]),
  });
  expect(res.status()).toBe(428);
});

test("版本对不上：409，并把云端那份带回来", async ({ browser }) => {
  const ctx = await authed(browser);
  await put(ctx.request, ledger([{ id: "x", name: "云端的", amount: 1, dir: "in" }]));

  const stale = await ctx.request.fetch(APP + "/api/ledger", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": '"0"' }, // 明显过期的版本
    data: ledger([{ id: "y", name: "过期的", amount: 2, dir: "in" }]),
  });
  expect(stale.status()).toBe(409);
  // 冲突响应里要带着云端那份，前端才有东西可以摆给人看
  expect((await stale.json()).records.map((r: any) => r.name)).toContain("云端的");
  expect(stale.headers()["etag"]).toMatch(/^"\d+"$/);
  await ctx.close();
});

test("版本对得上：接受，并且版本号往前走一格", async ({ browser }) => {
  const ctx = await authed(browser);
  const before = Number(/"(\d+)"/.exec(await rev(ctx.request))![1]);
  const res = await put(ctx.request, ledger([]));
  expect(res.status()).toBe(200);
  expect(Number(/"(\d+)"/.exec(res.headers()["etag"])![1])).toBe(before + 1);
  await ctx.close();
});

/* ---------- 本票的核心：两台设备 ---------- */

// 这就是 grill 了三轮的那个场景，而且**不需要离线**：
// 电脑上开着页面（手里是旧的那份），手机记了一笔，电脑那边再一存——
// 没有护栏的话，手机那笔会被整份覆盖掉，没有任何提示。
test("两台设备：后存的不会静默吃掉先存的", async ({ browser }) => {
  const ctxA = await authed(browser);
  await put(ctxA.request, ledger([])); // 干净起点
  const A = await ctxA.newPage();
  await A.goto("/"); // A 加载了这一版

  const ctxB = await authed(browser);
  const B = await ctxB.newPage();
  await B.goto("/"); // B 加载的是同一版

  // B 先记先存
  await B.fill("#f-name", "B记的");
  await B.fill("#f-amount", "111");
  await B.click("#btn-add");
  await expect(B.locator("#cloud-status")).toContainText("已存到云端");

  // A 基于旧版本再存
  await A.fill("#f-name", "A记的");
  await A.fill("#f-amount", "222");
  await A.click("#btn-add");

  // A 被拦下，而且说人话
  await expect(A.locator("#conflict-overlay")).toBeVisible();
  await expect(A.locator("#conflict-overlay")).toContainText("在别处改过");
  await expect(A.locator("#conflict-overlay")).toContainText("不会自动合并");

  // 最要紧的一条：B 那笔还活着，没被 A 覆盖
  const body = await (await ctxB.request.get(APP + "/api/ledger")).json();
  const names = body.records.map((r: any) => r.name);
  expect(names).toContain("B记的");
  expect(names).not.toContain("A记的");

  await ctxA.close();
  await ctxB.close();
});

/* ---------- 三选一 ---------- */

async function makeConflict(browser: Browser) {
  const ctxA = await authed(browser);
  await put(ctxA.request, ledger([]));
  const A = await ctxA.newPage();
  await A.goto("/");

  const ctxB = await authed(browser);
  const B = await ctxB.newPage();
  await B.goto("/");
  await B.fill("#f-name", "B记的");
  await B.fill("#f-amount", "111");
  await B.click("#btn-add");
  await expect(B.locator("#cloud-status")).toContainText("已存到云端");
  await ctxB.close();

  await A.fill("#f-name", "A记的");
  await A.fill("#f-amount", "222");
  await A.click("#btn-add");
  await expect(A.locator("#conflict-overlay")).toBeVisible();
  return { ctxA, A };
}

test("面板把两边的笔数都摆出来，让人自己定", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);
  await expect(A.locator("#conflict-remote")).toHaveText("1 笔");
  await expect(A.locator("#conflict-local")).toHaveText("1 笔");
  await ctxA.close();
});

test("选「用云端那份」：本地换成云端的，自己那笔作废", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);
  await A.click("#conflict-theirs");

  await expect(A.locator("#conflict-overlay")).toBeHidden();
  await expect(A.locator("#rows").getByText("B记的")).toHaveCount(1);
  await expect(A.locator("#rows").getByText("A记的")).toHaveCount(0);

  // 云端也仍然是 B 那份——接受云端不该反过来又推一次
  const body = await (await ctxA.request.get(APP + "/api/ledger")).json();
  expect(body.records.map((r: any) => r.name)).toEqual(["B记的"]);
  await ctxA.close();
});

test("选「用我这边」：明确覆盖，云端变成我的", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);
  await A.click("#conflict-mine");

  await expect(A.locator("#conflict-overlay")).toBeHidden();
  await expect(A.locator("#cloud-status")).toContainText("已存到云端");

  const body = await (await ctxA.request.get(APP + "/api/ledger")).json();
  const names = body.records.map((r: any) => r.name);
  expect(names).toContain("A记的");
  expect(names).not.toContain("B记的"); // 覆盖就是覆盖，面板上写明了
  await ctxA.close();
});

// 合并听起来最好，实则最危险：合错了比丢了还难查，而且没人会去核对。
test("绝不自动合并：两边的记录不会被拼在一起", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);
  const body = await (await ctxA.request.get(APP + "/api/ledger")).json();
  expect(body.records.length).toBe(1); // 不是 2
  await ctxA.close();
});

// 冲突没决之前还一直重推的话，会反复撞同一堵墙、把状态条刷成一片红
test("冲突未决时不自动重试推送", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);
  let puts = 0;
  A.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/api/ledger")) puts++;
  });
  await A.waitForTimeout(1500);
  expect(puts, "冲突面板开着的时候不该自己再发 PUT").toBe(0);
  await ctxA.close();
});

// 面板是全屏 overlay，它把底下的表单挡住了——这不是副作用，是想要的：
// 还没决定用哪边之前继续改，只会让局面更乱。
test("面板挡住继续记账", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);
  // trial 只检查「这个元素现在能不能被点」，不会真的点下去
  await expect(A.locator("#btn-add").click({ trial: true, timeout: 1500 })).rejects.toThrow();
  await ctxA.close();
});
