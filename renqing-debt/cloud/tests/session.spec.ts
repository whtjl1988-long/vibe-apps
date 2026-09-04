import { test, expect, type APIResponse } from "@playwright/test";
import { createHmac } from "node:crypto";

// 与 wrangler.test.toml 一致
const USER = "test-user";
const PASS = "测试:密码-123";
const SECRET = "test-session-secret-do-not-use";
const COOKIE = "__Host-session";
const DAY = 24 * 3600;

// 没配 SESSION_SECRET 的那一份，见 playwright.config.ts
const NO_SESSION = "http://127.0.0.1:8788";

const basic = () => "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");

/**
 * 模拟「浏览器在打开一个页面」。
 *
 * 会话票只在导航请求上发（子资源不必各发一次），而 Worker 认导航靠的是
 * Sec-Fetch-Dest——真实浏览器导航一定带它，Playwright 的 request 不带。
 * 不显式加上的话，这里测的就不是「浏览器登录后拿到票」那件事。
 */
const nav = () => ({ Authorization: basic(), "Sec-Fetch-Dest": "document" });
const now = () => Math.floor(Date.now() / 1000);

/**
 * 测试这边**独立**实现一遍签名，不从 Worker import。
 * 关键是下面那条「格式对账」的**肯定**用例：只有当测试签出来的票 Worker 也认，
 * 才说明两份实现真的一致。光有否定用例（都断言 401）证明不了任何事——
 * Worker 换成 SHA-512、改字段名或换分隔符，否定用例照样全绿。
 */
function mint(payload: object, secret = SECRET): string {
  return mintRaw(JSON.stringify(payload), secret);
}

/** 手写 JSON 的版本：用来构造 JSON.stringify 造不出的东西，比如 1e400 */
function mintRaw(json: string, secret = SECRET): string {
  const body = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function setCookies(res: APIResponse): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
}

const sessionCookies = (res: APIResponse) => setCookies(res).filter((c) => c.startsWith(`${COOKIE}=`));

async function login(request: any): Promise<string> {
  const res = await request.get("/", { headers: nav() });
  expect(res.status()).toBe(200);
  const raw = sessionCookies(res)[0];
  expect(raw, "Basic 登录成功后应当种下会话 cookie").toBeTruthy();
  return raw.split(";")[0].split("=").slice(1).join("=");
}

/* ---------- 发票 ---------- */

test("Basic 登录成功后种下会话 cookie，属性齐全", async ({ request }) => {
  const res = await request.get("/", { headers: nav() });
  expect(res.status()).toBe(200);

  const raw = sessionCookies(res)[0];
  expect(raw).toBeTruthy();
  // 这些属性缺一个，cookie 就可能被 JS 读到、被跨站带走、或走明文
  expect(raw).toContain("HttpOnly");
  expect(raw).toContain("Secure");
  expect(raw).toContain("SameSite=Lax");
  expect(raw).toContain("Path=/");
  expect(raw).toMatch(/Max-Age=\d+/);
});

test("有效期至少 90 天", async ({ request }) => {
  const res = await request.get("/", { headers: nav() });
  const maxAge = Number(sessionCookies(res)[0].match(/Max-Age=(\d+)/)![1]);
  // 使用场景是一年几次的红白事，短有效期等于没做
  expect(maxAge).toBeGreaterThanOrEqual(90 * DAY);
});

test("子资源不重复发票", async ({ request }) => {
  const res = await request.get("/", {
    headers: { Authorization: basic(), "Sec-Fetch-Dest": "image" },
  });
  expect(res.status()).toBe(200);
  expect(sessionCookies(res)).toHaveLength(0);
});

/* ---------- 用票 ---------- */

test("拿到 cookie 后，不带 Basic 凭据也能进", async ({ request }) => {
  const value = await login(request);
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${value}` } });
  expect(res.status()).toBe(200);
});

test("格式对账：测试端独立签出的票，Worker 也认", async ({ request }) => {
  const valid = mint({ u: "me", exp: now() + 3600 });
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${valid}` } });
  // 这条是两份实现的唯一硬对照。Worker 改了签名算法、字段名或分隔符，它就红。
  expect(res.status(), "Worker 若改了 cookie 格式或签名算法，这条会红").toBe(200);
});

test("有效期还长的时候不续期", async ({ request }) => {
  const fresh = mint({ u: "me", exp: now() + 100 * DAY });
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${fresh}` } });
  expect(res.status()).toBe(200);
  expect(sessionCookies(res)).toHaveLength(0);
});

test("快到期时自动续一张，不用等被弹框", async ({ request }) => {
  const soon = mint({ u: "me", exp: now() + 10 * DAY });
  const res = await request.get("/", {
    headers: { Cookie: `${COOKIE}=${soon}`, "Sec-Fetch-Dest": "document" },
  });
  expect(res.status()).toBe(200);
  expect(sessionCookies(res), "剩不到 30 天就该续，否则 120 天是道硬悬崖").toHaveLength(1);
});

/* ---------- 伪造与过期 ---------- */

test("cookie 被篡改：干脆地 401，不是报错页，也不再弹原生框", async ({ request }) => {
  const value = await login(request);
  const [body, sig] = value.split(".");
  const tampered = `${body}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;

  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${tampered}` } });
  expect(res.status()).toBe(401);
  // 不带 WWW-Authenticate——那个头正是浏览器弹原生登录框的原因
  expect(res.headers()["www-authenticate"]).toBeUndefined();
});

test("payload 被改（想冒充别人）也过不去", async ({ request }) => {
  const value = await login(request);
  const sig = value.split(".")[1];
  const forged = Buffer.from(JSON.stringify({ u: "someone-else", exp: 9e9 }), "utf8").toString("base64url");
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${forged}.${sig}` } });
  expect(res.status()).toBe(401);
});

