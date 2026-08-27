/**
 * Client-held chat support state (widget ↔ API).
 * Complaints stay as drafts until approved; inquiries buffer then flush once.
 */

export type ComplaintDraft = {
  organized: string;
  raw: string;
  waybill: string | null;
  /** draft = show approve · awaiting_phone · awaiting_otp */
  phase?: "draft" | "awaiting_phone" | "awaiting_otp";
};

export type InquiryBuffer = {
  snippets: string[];
  contactPhone: string | null;
  /** high = business / sales follow-up */
  priority: "high" | "normal";
  topic: string | null;
  /** Structured fields collected during sales discovery */
  fields: Record<string, string>;
};

export type SupportState = {
  complaintDraft: ComplaintDraft | null;
  inquiryBuffer: InquiryBuffer | null;
};

export function emptySupportState(): SupportState {
  return { complaintDraft: null, inquiryBuffer: null };
}

export function parseSupportState(raw: unknown): SupportState {
  if (!raw || typeof raw !== "object") return emptySupportState();
  const o = raw as Record<string, unknown>;
  const draft = o.complaintDraft;
  let complaintDraft: ComplaintDraft | null = null;
  if (draft && typeof draft === "object") {
    const d = draft as Record<string, unknown>;
    if (typeof d.organized === "string" && d.organized.trim()) {
      const phase =
        d.phase === "awaiting_phone" || d.phase === "awaiting_otp"
          ? d.phase
          : "draft";
      complaintDraft = {
        organized: d.organized.trim(),
        raw: typeof d.raw === "string" ? d.raw : d.organized.trim(),
        waybill: typeof d.waybill === "string" ? d.waybill : null,
        phase,
      };
    }
  }

  const buf = o.inquiryBuffer;
  let inquiryBuffer: InquiryBuffer | null = null;
  if (buf && typeof buf === "object") {
    const b = buf as Record<string, unknown>;
    const snippets = Array.isArray(b.snippets)
      ? b.snippets.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const fields: Record<string, string> = {};
    if (b.fields && typeof b.fields === "object" && !Array.isArray(b.fields)) {
      for (const [k, v] of Object.entries(b.fields as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) fields[k] = v.trim();
      }
    }
    if (snippets.length || Object.keys(fields).length) {
      inquiryBuffer = {
        snippets: snippets.slice(-20),
        contactPhone:
          typeof b.contactPhone === "string" ? b.contactPhone : null,
        priority: b.priority === "high" ? "high" : "normal",
        topic: typeof b.topic === "string" ? b.topic : null,
        fields,
      };
    }
  }

  return { complaintDraft, inquiryBuffer };
}

/** Recover draft from the last bot “raise this complaint” message (if client state was lost). */
export function recoverComplaintDraftFromHistory(
  history: { role: string; text: string }[]
): ComplaintDraft | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn || turn.role !== "bot") continue;
    if (!/raise this complaint/i.test(turn.text)) continue;
    const fenced = turn.text.match(/```\n?([\s\S]*?)```/);
    const organized = fenced?.[1]?.trim();
    if (!organized || organized.length < 10) continue;
    const wb = organized.match(/Waybill:\s*([A-Z0-9]+)/i);
    const waybill =
      wb?.[1] && !/not\s*specified/i.test(wb[1]) ? wb[1].toUpperCase() : null;
    return { organized, raw: organized, waybill, phase: "draft" };
  }
  return null;
}

