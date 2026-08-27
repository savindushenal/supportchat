"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type PdfDownload = {
  url: string;
  label: string;
};

type SupportState = {
  complaintDraft: {
    organized: string;
    raw: string;
    waybill: string | null;
  } | null;
  inquiryBuffer: {
    snippets: string[];
    contactPhone: string | null;
    priority: "high" | "normal";
    topic: string | null;
    fields?: Record<string, string>;
  } | null;
};

type Message = {
  role: "bot" | "user";
  text: string;
  download?: PdfDownload | null;
};

type ChatApiResponse = {
  reply: string;
  waybill: string | null;
  suggestions?: string[];
  callerPhone?: string | null;
  sessionToken?: string | null;
  download?: PdfDownload | null;
  supportState?: SupportState;
  mode?: "llm" | "rules";
};

const EMPTY_SUPPORT: SupportState = {
  complaintDraft: null,
  inquiryBuffer: null,
};

const INITIAL_BOT_MESSAGE =
  "Hi! I'm the **TransExpress support agent**.\n\n" +
  "Senders and receivers can track consignments. Full journey details need **SMS OTP**.\n\n" +
  "Share a **waybill** or **contact number** — or type **help**.";

/**
 * Floating support agent — waybill/phone → OTP → verified journey.
 */
export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: "bot", text: INITIAL_BOT_MESSAGE },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentWaybill, setCurrentWaybill] = useState<string | null>(null);
  const [callerPhone, setCallerPhone] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [supportState, setSupportState] =
    useState<SupportState>(EMPTY_SUPPORT);
  const [suggestions, setSuggestions] = useState<string[]>(["help"]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const supportStateRef = useRef(supportState);
  const verified = Boolean(sessionToken && currentWaybill);

  useEffect(() => {
    supportStateRef.current = supportState;
  }, [supportState]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("tx_support_state");
      if (raw) {
        setSupportState(JSON.parse(raw) as SupportState);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("tx_support_state", JSON.stringify(supportState));
    } catch {
      /* ignore */
    }
  }, [supportState]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, isOpen, suggestions]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  async function flushInquiriesOnClose() {
    const state = supportStateRef.current;
    if (!state.inquiryBuffer?.snippets.length) return;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "done",
          flushInquiries: true,
          currentWaybill,
          callerPhone,
          sessionToken,
          supportState: state,
          history: [],
        }),
      });
      const data = (await response.json()) as ChatApiResponse;
      if (data.supportState) setSupportState(data.supportState);
      if (data.callerPhone) setCallerPhone(data.callerPhone);
    } catch {
      /* ignore close flush errors */
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    setInput("");
    setSuggestions([]);
    const nextHistory = [...messages, { role: "user" as const, text: trimmed }];
    setMessages(nextHistory);
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          currentWaybill,
          callerPhone,
          sessionToken,
          supportState,
          history: nextHistory,
        }),
      });

      const data = (await response.json()) as ChatApiResponse;
      setCurrentWaybill(data.waybill ?? null);
      if (data.callerPhone !== undefined) {
        setCallerPhone(data.callerPhone ?? null);
      }
      if (data.sessionToken !== undefined) {
        setSessionToken(data.sessionToken ?? null);
      }
      if (data.supportState !== undefined) {
        setSupportState(data.supportState);
      }
      setSuggestions(data.suggestions ?? []);
      setMessages((prev) => [
        ...prev,
        {
          role: "bot",
          text: data.reply || "No response from server.",
          download: data.download ?? null,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "bot",
          text: "Sorry, we could not reach the server. Please try again.",
        },
      ]);
      setSuggestions(["help"]);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void sendMessage(input);
  }

  function closeChat() {
    void flushInquiriesOnClose();
    setIsOpen(false);
  }

  function suggestionLabel(value: string): string {
    if (value === "1") return "1 · Re-delivery";
    if (value === "2") return "2 · Human agent";
    if (value === "help") return "Help";
    if (value.toUpperCase() === "OTP") return "Send OTP";
    if (value === "pending pdf") return "Pending PDF";
    if (value === "paid pdf") return "Paid PDF";
    if (value === "pending invoices") return "Pending invoices";
    if (value === "complaint status") return "Complaint status";
    if (value === "yes") return "Yes · Raise complaint";
    if (value === "no") return "No · Cancel";
    if (value === "done") return "Yes · Submit inquiry";
    if (value === "yes") return "Yes · Submit";
    if (value === "no") return "No · Cancel";
    return value;
  }

  function renderMessageText(text: string) {
    const withBreaks = text.split("\n");
    return withBreaks.map((line, lineIndex) => (
      <span key={lineIndex}>
        {lineIndex > 0 && <br />}
        {line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).map((part, i) => {
          if (part.startsWith("**") && part.endsWith("**")) {
            return (
              <strong key={i} className="font-semibold">
                {part.slice(2, -2)}
              </strong>
            );
          }
          if (part.startsWith("`") && part.endsWith("`")) {
            return (
              <code
                key={i}
                className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-700"
              >
                {part.slice(1, -1)}
              </code>
            );
          }
          if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
            return (
              <em key={i} className="italic">
                {part.slice(1, -1)}
              </em>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </span>
    ));
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3 font-sans">
      {isOpen && (
        <div
          className="flex h-[min(560px,70vh)] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-2xl shadow-blue-900/20"
          role="dialog"
          aria-label="TransExpress support agent"
        >
          <header className="flex items-center justify-between bg-gradient-to-r from-blue-600 to-blue-500 px-4 py-3 text-white">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-lg">
                💬
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">
                  Support Agent
                </p>
                <p className="text-xs text-blue-100">
                  {currentWaybill
                    ? `${verified ? "Verified · " : ""}${currentWaybill}`
                    : "TransExpress · Online"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => closeChat()}
              className="rounded-full p-1.5 text-white/90 transition hover:bg-white/15"
              aria-label="Close chat"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-5 w-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-4">
            {messages.map((msg, index) => (
              <div
                key={`${msg.role}-${index}`}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                    msg.role === "user"
                      ? "rounded-br-md bg-blue-600 text-white"
                      : "rounded-bl-md border border-slate-100 bg-white text-slate-800"
                  }`}
                >
                  {renderMessageText(msg.text)}
                  {msg.role === "bot" && msg.download?.url && (
                    <a
                      href={msg.download.url}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="h-4 w-4"
                        aria-hidden
                      >
                        <path d="M12 16.5l4.5-4.5h-3V4.5h-3v7.5h-3L12 16.5zM5.25 19.5h13.5V18H5.25v1.5z" />
                      </svg>
                      {msg.download.label || "Download PDF"}
                    </a>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md border border-slate-100 bg-white px-3.5 py-2.5 text-sm text-slate-500 shadow-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:-0.3s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:-0.15s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400" />
                    </span>
                    Helping you...
                  </span>
                </div>
              </div>
            )}

            {!isLoading && suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void sendMessage(s)}
                    className="rounded-full border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-blue-50"
                  >
                    {suggestionLabel(s)}
                  </button>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 border-t border-slate-200 bg-white p-3"
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                currentWaybill && !verified
                  ? "OTP code, or ask…"
                  : verified
                    ? "1, 2, or ask about journey…"
                    : "Waybill / phone / ask…"
              }
              disabled={isLoading}
              className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
              aria-label="Support message"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              aria-label="Send message"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-4 w-4 translate-x-px"
              >
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (isOpen) closeChat();
          else setIsOpen(true);
        }}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/40 transition hover:scale-105 hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-300"
        aria-label={isOpen ? "Close support agent" : "Open support agent"}
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="h-6 w-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-7 w-7"
          >
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z" />
            <circle cx="8" cy="10" r="1.2" />
            <circle cx="12" cy="10" r="1.2" />
            <circle cx="16" cy="10" r="1.2" />
          </svg>
        )}
      </button>
    </div>
  );
}
