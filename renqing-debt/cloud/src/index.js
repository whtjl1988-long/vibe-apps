/**
 * 云端版的 Worker：一道登录墙 + 静态资源投递。
 *
 * 「云端版」是**自托管态**的一种——你自己部署、自己拿钥匙（见 CONTEXT.md）。
 * 培然同学自己那一份实例才叫**私有云态**。
 *
 * 进门有两条路：
 *   1. 会话 cookie —— 免输密码，日常走这条
 *   2. Basic Auth  —— 第一次、或会话过期时走这条，成功后换一张会话 cookie
 *
 * 为什么非要有第一条：iOS Safari 的 Basic Auth 弹框是**原生对话框**，
 * 密码 App 的自动填充在它上面不生效。只有 Basic 的话，强密码等于每次
 * 都要在手机上手输一遍——而这东西的使用场景是「在婚礼现场掏出手机记一笔」。
 *
 * 账本读写（KV）不在这一层，见 T2。
 */

// realm 只用 ASCII——它会进 HTTP 头，中文在部分客户端上会乱码
const REALM = "Private";

// 认证通过后的用户标识。今天只有一个人，所以是定值；
// T2 会拿它当账本 KV key 的前缀（`u/<标识>/...`），多用户时这里才会变。
const USER_ID = "me";

// `__Host-` 前缀是浏览器强制的最严档：必须 Secure、必须 Path=/、不许带 Domain，
// 且不能被同站的其他子域覆写。
const COOKIE = "__Host-session";

// 120 天。使用场景是一年几次的红白事，有效期短了等于没做这一层。
const SESSION_MAX_AGE = 120 * 24 * 3600;

// 剩余不足 30 天就顺手续一张。没有续期的话 120 天是一道硬悬崖——
// 天天在用的人也可能正好在婚礼现场撞上到期。
const SESSION_RENEW_WITHIN = 30 * 24 * 3600;

export default {
  async fetch(request, env) {
    // 退出登录不需要先登录：它只做「清掉凭证」这一件事
    if (new URL(request.url).pathname === "/logout") return logout();

    const session = await authenticate(request, env);
    if (!session) return unauthorized();

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    // 门后的东西是私人的：别让任何中间层替我缓存
    out.headers.set("Cache-Control", "private, no-cache");

    // 有票要发就挂上。这里不问「你是怎么进来的」——那是认证自己的事。
    // 只在导航请求上挂：否则登录后一页十几张子资源会各种一次。
    if (session.cookie && isNavigation(request)) {
      out.headers.append("Set-Cookie", session.cookie);
    }
    return out;
  },
};

/**
 * 唯一的认证入口：返回 `{ user, cookie }`，或 null 表示拒绝。
 * `cookie` 是「这次要不要给他发张新票」，没有就是 null。
 *
 * 调用方只知道「是谁」和「有没有票要挂」，**不知道他是怎么进来的**——
 * 这正是单一入口要保的东西。将来换成用户表或 SSO，改的还是这一个函数，
 * 调用方一行都不用动。
 */
async function authenticate(request, env) {
  const session = await userFromSession(request, env);
  if (session) {
    // 快到期了就顺手续一张
    const dueSoon = session.exp - Math.floor(Date.now() / 1000) < SESSION_RENEW_WITHIN;
    return {
      user: session.u,
      cookie: dueSoon ? await mintSession(session.u, env.SESSION_SECRET) : null,
    };
  }

  const user = await userFromBasicAuth(request, env);
  if (user) {
    // 刚用密码进来的，换一张通行证，下次免输。没配签名密钥就只是没票可发。
    return { user, cookie: env.SESSION_SECRET ? await mintSession(user, env.SESSION_SECRET) : null };
  }

  return null;
}

/**
 * 子资源不发新票，免得登录后一页十几张各种一次。
 * 认不出来的（curl、老浏览器、测试）按导航算——宁可多发一次，也别让人拿不到票。
 */
function isNavigation(request) {
  const dest = request.headers.get("Sec-Fetch-Dest");
  return !dest || dest === "document";
}

/* ---------- 路径一：会话 cookie ---------- */

