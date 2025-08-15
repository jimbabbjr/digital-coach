import type { Handler } from "@netlify/functions";

export const handler: Handler = async (event) => {
  const t0 = Date.now();
  // optional: read a query ?q= to echo
  const q = new URL(event.rawUrl).searchParams.get("q") || "ok";

  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    // custom headers you want to read in the browser
    "X-Route": "test",
    "X-Reco": "true",
    "X-Duration": `${Date.now() - t0}ms`,
    // expose them to JS fetch() just in case
    "Access-Control-Expose-Headers": "X-Route, X-Reco, X-Duration",
  };
  

  return { statusCode: 200, headers, body: `echo: ${q}` };
};
