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

// 账本接口。整份 JSON 存一个 key——这本账一年几十条，整份重写在这个量级
// 没有性能问题，不值得为它上 D1。
const LEDGER_PATH = "/api/ledger";
const HISTORY_PATH = "/api/ledger/history";

// key 带用户前缀。今天前缀是定值，将来多用户天然分隔——**新用户**不需要迁移；
// 培然同学自己那份在 `u/me/...`，真做多用户时得把 me 映射到他的 id 或迁一次。
const ledgerKey = (user) => `u/${user}/renqing/v1`;

// 历史版本。每次写入把**被覆盖掉的那一份**留下来，挡的是「误删一笔」和
// 「冲突时选错了边」——最可能真发生的两种。这本账丢了不可重建：
// 谁三年前随了你多少，没有第二个地方记着。
const historyPrefix = (user) => `h/${user}/renqing/`;
// 补零到 6 位，好让 KV 的字典序等于版本序（淘汰最老的时候直接切前几个）。
// 边界：版本号到 1000000 之后字典序会翻转，淘汰就会删错方向。一年几十次写入，
// 这一天不会来；真要来了，改成 8 位并把历史 key 迁一次即可。
const historyKey = (user, rev) => `${historyPrefix(user)}${String(rev).padStart(6, "0")}`;
const HISTORY_KEEP = 20;

// 注入给页面的标记：告诉软件「你正跑在云端」，顺带告诉它账本接口和首页在哪。
// 公开分发的那一份没有这些标记，于是仍是试玩态/自托管态——同一份源码，不 fork。
//
// 为什么要注入地址而不是让软件用相对路径：软件可能被放在子路径下
// （自留地里它住 /renqing/），那时 `./api/ledger` 会解析成 /renqing/api/ledger。
// 部署在哪只有托管它的 Worker 知道，所以由 Worker 说了算。
const CLOUD_FLAG = "__CLOUD_HOSTED__";
// 首页地址可配：自留地的首页是卡片墙，粉丝自建时通常就是根。
// 只收同源的绝对路径——配错了（或被塞进 javascript: / 外部 URL）就退回根，
// 免得品牌条把人带去别处。
function homeOf(env) {
  const raw = String(env.CLOUD_HOME || "/");
  return /^\/[^/\\]*/.test(raw) ? raw : "/";
}

/**
 * 往 <script> 里塞值时，JSON.stringify 是不够的：它不转义 `<`，
 * 于是一个含 `</script>` 的值就能越出脚本块。把 `<` 转成 \u003c 即可。
 */
const inlineJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

export default {
  async fetch(request, env) {
    // 退出登录不需要先登录：它只做「清掉凭证」这一件事
    if (new URL(request.url).pathname === "/logout") return logout();

    const session = await authenticate(request, env);
    if (!session) return unauthorized();

    const path = new URL(request.url).pathname;
    if (path === HISTORY_PATH || path.startsWith(HISTORY_PATH + "/")) {
      return withCookie(await historyApi(request, env, session.user), session, request);
    }
    if (path === LEDGER_PATH) {
      return withCookie(await ledgerApi(request, env, session.user), session, request);
    }

    let res = await env.ASSETS.fetch(request);
    // 给 HTML 注入云端标记。放在 head 最前面，页面脚本读到时它已经在了。
    if (isHtml(res)) {
      res = new HTMLRewriter()
        .on("head", {
          element(el) {
            el.prepend(
              `<script>window.${CLOUD_FLAG}=true;window.__LEDGER_API__=${inlineJson(LEDGER_PATH)};window.__CLOUD_HOME__=${inlineJson(homeOf(env))}</script>`,
              { html: true },
            );
          },
        })
        .transform(res);
    }

    return withCookie(res, session, request);
  },
};

/* ---------- 账本 ---------- */

/**
 * 整份账本读写。Worker 不解释账本的内容——它只认「是不是一份看起来像账本的 JSON」，
 * 剩下的归软件。这样将来软件改数据结构，这一层不用跟着动。
 *
 * 并发控制走标准的 HTTP 乐观锁：GET 带回 `ETag`（版本号），PUT 必须带
 * `If-Match` 说明「我这份是基于第几版改的」。对不上就 409，并把云端那份
 * 一起返回，让前端去问人要怎么办——**绝不自动合并**。
 *
 * 版本号存在 KV 的 metadata 里，账本本体仍是一份纯 JSON，这一层不碰它。
 *
 * ⚠️ 诚实说明限制：KV 没有原子的 compare-and-swap，而且它的读是**最终一致**的
 * ——同一个 key 的写入可能要几十秒才在所有节点可见。所以窗口不是「毫秒级」，
 * 而是**可以到分钟级**，跨设备时尤其如此。撞上陈旧读的话，CAS 会误判为一致
 * 而放行，并且归档下来的是那份陈旧的内容——被吃掉的那一版连历史里都没有。
 *
 * 那为什么还是这么做：它挡住了真正高频的那类事故（开了几小时的旧标签页、
 * 两台设备隔着几小时各记各的），而剩下的窗口要求两台设备在同一分钟内先后
 * 写入同一本账。消灭它得上 Durable Objects，对一本一年几十条的账是过度设计。
 * 但别把这个限制说小了——它是分钟级的，不是毫秒级的。
 */
