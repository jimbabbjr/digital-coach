// src/components/Chat.tsx
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// tiny Markdown → HTML (bold, italics, lists, paragraphs)
function mdToHtml(src: string) {
  const safe = escapeHtml(src ?? "");
  let html = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])_([^_]+)_([)\s.,!?]|$)/g, (_, a, b, c) => `${a}<em>${b}</em>${c}`);
  const lines = html.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.*)$/);
    if (m) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${m[1]}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(line);
    }
  }
  if (inList) out.push("</ul>");
  const joined = out.join("\n");
  const paras = joined.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("\n");
}

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [msgs]);

  async function send() {
    const user = (inputRef.current?.value || "").trim();
    if (!user || pending) return;

    // optimistic bubbles
    setMsgs((m) => [...m, { role: "user", content: user }, { role: "assistant", content: "…" }]);
    setPending(true);

    try {
      // build history (exclude the placeholder)
      const history: Msg[] = [];
      const snapshot = [...msgs, { role: "user", content: user }];
      for (const m of snapshot) {
        if (m.role === "assistant" && m.content === "…") continue;
        history.push({ role: m.role, content: m.content });
      }

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      const ct = resp.headers.get("content-type") || "";
      let text = "";
      if (ct.includes("application/json")) {
        const data = (await resp.json().catch(() => null)) as any;
        text = String(data?.text ?? "");
        if (!text) {
          for (const k of Object.keys(data || {})) {
            if (typeof (data as any)[k] === "string" && (data as any)[k].length > 0) { text = String((data as any)[k]); break; }
          }
        }
      } else {
        const bodyText = await resp.text();
        try { text = String((JSON.parse(bodyText) as any)?.text ?? ""); }
        catch { text = bodyText; }
      }
      if (!text || text === "undefined") text = "Sorry—no answer came back.";

      setMsgs((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: "assistant", content: text };
        return copy;
      });
    } catch (e: any) {
      setMsgs((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: "assistant", content: `Error: ${e?.message ?? String(e)}` };
        return copy;
      });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
      setPending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        ref={boxRef}
        style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, height: 360, overflow: "auto", background: "#fff" }}
      >
        {msgs.map((m, i) => (
          <div key={i} style={{ marginBottom: 10, lineHeight: 1.5 }}>
            <strong style={{ marginRight: 6 }}>{m.role === "user" ? "You" : "Assistant"}:</strong>
            {m.role === "assistant"
              ? <span style={{ display: "block" }} dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />
              : <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>}
          </div>
        ))}
        {msgs.length === 0 && (
          <div style={{ color: "#666" }}>
            <div style={{ marginBottom: 8 }}>
              Try: <code>Book recommendation for day-to-day task execution with entry-level staff</code>
            </div>
            <em>Then reply “checklist manifesto” to drill in.</em>
          </div>
        )}
      </div>

      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
        rows={3}
        disabled={pending}
        style={{ padding: 8, borderRadius: 6, border: "1px solid #ddd", resize: "vertical", minHeight: 64, font: "inherit" }}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={send}
          disabled={pending}
          style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #111", background: pending ? "#999" : "#111", color: "#fff", cursor: pending ? "not-allowed" : "pointer" }}
        >
          {pending ? "Sending…" : "Send"}
        </button>
        <span style={{ alignSelf: "center", color: "#666", fontSize: 12 }}>Enter = send • Shift+Enter = newline</span>
      </div>
    </div>
  );
}
