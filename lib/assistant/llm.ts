import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import {
  findOrderByWaybill,
  findValidSessionForPhone,
  findValidTrackingSession,
  getInvoiceSummaryForPhone,
  getOrderJourney,
  listComplaints,
  lookupShipments,
  partyPhoneForOtp,
  requestRedelivery,
  updateOrderAction,
} from "@/lib/supabase";
import { hashSecret, sendTrackingOtp, verifyTrackingOtp } from "@/lib/otp";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import {
  formatComplaintsReply,
  formatInvoiceSummaryReply,
  formatJourneyReply,
  formatMaskedOrdersReply,
  formatMaskedSingleReply,
  formatOtpSentReply,
  summarizeOrderForTool,
} from "@/lib/assistant/format";
import { normalisePhoneTo94 } from "@/lib/sms/notifylk";
import {
  appendInquirySnippet,
  applySalesTurnFields,
  formatComplaintDraftReply,
  inquiryContextForPrompt,
  isActiveSalesConversation,
  isRichSalesInquiry,
  nextSalesQuestion,
  organizeComplaintText,
  parseSupportState,
  recoverInquiryFromHistory,
  salesDiscoveryFallbackReply,
  salesReplyIgnoresKnownFields,
  type SupportState,
} from "@/lib/assistant/session-state";

export type ChatTurn = {
  role: "user" | "bot";
  text: string;
};

export type PdfDownload = {
  url: string;
  label: string;
};

export type AssistantResult = {
  reply: string;
  waybill: string | null;
  suggestions: string[];
  callerPhone?: string | null;
  sessionToken?: string | null;
  /** Invoice PDF — widget shows a download button (not a raw link). */
  download?: PdfDownload | null;
  /** Client-held draft / inquiry buffer — always return latest. */
  supportState?: SupportState;
};

const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "lookup_orders",
    description:
      "Find active orders by waybill or phone (sender or receiver). Returns masked summaries.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Waybill or phone number",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "request_otp",
    description: "Send SMS OTP to unlock full journey for a waybill.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        waybill: { type: Type.STRING },
        phone: {
          type: Type.STRING,
          description: "Optional caller phone; defaults to party on the order",
        },
      },
      required: ["waybill"],
    },
  },
  {
    name: "verify_otp",
    description: "Verify 6-digit SMS OTP and open a tracking session.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        waybill: { type: Type.STRING },
        phone: { type: Type.STRING },
        code: { type: Type.STRING },
      },
      required: ["waybill", "phone", "code"],
    },
  },
  {
    name: "get_shipment_journey",
    description:
      "Full timeline + next step. Requires verified session for that waybill.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        waybill: { type: Type.STRING },
      },
      required: ["waybill"],
    },
  },
  {
    name: "request_redelivery",
    description:
      "Log re-delivery or follow-up. Allowed even if already on re_delivery.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        waybill: { type: Type.STRING },
      },
      required: ["waybill"],
    },
  },
  {
    name: "request_human_agent",
    description: "Request human agent (verified session required).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        waybill: { type: Type.STRING },
      },
      required: ["waybill"],
    },
  },
  {
    name: "propose_complaint",
    description:
      "Organize a complaint DRAFT for user approval. NEVER saves to DB. Use when user describes a service issue (even without saying complaint). Show organized text; user must say yes later.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        organized_text: {
          type: Type.STRING,
          description:
            "Short structured complaint: Type, Waybill, Customer report, Theme, Requested action",
        },
        raw_text: { type: Type.STRING },
        waybill: { type: Type.STRING },
      },
      required: ["organized_text"],
    },
  },
  {
    name: "get_complaints",
    description:
      "List complaint status / history for the verified caller (and optional waybill). Use for status, check, my complaints — NOT to create.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        waybill: { type: Type.STRING },
      },
      required: [],
    },
  },
  {
    name: "buffer_inquiry",
    description:
      "Quietly store/update a sales inquiry in the chat session (NOT DB). Call every turn while gathering export/business details. Pass structured fields when known. Do NOT rely on this tool's text — you write the next question yourself after the tool returns.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        note: {
          type: Type.STRING,
          description: "Short note from this user turn",
        },
        priority: { type: Type.STRING },
        topic: { type: Type.STRING },
        contact_phone: { type: Type.STRING },
        product: { type: Type.STRING },
        destination: { type: Type.STRING },
        min_packs: { type: Type.STRING },
        max_packs: { type: Type.STRING },
        weight_or_size: { type: Type.STRING },
        frequency: { type: Type.STRING },
      },
      required: ["note"],
    },
  },
  {
    name: "get_invoices",
    description:
      "Pending/paid invoice summary for the verified account phone.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone: { type: Type.STRING },
      },
      required: [],
    },
  },
];