async function ledgerApi(request, env, user) {
  if (!env.LEDGER) return json({ error: "没有配置账本存储" }, 501);
  const key = ledgerKey(user);

  if (request.method === "GET") {
    const { value, metadata } = await env.LEDGER.getWithMetadata(key);
    // 还没有账本 ≠ 出错：204 + rev 0 让前端干净地走「空账本起步」
    if (value === null) return new Response(null, { status: 204, headers: { ETag: etag(0) } });
    return new Response(value, {
      headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag(revOf(metadata)) },
    });
  }

  if (request.method === "PUT") {
    const base = parseIfMatch(request.headers.get("If-Match"));
    // 不带 If-Match 一律拒绝：那等于「我不管现在是第几版，覆盖就是了」，
    // 而那正是这道护栏要挡的事
    if (base === null) return json({ error: "PUT 必须带 If-Match" }, 428);

    const text = await request.text();
    // 形状校验，不看内容：挡住空 body 和明显不是账本的东西，
    // 免得一次网络抽风把整本账覆盖成 "undefined"
    try {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.records)) throw new Error("shape");
    } catch {
      return json({ error: "这不像一份账本" }, 400);
    }

    const { value: current, metadata } = await env.LEDGER.getWithMetadata(key);
    const currentRev = current === null ? 0 : revOf(metadata);

    if (base !== currentRev) {
      // 冲突。把云端那份原样带回去，前端拿它去问人：用哪边？
      return new Response(current === null ? "null" : current, {
        status: 409,
        headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag(currentRev) },
      });
    }

    const next = currentRev + 1;

    // 先把旧的那份归档，再覆盖。顺序反了的话，写成功、归档失败就等于没备份。
    if (current !== null) {
      await env.LEDGER.put(historyKey(user, currentRev), current, {
        metadata: { rev: currentRev, at: new Date().toISOString() },
      });
      await pruneHistory(env, user);
    }

    await env.LEDGER.put(key, text, { metadata: { rev: next } });
    return new Response(JSON.stringify({ ok: true, rev: next }), {
      headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag(next) },
    });
  }

  return json({ error: "不支持的方法" }, 405);
}

/**
 * 历史版本的读取。
 *   GET  /api/ledger/history        列出有哪些版本（新的在前）
 *   GET  /api/ledger/history/<rev>  取某一版的内容
 *
 * 恢复不在这里做——前端把某一版读出来当作「我这边」，再走正常的 PUT + If-Match。
 * 这样恢复动作也受同一道护栏管着，不会绕过 T3。
 */
async function historyApi(request, env, user) {
  if (!env.LEDGER) return json({ error: "没有配置账本存储" }, 501);
  if (request.method !== "GET") return json({ error: "不支持的方法" }, 405);

  const path = new URL(request.url).pathname;
  const tail = path.slice(HISTORY_PATH.length).replace(/^\//, "");

  if (!tail) {
    const list = await env.LEDGER.list({ prefix: historyPrefix(user) });
    const versions = list.keys
      .map((k) => ({ rev: k.metadata?.rev ?? 0, at: k.metadata?.at ?? null }))
      .sort((a, b) => b.rev - a.rev);
    return json({ versions });
  }

  if (!/^\d+$/.test(tail)) return json({ error: "版本号得是数字" }, 400);
  const value = await env.LEDGER.get(historyKey(user, Number(tail)));
  if (value === null) return json({ error: "没有这一版" }, 404);
  return new Response(value, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

/** 只留最近 20 版。KV 的 list 是按 key 字典序的，而 key 里的版本号补了零，所以序就是版本序。 */
async function pruneHistory(env, user) {
  const list = await env.LEDGER.list({ prefix: historyPrefix(user) });
  const extra = list.keys.length - HISTORY_KEEP;
  if (extra <= 0) return;
  // 字典序最小的就是最老的
  const doomed = list.keys.slice(0, extra);
  await Promise.all(doomed.map((k) => env.LEDGER.delete(k.name)));
}

const etag = (rev) => `"${rev}"`;
const revOf = (metadata) => (Number.isInteger(metadata?.rev) ? metadata.rev : 0);

/** 只认确切的版本号。`*` 和多值形式一律当作没给——这道门不留模糊地带。 */
function parseIfMatch(header) {
  if (!header) return null;
  const m = /^"(\d+)"$/.exec(header.trim());
  return m ? Number(m[1]) : null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const isHtml = (res) => (res.headers.get("Content-Type") || "").includes("text/html");

/**
 * 统一出口：加缓存策略、按需挂会话票。
 *
 * ⚠️ 别写成 `new Response(res.body, res)`。那样复制过来的 headers 在**线上**
 * 是 immutable，set/append 会**静默失败**——不报错、不抛异常，就是不生效。
 * 本地 Miniflare 没有这个约束，于是本地测试全绿而线上一张票都发不出去
 * （2026-09-03 就是这么栽的）。显式建一个新的 Headers，才是两边都成立的写法。
 */
function withCookie(res, session, request) {
  const headers = new Headers(res.headers);

  // 门后的东西是私人的：别让任何中间层替我缓存
  headers.set("Cache-Control", "private, no-cache");

  // 有票要发就挂上。这里不问「你是怎么进来的」——那是认证自己的事。
  // 只在导航请求上挂：否则登录后一页十几张子资源会各种一次。
  if (session.cookie && isNavigation(request)) {
    headers.append("Set-Cookie", session.cookie);
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