/** Turn free-text issue into a short structured complaint for approval. */
export function organizeComplaintText(
  raw: string,
  waybill: string | null
): string {
  const cleaned = raw
    .replace(/^(complaint|complain)\s*[:\-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const lines = [
    "Type: Service / delivery complaint",
    waybill ? `Waybill: ${waybill}` : "Waybill: (not specified)",
    `Customer report: ${cleaned}`,
  ];

  // Light structuring for common patterns
  if (/\bno\s*(answer|answered|response|call)\b/i.test(cleaned)) {
    lines.push("Theme: No contact / missed call from delivery");
  } else if (/\bdamag/i.test(cleaned)) {
    lines.push("Theme: Damaged parcel");
  } else if (/\bdelay|late\b/i.test(cleaned)) {
    lines.push("Theme: Delay");
  } else if (/\brude|behav/i.test(cleaned)) {
    lines.push("Theme: Rider behaviour");
  }

  lines.push("Requested action: Investigate and follow up with customer");
  return lines.join("\n");
}

export function formatComplaintDraftReply(draft: ComplaintDraft): string {
  return (
    "I'm sorry you had this experience — we'll help sort it out.\n\n" +
    "Here is the complaint I prepared for our care team:\n\n" +
    "```\n" +
    draft.organized +
    "\n```\n\n" +
    "Is it okay to **raise this complaint**?\n" +
    "Reply **yes** to submit, or **no** to cancel."
  );
}

export function complaintOtpWaybill(draft: ComplaintDraft, current: string | null): string {
  return (draft.waybill || current || "COMPLAINT").toUpperCase();
}

export function isApproveIntent(text: string): boolean {
  return /^(yes|y|ok|okay|approve|confirm|sure|go\s*ahead|raise\s*it|submit|do\s*it)[!?.]*$/i.test(
    text.trim()
  );
}

export function isRejectIntent(text: string): boolean {
  return /^(no|n|cancel|don't|dont|stop|never\s*mind|nevermind)[!?.]*$/i.test(
    text.trim()
  );
}

export function isConversationClosing(text: string): boolean {
  return /^(bye|goodbye|thanks|thank\s*you|ty|that's\s*all|thats\s*all|done|ok\s*thanks|nothing\s*else)\b/i.test(
    text.trim()
  );
}

/** Submit sales inquiry — yes/done/ok while an inquiry is in progress. */
export function isInquirySubmitIntent(text: string): boolean {
  return /^(done|yes|y|ok|okay|submit|confirm|sure|go\s*ahead|ready|send\s*it|please\s*submit)[!?.]*$/i.test(
    text.trim()
  );
}

/** Short domestic rate FAQ only — NOT for export/business discovery. */
export function pricingFaqReply(normalized: string): string | null {
  if (isRichSalesInquiry(normalized)) return null;
  if (
    !/\b(price|pricing|rate|rates|cost|charge|charges|how\s*much|fee|fees)\b/i.test(
      normalized
    )
  ) {
    return null;
  }
  // Only for short local-looking asks
  if (normalized.split(/\s+/).length > 14) return null;
  return (
    "**TransExpress — indicative domestic rates** (approx., LKR):\n\n" +
    "• Colombo metro door-to-door: from **~Rs. 250–450** (weight/size based)\n" +
    "• Outstation: from **~Rs. 350+** depending on destination\n" +
    "• COD available on eligible consignments\n\n" +
    "For **export / bulk / business** quotes I can take a few details and pass a proper inquiry to sales.\n\n" +
    "Care: **+94 112 999 888**"
  );
}

/** Export, bulk, corporate, international — needs multi-turn Gemini discovery. */
export function isRichSalesInquiry(normalized: string): boolean {
  return /\b(export|import|international|overseas|australia|aussie|usa|uk|canada|dubai|middle\s*east|europe|singapore|malaysia|bulk|corporate|b2b|business|company|partnership|contract|wholesale|shipment\s*to|ship\s*to|kurundu|cinnamon|tea|spice|cargo|freight|consignment\s*to|best\s*rate|special\s*rate|volume|packs?|packages?|cartons?|pallets?|boxes|\d+\s*kg|kilograms?)\b/i.test(
    normalized
  );
}

/** True if recent chat is clearly a sales/export quote conversation. */
export function isActiveSalesConversation(
  history: { role: string; text: string }[] | undefined | null
): boolean {
  if (!history?.length) return false;
  const recent = history.slice(-8);
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    if (!t?.text) continue;
    const text = t.text.toLowerCase();
    if (
      /\b(export|australia|cinnamon|kurundu|best\s*quote|competitive\s*export|per\s*shipment|how\s*many\s*(packs?|packages?|cartons?)|how\s*much\s*weight|sales\s*team|quote|packages?\s*do\s*you)\b/i.test(
        text
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Rebuild a minimal inquiry buffer from chat history when client state was lost.
 */
export function recoverInquiryFromHistory(
  history: { role: string; text: string }[] | undefined | null
): InquiryBuffer | null {
  if (!isActiveSalesConversation(history)) return null;
  const snippets: string[] = [];
  const fields: Record<string, string> = {};
  for (const turn of history || []) {
    if (turn.role !== "user" || !turn.text?.trim()) continue;
    const text = turn.text.trim();
    snippets.push(text);
    const n = text.toLowerCase();
    const productMatch = n.match(
      /\b(kurundu|cinnamon|tea|spice|spices|garment|apparel|coconut|rubber)\b/i
    );
    const destMatch = n.match(
      /\b(australia|aussie|usa|uk|canada|dubai|singapore|malaysia|europe)\b/i
    );
    const packsRange = n.match(
      /(\d+)\s*(?:to|-|–)\s*(\d+)\s*(packs?|packages?|cartons?|boxes)?/i
    );
    const packsSingle = n.match(
      /\b(?:about|around|approx(?:imately)?)?\s*(\d+)\s*(packs?|packages?|cartons?|boxes)\b/i
    );
    const weight = n.match(/\b(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?)\b/i);
    if (productMatch) fields.product = productMatch[1];
    if (destMatch) fields.destination = destMatch[1];
    if (packsRange) {
      fields.min_packs = packsRange[1];
      fields.max_packs = packsRange[2];
    } else if (packsSingle) {
      fields.min_packs = packsSingle[1];
      fields.max_packs = packsSingle[1];
    }
    if (weight) fields.weight_or_size = `${weight[1]} ${weight[2]}`;
  }
  if (!snippets.length) return null;

  let contactPhone: string | null = null;
  for (const turn of history || []) {
    if (turn.role !== "user" || !turn.text?.trim()) continue;
    const digits = turn.text.replace(/\D/g, "");
    let phone = digits;
    if (phone.startsWith("0") && phone.length >= 10) {
      phone = "94" + phone.slice(1);
    }
    if (!phone.startsWith("94") && phone.length === 9) {
      phone = "94" + phone;
    }
    if (/^94\d{9}$/.test(phone)) {
      contactPhone = phone;
    }
  }

  return {
    snippets: snippets.slice(-20),
    contactPhone,
    priority: "high",
    topic: "Business / export sales",
    fields,
  };
}

export function isBusinessInquiry(normalized: string): boolean {
  return (
    isRichSalesInquiry(normalized) ||
    /\b(business|corporate|bulk|b2b|contract|partnership|sales|account|monthly|volume|warehouse\s*account|enterprise|company\s*rates|fleet)\b/i.test(
      normalized
    )
  );
}

export function isInquiryIntent(normalized: string): boolean {
  if (isBusinessInquiry(normalized)) return true;
  return /\b(inquir(y|ies)|enquire|enquiry|quote|quotation|partnership|sales|how\s*(do|can)\s*i\s*(send|ship)|open\s*an?\s*account)\b/i.test(
    normalized
  );
}

/**
 * Warm one-question opener / fallback — never a form checklist.
 * Customers leave when we dump 6 fields at once.
 */
export function salesDiscoveryFallbackReply(firstMessage: string): string {
  const text = firstMessage.toLowerCase();
  const productMatch = text.match(
    /\b(kurundu|cinnamon|tea|spice|spices|garment|apparel|coconut|rubber|gems?|jewellery|jewelry)\b/i
  );
  const destMatch = text.match(
    /\b(australia|aussie|usa|uk|canada|dubai|singapore|malaysia|europe|germany|france|japan|china)\b/i
  );
  const product = productMatch?.[1];
  const dest = destMatch?.[1];

  if (product && dest) {
    return (
      `Nice — exporting **${product}** to **${dest}** sounds great, and we can help with rates.\n\n` +
      `Roughly how many packs or cartons would you ship at a time — say a minimum and a maximum?`
    );
  }
  if (product) {
    return (
      `Got it — happy to help with **${product}** export rates.\n\n` +
      `Which country are you looking to ship to?`
    );
  }
  if (dest) {
    return (
      `Sure — we can look at options for **${dest}**.\n\n` +
      `What product will you be exporting?`
    );
  }
  return (
    `Happy to help you find better rates for that.\n\n` +
    `What's the product, and which country do you want to export to?`
  );
}

/** Next single question from what we already know (rules / fallback). */
export function nextSalesQuestion(buffer: InquiryBuffer | null): string {
  const f = buffer?.fields || {};
  if (!f.product) {
    return "What product will you be exporting?";
  }
  if (!f.destination) {
    return "Which country (and city, if you know) should it go to?";
  }
  if (!f.min_packs && !f.max_packs) {
    return "About how many packs or cartons per shipment — a rough min and max is fine.";
  }
  if (!f.weight_or_size) {
    return "Roughly how heavy or large is one pack?";
  }
  if (!f.frequency) {
    return "How often do you plan to ship — weekly, monthly, or as needed?";
  }
  if (!buffer?.contactPhone) {
    return "What's the best mobile number to reach you on (e.g. 07… or 9477…)?";
  }
  return (
    "Thanks — I have enough to pass this to our sales team for a proper quote.\n\n" +
    "Reply **yes** or **done** and I'll submit it (you'll get an SMS)."
  );
}

export function appendInquirySnippet(
  buffer: InquiryBuffer | null,
  snippet: string,
  options: {
    contactPhone?: string | null;
    priority?: "high" | "normal";
    topic?: string | null;
    fields?: Record<string, string> | null;
  } = {}
): InquiryBuffer {
  const base: InquiryBuffer = buffer ?? {
    snippets: [],
    contactPhone: null,
    priority: "normal",
    topic: null,
    fields: {},
  };
  const next = [...base.snippets, snippet.trim()].filter(Boolean).slice(-20);
  return {
    snippets: next,
    contactPhone: options.contactPhone ?? base.contactPhone,
    priority:
      options.priority === "high" || base.priority === "high"
        ? "high"
        : "normal",
    topic: options.topic ?? base.topic,
    fields: { ...base.fields, ...(options.fields || {}) },
  };
}

export function organizeInquirySummary(buffer: InquiryBuffer): string {
  const topic =
    buffer.topic ||
    (buffer.priority === "high" ? "Business / export inquiry" : "General inquiry");
  const fieldLines = Object.entries(buffer.fields)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return (
    `Topic: ${topic}\n` +
    `Priority: ${buffer.priority.toUpperCase()}\n` +
    `Contact: ${buffer.contactPhone || "(missing — need callback number)"}\n` +
    (fieldLines ? `Details:\n${fieldLines}\n` : "") +
    `Notes from chat:\n` +
    buffer.snippets.map((s, i) => `${i + 1}. ${s}`).join("\n")
  );
}

export function inquiryContextForPrompt(buffer: InquiryBuffer | null): string {
  if (!buffer) return "Active sales inquiry: no";
  const fields = Object.entries(buffer.fields)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return (
    `Active sales inquiry: yes (priority ${buffer.priority})\n` +
    `Topic: ${buffer.topic || "(open)"}\n` +
    `Contact: ${buffer.contactPhone || "(need mobile)"}\n` +
    `Known fields: ${fields || "(none yet)"}\n` +
    `Snippets so far: ${buffer.snippets.length}`
  );
}
