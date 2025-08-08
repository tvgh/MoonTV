// Cloudflare Pages Functions: /proxy?url=<http/https URL>
// 仅做通用资源代理，满足图片/静态资源代理与基础 CORS 需求。
// 如需更复杂的 HTML 重写，可后续扩展（保持与 proxy.worker.js 的策略一致）。

function setNoCache(headers: Headers) {
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
}

function isValidTarget(u: URL) {
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  // 简单 SSRF 防护：禁止内网、环回、元地址等（Cloudflare 不解析主机，但可保守拒绝常见内部域名）
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host.startsWith('10.') ||
    host.startsWith('172.16.') ||
    host.startsWith('172.17.') ||
    host.startsWith('172.18.') ||
    host.startsWith('172.19.') ||
    host.startsWith('172.2') || // 粗略排内网段
    host.startsWith('192.168.') ||
    host === '169.254.169.254'
  ) {
    return false;
  }
  return true;
}

function rewriteRedirectLocation(reqUrl: URL, loc: string) {
  try {
    const resolved = new URL(loc, reqUrl);
    const self = new URL(reqUrl.origin);
    // 将重定向的目标继续通过本代理转发
    const proxied = new URL('/proxy', self);
    proxied.searchParams.set('url', resolved.toString());
    return proxied.toString();
  } catch {
    return loc;
  }
}

export const onRequest: PagesFunction = async ({ request }) => {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    return new Response('Missing url parameter', { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('Invalid url parameter', { status: 400 });
  }

  if (!isValidTarget(targetUrl)) {
    return new Response('Forbidden target', { status: 403 });
  }

  // 复制必要请求头，剔除宿主相关头
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('referer');
  headers.set('origin', `${targetUrl.protocol}//${targetUrl.host}`);
  headers.set('accept-encoding', 'identity'); // 避免压缩导致流式转发复杂化

  // 构造下游请求
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  // 仅透传非 GET/HEAD 的 body
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  const downstream = await fetch(targetUrl.toString(), init);

  // 处理 3xx：改写 Location 继续走代理
  if ([301, 302, 303, 307, 308].includes(downstream.status)) {
    const newHeaders = new Headers(downstream.headers);
    const loc = newHeaders.get('Location');
    if (loc) {
      newHeaders.set('Location', rewriteRedirectLocation(reqUrl, loc));
    }
    // CORS 友好
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    setNoCache(newHeaders);
    return new Response(null, {
      status: downstream.status,
      statusText: downstream.statusText,
      headers: newHeaders,
    });
  }

  // 其他响应：透传 body 与大多数头
  const respHeaders = new Headers(downstream.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  // 防止缓存
  setNoCache(respHeaders);

  return new Response(downstream.body, {
    status: downstream.status,
    statusText: downstream.statusText,
    headers: respHeaders,
  });
};