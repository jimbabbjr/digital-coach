// works in both Web Request and Express-like req
export const POST = async (req: any) => {
  let body: any = {};
  try {
    if (typeof req?.json === "function") {
      // Web Fetch API style
      body = await req.json();
    } else if (req?.body !== undefined) {
      // Express style (may be object or raw string)
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    } else if (typeof req?.text === "function") {
      // Some runtimes expose text()
      const t = await req.text();
      body = t ? JSON.parse(t) : {};
    }
  } catch {
    body = {};
  }

  const messages = body?.messages ?? [];
  const last = messages.at?.(-1)?.content ?? "No message";

  return new Response(`API up. You said: ${last}`, {
    headers: { "Content-Type": "text/plain" },
  });
};