function getGemini(): GoogleGenAI | null {
  const apiKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  ).trim();
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function toGeminiContents(
  history: ChatTurn[],
  inquiryActive: boolean
): Content[] {
  const limit = inquiryActive ? 12 : 6;
  return history.slice(-limit).map((turn) => ({
    role: turn.role === "user" ? "user" : "model",
    parts: [{ text: turn.text }],
  }));
}

function suggestionsFor(
  waybill: string | null,
  verified: boolean,
  reply: string,
  inquiryActive?: boolean,
  inquiryReady?: boolean
): string[] {
  if (inquiryActive) return inquiryReady ? ["done", "help"] : ["help"];
  if (waybill && !verified && /otp/i.test(reply)) return ["OTP", "help"];
  if (waybill && verified) return ["1", "2", "help"];
  if (waybill) return ["OTP", "help"];
  return ["help"];
}

function inquiryLooksReady(state: SupportState): boolean {
  const buf = state.inquiryBuffer;
  if (!buf) return false;
  const f = buf.fields || {};
  return Boolean(
    f.product &&
      f.destination &&
      (f.min_packs || f.max_packs) &&
      buf.contactPhone
  );
}

type ToolState = {
  activeWaybill: string | null;
  callerPhone: string | null;
  sessionToken: string | null;
  verified: boolean;
  supportState: SupportState;
};

