/**
 * 云端版的 Worker：一道登录墙 + 静态资源投递。
 *
 * 「云端版」是**自托管态**的一种——你自己部署、自己拿钥匙（见 CONTEXT.md）。
 * 培然同学自己那一份实例才叫**私有云态**。
 *
 * 两件事，就这两件：
 *   1. 每个请求先过 authenticate()，不通过一律 401
 *   2. 通过了才把请求交给静态资源
 *
 * 账本读写（KV）不在这一层，见 T2。
 */

// realm 只用 ASCII——它会进 HTTP 头，中文在部分客户端上会乱码
const REALM = "Private";

// 认证通过后的用户标识。今天只有一个人，所以是定值；
// T2 会拿它当账本 KV key 的前缀（`u/<标识>/...`），多用户时这里才会变。
const USER_ID = "me";

export default {
  async fetch(request, env) {
    if (!(await authenticate(request, env))) return unauthorized();

    const res = await env.ASSETS.fetch(request);
    // 门后的东西是私人的：别让任何中间层替我缓存
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-cache");
    return out;
  },
};

/**
 * 唯一的认证入口：返回用户标识，或 null 表示拒绝。
 *
 * 今天的实现是「比对配置好的那一对凭据，返回定值标识」。将来换成用户表、
 * SSO 或别的什么，只改这个函数——调用方拿到的仍是一个用户标识，一行都不用动。
 */
async function authenticate(request, env) {
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

/**
 * atob() 吐出的是「一字符一字节」的 binary string。把它直接当文本用，
 * 非 ASCII 会被二次 UTF-8 编码——中文密码将永远对不上，且毫无提示
 * （401 里我们还发了 charset="UTF-8"，等于请浏览器就这么发）。必须按字节解回来。
 */
function utf8FromBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
