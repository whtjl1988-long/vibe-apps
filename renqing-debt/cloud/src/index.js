/**
 * 云端形态的 Worker：一道登录墙 + 静态资源投递。
 *
 * 两件事，就这两件：
 *   1. 每个请求先过 authenticate()，不通过一律 401
 *   2. 通过了才把请求交给静态资源
 *
 * 账本读写（KV）不在这一层，见 T2。
 */

// realm 只用 ASCII——它会进 HTTP 头，中文在部分客户端上会乱码
const REALM = "Private";

export default {
  async fetch(request, env) {
    const user = authenticate(request, env);
    if (!user) return unauthorized();
    return env.ASSETS.fetch(request);
  },
};

/**
 * 唯一的认证入口：返回用户标识，或 null 表示拒绝。
 *
 * 今天的实现是「比对配置好的那一对凭据，返回固定标识」。将来换成用户表、
 * SSO 或别的什么，只改这个函数——调用方拿到的仍是一个用户标识，一行都不用动。
 * 这个标识将来就是账本 KV key 的用户前缀（`u/<标识>/...`）。
 */
export function authenticate(request, env) {
  // 凭据没配好就一律拒绝。宁可谁都进不来，也不能因为忘了设 secret 就敞开。
  if (!env.AUTH_USER || !env.AUTH_PASSWORD) return null;

  const [scheme, encoded] = (request.headers.get("Authorization") || "").split(" ");
  if (scheme !== "Basic" || !encoded) return null;

  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }

  // 密码里可以有冒号，用户名不行——按第一个冒号切
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;

  if (!safeEqual(decoded.slice(0, sep), env.AUTH_USER)) return null;
  if (!safeEqual(decoded.slice(sep + 1), env.AUTH_PASSWORD)) return null;

  return "me";
}

/** 常量时间比较：别让响应时间变成一条试探密码的信道 */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // timingSafeEqual 要求等长，长度本身不是秘密
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
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
