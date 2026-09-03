import { test, expect } from "@playwright/test";

// wrangler.test.toml 里的假凭据
const USER = "test-user";
const PASS = "test-password";

test("没凭据进不来：401，且页面内容不可见", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(401);
  // 401 的响应体不该泄露里面有什么
  expect(await res.text()).not.toContain("登录墙已经立起来了");
});

test("401 带 WWW-Authenticate，浏览器才会弹登录框", async ({ request }) => {
  const res = await request.get("/");
  expect(res.headers()["www-authenticate"]).toContain("Basic");
});

test("凭据错了也进不来", async ({ browser }) => {
  const ctx = await browser.newContext({
    httpCredentials: { username: USER, password: "wrong-password" },
  });
  const res = await ctx.request.get("/");
  expect(res.status()).toBe(401);
  await ctx.close();
});

test("凭据对了进得去，页面看得见", async ({ browser }) => {
  const ctx = await browser.newContext({
    httpCredentials: { username: USER, password: PASS },
  });
  const page = await ctx.newPage();
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "登录墙已经立起来了" })).toBeVisible();
  await ctx.close();
});

// 这条钉住 wrangler 配置里的 run_worker_first：
// 不开它，静态资源会先于 Worker 命中，整道登录墙形同虚设——
// 而且首页看起来还是「正常」的，不测就发现不了。
test("静态资源不绕过登录墙", async ({ request }) => {
  for (const path of ["/index.html", "/"]) {
    const res = await request.get(path);
    expect(res.status(), `${path} 应被登录墙拦住`).toBe(401);
  }
});
