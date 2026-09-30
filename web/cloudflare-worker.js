/**
 * Cloudflare Worker — proxies /c/<clipId> to the backend OG route, so shared
 * clip links live on your own domain instead of the backend's hostname.
 *
 * Optional: clip sharing works without it, just with uglier URLs.
 *
 * Setup in the Cloudflare dashboard:
 * 1. Workers & Pages → Create → "Create Worker"
 * 2. Name it, e.g. "courtside-clip-share"
 * 3. Paste this code → Deploy
 * 4. Settings → Variables → add BACKEND = your Courtside backend URL
 * 5. Your domain → Workers Routes → add: <your-domain>/c/* → the worker
 */

export default {
  async fetch(request, env) {
    const BACKEND = (env && env.BACKEND ? env.BACKEND : "").replace(/\/$/, "");
    if (!BACKEND) {
      return new Response("Worker not configured: set the BACKEND variable", { status: 500 });
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/c\/([^/]+)$/);

    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const clipId = match[1];

    // Forward the request to the backend OG route (preserve user-agent for bot detection)
    const backendUrl = `${BACKEND}/api/clips/${encodeURIComponent(clipId)}/og`;
    const res = await fetch(backendUrl, {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "",
      },
    });

    // Return the response with the correct content type
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "text/html",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};
