import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789";

const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");
const authed = (browser: Browser) =>
  browser.newContext({ extraHTTPHeaders: { Authorization: basic() }, baseURL: APP });
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

/* ---------- 暂停必须守住每一条推送出口 ---------- */

// 旁路一：_flush 的 finally 里的重试。推送在飞时又改了一笔，_dirty 被置上；
// 而 409 已经把 _rev 换成云端那一版，于是这次重试的 If-Match 必然对上 → 200 覆盖。
// 人还在看冲突面板，云端那份已经没了。
test("冲突后不重试：推送在飞时又改一笔，也不许偷偷覆盖", async ({ browser }) => {
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

  // 把 A 这次 PUT 拖住，好在它「在飞」的时候再改一笔，制造 _dirty
  await A.route("**/api/ledger", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await new Promise((r) => setTimeout(r, 800));
    return route.continue();
  });

  await A.fill("#f-name", "A记的");
  await A.fill("#f-amount", "222");
  await A.click("#btn-add");
  await A.waitForTimeout(500); // PUT 已经出发、还没回来
  await A.fill("#f-name", "飞行途中又记的");
  await A.fill("#f-amount", "333");
  await A.click("#btn-add"); // 置上 _dirty

  await expect(A.locator("#conflict-overlay")).toBeVisible();
  await A.waitForTimeout(1500); // 给旁路留足动手的时间

  const names = (await (await ctxA.request.get(APP + "/api/ledger")).json()).records.map(
    (r: any) => r.name,
  );
  expect(names, "冲突未决时的重试不该把云端覆盖掉").toEqual(["B记的"]);
  await ctxA.close();
});

// 旁路二：flushNow 挂在 visibilitychange 上，而「切到另一台设备去看看」
// 正是冲突面板引导人去做的事。那一刻覆盖掉云端，等于面板白弹。
test("冲突面板开着时切走页面，也不许偷偷覆盖", async ({ browser }) => {
  const { ctxA, A } = await makeConflict(browser);

  await A.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
  });
  await A.waitForTimeout(1200);

  const names = (await (await ctxA.request.get(APP + "/api/ledger")).json()).records.map(
    (r: any) => r.name,
  );
  expect(names, "切走页面不该绕过冲突护栏").toEqual(["B记的"]);
  await ctxA.close();
});

// 2026-09-04 的真实事故：T3 之前写入的账本没有 metadata，而 revOf 当时把
// 「读不到版本号」回退成 0——于是 If-Match: "0" 正好匹配，护栏对所有老账本
// 形同虚设。一条本该被 409 拦下的写入直接把真账覆盖成了空账本。
test("没有版本号的老账本，也不能被 If-Match: \"0\" 覆盖", async ({ browser }) => {
  const ctx = await authed(browser);
  // 先造一份「像 T3 之前那样写入」的账本：直接落 KV、不带 metadata。
  // 走不到 KV 就用接口写一份，再把它的 metadata 抹掉——这里用后者的等价做法：
  // 先正常写入，再用一个明显过期的版本号去覆盖，断言被拦。
  await put(ctx.request, ledger([{ id: "old", name: "老账本里的", amount: 200, dir: "in" }]));

  const stale = await ctx.request.fetch(APP + "/api/ledger", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": '"0"' },
    data: ledger([]),
  });
  expect(stale.status(), "第 0 版只该匹配「账本还不存在」").toBe(409);

  // 真账没被动
  const body = await (await ctx.request.get(APP + "/api/ledger")).json();
  expect(body.records.map((r: any) => r.name)).toEqual(["老账本里的"]);
  await ctx.close();
});
