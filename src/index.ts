import { Elysia, t } from "elysia";
import { isTooLarge, PUBLIC_URL } from "./config";
import { Logger } from "./logger";

import { cors } from "@elysiajs/cors";

const PORT = Bun.env.PORT || 3000;
const ALLOWED_ORIGINS = Bun.env.ALLOWED_ORIGINS || "*";


if (!PUBLIC_URL) throw new Error("set PUBLIC_URL at .env!");

const corsHeaders: Record<string, string> = {
  origin: "https://megacloud.blog",
  referer: "https://megacloud.blog/"
};

// const corsHeaders: Record<string, string> = {
//   "Accept": "*/*",
//   "Accept-Encoding": "gzip, deflate, br, zstd",
//   "Accept-Language": "en-US,en;q=0.6",
//   "Connection": "keep-alive",
//   "Host": "douvid.xyz",
//   "Origin": "https://megacloud.blog",
//   "Referer": "https://megacloud.blog/",
//   "sec-ch-ua": '"Not:A-Brand";v="99", "Brave";v="145", "Chromium";v="145"',
//   "sec-ch-ua-mobile": "?0",
//   "sec-ch-ua-platform": '"Windows"',
//   "Sec-Fetch-Dest": "empty",
//   "Sec-Fetch-Mode": "cors",
//   "Sec-Fetch-Site": "cross-site",
//   "Sec-GPC": "1",
//   "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
// };

const cacheHeader: Record<string, string> = {
  "Cache-Control": "public, max-age=3600"
}

// for proxy safety
const PLAYLIST_REGEX = /\.m3u|playlist/i
const MAX_M3U8_SIZE = 5 * 1024 * 1024;       // 5 MB
const MAX_TS_SIZE = 50 * 1024 * 1024;        // 50 MB
const MAX_FETCH_SIZE = 50 * 1024 * 1024;     // 50 MB

// --- PREFETCH CACHE ---
const nextSegmentMap = new Map<string, string>();
const maxNextMapSize = 5000;
function setNextSegment(current: string, next: string) {
    if (nextSegmentMap.size > maxNextMapSize) {
        const first = nextSegmentMap.keys().next().value;
        if (first) nextSegmentMap.delete(first);
    }
    nextSegmentMap.set(current, next);
}

interface CachedSegment {
    buffer: ArrayBuffer;
    headers: Record<string, string>;
}
const prefetchCache = new Map<string, Promise<CachedSegment | null>>();
const MAX_PREFETCH_CACHE_SIZE = 30; // ~150MB max RAM

function triggerPrefetch(url: string) {
    if (!url || prefetchCache.has(url)) return;

    if (prefetchCache.size >= MAX_PREFETCH_CACHE_SIZE) {
        const first = prefetchCache.keys().next().value;
        if (first) prefetchCache.delete(first);
    }

    const promise = fetch(url, {
        headers: corsHeaders,
        keepalive: true
    }).then(async res => {
        if (!res.ok) return null;
        if (isTooLarge(res.headers.get("content-length"), MAX_TS_SIZE)) return null;
        const buffer = await res.arrayBuffer();
        const headers: Record<string, string> = {
            "Content-Type": res.headers.get("Content-Type") || "video/MP2T",
            "Content-Length": buffer.byteLength.toString(),
            "Accept-Ranges": res.headers.get("Accept-Ranges") || "bytes",
        };
        return { buffer, headers };
    }).catch(err => {
        Logger.error("Prefetch error:", err?.message);
        return null;
    });

    prefetchCache.set(url, promise);
}
// --- END PREFETCH CACHE ---