test("过期 cookie：干脆地 401；浏览器则被领去登录页", async ({ request }) => {
  const expired = mint({ u: "me", exp: now() - 60 });

  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${expired}` } });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toBeUndefined();

  // 同一张过期票，浏览器打开页面时该被领到登录页而不是看到 401
  const nav = await request.get("/", {
    headers: { Cookie: `${COOKIE}=${expired}`, "Sec-Fetch-Dest": "document" },
    maxRedirects: 0,
  });
  expect(nav.status()).toBe(302);
  expect(nav.headers()["location"]).toContain("/login");
});

// JSON.parse('{"exp":1e400}') 得到的是 Infinity，而 `Infinity <= now` 为 false——
// 少一个 Number.isFinite，这就是一张永不过期的票。构造它需要签名，属纵深防御。
test("exp 写成 1e400（Infinity）不能变成永不过期", async ({ request }) => {
  const forever = mintRaw(`{"u":"me","exp":1e400}`);
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${forever}` } });
  expect(res.status()).toBe(401);
});

test("换了签名密钥，旧 cookie 立刻失效（这就是密钥轮换）", async ({ request }) => {
  const otherKey = mint({ u: "me", exp: now() + 3600 }, "some-other-secret");
  const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${otherKey}` } });
  expect(res.status()).toBe(401);
});

test("垃圾 cookie 不会把 Worker 打崩", async ({ request }) => {
  for (const junk of ["", "no-dot", "a.b.c.d", "....", "%%%.%%%", "a.".repeat(500)]) {
    const res = await request.get("/", { headers: { Cookie: `${COOKIE}=${junk}` } });
    expect(res.status(), `cookie=${junk.slice(0, 20)} 不该 5xx`).toBe(401);
  }
});

/* ---------- 退出 ---------- */

test("退出登录：清票，且返回 200 而不是 401", async ({ request }) => {
  const value = await login(request);
  const out = await request.get("/logout", { headers: { Cookie: `${COOKIE}=${value}` } });

  // 200 而非 401：401 会召唤浏览器的登录弹框，而浏览器多半还缓存着 Basic 凭据，
  // 会静默重发、立刻又换到一张新票——退出等于没退。
  expect(out.status()).toBe(200);
  expect(out.headers()["www-authenticate"]).toBeUndefined();
  expect(sessionCookies(out)[0]).toMatch(/Max-Age=0/);
});

// 表征测试：如实记下当前的限制，而不是假装它不存在。
// 签名 cookie 是无状态的，服务端没有「已注销」名单——退出只让这台设备丢票，
// 抄走过 cookie 原文的人重放它仍然管用。真要踢所有设备下线，只有换 SESSION_SECRET。
// 将来若实现了服务端注销，这条会红，那时更新它。
test("已知限制：logout 之后重放旧 cookie 仍然有效", async ({ request }) => {
  const value = await login(request);
  await request.get("/logout", { headers: { Cookie: `${COOKIE}=${value}` } });

  const replay = await request.get("/", { headers: { Cookie: `${COOKIE}=${value}` } });
  expect(replay.status(), "无状态签名 cookie 的固有限制，靠换 SESSION_SECRET 兜底").toBe(200);
});

/* ---------- 忘配密钥 ---------- */

// 忘了配 SESSION_SECRET 是很可能发生的事。那种情况下应当退回 #33 的行为：
// 仍然要 Basic Auth，只是不种 cookie——绝不能因为少配一个密钥就谁都能进。
test("没配签名密钥时：不种 cookie，但门照样关着", async ({ request }) => {
  const anon = await request.get(NO_SESSION + "/");
  expect(anon.status()).toBe(401);

  const authed = await request.get(NO_SESSION + "/", { headers: nav() });
  expect(authed.status()).toBe(200);
  expect(sessionCookies(authed)).toHaveLength(0);
});

/* ---------- 真实浏览器 ---------- */

// 上面全是手写 Cookie 头，证明不了浏览器**愿意存**这张票。
// `__Host-` 前缀要求 Secure，本地又跑在 http 上——这条走真实浏览器，
// 顺带验的正是本票的目的：第二次打开时不再需要密码。
test("真实浏览器：登录一次之后，新开的上下文不用再输密码", async ({ browser }) => {
  const first = await browser.newContext({ extraHTTPHeaders: { Authorization: basic() } });
  const p1 = await first.newPage();
  await p1.goto("/");
  const state = await first.storageState();
  await first.close();

  const stored = state.cookies.find((c) => c.name === COOKIE);
  expect(stored, "浏览器应当接受 __Host- 前缀的会话 cookie").toBeTruthy();

  // 第二个上下文只带 cookie，不带任何凭据
  const second = await browser.newContext({ storageState: state });
  const p2 = await second.newPage();
  const res = await p2.goto("/");
  expect(res?.status()).toBe(200);
  await expect(p2.getByRole("heading", { name: "登录墙已经立起来了" })).toBeVisible();
  await second.close();
});

// 告别页是可选的：部署者在 public/ 放一张 logged-out.html 就用它，
// 没放就回退纯文本。这里跑的实例没有那张页面，正好钉住回退这一半。
test("没有自备告别页时，/logout 干净地回退纯文本", async ({ request }) => {
  const res = await request.get("/logout");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/plain");
  expect(await res.text()).toContain("已退出登录");
  // 不管走哪条路，票都得收走
  expect(setCookies(res)[0]).toMatch(/Max-Age=0/);
});
