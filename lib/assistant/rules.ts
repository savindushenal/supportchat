import {
  fileComplaint,
  findOrderByWaybill,
  findValidSessionForPhone,
  findValidTrackingSession,
  getInvoiceSummaryForPhone,
  getOrderJourney,
  listComplaints,
  looksLikePhone,
  lookupShipments,
  partyPhoneForOtp,
  requestRedelivery,
  saveOrganizedInquiry,
  updateOrderAction,
} from "@/lib/supabase";
import { sendTrackingOtp, verifyTrackingOtp, hashSecret } from "@/lib/otp";
import type { AssistantResult } from "@/lib/assistant/llm";
import {
  formatClosedOnlyReply,
  formatComplaintsReply,
  formatInvoiceSummaryReply,
  formatJourneyReply,
  formatMaskedOrdersReply,
  formatMaskedSingleReply,
  formatOtpSentReply,
  formatPdfReadyReply,
} from "@/lib/assistant/format";
import {
  isInBusinessScope,
  isOffTopic,
  scopeRefusalReply,
} from "@/lib/assistant/scope";
import { normalisePhoneTo94 } from "@/lib/sms/notifylk";
import {
  appendInquirySnippet,
  applySalesTurnFields,
  complaintOtpWaybill,
  formatComplaintDraftReply,
  isApproveIntent,
  isActiveSalesConversation,
  isBusinessInquiry,
  isConversationClosing,
  isInquiryIntent,
  isInquirySubmitIntent,
  isRejectIntent,
  isRichSalesInquiry,
  nextSalesQuestion,
  organizeComplaintText,
  organizeInquirySummary,
  parseSupportState,
  pricingFaqReply,
  recoverComplaintDraftFromHistory,
  recoverInquiryFromHistory,
  salesDiscoveryFallbackReply,
  type SupportState,
} from "@/lib/assistant/session-state";

export type RuleContext = {
  message: string;
  currentWaybill: string | null;
  /** Caller phone used for OTP (from prior lookup). */
  callerPhone?: string | null;
  /** Raw session token from widget (not hashed). */
  sessionToken?: string | null;
  /** Client-held drafts / inquiry buffer. */
  supportState?: SupportState | null;
  /** When true, flush inquiry buffer to DB (e.g. chat closed). */
  flushInquiries?: boolean;
  /** Chat history — used to recover lost complaint drafts. */
  history?: { role: string; text: string }[];
};

/**
 * Deterministic support flows — lookups, OTP, journey, menus.
 */
