import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // auto-scroll to the latest message
  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [msgs]);

  async function send() {
    const user = (inputRef.current?.value || "").trim();
    if (!user || pending) return;

    // show user message + placeholder assistant bubble immediately
    setMsgs((m) => [...m, { role: "user", content: user }, { role: "assistant", content: "…" }]);
    setPending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: user }] }),
      });

     const route = resp.headers.get("X-Route") ?? "";
const recoHeader = resp.headers.get("X-Reco") ?? "";
const slug = resp.headers.get("X-Reco-Slug") ?? "";

let bodyText = await resp.text();
      // cooldown: hide duplicate "Try:" if it's the same slug as last time
const lastSlug = localStorage.getItem("lastReco");
if (slug && lastSlug === slug) {
  bodyText = bodyText.replace(/^Try:.*$/m, "").trim();
}
if (slug) localStorage.setItem("lastReco", slug);

const text =
  bodyText +
  (route ? `\n\n[route=${route}${recoHeader ? `, reco=${recoHeader}` : ""}]` : "");

      // replace the placeholder with the real answer
      setMsgs((m) =>
        m.map((msg, i) =>
          i === m.length - 1 ? { ...msg, content: text } : msg
        )
      );
    } catch (e: any) {
      setMsgs((m) =>
        m.map((msg, i) =>
          i === m.length - 1
            ? { ...msg, content: `Error: ${e?.message ?? String(e)}` }
            : msg
        )
      );
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
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 12,
          height: 360,
          overflow: "auto",
          background: "#fff",
        }}
      >
        {msgs.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 10,
              whiteSpace: "pre-wrap",
              lineHeight: 1.4,
            }}
          >
            <strong style={{ marginRight: 6 }}>
              {m.role === "user" ? "You" : "Assistant"}:
            </strong>
            {m.content}
          </div>
        ))}
        {msgs.length === 0 && (
          <div style={{ color: "#666" }}>
            Ask me something like:{" "}
            <em>“How do I collect weekly updates without nagging the team?”</em>
          </div>
        )}
      </div>

      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
        rows={3}
        disabled={pending}
        style={{
          padding: 8,
          borderRadius: 6,
          border: "1px solid #ddd",
          resize: "vertical",
        }}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={send}
          disabled={pending}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid #111",
            background: pending ? "#999" : "#111",
            color: "#fff",
            cursor: pending ? "not-allowed" : "pointer",
          }}
        >
          {pending ? "Sending…" : "Send"}
        </button>
        <span style={{ alignSelf: "center", color: "#666", fontSize: 12 }}>
          Enter = send • Shift+Enter = newline
        </span>
      </div>
    </div>
  );
}
