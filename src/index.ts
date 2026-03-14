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
          return `${PUBLIC_URL}/ts-segment?url=${encodedUrl}`;
        }
      }).join("\n");

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

  .get("/ts-segment", async ({ request, query: { url } }) => {
    try {
      const res = await fetch(url, {
        headers: corsHeaders,
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
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "video/MP2T",
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

  .get("/fetch", async ({ request, query: { url } }) => {
    try {
      const res = await fetch(url, {
        headers: corsHeaders,
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

app.listen(PORT);


Logger.info(
  `Started at ${app.server?.protocol}://${app.server?.hostname}:${PORT}`,
);

export default app; // Must use a default export