async function runTool(
  name: string,
  args: Record<string, unknown>,
  state: ToolState
): Promise<{ result: string; state: ToolState; replyOverride?: string }> {
  const waybillArg =
    typeof args.waybill === "string" ? args.waybill.trim() : "";
  const waybill = (waybillArg || state.activeWaybill || "").trim();

  if (name === "lookup_orders" || name === "lookup_shipment") {
    const query = (
      typeof args.query === "string" ? args.query : waybillArg
    ).trim();
    if (!query) {
      return {
        result: JSON.stringify({ found: false, error: "Need query" }),
        state,
      };
    }
    const match = await lookupShipments(query);
    if (!match?.orders.length) {
      return {
        result: JSON.stringify({ found: false, query }),
        state: { ...state, activeWaybill: null },
      };
    }
    const next = { ...state };
    if (/^\+?\d/.test(query) || query.replace(/\D/g, "").length >= 9) {
      // keep caller phone for OTP
      const digits = query.replace(/\D/g, "");
      if (digits) next.callerPhone = query;
    }
    if (match.orders.length === 1) {
      next.activeWaybill = match.orders[0].waybill;
      return {
        result: JSON.stringify({
          found: true,
          count: 1,
          order: summarizeOrderForTool(match.orders[0], false),
        }),
        state: next,
        replyOverride: formatMaskedSingleReply(match.orders[0]),
      };
    }
    next.activeWaybill = null;
    return {
      result: JSON.stringify({
        found: true,
        count: match.orders.length,
        orders: match.orders.map((o) => summarizeOrderForTool(o, false)),
      }),
      state: next,
      replyOverride: formatMaskedOrdersReply(match.orders, query),
    };
  }

  if (name === "request_otp") {
    if (!waybill) {
      return {
        result: JSON.stringify({ ok: false, error: "Need waybill" }),
        state,
      };
    }
    const order = await findOrderByWaybill(waybill);
    if (!order) {
      return {
        result: JSON.stringify({ ok: false, error: "Not found" }),
        state,
      };
    }
    const phone =
      (typeof args.phone === "string" && args.phone) ||
      partyPhoneForOtp(order, state.callerPhone);
    const sent = await sendTrackingOtp({ phone, waybill: order.waybill });
    if (!sent.ok) {
      return {
        result: JSON.stringify({ ok: false, error: sent.error }),
        state: { ...state, activeWaybill: order.waybill, callerPhone: phone },
      };
    }
    return {
      result: JSON.stringify({
        ok: true,
        masked_phone: sent.maskedPhone,
        waybill: order.waybill,
      }),
      state: { ...state, activeWaybill: order.waybill, callerPhone: phone },
      replyOverride: formatOtpSentReply(sent.maskedPhone, order.waybill),
    };
  }

  if (name === "verify_otp") {
    const code = typeof args.code === "string" ? args.code.trim() : "";
    const phone =
      (typeof args.phone === "string" && args.phone) || state.callerPhone || "";
    if (!waybill || !phone || !code) {
      return {
        result: JSON.stringify({ ok: false, error: "Need waybill, phone, code" }),
        state,
      };
    }
    const verified = await verifyTrackingOtp({ phone, waybill, code });
    if (!verified.ok) {
      return {
        result: JSON.stringify({ ok: false, error: verified.error }),
        state,
      };
    }
    const journey = await getOrderJourney(verified.waybill);
    const next: ToolState = {
      activeWaybill: verified.waybill,
      callerPhone: verified.phoneE164,
      sessionToken: verified.sessionToken,
      verified: true,
      supportState: state.supportState,
    };
    return {
      result: JSON.stringify({ ok: true, waybill: verified.waybill }),
      state: next,
      replyOverride: journey
        ? formatJourneyReply(journey)
        : "Verified successfully.",
    };
  }

  if (name === "get_shipment_journey") {
    if (!waybill) {
      return {
        result: JSON.stringify({ ok: false, error: "Need waybill" }),
        state,
      };
    }
    if (!state.sessionToken) {
      return {
        result: JSON.stringify({
          ok: false,
          error: "OTP verification required",
        }),
        state,
      };
    }
    const session = await findValidTrackingSession(
      hashSecret(state.sessionToken),
      waybill
    );
    if (!session) {
      return {
        result: JSON.stringify({
          ok: false,
          error: "Session expired — request OTP again",
        }),
        state: { ...state, verified: false },
      };
    }
    const journey = await getOrderJourney(waybill);
    if (!journey) {
      return {
        result: JSON.stringify({ ok: false, error: "Not found" }),
        state,
      };
    }
    return {
      result: JSON.stringify({
        ok: true,
        ...summarizeOrderForTool(journey, true),
        next_hint: journey.nextHint,
        events: journey.events,
      }),
      state: { ...state, activeWaybill: waybill, verified: true },
      replyOverride: formatJourneyReply(journey),
    };
  }

  if (name === "request_redelivery" || name === "request_human_agent") {
    if (!waybill) {
      return {
        result: JSON.stringify({ ok: false, error: "Need waybill" }),
        state,
      };
    }
    if (!state.verified || !state.sessionToken) {
      return {
        result: JSON.stringify({ ok: false, error: "Verify OTP first" }),
        state,
      };
    }
    if (name === "request_redelivery") {
      const result = await requestRedelivery(waybill);
      return {
        result: JSON.stringify({
          ok: true,
          already_scheduled: result.alreadyScheduled,
          waybill,
        }),
        state: { ...state, activeWaybill: waybill },
        replyOverride: result.message,
      };
    }
    await updateOrderAction(waybill, "Requested Human Agent");
    return {
      result: JSON.stringify({ ok: true, waybill, action: "agent" }),
      state: { ...state, activeWaybill: waybill },
      replyOverride: `Got it — an agent will follow up on **${waybill}**.`,
    };
  }

  if (name === "propose_complaint" || name === "file_complaint") {
    const organizedArg =
      typeof args.organized_text === "string" ? args.organized_text.trim() : "";
    const rawArg =
      typeof args.raw_text === "string"
        ? args.raw_text.trim()
        : typeof args.text === "string"
          ? args.text.trim()
          : "";
    const source = organizedArg || rawArg;
    if (!source || source.length < 5) {
      return {
        result: JSON.stringify({
          ok: false,
          error: "Need issue details to draft a complaint",
        }),
        state,
      };
    }
    const organized =
      organizedArg ||
      organizeComplaintText(source, waybill || state.activeWaybill);
    const draft = {
      organized,
      raw: rawArg || source,
      waybill: waybill || state.activeWaybill,
      phase: "draft" as const,
    };
    const next = {
      ...state,
      supportState: { ...state.supportState, complaintDraft: draft },
    };
    return {
      result: JSON.stringify({
        ok: true,
        drafted: true,
        saved: false,
        message: "Draft ready — await user yes/no",
      }),
      state: next,
      replyOverride: formatComplaintDraftReply(draft),
    };
  }

  if (name === "get_complaints") {
    if (!state.verified) {
      return {
        result: JSON.stringify({ ok: false, error: "Verify OTP first" }),
        state,
      };
    }
    try {
      const tickets = await listComplaints({
        phone: state.callerPhone,
        waybill: waybill || state.activeWaybill,
      });
      return {
        result: JSON.stringify({
          ok: true,
          count: tickets.length,
          tickets: tickets.map((t) => ({
            ref: t.id.slice(0, 8),
            status: t.statusLabel,
            waybill: t.waybill,
            text: t.text,
            solution: t.solution,
          })),
        }),
        state,
        replyOverride: formatComplaintsReply(tickets),
      };
    } catch (e) {
      return {
        result: JSON.stringify({
          ok: false,
          error: e instanceof Error ? e.message : "failed",
        }),
        state,
      };
    }
  }

  if (name === "buffer_inquiry") {
    const note = typeof args.note === "string" ? args.note.trim() : "";
    if (!note) {
      return {
        result: JSON.stringify({ ok: false, error: "Need note" }),
        state,
      };
    }
    const priority =
      typeof args.priority === "string" &&
      args.priority.toLowerCase() === "normal"
        ? "normal"
        : "high";
    const topic =
      typeof args.topic === "string" && args.topic.trim()
        ? args.topic.trim()
        : "Business / export sales";
    const phoneArg =
      typeof args.contact_phone === "string" ? args.contact_phone : null;
    if (phoneArg) {
      state = {
        ...state,
        callerPhone: normalisePhoneTo94(phoneArg) || phoneArg,
      };
    }
    const fields: Record<string, string> = {
      ...applySalesTurnFields(state.supportState.inquiryBuffer?.fields, note),
    };
    const map: Array<[string, string]> = [
      ["product", "product"],
      ["destination", "destination"],
      ["min_packs", "min_packs"],
      ["max_packs", "max_packs"],
      ["weight_or_size", "weight_or_size"],
      ["frequency", "frequency"],
    ];
    for (const [argKey, fieldKey] of map) {
      const v = args[argKey];
      if (typeof v === "string" && v.trim()) fields[fieldKey] = v.trim();
    }
    const supportState = {
      ...state.supportState,
      inquiryBuffer: appendInquirySnippet(
        state.supportState.inquiryBuffer,
        note,
        {
          contactPhone: state.callerPhone,
          priority,
          topic,
          fields,
        }
      ),
    };
    const buf = supportState.inquiryBuffer!;
    const missing: string[] = [];
    if (!buf.fields.product) missing.push("product");
    if (!buf.fields.destination) missing.push("destination");
    if (!buf.fields.min_packs && !buf.fields.max_packs) {
      missing.push("min/max packs");
    }
    if (!buf.contactPhone) missing.push("contact mobile");
    return {
      result: JSON.stringify({
        ok: true,
        buffered: true,
        saved: false,
        need_phone: !buf.contactPhone,
        priority,
        known_fields: buf.fields,
        still_missing: missing,
        hint:
          "Write a short WhatsApp-style reply: acknowledge their last answer, ask ONE next missing detail only. No lists. No domestic rates. Do not push 'done' until product+destination+volume+phone are known.",
      }),
      state: { ...state, supportState },
      // No replyOverride — Gemini must continue the discovery conversation
    };
  }

  if (name === "get_invoices") {
    const phone =
      (typeof args.phone === "string" && args.phone) ||
      state.callerPhone ||
      "";
    const phone94 = normalisePhoneTo94(phone);
    if (!phone94 || !state.sessionToken) {
      return {
        result: JSON.stringify({ ok: false, error: "Need verified phone" }),
        state,
      };
    }
    const ok = await findValidSessionForPhone(
      hashSecret(state.sessionToken),
      phone94
    );
    if (!ok) {
      return {
        result: JSON.stringify({ ok: false, error: "Session invalid" }),
        state,
      };
    }
    const summary = await getInvoiceSummaryForPhone(phone94);
    if (!summary) {
      return {
        result: JSON.stringify({ ok: false, error: "No invoices" }),
        state,
      };
    }
    return {
      result: JSON.stringify({
        ok: true,
        pending_total: summary.pendingTotal,
        paid_total: summary.paidTotal,
        pending_count: summary.pendingCount,
        paid_count: summary.paidCount,
      }),
      state,
      replyOverride: formatInvoiceSummaryReply(summary),
    };
  }

  return {
    result: JSON.stringify({ error: `Unknown tool: ${name}` }),
    state,
  };
}

