"use client";

import { useState } from "react";

/** Icon-only by default; `text` adds a visible label (e.g. "Copy data"). */
export function CopyButton({ value, label, text }: { value: string; label: string; text?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the full value remains in the title and in Sources & methodology.
    }
  };
  return (
    <button type="button" className={`copy-button${copied ? " copied" : ""}`} onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`} title={text ? undefined : value}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {copied ? <path d="m3.5 8.5 3 3 6-7" /> : <><rect x="5.5" y="5.5" width="7" height="8" rx="1" /><path d="M3.5 10.5v-7a1 1 0 0 1 1-1h6" /></>}
      </svg>
      <span aria-live="polite">{copied ? "Copied" : text ?? ""}</span>
    </button>
  );
}
