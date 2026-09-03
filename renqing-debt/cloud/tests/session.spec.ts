import { test, expect, type APIResponse } from "@playwright/test";
import { createHmac } from "node:crypto";

// 与 wrangler.test.toml 一致
const USER = "test-user";
const PASS = "测试:密码-123";
const SECRET = "test-session-secret-do-not-use";
const COOKIE = "__Host-session";

// 没配 SESSION_SECRET 的那一份，见 playwright.config.ts
const NO_SESSION = "http://127.0.0.1:8788";

/**
 * 测试这边**独立**实现一遍签名，不从 Worker 里 import。
 * 两份实现互为对照：Worker 悄悄改了 cookie 格式或签名算法，这里就会红。
 */
function mint(payload: object, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function setCookies(res: APIResponse): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
}

/** 从一次 Basic 登录里取回真实的会话 cookie 值 */
async function login(request: any): Promise<string> {
  const res = await request.get("/", {
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64") },
  });
  expect(res.status()).toBe(200);
  const raw = setCookies(res).find((c) => c.startsWith(`${COOKIE}=`));
  expect(raw, "Basic 登录成功后应当种下会话 cookie").toBeTruthy();
  return raw!.split(";")[0].split("=").slice(1).join("=");
}

test("Basic 登录成功后种下会话 cookie，属性齐全", async ({ request }) => {
  const res = await request.get("/", {
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64") },
  });
  expect(res.status()).toBe(200);

  const raw = setCookies(res).find((c) => c.startsWith(`${COOKIE}=`));
  expect(raw).toBeTruthy();
  // 这些属性缺一个，cookie 就可能被 JS 读到、被跨站带走、或走明文
  expect(raw).toContain("HttpOnly");
  expect(raw).toContain("Secure");
  expect(raw).toContain("SameSite=Lax");
  expect(raw).toContain("Path=/");
  expect(raw).toMatch(/Max-Age=\d+/);
});

test("有效期至少 90 天", async ({ request }) => {
  const res = await request.get("/", {
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64") },
  });
  const raw = setCookies(res).find((c) => c.startsWith(`${COOKIE}=`))!;
  const maxAge = Number(raw.match(/Max-Age=(\d+)/)![1]);
  // 使用场景是一年几次的红白事，短有效期等于没做
  expect(maxAge).toBeGreaterThanOrEqual(90 * 24 * 3600);
});

test("拿到 cookie 后，不带 Basic 凭据也能进", async ({ request }) => {
  const value = await login(request);
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${value}` } });
  expect(res.status()).toBe(200);
  // 这次不该再种一遍——已经有有效会话了
  expect(setCookies(res).filter((c) => c.startsWith(`${COOKIE}=`))).toHaveLength(0);
});

test("cookie 被篡改：回落到 401 弹框，不是报错页", async ({ request }) => {
  const value = await login(request);
  const [body, sig] = value.split(".");
  // 改签名的最后一个字符
  const tampered = `${body}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;

  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${tampered}` } });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toContain("Basic");
});

test("payload 被改（想冒充别人）也过不去", async ({ request }) => {
  const value = await login(request);
  const sig = value.split(".")[1];
  const forged = Buffer.from(JSON.stringify({ u: "someone-else", exp: 9e9 }), "utf8").toString("base64url");
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${forged}.${sig}` } });
  expect(res.status()).toBe(401);
});

test("过期 cookie：回落到 401 弹框", async ({ request }) => {
  const expired = mint({ u: "me", exp: Math.floor(Date.now() / 1000) - 60 });
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${expired}` } });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toContain("Basic");
});

test("换了签名密钥，旧 cookie 立刻失效（这就是密钥轮换）", async ({ request }) => {
  const otherKey = mint({ u: "me", exp: Math.floor(Date.now() / 1000) + 3600 }, "some-other-secret");
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${otherKey}` } });
  expect(res.status()).toBe(401);
});

test("退出登录：清掉 cookie，并且真的进不去了", async ({ request }) => {
  const value = await login(request);

  const out = await request.get("/logout", { headers: { Cookie: `${COOKIE}=${value}` } });
  const cleared = setCookies(out).find((c) => c.startsWith(`${COOKIE}=`));
  expect(cleared, "/logout 应当下发一个清空的 cookie").toBeTruthy();
  expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

  // 退出后旧 cookie 不该还能用
  const after = await request.get("/", { headers: { Cookie: `${COOKIE}=` } });
  expect(after.status()).toBe(401);
});

test("垃圾 cookie 不会把 Worker 打崩", async ({ request }) => {
  for (const junk of ["", "no-dot", "a.b.c.d", "....", "%%%.%%%", "a.".repeat(500)]) {
    const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${junk}` } });
    expect([401, 200], `cookie=${junk.slice(0, 20)} 不该 5xx`).toContain(res.status());
    expect(res.status()).toBe(401);
  }
});

// 忘了配 SESSION_SECRET 是很可能发生的事。那种情况下应当退回 #33 的行为：
// 仍然要 Basic Auth，只是不种 cookie——绝不能因为少配一个密钥就谁都能进。
test("没配签名密钥时：不种 cookie，但门照样关着", async ({ request }) => {
  const anon = await request.get(NO_SESSION + "/");
  expect(anon.status()).toBe(401);

  const authed = await request.get(NO_SESSION + "/", {
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64") },
  });
  expect(authed.status()).toBe(200);
  expect(setCookies(authed).filter((c) => c.startsWith(`${COOKIE}=`))).toHaveLength(0);
});