/**
 * 验签在前、解析在后：签名不对就直接出局，绝不去 JSON.parse 一段来路不明的内容。
 * 换掉 SESSION_SECRET 会让所有旧 cookie 立刻验签失败——这就是密钥轮换。
 */
async function userFromSession(request, env) {
  if (!env.SESSION_SECRET) return null;

  const raw = readCookie(request, COOKIE);
  if (!raw) return null;

  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = await hmac(body, env.SESSION_SECRET);
  if (!(await digestEqual(sig, expected))) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
  } catch {
    return null;
  }

  // Number.isFinite 挡住 Infinity——`Infinity <= now` 是 false，会变成永不过期。
  // 要构造它得先有签名，纯属纵深防御，但这一行很便宜。
  if (!Number.isFinite(payload?.exp) || payload.exp * 1000 <= Date.now()) return null;
  if (payload.u !== USER_ID) return null;

  return { u: payload.u, exp: payload.exp };
}

async function mintSession(user, secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const body = bytesToBase64url(new TextEncoder().encode(JSON.stringify({ u: user, exp })));
  const sig = await hmac(body, secret);
  return `${COOKIE}=${body}.${sig}; Max-Age=${SESSION_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/* ---------- 路径二：Basic Auth ---------- */

async function userFromBasicAuth(request, env) {
  // 凭据没配好就一律拒绝。宁可谁都进不来，也不能因为忘了设 secret 就敞开。
  if (!env.AUTH_USER || !env.AUTH_PASSWORD) return null;

  const [scheme, encoded] = (request.headers.get("Authorization") || "").split(" ");
  // RFC 7235：auth-scheme 大小写不敏感
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return null;

  let decoded;
  try {
    decoded = utf8FromBase64(encoded);
  } catch {
    return null;
  }

  // 密码里可以有冒号，用户名不行——按第一个冒号切
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;

  // 两边都算完再判，不短路：短路会让「用户名错」和「密码错」的耗时可区分
  const [okUser, okPass] = await Promise.all([
    digestEqual(decoded.slice(0, sep), env.AUTH_USER),
    digestEqual(decoded.slice(sep + 1), env.AUTH_PASSWORD),
  ]);

  return okUser && okPass ? USER_ID : null;
}

/* ---------- 编码与比较 ---------- */

/**
 * atob() 吐出的是「一字符一字节」的 binary string。把它直接当文本用，
 * 非 ASCII 会被二次 UTF-8 编码——中文密码将永远对不上，且毫无提示
 * （401 里我们还发了 charset="UTF-8"，等于请浏览器就这么发）。必须按字节解回来。
 */
function utf8FromBase64(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
}

function bytesToBase64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function hmac(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return bytesToBase64url(new Uint8Array(sig));
}

/**
 * 比摘要，不比原文：摘要恒为 32 字节，于是长度本身不再是一条信道，
 * 也不必为「长度不等」开一个提前返回的分支。
 */
async function digestEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/* ---------- 响应 ---------- */

/** 401：只说「要登录」，不透露里面有什么 */
function unauthorized() {
  return new Response("401 Unauthorized\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * 退出登录 = **让这台设备把票丢掉**，仅此而已。说清楚它不是什么：
 *
 *   - 签名 cookie 是无状态的，服务端没有「已注销」名单。有人抄走过 cookie 原文的话，
 *     重放它在有效期内仍然管用。
 *   - 改 AUTH_PASSWORD 也踢不掉已经发出去的票——cookie 那条路根本不看密码。
 *
 * 真要把所有设备踢下线，只有一招：**换掉 SESSION_SECRET**，所有票立刻验签失败。
 *
 * 返回 200 而不是 401：401 会带出浏览器的登录弹框，而浏览器很可能还缓存着
 * Basic 凭据，于是静默重发 → 立刻又拿到一张新票，退出等于没退。
 */
function logout() {
  return new Response(
    "已退出登录（这台设备的会话已清除）。\n\n" +
      "浏览器可能还记着 Basic Auth 的用户名密码，重新打开本站会直接进来；要彻底退出，关掉浏览器。\n" +
      "要让所有设备一起下线，去换掉 SESSION_SECRET。\n",
    {
      status: 200,
      headers: {
        "Set-Cookie": `${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
