import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// wrangler.test.toml 里的假凭据。密码故意带中文和冒号——
// 这两样都曾经是真 bug 的藏身处，见下面对应的测试。
const USER = "test-user";
const PASS = "测试:密码-123";

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

// 这条是本文件里最贵的一条。原先的实现把 atob() 的 binary string 直接
// 当文本用，非 ASCII 会被二次 UTF-8 编码——中文密码永远对不上，而且
// 表现为「密码明明是对的，就是进不去」，没有任何报错。
// 密码里那个冒号顺带钉住「按第一个冒号切」而不是按最后一个或 split(":")。
test("中文密码 + 密码里带冒号，都能正确进门", async ({ browser }) => {
  const ctx = await browser.newContext({
    httpCredentials: { username: USER, password: PASS },
  });
  const res = await ctx.request.get("/");
  expect(res.status()).toBe(200);
  await ctx.close();
});

test("凭据对了进得去，页面看得见", async ({ browser }) => {
  const ctx = await browser.newContext({ httpCredentials: { username: USER, password: PASS } });
  const page = await ctx.newPage();
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "登录墙已经立起来了" })).toBeVisible();
  await ctx.close();
});

test("门后的内容标为 private，不让中间层缓存", async ({ browser }) => {
  const ctx = await browser.newContext({ httpCredentials: { username: USER, password: PASS } });
  const res = await ctx.request.get("/");
  expect(res.headers()["cache-control"]).toContain("private");
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

// 上一条只能证明「测试用的那份配置」是对的。真部署用的是别的 toml，
// 谁把那一行删了，上面的测试照样全绿。所以这里直接读配置文件断言。
test("每一份 wrangler 配置都开着 run_worker_first", () => {
  for (const file of ["wrangler.test.toml", "wrangler.example.toml"]) {
    const text = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    expect(text, `${file} 缺 run_worker_first，登录墙会被静态资源绕过`)
      .toMatch(/^\s*run_worker_first\s*=\s*true\s*$/m);
  }
});
