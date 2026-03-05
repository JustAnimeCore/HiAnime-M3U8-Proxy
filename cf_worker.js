export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (url.pathname === "/m3u8-proxy") {
      return handleM3U8Proxy(request, env);
    } else if (url.pathname === "/ts-proxy") {
      return handleTsProxy(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Robust query param extraction to avoid '+' -> ' ' issue with URLSearchParams
function getParam(url, name) {
  const match = url.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const isOriginAllowed = (origin, env) => {
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(o => o.trim());
  return allowed.includes("*") || allowed.includes(origin);
};

async function handleM3U8Proxy(request, env) {
  const targetUrl = getParam(request.url, "url");
  const headersParam = getParam(request.url, "headers");
  let headers = {};
  try {
    headers = JSON.parse(headersParam || "{}");
  } catch (e) {
    console.error("Failed to parse headers", e);
  }
  const origin = request.headers.get("Origin") || "";

  if (!isOriginAllowed(origin, env)) {
    return new Response(`Origin "${origin}" not allowed`, {
      status: 403,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  if (!targetUrl) return new Response("URL required", { status: 400 });

  // STEALTH: Use the exact User-Agent from the local proxy
  const fetchHeaders = {
    "Referer": env.DEFAULT_REFERER || "https://megacloud.blog",
    "Origin": env.DEFAULT_ORIGIN || "https://hianime.to",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36",
  };

  // Only allow "safe" headers to avoid proxy detection
  const safeHeaders = ["Accept", "Accept-Language", "Cache-Control", "Pragma"];
  Object.keys(headers).forEach(h => {
    if (safeHeaders.includes(h)) fetchHeaders[h] = headers[h];
  });

  try {
    const response = await fetch(targetUrl, { headers: fetchHeaders });
    const finalTargetUrl = response.url || targetUrl;

    // If blocked, Cloudflare/CDNs often return 403 but sometimes 200 with a challenge page
    if (!response.ok) {
      return new Response(`Upstream returned ${response.status}`, {
        status: response.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "x-debug-status": response.status.toString()
        }
      });
    }

    const workerUrl = new URL(request.url);
    const workerBaseUrl = `${workerUrl.protocol}//${workerUrl.host}`;

    const m3u8 = await response.text();
    const debugPeek = m3u8.substring(0, 100).replace(/\r?\n/g, " ");

    // Verify it's actually an M3U8
    if (!m3u8.trim().startsWith("#EXTM3U")) {
      return new Response(m3u8, {
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
          "x-debug-peek": "INVALID_M3U8: " + debugPeek
        }
      });
    }

    const lines = m3u8.split(/\r?\n/);
    const newLines = [];
    const isMaster = m3u8.includes("#EXT-X-STREAM-INF") || m3u8.includes("RESOLUTION=");

    for (let line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        newLines.push(line);
        continue;
      }

      if (trimmedLine.startsWith("#")) {
        if (trimmedLine.startsWith("#EXT-X-KEY:") || trimmedLine.startsWith("#EXT-X-MEDIA:")) {
          const newLine = line.replace(/URI=["']?([^"'\s,]+)["']?/, (match, originalUri) => {
            const absoluteUri = new URL(originalUri, finalTargetUrl).href;
            const isPlaylist = line.includes("TYPE=AUDIO") || line.includes("TYPE=SUBTITLES") || originalUri.includes(".m3u8");
            const proxyPath = isPlaylist ? "/m3u8-proxy" : "/ts-proxy";
            const newProxiedUrl = `${workerBaseUrl}${proxyPath}?url=${encodeURIComponent(absoluteUri)}${headersParam ? `&headers=${encodeURIComponent(headersParam)}` : ""}`;
            return match.replace(originalUri, newProxiedUrl);
          });
          newLines.push(newLine);
        } else {
          newLines.push(line);
        }
      } else {
        const absoluteUri = new URL(trimmedLine, finalTargetUrl).href;
        const proxyPath = isMaster ? "/m3u8-proxy" : "/ts-proxy";
        const newProxiedUrl = `${workerBaseUrl}${proxyPath}?url=${encodeURIComponent(absoluteUri)}${headersParam ? `&headers=${encodeURIComponent(headersParam)}` : ""}`;
        newLines.push(newProxiedUrl);
      }
    }

    return new Response(newLines.join("\n"), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "Cache-Control": "no-cache",
        "x-debug-peek": debugPeek,
        "x-request-url": targetUrl
      },
    });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

async function handleTsProxy(request, env) {
  const targetUrl = getParam(request.url, "url");
  const headersParam = getParam(request.url, "headers");
  let headers = {};
  try {
    headers = JSON.parse(headersParam || "{}");
  } catch (e) { }
  const origin = request.headers.get("Origin") || "";

  if (!isOriginAllowed(origin, env)) {
    return new Response(`Origin "${origin}" not allowed`, {
      status: 403,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  if (!targetUrl) return new Response("URL required", { status: 400 });

  const forwardHeaders = new Headers({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36",
    "Referer": env.DEFAULT_REFERER || "https://megacloud.blog",
    "Origin": env.DEFAULT_ORIGIN || "https://hianime.to",
  });

  if (request.headers.has("Range")) {
    forwardHeaders.set("Range", request.headers.get("Range"));
  }
  // Also check passed headers for Range
  if (headers["Range"]) forwardHeaders.set("Range", headers["Range"]);

  try {
    const response = await fetch(targetUrl, {
      method: request.method === "OPTIONS" ? "GET" : request.method,
      headers: forwardHeaders,
    });

    const responseHeaders = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Cache-Control": "public, max-age=3600",
      "x-debug-status": response.status.toString(),
      "x-request-url": targetUrl
    });

    const headersToForward = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"];
    headersToForward.forEach(h => {
      if (response.headers.has(h)) responseHeaders.set(h, response.headers.get(h));
    });

    // Determine correct content-type
    if (targetUrl.includes(".m3u8")) {
      responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    } else if (targetUrl.includes(".ts")) {
      responseHeaders.set("Content-Type", "video/mp2t");
    } else if (targetUrl.includes(".m4s")) {
      responseHeaders.set("Content-Type", "video/iso.segment");
    } else if (targetUrl.includes("key") || targetUrl.includes(".key") || targetUrl.includes("/key/")) {
      responseHeaders.set("Content-Type", "application/octet-stream");
    } else if (!responseHeaders.has("Content-Type")) {
      responseHeaders.set("Content-Type", "video/mp2t");
    }

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