export async function runRuleAssistant(
  options: RuleContext
): Promise<AssistantResult> {
  const message = options.message.trim();
  let currentWaybill = options.currentWaybill;
  let callerPhone = options.callerPhone?.trim() || null;
  let sessionToken = options.sessionToken?.trim() || null;
  let supportState = parseSupportState(options.supportState);
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();

  // Recover sales inquiry first — needed before yes/done submit
  if (!supportState.inquiryBuffer) {
    const recoveredInquiry = recoverInquiryFromHistory(options.history ?? []);
    if (recoveredInquiry) {
      supportState = { ...supportState, inquiryBuffer: recoveredInquiry };
    }
  }

  const verified = await resolveVerified(
    sessionToken,
    currentWaybill
  );

  const base = (): Pick<
    AssistantResult,
    "waybill" | "callerPhone" | "sessionToken" | "supportState"
  > => ({
    waybill: currentWaybill,
    callerPhone,
    sessionToken,
    supportState,
  });

  // Explicit flush (chat close) or submit sales inquiry (yes / done / ok)
  if (
    options.flushInquiries ||
    (supportState.inquiryBuffer &&
      (isConversationClosing(normalized) || isInquirySubmitIntent(normalized)))
  ) {
    const flushed = await tryFlushInquiry(supportState, callerPhone);
    supportState = flushed.supportState;
    if (flushed.reply || options.flushInquiries) {
      return {
        reply:
          flushed.reply ||
          (supportState.inquiryBuffer
            ? "Please share a **contact mobile number** (with country code, e.g. 9477…) so we can save your inquiry and SMS you."
            : "Thanks for chatting with TransExpress. Have a good day!"),
        ...base(),
        suggestions: ["help"],
      };
    }
    // Submit intent but missing phone — ask, don't treat as complaint
    if (
      supportState.inquiryBuffer &&
      isInquirySubmitIntent(normalized)
    ) {
      return {
        reply:
          "Almost there — please send your **mobile number** (07… or 9477…) so I can submit this to sales and SMS you.",
        ...base(),
        suggestions: ["help"],
      };
    }
  }

  if (!message && !options.flushInquiries) {
    return {
      reply:
        "How can I help with your **TransExpress** shipment? Share a **waybill** or **contact number**, or type **help**.",
      ...base(),
      suggestions: [],
    };
  }

  if (isGreeting(normalized)) {
    return {
      reply:
        "Hi! I'm the **TransExpress support agent**.\n\n" +
        "I help **senders and receivers** track shipments. Full journey details need **SMS OTP**.\n\n" +
        "Send a **waybill** / **phone number**, or type **help**.",
      ...base(),
      suggestions: ["help"],
    };
  }

  if (isHelp(normalized)) {
    return {
      reply:
        "TransExpress support:\n\n" +
        "• **Track** — waybill or phone (sender or receiver)\n" +
        "• **OTP** — unlock journey, invoices, complaints, actions\n" +
        "• **1** — re-delivery / follow-up (even if already scheduled)\n" +
        "• **2** — human agent\n" +
        "• Describe an issue → we draft a complaint → you **approve** before save\n" +
        "• **complaint status** — check tickets\n" +
        "• **pricing** / business quotes · **pending invoices**\n\n" +
        "Care: **+94 112 999 888**",
      ...base(),
      suggestions: currentWaybill ? ["OTP", "help"] : ["help"],
    };
  }

  // Recover draft if client state was lost but history still has it
  if (
    !supportState.complaintDraft &&
    (isApproveIntent(normalized) ||
      isRejectIntent(normalized) ||
      /^\d{6}$/.test(message.trim()) ||
      looksLikePhone(message) ||
      Boolean(normalisePhoneTo94(message)))
  ) {
    const recovered = recoverComplaintDraftFromHistory(options.history ?? []);
    if (recovered) supportState = { ...supportState, complaintDraft: recovered };
  }

  // ---- Complaint draft / approve / phone / OTP (BEFORE scope checks) ----
  if (supportState.complaintDraft) {
    const draft = supportState.complaintDraft;

    if (isRejectIntent(normalized)) {
      supportState = { ...supportState, complaintDraft: null };
      return {
        reply: "Okay — I cancelled that complaint draft. Nothing was saved.",
        ...base(),
        suggestions: ["help"],
      };
    }

    // OTP code while raising complaint
    if (/^\d{6}$/.test(message.trim())) {
      const phone = callerPhone;
      const otpWb = complaintOtpWaybill(draft, currentWaybill);
      if (!phone) {
        supportState = {
          ...supportState,
          complaintDraft: { ...draft, phase: "awaiting_phone" },
        };
        return {
          reply:
            "I still need your **mobile number** before OTP. Send it (07… or 9477…), then the code.",
          ...base(),
          suggestions: ["no"],
        };
      }
      const result = await verifyTrackingOtp({
        phone,
        waybill: otpWb,
        code: message.trim(),
      });
      if (!result.ok) {
        return {
          reply: result.error + "\n\nReply with the 6-digit code again, or **no** to cancel.",
          ...base(),
          suggestions: ["OTP", "no"],
        };
      }
      sessionToken = result.sessionToken;
      callerPhone = result.phoneE164;
      if (draft.waybill) currentWaybill = draft.waybill;
      try {
        const logged = await fileComplaint({
          waybill: draft.waybill || currentWaybill,
          phone: callerPhone,
          text: draft.organized,
        });
        supportState = { ...supportState, complaintDraft: null };
        return {
          reply:
            logged.summary +
            `\n\nRef: \`${logged.id.slice(0, 8)}\`` +
            (logged.smsSent
              ? "\nConfirmation SMS sent."
              : "\n(Could not send SMS — check Notify.lk config.)"),
          ...base(),
          suggestions: ["complaint status", "help"],
        };
      } catch (e) {
        return {
          reply: e instanceof Error ? e.message : "Could not log complaint.",
          ...base(),
          suggestions: ["yes", "no"],
        };
      }
    }

    // Phone while draft pending
    if (looksLikePhone(message) || normalisePhoneTo94(message)) {
      callerPhone = normalisePhoneTo94(message) || message;
      const otpWb = complaintOtpWaybill(draft, currentWaybill);
      const sent = await sendTrackingOtp({ phone: callerPhone, waybill: otpWb });
      if (!sent.ok) {
        supportState = {
          ...supportState,
          complaintDraft: { ...draft, phase: "awaiting_phone" },
        };
        return {
          reply: sent.error,
          ...base(),
          suggestions: ["yes", "no"],
        };
      }
      supportState = {
        ...supportState,
        complaintDraft: { ...draft, phase: "awaiting_otp" },
      };
      return {
        reply:
          `Thanks — mobile **${sent.maskedPhone}** noted.\n\n` +
          `I sent an **OTP** to verify before raising the complaint. Reply with the **6-digit code**.`,
        waybill: draft.waybill || currentWaybill,
        callerPhone,
        sessionToken,
        supportState,
        suggestions: ["no"],
      };
    }

    if (isApproveIntent(normalized)) {
      // Already verified this chat → save immediately
      if (verified && callerPhone) {
        try {
          const logged = await fileComplaint({
            waybill: draft.waybill || currentWaybill,
            phone: callerPhone,
            text: draft.organized,
          });
          supportState = { ...supportState, complaintDraft: null };
          return {
            reply:
              logged.summary +
              `\n\nRef: \`${logged.id.slice(0, 8)}\`` +
              (logged.smsSent
                ? "\nConfirmation SMS sent."
                : "\n(Could not send SMS — check Notify.lk config.)"),
            ...base(),
            suggestions: ["complaint status", "help"],
          };
        } catch (e) {
          return {
            reply: e instanceof Error ? e.message : "Could not log complaint.",
            ...base(),
            suggestions: ["yes", "no", "help"],
          };
        }
      }

      // Have phone but not verified → send OTP
      if (callerPhone) {
        const otpWb = complaintOtpWaybill(draft, currentWaybill);
        const sent = await sendTrackingOtp({
          phone: callerPhone,
          waybill: otpWb,
        });
        if (!sent.ok) {
          return {
            reply: sent.error,
            ...base(),
            suggestions: ["yes", "no"],
          };
        }
        supportState = {
          ...supportState,
          complaintDraft: { ...draft, phase: "awaiting_otp" },
        };
        return {
          reply:
            `Please verify your mobile **${sent.maskedPhone}** before we raise the complaint.\n\n` +
            `I sent an **OTP** — reply with the **6-digit code**.`,
          waybill: draft.waybill || currentWaybill,
          callerPhone,
          sessionToken,
          supportState,
          suggestions: ["no"],
        };
      }

      // Need mobile first
      supportState = {
        ...supportState,
        complaintDraft: { ...draft, phase: "awaiting_phone" },
      };
      return {
        reply:
          "To raise this complaint I need to verify your mobile.\n\n" +
          "Please send your **mobile number** (07… or **9477…**). I'll SMS an OTP, then save the complaint.",
        ...base(),
        suggestions: ["no"],
      };
    }

    // Still waiting
    if (draft.phase === "awaiting_otp") {
      return {
        reply:
          "Waiting for the **6-digit OTP** to verify your mobile and raise the complaint.\n" +
          "Or reply **no** to cancel.",
        ...base(),
        suggestions: ["no"],
      };
    }
    if (draft.phase === "awaiting_phone") {
      return {
        reply:
          "Please send your **mobile number** (07… or 9477…) to continue raising the complaint.\n" +
          "Or reply **no** to cancel.",
        ...base(),
        suggestions: ["no"],
      };
    }
    return {
      reply:
        "Still waiting for your approval on the draft below.\n\n" +
        formatComplaintDraftReply(draft),
      ...base(),
      suggestions: ["yes", "no"],
    };
  }

  // Approve/reject only for complaints — not for sales "yes"
  if (
    !supportState.inquiryBuffer &&
    (isApproveIntent(normalized) || isRejectIntent(normalized))
  ) {
    return {
      reply:
        "There's no complaint draft waiting. Describe your issue and I'll prepare one for your approval.",
      ...base(),
      suggestions: ["help"],
    };
  }

  if (/^(thanks|thank you|ty|bye|cool|great)\b[!?.]*$/.test(normalized)) {
    return {
      reply:
        "You're welcome! Send a **waybill** or **phone number** anytime for shipment help.",
      ...base(),
      suggestions: ["help"],
    };
  }

  if (isOffTopic(message) || isOutOfScopeChat(message, normalized, options.history)) {
    // Never kill an active sales quote chat
    if (
      supportState.inquiryBuffer ||
      isActiveSalesConversation(options.history)
    ) {
      // fall through to inquiry handling below
    } else {
      return {
        reply: scopeRefusalReply(),
        ...base(),
        suggestions: ["help"],
      };
    }
  }

  // Verify OTP code (6 digits) when awaiting verification
  if (/^\d{6}$/.test(message.trim()) && currentWaybill) {
    const phone =
      callerPhone ||
      (await findOrderByWaybill(currentWaybill).then((o) =>
        o ? partyPhoneForOtp(o, callerPhone) : null
      ));
    if (!phone) {
      return {
        reply: "I need the phone linked to this waybill. Send your **contact number** again.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }
    const result = await verifyTrackingOtp({
      phone,
      waybill: currentWaybill,
      code: message.trim(),
    });
    if (!result.ok) {
      return {
        reply: result.error,
        waybill: currentWaybill,
        callerPhone: phone,
        sessionToken,
        suggestions: ["OTP", "help"],
      };
    }
    sessionToken = result.sessionToken;
    callerPhone = result.phoneE164;
    const journey = await getOrderJourney(result.waybill);
    return {
      reply: journey
        ? formatJourneyReply(journey)
        : "Verified — but journey data was not found.",
      waybill: result.waybill,
      callerPhone,
      sessionToken,
      suggestions: ["1", "2", "help"],
    };
  }

  // Request OTP
  if (
    /^(otp|send\s*otp|verify|resend(\s*otp)?|code)$/i.test(normalized) ||
    /\b(send|resend)\s*(me\s*)?(an?\s*)?(otp|code)\b/i.test(normalized)
  ) {
    if (!currentWaybill) {
      return {
        reply: "Pick a **waybill** first, then reply **OTP**.",
        waybill: null,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }
    const order = await findOrderByWaybill(currentWaybill);
    if (!order) {
      return {
        reply: `Waybill **${currentWaybill}** not found.`,
        waybill: null,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }
    const phone = partyPhoneForOtp(order, callerPhone);
    const sent = await sendTrackingOtp({ phone, waybill: order.waybill });
    if (!sent.ok) {
      return {
        reply: sent.error,
        waybill: order.waybill,
        callerPhone: phone,
        sessionToken,
        suggestions: ["OTP", "help"],
      };
    }
    return {
      reply: formatOtpSentReply(sent.maskedPhone, order.waybill),
      waybill: order.waybill,
      callerPhone: phone,
      sessionToken,
      suggestions: ["help"],
    };
  }

  // Sales / quote discovery BEFORE re-delivery shortcuts ("1"/"2")
  // so answers like "1" (= one-time) never hit "Share or pick a waybill".
  if (
    supportState.inquiryBuffer &&
    (looksLikePhone(message) || normalisePhoneTo94(message))
  ) {
    callerPhone = normalisePhoneTo94(message) || message;
    const phoneBuf = {
      ...supportState.inquiryBuffer!,
      contactPhone: callerPhone,
    };
    supportState = {
      ...supportState,
      inquiryBuffer: phoneBuf,
    };
    const ready =
      Boolean(phoneBuf.fields?.product) &&
      Boolean(phoneBuf.fields?.destination) &&
      Boolean(phoneBuf.fields?.min_packs || phoneBuf.fields?.max_packs);
    return {
      reply:
        `Perfect, thanks — I'll use **${callerPhone}**.\n\n` +
        nextSalesQuestion(phoneBuf),
      ...base(),
      suggestions: ready ? ["yes", "help"] : ["help"],
    };
  }

  if (
    supportState.inquiryBuffer &&
    !isConversationClosing(normalized) &&
    !isInquirySubmitIntent(normalized)
  ) {
    const fields = applySalesTurnFields(
      supportState.inquiryBuffer.fields,
      message
    );

    const midBuf = appendInquirySnippet(
      supportState.inquiryBuffer,
      message,
      { contactPhone: callerPhone, priority: "high", fields }
    );
    supportState = {
      ...supportState,
      inquiryBuffer: midBuf,
    };
    return {
      reply: nextSalesQuestion(midBuf),
      ...base(),
      suggestions:
        fields.product &&
        fields.destination &&
        (fields.min_packs || fields.max_packs) &&
        midBuf.contactPhone
          ? ["yes", "help"]
          : ["help"],
    };
  }

  if (isRichSalesInquiry(normalized) || isBusinessInquiry(normalized)) {
    const fields = applySalesTurnFields(null, message);

    supportState = {
      ...supportState,
      inquiryBuffer: appendInquirySnippet(
        supportState.inquiryBuffer,
        message,
        {
          contactPhone: callerPhone,
          priority: "high",
          topic: "Business / export sales",
          fields,
        }
      ),
    };
    return {
      reply: salesDiscoveryFallbackReply(message, fields),
      ...base(),
      suggestions: ["help"],
    };
  }

  // Actions require verified session (not during sales discovery)
  if (isRedelivery(normalized) || isHumanAgent(normalized)) {
    if (!currentWaybill) {
      return {
        reply: "Share or pick a **waybill** first.",
        waybill: null,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }
    if (!verified) {
      return {
        reply:
          "Please **verify with OTP** first (reply **OTP**), then I can log re-delivery or connect an agent.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["OTP", "help"],
      };
    }
    if (isRedelivery(normalized)) {
      const result = await requestRedelivery(currentWaybill);
      return {
        reply: result.message,
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["help", "2"],
      };
    }
    await updateOrderAction(currentWaybill, "Requested Human Agent");
    return {
      reply:
        `Got it — an agent will follow up on **${currentWaybill}**.\n` +
        `Care: **+94 112 999 888**`,
      waybill: currentWaybill,
      callerPhone,
      sessionToken,
      suggestions: ["help"],
    };
  }

  // Complaint status (check first — never treat as a new complaint)
  if (isComplaintStatusIntent(normalized)) {
    if (!verified) {
      return {
        reply:
          "To check complaint status, please **verify with OTP** first (pick a waybill → **OTP**).",
        ...base(),
        suggestions: currentWaybill ? ["OTP", "help"] : ["help"],
      };
    }
    try {
      const tickets = await listComplaints({
        phone: callerPhone,
        waybill: currentWaybill,
      });
      return {
        reply: formatComplaintsReply(tickets),
        ...base(),
        suggestions: ["complaint status", "help"],
      };
    } catch (e) {
      return {
        reply:
          e instanceof Error ? e.message : "Could not load complaint status.",
        ...base(),
        suggestions: ["help"],
      };
    }
  }

  // New complaint → organize draft + ask approval (do NOT save yet)
  const complaintBody = extractNewComplaint(message, normalized);
  if (complaintBody) {
    const organized = organizeComplaintText(complaintBody, currentWaybill);
    supportState = {
      ...supportState,
      complaintDraft: {
        organized,
        raw: complaintBody,
        waybill: currentWaybill,
        phase: "draft",
      },
    };
    return {
      reply: formatComplaintDraftReply(supportState.complaintDraft!),
      ...base(),
      suggestions: ["yes", "no"],
    };
  }

  // Ambiguous complaint wording — Gemini first; if we reach here, clarify
  if (isAmbiguousComplaintTalk(normalized)) {
    return {
      reply:
        "I hear there may be a problem. Please describe what happened (or reply **complaint status** to check existing tickets).\n\n" +
        "I'll prepare a draft for your approval before anything is saved.",
      ...base(),
      suggestions: ["complaint status", "help"],
    };
  }

  // Short domestic pricing FAQ only (rich sales → Gemini)
  const pricing = pricingFaqReply(normalized);
  if (pricing) {
    return {
      reply: pricing,
      ...base(),
      suggestions: ["help"],
    };
  }

  // Invoices / PDF
  if (isInvoiceIntent(normalized)) {
    if (!callerPhone) {
      return {
        reply:
          "Send your **account / sender phone number** first so I can load invoices.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }
    const phone94 = normalisePhoneTo94(callerPhone);
    if (!phone94 || !sessionToken) {
      return {
        reply:
          "Invoice details need **OTP verification**. Track a waybill, reply **OTP**, then ask again.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: currentWaybill ? ["OTP", "help"] : ["help"],
      };
    }
    const phoneOk = await findValidSessionForPhone(
      hashSecret(sessionToken),
      phone94
    );
    if (!phoneOk) {
      return {
        reply:
          "Your session expired. Reply **OTP** on a waybill for this account, then ask for invoices again.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken: null,
        suggestions: ["OTP", "help"],
      };
    }

    const wantPdf = /\bpdf\b/i.test(normalized);
    const filter: "pending" | "paid" | "all" = /\bpaid\b/i.test(normalized)
      ? "paid"
      : /\bpending\b/i.test(normalized)
        ? "pending"
        : "all";

    const summary = await getInvoiceSummaryForPhone(phone94);
    if (!summary) {
      return {
        reply: "No invoices found for this phone.",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }

    if (wantPdf) {
      const url = `/api/invoices/pdf?phone=${encodeURIComponent(phone94)}&status=${filter}&token=${encodeURIComponent(sessionToken)}`;
      const label =
        filter === "pending"
          ? "Download pending PDF"
          : filter === "paid"
            ? "Download paid PDF"
            : "Download PDF";
      return {
        reply:
          formatInvoiceSummaryReply(summary) +
          "\n\n" +
          formatPdfReadyReply(filter),
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["pending pdf", "paid pdf", "help"],
        download: { url, label },
      };
    }

    if (/\btotal\s*paid\b/i.test(normalized)) {
      return {
        reply: `**Total paid** for **${summary.clientName}**: **LKR ${summary.paidTotal.toLocaleString("en-LK", { minimumFractionDigits: 2 })}** (${summary.paidCount} invoices).`,
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["pending invoices", "paid pdf", "help"],
      };
    }

    return {
      reply: formatInvoiceSummaryReply(summary),
      waybill: currentWaybill,
      callerPhone,
      sessionToken,
      suggestions: ["pending pdf", "paid pdf", "help"],
    };
  }

  // Ask for journey details while verified
  if (
    verified &&
    currentWaybill &&
    /\b(where|next|journey|timeline|detail|status|warehouse|dispatch)\b/i.test(
      normalized
    )
  ) {
    const journey = await getOrderJourney(currentWaybill);
    if (journey) {
      return {
        reply: formatJourneyReply(journey),
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["1", "2", "help"],
      };
    }
  }

  const lookupQuery = extractLookupQuery(message);
  if (!lookupQuery) {
    if (isInBusinessScope(message)) {
      return {
        reply:
          "Happy to help. Please send your **waybill** or **contact number** (sender or receiver).",
        waybill: currentWaybill,
        callerPhone,
        sessionToken,
        suggestions: ["help"],
      };
    }
    return {
      reply: scopeRefusalReply(),
      waybill: currentWaybill,
      callerPhone,
      sessionToken,
      suggestions: ["help"],
    };
  }

  return replyFromLookup(lookupQuery, {
    currentWaybill,
    callerPhone,
    sessionToken,
    verified,
  });
}

async function resolveVerified(
  sessionToken: string | null,
  waybill: string | null
): Promise<boolean> {
  if (!sessionToken) return false;
  const row = await findValidTrackingSession(
    hashSecret(sessionToken),
    waybill
  );
  return Boolean(row);
}

async function replyFromLookup(
  lookupQuery: string,
  ctx: {
    currentWaybill: string | null;
    callerPhone: string | null;
    sessionToken: string | null;
    verified: boolean;
  }
): Promise<AssistantResult> {
  const result = await lookupShipments(lookupQuery);
  if (!result) {
    const label = looksLikePhone(lookupQuery)
      ? `contact number **${lookupQuery}**`
      : `waybill **${lookupQuery}**`;
    return {
      reply:
        `I couldn't find a shipment for ${label}.\n\n` +
        "Customer Care: **+94 112 999 888**",
      waybill: null,
      callerPhone: ctx.callerPhone,
      sessionToken: ctx.sessionToken,
      suggestions: ["help"],
    };
  }

  if (looksLikePhone(lookupQuery) || normalisePhoneTo94(lookupQuery)) {
    ctx.callerPhone = normalisePhoneTo94(lookupQuery) || ctx.callerPhone;
  }

  if (result.onlyClosed && result.orders[0]) {
    return {
      reply: formatClosedOnlyReply(result.orders[0], lookupQuery),
      waybill: null,
      callerPhone: ctx.callerPhone,
      sessionToken: ctx.sessionToken,
      suggestions: ["help"],
    };
  }

  if (result.matchedBy === "phone" && result.orders.length > 1) {
    return {
      reply: formatMaskedOrdersReply(result.orders, lookupQuery),
      waybill: null,
      callerPhone: ctx.callerPhone,
      sessionToken: ctx.sessionToken,
      suggestions: result.orders.slice(0, 3).map((o) => o.waybill),
    };
  }

  const order = result.orders[0];
  if (!order) {
    return {
      reply: "No shipment found.",
      waybill: ctx.currentWaybill,
      callerPhone: ctx.callerPhone,
      sessionToken: ctx.sessionToken,
      suggestions: ["help"],
    };
  }

  // Already verified for this waybill → full journey
  if (ctx.verified && ctx.currentWaybill?.toUpperCase() === order.waybill.toUpperCase()) {
    const journey = await getOrderJourney(order.waybill);
    if (journey) {
      return {
        reply: formatJourneyReply(journey),
        waybill: order.waybill,
        callerPhone: ctx.callerPhone,
        sessionToken: ctx.sessionToken,
        suggestions: ["1", "2", "help"],
      };
    }
  }

  return {
    reply: formatMaskedSingleReply(order),
    waybill: order.waybill,
    callerPhone: ctx.callerPhone,
    sessionToken: ctx.sessionToken,
    suggestions: ["OTP", "help"],
  };
}

function isOutOfScopeChat(
  message: string,
  normalized: string,
  history?: { role: string; text: string }[] | null
): boolean {
  if (extractLookupQuery(message)) return false;
  if (isRedelivery(normalized) || isHumanAgent(normalized)) return false;
  if (/^(otp|send\s*otp|verify|resend)/i.test(normalized)) return false;
  if (/^\d{6}$/.test(message.trim())) return false;
  if (isApproveIntent(normalized) || isRejectIntent(normalized)) return false;
  if (isInvoiceIntent(normalized)) return false;
  if (isComplaintStatusIntent(normalized)) return false;
  if (extractNewComplaint(message, normalized)) return false;
  if (isAmbiguousComplaintTalk(normalized)) return false;
  if (pricingFaqReply(normalized)) return false;
  if (isRichSalesInquiry(normalized) || isBusinessInquiry(normalized)) return false;
  if (isInquiryIntent(normalized)) return false;
  // Follow-up answers during an export quote chat (e.g. "50 packages, 20kg")
  if (isActiveSalesConversation(history)) return false;
  if (
    /\b(\d+)\s*(packs?|packages?|cartons?|boxes|kg|kgs)\b/i.test(normalized)
  ) {
    return false;
  }
  if (isInBusinessScope(message)) return false;
  if (/^(ok|okay|thanks|thank you|ty|bye|cool|great)\b/.test(normalized)) {
    return false;
  }
  return true;
}

export function shouldSkipLlm(
  message: string,
  currentWaybill: string | null,
  supportState?: SupportState | null,
  history?: { role: string; text: string }[] | null
): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  let state = parseSupportState(supportState);
  if (!state.inquiryBuffer) {
    const recovered = recoverInquiryFromHistory(history);
    if (recovered) state = { ...state, inquiryBuffer: recovered };
  }

  // Draft / approve / OTP for complaint — always rules
  if (state.complaintDraft) return true;
  // Sales submit (yes/done) while inquiry active — rules flush
  if (
    state.inquiryBuffer &&
    (isInquirySubmitIntent(normalized) || isConversationClosing(normalized))
  ) {
    return true;
  }
  if (
    !state.inquiryBuffer &&
    (isApproveIntent(normalized) || isRejectIntent(normalized))
  ) {
    return true;
  }

  if (!normalized) return true;
  if (isGreeting(normalized) || isHelp(normalized)) return true;

  // Active sales chat must stay with Gemini — never skip for "1"/"2" shortcuts
  if (state.inquiryBuffer || isActiveSalesConversation(history)) {
    if (isConversationClosing(normalized)) return true;
    if (looksLikePhone(message) || normalisePhoneTo94(message)) return true;
    if (isInquirySubmitIntent(normalized)) return true;
    return false;
  }

  if (isOffTopic(message) || isOutOfScopeChat(message, normalized, history)) return true;
  // Bare "1"/"2" only skip LLM when NOT in a sales chat (handled above)
  if (isRedelivery(normalized) || isHumanAgent(normalized)) return true;
  if (/^(otp|send\s*otp|verify|resend)/i.test(normalized)) return true;
  if (/^\d{6}$/.test(message.trim())) return true;
  if (isInvoiceIntent(normalized)) return true;
  if (isComplaintStatusIntent(normalized)) return true;
  if (extractNewComplaint(message, normalized)) return true;
  // Simple domestic FAQ only — rich sales uses Gemini
  if (pricingFaqReply(normalized)) return true;
  // Business/export discovery → Gemini
  if (isRichSalesInquiry(normalized) || isBusinessInquiry(normalized)) return false;
  if (isInquiryIntent(normalized) && !isRichSalesInquiry(normalized)) return false;
  if (isConversationClosing(normalized)) return true;
  // Ambiguous / natural-language service issues → Gemini proposes draft only
  if (isAmbiguousComplaintTalk(normalized)) return false;
  if (extractLookupQuery(message)) return true;
  if (/^(ok|okay|thanks|thank you|ty|bye|cool|great)\b/.test(normalized)) {
    return true;
  }
  void currentWaybill;
  return false;
}

function isInvoiceIntent(text: string): boolean {
  return /\b(invoice|invoices|pending\s*invoice|total\s*paid|paid\s*invoice|account\s*balance|pdf)\b/i.test(
    text
  );
}

/** View / check existing complaints — never create. */
function isComplaintStatusIntent(text: string): boolean {
  if (
    /\b(complaint|complaints|complain|ticket|tickets)\b/.test(text) &&
    /\b(status|check|track|view|list|show|update|progress|history|open|pending|my)\b/.test(
      text
    )
  ) {
    return true;
  }
  return /^(my\s+)?complaints?\s*$/i.test(text);
}

/**
 * Explicit create only: "complaint: …" or clear issue keywords
 * (not "complaint status"). Does NOT save — only used to build a draft.
 */
function extractNewComplaint(
  message: string,
  normalized: string
): string | null {
  if (isComplaintStatusIntent(normalized)) return null;

  const prefixed = message.match(
    /^(?:file\s+|lodge\s+|raise\s+|make\s+|new\s+)?complaint\s*[:\-]\s*(.+)$/i
  );
  if (prefixed?.[1]?.trim()) return prefixed[1].trim();

  if (
    /\b(damaged|missing\s*item|wrong\s*item|rude\s*rider|broken\s*parcel)\b/i.test(
      normalized
    )
  ) {
    return message.trim();
  }

  // Service issues often phrased without the word "complaint"
  if (
    /\b(no\s*(answer|answered|response)|never\s*call|didn'?t\s*call|no\s*call|only\s*call|delivery\s*person|rider\s*(didn'?t|never|no))\b/i.test(
      normalized
    ) &&
    /\b(order|status|receiver|delivery|rider|said|got|from)\b/i.test(normalized)
  ) {
    return message.trim();
  }

  const fileWithDetail = message.match(
    /\b(?:file|lodge|raise|make|submit)\s+(?:a\s+)?complaint\s+(?:about|for|regarding|:)\s+(.+)/i
  );
  if (fileWithDetail?.[1]?.trim() && fileWithDetail[1].trim().length >= 5) {
    return fileWithDetail[1].trim();
  }

  return null;
}

async function tryFlushInquiry(
  supportState: SupportState,
  callerPhone: string | null
): Promise<{ supportState: SupportState; reply: string | null }> {
  const buf = supportState.inquiryBuffer;
  if (!buf?.snippets.length) {
    return { supportState, reply: null };
  }
  const phone = buf.contactPhone || callerPhone;
  if (!phone || !normalisePhoneTo94(phone)) {
    return {
      supportState: {
        ...supportState,
        inquiryBuffer: { ...buf, contactPhone: phone },
      },
      reply: null,
    };
  }
  try {
    const organized = organizeInquirySummary({
      ...buf,
      contactPhone: normalisePhoneTo94(phone) || phone,
    });
    const saved = await saveOrganizedInquiry({
      phone,
      organized,
      priority: buf.priority,
    });
    return {
      supportState: { ...supportState, inquiryBuffer: null },
      reply:
        `Thank you. ${saved.summary}\n\n` +
        "Our team will review the organized notes and follow up.",
    };
  } catch (e) {
    return {
      supportState,
      reply: e instanceof Error ? e.message : "Could not save inquiry.",
    };
  }
}

/** Soft complaint wording — Gemini decides status vs file (saves wrong creates). */
function isAmbiguousComplaintTalk(text: string): boolean {
  if (isComplaintStatusIntent(text)) return false;
  if (extractNewComplaint(text, text)) return false;
  return /\b(complaint|complain|complaints)\b/i.test(text);
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|good\s*(morning|afternoon|evening)|ayo|hola)\b[!?.]*$/.test(
    text
  );
}

function isHelp(text: string): boolean {
  return /^(help|menu|options|start|what can you do)\b/.test(text);
}

function isRedelivery(text: string): boolean {
  return (
    text === "1" ||
    /\b(re[\s-]?deliver(y|ies)?|reschedule|deliver\s*again)\b/.test(text)
  );
}

function isHumanAgent(text: string): boolean {
  return (
    text === "2" ||
    /\b(agent|human|operator|customer\s*care|speak\s*to\s*(someone|a\s*person)|call\s*me)\b/.test(
      text
    )
  );
}

export function extractLookupQuery(message: string): string | null {
  const cleaned = message.trim();

  const phoneMatch = cleaned.match(
    /(?:\+?94[\s-]?)?(0?7\d{8}|0?1\d{8})\b/
  );
  if (phoneMatch?.[0]) {
    return phoneMatch[0].replace(/[\s-]/g, "");
  }

  const patterns = [/\b([A-Z]{1,3}\d{5,})\b/i, /\b(\d{7,})\b/];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return /[A-Za-z]/.test(match[1]) ? match[1].toUpperCase() : match[1];
    }
  }

  const token = cleaned.split(/\s+/).find((t) => {
    const tClean = t.replace(/[^A-Za-z0-9+]/g, "");
    return (
      tClean.length >= 6 &&
      /[0-9]/.test(tClean) &&
      !/^(help|track|status|please|thanks|thankyou)$/i.test(tClean)
    );
  });

  if (!token) return null;
  const stripped = token.replace(/[^A-Za-z0-9+]/g, "");
  return /[A-Za-z]/.test(stripped) ? stripped.toUpperCase() : stripped;
}
