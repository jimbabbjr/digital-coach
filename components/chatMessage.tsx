import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";

type Props = { text: string };

export default function ChatMessage({ text }: Props) {
  // optional: strip leading/trailing whitespace
  const safe = DOMPurify.sanitize(text ?? "");
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{safe}</ReactMarkdown>
    </div>
  );
}