export async function runLlmAssistant(options: {
  history: ChatTurn[];
  currentWaybill: string | null;
  callerPhone?: string | null;
  sessionToken?: string | null;
  supportState?: SupportState | null;
}): Promise<AssistantResult | null> {
  const ai = getGemini();
  if (!ai) return null;

  try {
    return await runGeminiInner(ai, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[assistant/llm] Falling back to rules:", message);
    const wrapped = new Error(message);
    (wrapped as Error & { geminiFailed: true }).geminiFailed = true;
    throw wrapped;
  }
}

async function runGeminiInner(
  ai: GoogleGenAI,
  options: {
    history: ChatTurn[];
    currentWaybill: string | null;
    callerPhone?: string | null;
    sessionToken?: string | null;
    supportState?: SupportState | null;
  }
): Promise<AssistantResult> {
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  let state: ToolState = {
    activeWaybill: options.currentWaybill,
    callerPhone: options.callerPhone ?? null,
    sessionToken: options.sessionToken ?? null,
    verified: false,
    supportState: parseSupportState(options.supportState),
  };

  if (!state.supportState.inquiryBuffer) {
    const recovered = recoverInquiryFromHistory(options.history);
    if (recovered) {
      state = {
        ...state,
        supportState: { ...state.supportState, inquiryBuffer: recovered },
      };
    }
  }

  if (state.sessionToken && state.activeWaybill) {
    const session = await findValidTrackingSession(
      hashSecret(state.sessionToken),
      state.activeWaybill
    );
    state.verified = Boolean(session);
  }

  const lastUserText =
    [...options.history].reverse().find((h) => h.role === "user")?.text || "";
  const salesLead =
    Boolean(state.supportState.inquiryBuffer) ||
    isRichSalesInquiry(lastUserText.toLowerCase()) ||
    isActiveSalesConversation(options.history);

  function ensureInquiryBuffered(userNote: string) {
    if (state.supportState.inquiryBuffer) {
      const fields = applySalesTurnFields(
        state.supportState.inquiryBuffer.fields,
        userNote
      );
      state = {
        ...state,
        supportState: {
          ...state.supportState,
          inquiryBuffer: appendInquirySnippet(
            state.supportState.inquiryBuffer,
            userNote,
            { priority: "high", contactPhone: state.callerPhone, fields }
          ),
        },
      };
      return;
    }
    const fields = applySalesTurnFields(null, userNote);
    state = {
      ...state,
      supportState: {
        ...state.supportState,
        inquiryBuffer: appendInquirySnippet(null, userNote, {
          priority: "high",
          topic: "Business / export sales",
          contactPhone: state.callerPhone,
          fields,
        }),
      },
    };
  }

  const contents = toGeminiContents(options.history, salesLead);

  for (let round = 0; round < 3; round++) {
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: buildSystemPrompt(
          state.activeWaybill,
          state.verified,
          salesLead
            ? inquiryContextForPrompt(state.supportState.inquiryBuffer) +
                "\nTreat this as an active HIGH-priority sales/export discovery."
            : inquiryContextForPrompt(state.supportState.inquiryBuffer)
        ),
        temperature: salesLead ? 0.45 : 0.3,
        maxOutputTokens: salesLead ? 700 : 512,
        tools: [{ functionDeclarations }],
      },
    });

    const functionCalls = response.functionCalls;
    if (functionCalls?.length) {
      const modelContent = response.candidates?.[0]?.content;
      if (modelContent?.parts?.length) {
        contents.push(modelContent);
      } else {
        contents.push({
          role: "model",
          parts: functionCalls.map((fc) => ({
            functionCall: { name: fc.name, args: fc.args ?? {} },
          })),
        });
      }

      const responseParts: Part[] = [];
      let replyOverride: string | undefined;

      for (const call of functionCalls) {
        const name = call.name || "";
        const args = (call.args ?? {}) as Record<string, unknown>;
        const out = await runTool(name, args, state);
        state = out.state;
        if (out.replyOverride) replyOverride = out.replyOverride;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(out.result) as Record<string, unknown>;
        } catch {
          payload = { result: out.result };
        }
        responseParts.push({
          functionResponse: { name, response: payload },
        });
      }

      if (replyOverride) {
        return {
          reply: replyOverride,
          waybill: state.activeWaybill,
          callerPhone: state.callerPhone,
          sessionToken: state.sessionToken,
          supportState: state.supportState,
          suggestions: state.supportState.complaintDraft
            ? ["yes", "no"]
            : suggestionsFor(
                state.activeWaybill,
                state.verified,
                replyOverride,
                Boolean(state.supportState.inquiryBuffer),
                inquiryLooksReady(state.supportState)
              ),
        };
      }

      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    let reply =
      response.text?.trim() ||
      (state.supportState.inquiryBuffer || salesLead
        ? salesDiscoveryFallbackReply(
            options.history.filter((h) => h.role === "user").slice(-1)[0]
              ?.text || "export inquiry",
            state.supportState.inquiryBuffer?.fields
          )
        : "How can I help with your shipment today?");

    // Always keep inquiry session alive for sales chats (even if model skipped the tool)
    if (salesLead || state.supportState.inquiryBuffer) {
      ensureInquiryBuffered(lastUserText);
    }

    // If the model re-asks for something we already captured, advance the script
    if (
      state.supportState.inquiryBuffer &&
      salesReplyIgnoresKnownFields(reply, state.supportState.inquiryBuffer.fields)
    ) {
      reply = nextSalesQuestion(state.supportState.inquiryBuffer);
    }

    return {
      reply,
      waybill: state.activeWaybill,
      callerPhone: state.callerPhone,
      sessionToken: state.sessionToken,
      supportState: state.supportState,
      suggestions: suggestionsFor(
        state.activeWaybill,
        state.verified,
        reply,
        Boolean(state.supportState.inquiryBuffer),
        inquiryLooksReady(state.supportState)
      ),
    };
  }

  return {
    reply: state.supportState.inquiryBuffer
      ? salesDiscoveryFallbackReply("export / business inquiry")
      : "Please send your waybill or contact number.",
    waybill: state.activeWaybill,
    callerPhone: state.callerPhone,
    sessionToken: state.sessionToken,
    supportState: state.supportState,
    suggestions: state.supportState.inquiryBuffer
      ? inquiryLooksReady(state.supportState)
        ? ["yes", "help"]
        : ["help"]
      : ["help"],
  };
}
