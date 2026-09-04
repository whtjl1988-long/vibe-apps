import { test, expect, type Browser } from "@playwright/test";

const USER = "test-user";
const PASS = "测试:密码-123";
const APP = "http://127.0.0.1:8789";
const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");

/* ---------- 弹框不能再出现 ---------- */

// 浏览器弹那个原生登录框，是因为 401 带了 WWW-Authenticate。
// 去掉它，浏览器才不弹，我们才能把人领到自己的登录页。
test("401 不再带 WWW-Authenticate（弹框的来源）", async ({ browser }) => {
  // 必须用干净上下文：request fixture 跨用例共享 cookie，
  // 前面登录成功的那条会把票留下，这里就不是「未登录」了
  const ctx = await browser.newContext();
  const res = await ctx.request.get(APP + "/api/ledger");
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toBeUndefined();
  await ctx.close();
});

test("未登录访问页面：跳登录页，并记住原来要去哪", async ({ request }) => {
  const res = await request.get(APP + "/renqing/", {
    headers: { "Sec-Fetch-Dest": "document" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  const loc = res.headers()["location"];
  expect(loc).toContain("/login");
  expect(decodeURIComponent(loc)).toContain("next=/renqing/");
});

// 接口和脚本不该被重定向到一张 HTML 页面上——它们要的是状态码
test("非导航请求仍是干脆的 401，不重定向", async ({ browser }) => {
  const ctx = await browser.newContext();
  const res = await ctx.request.get(APP + "/api/ledger", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  await ctx.close();
});

// 上一条用的是不带 Sec-Fetch-Dest 的请求，而那种本来就被当作非导航——
// 所以它证明不了「接口有豁免」。这一条**装成浏览器导航**去打接口：
// 只有 API 豁免真的存在，它才会是 401 而不是 302。
// （变异测试发现的：把 isApi 改成恒 false，上一条照样全绿。）
test("接口即使带着导航头，也只给状态码不给登录页", async ({ browser }) => {
  const ctx = await browser.newContext();
  const res = await ctx.request.get(APP + "/api/ledger", {
    headers: { "Sec-Fetch-Dest": "document" },
    maxRedirects: 0,
  });
  expect(res.status(), "接口不该被 302 到一张 HTML 上").toBe(401);
  await ctx.close();
});

/* ---------- 登录 ---------- */

test("密码对：发会话票并送回原处", async ({ request }) => {
  const res = await request.post(APP + "/login", {
    form: { user: USER, password: PASS, next: "/renqing/" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  expect(res.headers()["location"]).toBe("/renqing/");
  const cookie = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value)
    .find((c) => c.startsWith("__Host-session="));
  expect(cookie, "登录成功要发会话票").toBeTruthy();
  expect(cookie).toContain("HttpOnly");
});

test("密码错：回登录页，不发票，也不说是哪里错了", async ({ request }) => {
  const res = await request.post(APP + "/login", {
    form: { user: USER, password: "wrong", next: "/" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  expect(res.headers()["location"]).toContain("failed=1");
  const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
  expect(cookies.filter((c) => c.value.startsWith("__Host-session=")), "密码错不该发票").toHaveLength(0);
});

// ?next=//evil.com 这类值不能被拿去做跳板
test("next 只认站内路径，挡住开放重定向", async ({ request }) => {
  for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)"]) {
    const res = await request.post(APP + "/login", {
      form: { user: USER, password: PASS, next: bad },
      maxRedirects: 0,
    });
    expect(res.headers()["location"], `next=${bad} 不该被采信`).toBe("/");
  }
});

test("已经有票的人访问 /login，直接放行不用再登", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: APP });
  const page = await ctx.newPage();
  // 走真实登录拿票（而不是 Basic）——这条用例问的就是「已经登过的人」
  await page.goto("/login");
  await page.fill("#user", USER);
  await page.fill("#password", PASS);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  await page.goto("/login");
  expect(new URL(page.url()).pathname, "有票的人不该再看到登录页").toBe("/");
  await ctx.close();
});

/* ---------- 命令行那条路要留着 ---------- */

// smoke.sh 和一切脚本化访问都靠它；浏览器不再弹框不等于要把这条路砍掉
test("curl -u 那条路仍然走得通", async ({ request }) => {
  const res = await request.get(APP + "/", { headers: { Authorization: basic() } });
  expect(res.status()).toBe(200);
});

/* ---------- 真实浏览器 ---------- */

// 本票的全部意义：进门不再是浏览器的原生弹框，而是我们自己的页面
test("真实浏览器：不弹框、登录后回到原处、再开一页免登录", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: APP }); // 故意不给凭据
  const page = await ctx.newPage();
  let popped = false;
  page.on("dialog", () => {
    popped = true;
  });

  await page.goto("/renqing/");
  expect(popped, "不该再弹浏览器原生登录框").toBe(false);
  expect(new URL(page.url()).pathname).toBe("/login");

  await page.fill("#user", USER);
  await page.fill("#password", PASS);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");
  expect(new URL(page.url()).pathname, "登录后该回到原来要去的地方").toBe("/renqing/");

  const p2 = await ctx.newPage();
  await p2.goto("/");
  expect(new URL(p2.url()).pathname, "会话票该让第二个页面免登录").toBe("/");
  await ctx.close();
});