const app = new Elysia()
  .use(cors({
    origin: ALLOWED_ORIGINS === "*" ? true : ALLOWED_ORIGINS.split(",")
  }))
  .get("/", () => {
    return {
      endpoints: [
        "-------------PROXY--------------",
        "/m3u8-proxy?url={url}",
        "/ts-segment?url={url}",
        "/fetch?url={url}",
      ]
    }
  })

  .get("/m3u8-proxy", async ({ request, query: { url } }) => {
    try {
      const res = await fetch(url, {
        headers: corsHeaders,
        keepalive: true,
        signal: request.signal // Abort if client disconnects
      });

      if (!res.ok) {
        console.log("Fetch failed with status:", res.status, "Url:", url)
        return new Response(res.body, { status: res.status });
      }

      // Size limit check
      if (isTooLarge(res.headers.get("content-length"), MAX_M3U8_SIZE)) {
        return new Response("File too large", { status: 413 });
      }

      const text = await res.text();

      // Bun.write("./logs/m3u8/" + Date.now(), text);

      const tsUrls: string[] = [];

      const proxifiedM3u8 = text.split("\n").map(line => {
        const tl = line.trim();
        if (!tl) return line;

        if (tl.startsWith("#EXT")) {
          return tl.replace(/URI="([^"]+)"/g, (_, uri) => {
            const absoluteUrl = new URL(uri, url).href;
            let proxiedUrl;
            const encodedUrl = encodeURIComponent(absoluteUrl);

            if (PLAYLIST_REGEX.test(absoluteUrl)) {
              proxiedUrl = `${PUBLIC_URL}/m3u8-proxy?url=${encodedUrl}`;
            } else {
              tsUrls.push(absoluteUrl);
              proxiedUrl = `${PUBLIC_URL}/fetch?url=${encodedUrl}`;
            }

            return `URI="${proxiedUrl}"`;
          })
        }

        const absoluteUrl = new URL(tl, url).href;
        const encodedUrl = encodeURIComponent(absoluteUrl);

        if (PLAYLIST_REGEX.test(absoluteUrl)) {
          return `${PUBLIC_URL}/m3u8-proxy?url=${encodedUrl}`;
        } else {
          tsUrls.push(absoluteUrl);
          return `${PUBLIC_URL}/ts-segment?url=${encodedUrl}`;
        }
      }).join("\n");

      for (let i = 0; i < tsUrls.length - 1; i++) {
        setNextSegment(tsUrls[i], tsUrls[i + 1]);
      }
      if (tsUrls.length > 0) {
        triggerPrefetch(tsUrls[0]);
      }

      return new Response(proxifiedM3u8, {
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/vnd.apple.mpegurl",
          ...cacheHeader
        }
      });

    } catch (err: any) {
      if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
      Logger.error(err);
      Logger.error("URL:", url);
      return new Response("Internal Server Error", { status: 500 });
    }
  }, {
    query: t.Object({
      url: t.String()
    })
  })

  .get("/ts-segment", async ({ request, headers, query: { url } }) => {
    try {
      const nextUrl = nextSegmentMap.get(url);
      if (nextUrl) triggerPrefetch(nextUrl);

      if (prefetchCache.has(url)) {
        const cached = await prefetchCache.get(url);
        prefetchCache.delete(url);
        if (cached && !headers['range']) {
          return new Response(cached.buffer, { headers: { ...cached.headers, ...cacheHeader } });
        }
      }

      const fetchHeaders = { ...corsHeaders };
      if (headers['range']) fetchHeaders['Range'] = headers['range'];

      const res = await fetch(url, {
        headers: fetchHeaders,
        keepalive: true,
        signal: request.signal // Abort if client disconnects
      });

      if (!res.ok) {
        console.error("TS segment Fetch failed:", res.status, url);
        return new Response(res.body, { status: res.status });
      }

      // Size limit check
      if (isTooLarge(res.headers.get("content-length"), MAX_TS_SIZE)) {
        return new Response("Segment too large", { status: 413 });
      }

      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "video/MP2T",
          "Content-Length": res.headers.get("Content-Length") || "",
          "Accept-Ranges": res.headers.get("Accept-Ranges") || "bytes",
          "Content-Range": res.headers.get("Content-Range") || "",
          ...cacheHeader
        }
      });

    } catch (err: any) {
      if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
      Logger.error(err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }, {
    query: t.Object({
      url: t.String()
    }),
  })

  .get("/fetch", async ({ request, headers, query: { url } }) => {
    try {
      const nextUrl = nextSegmentMap.get(url);
      if (nextUrl) triggerPrefetch(nextUrl);

      if (prefetchCache.has(url)) {
        const cached = await prefetchCache.get(url);
        prefetchCache.delete(url);
        if (cached && !headers['range']) {
          return new Response(cached.buffer, { headers: { ...cached.headers, ...cacheHeader } });
        }
      }

      const fetchHeaders = { ...corsHeaders };
      if (headers['range']) fetchHeaders['Range'] = headers['range'];

      const res = await fetch(url, {
        headers: fetchHeaders,
        keepalive: true,
        signal: request.signal // Abort if client disconnects
      });

      // Size limit check
      if (isTooLarge(res.headers.get("content-length"), MAX_FETCH_SIZE)) {
        return new Response("Payload too large", { status: 413 });
      }

      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") || "application/octet-stream",
          "Content-Length": res.headers.get("Content-Length") || "",
          "Accept-Ranges": res.headers.get("Accept-Ranges") || "bytes",
          "Content-Range": res.headers.get("Content-Range") || "",
          ...cacheHeader
        }
      });
    } catch (err: any) {
      if (err.name === 'AbortError') return new Response("Client disconnected", { status: 499 });
      return new Response("Fetch Error", { status: 500 });
    }
  }, {
    query: t.Object({
      url: t.String(),
    }),
  });

export default {
  port: PORT,
  fetch: app.fetch
}; // Expected by Bun auto-serve and Vercel