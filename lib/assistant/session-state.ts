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

const EXPORT_COUNTRY_ALIASES: Record<string, string> = {
  nz: "New Zealand",
  "new zealand": "New Zealand",
  australia: "Australia",
  aussie: "Australia",
  au: "Australia",
  usa: "USA",
  us: "USA",
  "united states": "USA",
  america: "USA",
  uk: "UK",
  "united kingdom": "UK",
  england: "UK",
  canada: "Canada",
  ca: "Canada",
  dubai: "Dubai",
  uae: "UAE",
  singapore: "Singapore",
  sg: "Singapore",
  malaysia: "Malaysia",
  europe: "Europe",
  germany: "Germany",
  france: "France",
  japan: "Japan",
  china: "China",
  india: "India",
  korea: "South Korea",
  "south korea": "South Korea",
  italy: "Italy",
  netherlands: "Netherlands",
  sweden: "Sweden",
  norway: "Norway",
  qatar: "Qatar",
  saudi: "Saudi Arabia",
  "saudi arabia": "Saudi Arabia",
  "middle east": "Middle East",
  thailand: "Thailand",
  vietnam: "Vietnam",
  indonesia: "Indonesia",
};

/** Common typos / near-misses for country codes (keyboard neighbors). */
const COUNTRY_CODE_TYPOS: Record<string, string> = {
  nx: "nz",
  mz: "nz",
  ns: "nz",
  nq: "nz",
  na: "nz",
  ay: "au",
  ai: "au",
  auy: "au",
  uj: "uk",
  uh: "uk",
  yk: "uk",
  ys: "us",
  uz: "us",
  ua: "us",
};

const UNIT_WORDS =
  "packs?|packages?|parcels?|cartons?|boxes|envelopes?|sets?|pieces?|items?|pcs";

function resolveDestinationLabel(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (EXPORT_COUNTRY_ALIASES[key]) return EXPORT_COUNTRY_ALIASES[key];
  const typo = COUNTRY_CODE_TYPOS[key];
  if (typo && EXPORT_COUNTRY_ALIASES[typo]) return EXPORT_COUNTRY_ALIASES[typo];
  // Fuzzy: 1-char edit distance against known 2–3 letter codes
  if (/^[a-z]{2,3}$/.test(key)) {
    const shortKeys = Object.keys(EXPORT_COUNTRY_ALIASES).filter(
      (k) => k.length >= 2 && k.length <= 3 && !k.includes(" ")
    );
    let best: string | null = null;
    let bestDist = 99;
    for (const k of shortKeys) {
      const d = editDistance(key, k);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    if (best && bestDist === 1) return EXPORT_COUNTRY_ALIASES[best];
  }
  return null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[b.length];
}

function extractVolumeFields(n: string): {
  min_packs?: string;
  max_packs?: string;
} {
  const unit = UNIT_WORDS;
  const packsRange = n.match(
    new RegExp(
      `(\\d+)\\s*(?:to|-|–)\\s*(\\d+)\\s*(?:${unit})?`,
      "i"
    )
  );
  if (packsRange) {
    return { min_packs: packsRange[1], max_packs: packsRange[2] };
  }
  const packsSingle = n.match(
    new RegExp(
      `\\b(?:about|around|approx(?:imately)?|roughly|nearly|~)?\\s*(\\d+)\\s*(?:${unit})\\b`,
      "i"
    )
  );
  if (packsSingle) {
    return { min_packs: packsSingle[1], max_packs: packsSingle[1] };
  }
  // Bare quantity answers: "10", "about 10", "~10"
  const bare = n.match(
    /^(?:about|around|approx(?:imately)?|roughly|nearly|~)?\s*(\d{1,4})\s*(?:pcs|x)?\.?$/i
  );
  if (bare) {
    return { min_packs: bare[1], max_packs: bare[1] };
  }
  return {};
}

const EXPORT_PRODUCT_WORDS =
  /\b(kurundu|cinnamon|tea|spice|spices|garment|apparel|coconut|rubber|gems?|jewellery|jewelry|handicrafts?|cosmetics?|snacks?|food\s*items?|documents?|docs|papers?|paperwork|clothing|clothes|personal\s*goods?|personal\s*items?|electronics?|gifts?|samples?|medicines?|pharma|books?)\b/i;

const PRODUCT_REJECT =
  /^(yes|y|no|n|ok|okay|done|thanks|thank you|help|hi|hello|otp|nz|nx|uk|usa|au)$/i;

const DESTINATION_STOP_WORDS = new Set([
  "send",
  "ship",
  "export",
  "deliver",
  "you",
  "get",
  "find",
  "know",
  "see",
  "make",
  "them",
  "me",
  "us",
  "my",
  "the",
  "a",
  "an",
]);

/** Pull structured sales fields from free-text (rules fallback + buffer merge). */
export function extractInquiryFieldsFromText(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const n = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return fields;

  const productMatch = n.match(EXPORT_PRODUCT_WORDS);
  if (productMatch) {
    fields.product = titleCaseProduct(productMatch[1]);
  }

  const countryKeys = Object.keys(EXPORT_COUNTRY_ALIASES).sort(
    (a, b) => b.length - a.length
  );
  for (const key of countryKeys) {
    const re = new RegExp(`\\b${key.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(n)) {
      fields.destination = EXPORT_COUNTRY_ALIASES[key];
      break;
    }
  }

  if (!fields.destination) {
    const toPatterns = [
      /\b(?:send|ship|export|deliver|post|mail|courier|freight|transport|move|sending|shipping)\s+(?:a\s+|my\s+|the\s+)?(?:\w+\s+){0,4}?(?:to|towards?)\s+([a-z]{2,}(?:\s+[a-z]{2,})?)\b/i,
      /\b(?:going|headed|heading)\s+to\s+([a-z]{2,}(?:\s+[a-z]{2,})?)\b/i,
      /\b(?:to|for|into)\s+([a-z]{2,}(?:\s+[a-z]{2,})?)\b/i,
    ];
    for (const pat of toPatterns) {
      const m = n.match(pat);
      if (!m?.[1]) continue;
      const candidate = m[1].trim().toLowerCase();
      if (DESTINATION_STOP_WORDS.has(candidate)) continue;
      const resolved = resolveDestinationLabel(candidate);
      if (resolved) {
        fields.destination = resolved;
        break;
      }
    }
  }

  // Standalone country / typo replies: "nz", "nx", "australia"
  if (!fields.destination) {
    const alone = n.replace(/[.!?]+$/g, "").trim();
    const resolvedAlone = resolveDestinationLabel(alone);
    if (resolvedAlone) fields.destination = resolvedAlone;
  }

  const volume = extractVolumeFields(n);
  if (volume.min_packs) fields.min_packs = volume.min_packs;
  if (volume.max_packs) fields.max_packs = volume.max_packs;

  const weight = n.match(/\b(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?)\b/i);
  if (weight) fields.weight_or_size = `${weight[1]} ${weight[2]}`;
  const freq = n.match(
    /\b(weekly|monthly|daily|as\s*needed|occasionally|one[\s-]?time|once)\b/i
  );
  if (freq) {
    fields.frequency = /one|once/i.test(freq[1]) ? "one-time" : freq[1];
  }

  return fields;
}

function titleCaseProduct(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Accept free-text product answers like "just documents" when we already
 * know the destination (or are clearly answering a product question).
 */
export function acceptFreeTextProduct(
  message: string,
  known?: Record<string, string> | null
): string | null {
  const extracted = extractInquiryFieldsFromText(message);
  if (extracted.product) return extracted.product;

  // Never treat a shipping-intent sentence as the product
  if (
    /\b(want|wanna|need|like|plan|planning)\s+(to\s+)?(send|ship|export|deliver|post|mail)\b/i.test(
      message
    ) ||
    /\b(send|ship|export|deliver|post|mail|courier)\b.*\bto\b/i.test(message) ||
    /\b(parcel|package|shipment)\s+to\b/i.test(message)
  ) {
    return null;
  }

  const cleaned = message
    .trim()
    .replace(/^(just|only|it's|its|some|mainly|mostly)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 80) return null;
  if (PRODUCT_REJECT.test(cleaned)) return null;
  if (extracted.destination && !known?.destination) return null;
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length >= 9) return null;

  // Free-text product only when destination was already known, or message is a known product word
  if (!known?.destination && !EXPORT_PRODUCT_WORDS.test(cleaned)) {
    return null;
  }
  const words = cleaned.split(/\s+/);
  if (words.length > 6) return null;
  return titleCaseProduct(cleaned);
}

/**
 * Merge extraction + free-text answers for the current sales turn.
 */
export function applySalesTurnFields(
  known: Record<string, string> | undefined | null,
  message: string
): Record<string, string> {
  const extracted = extractInquiryFieldsFromText(message);
  let fields = mergeInquiryFields(known, extracted);
  if (!fields.product) {
    // Don't invent product from the same sentence that first mentioned the country
    const destAlreadyKnown = Boolean(known?.destination);
    if (destAlreadyKnown || (!extracted.destination && EXPORT_PRODUCT_WORDS.test(message))) {
      const product = acceptFreeTextProduct(message, {
        ...fields,
        // Force "already known" gate only when prior turn had destination
        ...(destAlreadyKnown ? { destination: fields.destination } : {}),
      });
      if (product) fields = { ...fields, product };
    }
  }
  // Volume follow-ups when product + destination known
  if (
    fields.product &&
    fields.destination &&
    !fields.min_packs &&
    !fields.max_packs
  ) {
    const n = message.toLowerCase().trim();
    if (/^(one|1|a\s+few|few|single)$/i.test(n)) {
      fields = {
        ...fields,
        min_packs: "1",
        max_packs: /\bfew\b/i.test(n) ? "5" : "1",
      };
    } else {
      const volume = extractVolumeFields(n);
      if (volume.min_packs) {
        fields = {
          ...fields,
          min_packs: volume.min_packs,
          max_packs: volume.max_packs || volume.min_packs,
        };
      }
    }
  }

  // Normalize bad stored destinations like "NX" from older turns
  if (fields.destination) {
    const fixed = resolveDestinationLabel(fields.destination);
    if (fixed) fields = { ...fields, destination: fixed };
  }
  return fields;
}

export function mergeInquiryFields(
  base: Record<string, string> | undefined | null,
  extracted: Record<string, string>
): Record<string, string> {
  const merged = { ...(base || {}) };
  for (const [k, v] of Object.entries(extracted)) {
    if (v?.trim()) merged[k] = v.trim();
  }
  return merged;
}

/** Export, bulk, corporate, international — needs multi-turn Gemini discovery. */
export function isRichSalesInquiry(normalized: string): boolean {
  if (
    /\b(want|wanna|need|like|plan|planning)\s+(to\s+)?(send|ship|export|deliver|post|mail)\b/i.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /\b(send|ship|export|deliver|post|mail|courier)\s+(a\s+|my\s+|the\s+)?(package|parcel|goods?|item|product|shipment|box|carton)s?\s+to\b/i.test(
      normalized
    )
  ) {
    return true;
  }
  return /\b(export|import|international|overseas|new\s*zealand|\bnz\b|australia|aussie|usa|uk|canada|dubai|middle\s*east|europe|singapore|malaysia|bulk|corporate|b2b|business|company|partnership|contract|wholesale|shipment\s*to|ship\s*to|kurundu|cinnamon|tea|spice|cargo|freight|consignment\s*to|best\s*rate|special\s*rate|volume|packs?|packages?|parcels?|cartons?|pallets?|boxes|\d+\s*kg|kilograms?)\b/i.test(
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
      /\b(export|new\s*zealand|\bnz\b|australia|cinnamon|kurundu|best\s*quote|competitive\s*export|per\s*shipment|how\s*many\s*(packs?|packages?|cartons?)|how\s*much\s*weight|sales\s*team|quote|packages?\s*do\s*you|send\s*(a\s+)?(package|parcel)|ship\s*to|want\s*(to\s+)?send|what\s*(product|are you sending))\b/i.test(
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
    Object.assign(fields, applySalesTurnFields(fields, text));
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
  return /\b(inquir(y|ies)|enquire|enquiry|quote|quotation|partnership|sales|how\s*(do|can)\s*i\s*(send|ship)|(?:want|wanna|need|like)\s*to\s*(send|ship|export|deliver)|open\s*an?\s*account)\b/i.test(
    normalized
  );
}

/**
 * Warm one-question opener / fallback — never a form checklist.
 * Acknowledges what the customer already said; asks only what's missing.
 */
export function salesDiscoveryFallbackReply(
  firstMessage: string,
  knownFields?: Record<string, string> | null
): string {
  const fields = mergeInquiryFields(
    knownFields,
    extractInquiryFieldsFromText(firstMessage)
  );
  const product = fields.product;
  const dest = fields.destination;
  const n = firstMessage.toLowerCase();

  if (product && dest) {
    return (
      `Nice — **${product}** to **${dest}** is something we handle often.\n\n` +
      `Roughly how many packs or cartons would go in one shipment? A ballpark min–max is fine.`
    );
  }
  if (dest) {
    return (
      `**${dest}** — got it, we can help you ship there.\n\n` +
      `What are you sending — spices, clothing, personal goods, or something else?`
    );
  }
  if (product) {
    return (
      `**${product}** — nice. We can look at export options for that.\n\n` +
      `Which country should it go to?`
    );
  }
  if (/\b(send|ship|export|deliver|post|mail|courier|package|parcel)\b/i.test(n)) {
    return (
      `Sure, I can help with that.\n\n` +
      `Which country are you sending to?`
    );
  }
  return (
    `Happy to help with export rates.\n\n` +
    `Where are you looking to ship to?`
  );
}

function isDocumentLikeProduct(product: string | undefined): boolean {
  return Boolean(
    product && /\b(documents?|docs?|papers?|paperwork)\b/i.test(product)
  );
}

/** Next single question from what we already know (rules / fallback). */
export function nextSalesQuestion(buffer: InquiryBuffer | null): string {
  const f = buffer?.fields || {};
  if (!f.destination) {
    return "Which country should the shipment go to?";
  }
  if (!f.product) {
    return `Got **${f.destination}** — what are you sending (documents, clothes, gifts, etc.)?`;
  }
  if (!f.min_packs && !f.max_packs) {
    if (isDocumentLikeProduct(f.product)) {
      return `**Documents** to **${f.destination}** — roughly how many envelopes or sets would you send?`;
    }
    return `For **${f.product}** to **${f.destination}**, roughly how many packs or parcels per shipment?`;
  }
  if (!f.weight_or_size) {
    if (isDocumentLikeProduct(f.product)) {
      return "Rough weight is fine — under 1kg, or heavier?";
    }
    return "And roughly how heavy is one pack or parcel?";
  }
  if (!f.frequency) {
    return "Is this a one-time send, or something you'd do more often?";
  }
  if (!buffer?.contactPhone) {
    return "What's the best mobile to reach you on for the quote (e.g. 07…)?";
  }
  return (
    "Perfect — I'll pass this to our sales team for a proper quote.\n\n" +
    "Reply **yes** or **done** when you're ready and I'll submit it (you'll get an SMS)."
  );
}

/** True if the bot reply is re-asking for a field we already know. */
export function salesReplyIgnoresKnownFields(
  reply: string,
  fields: Record<string, string> | undefined | null
): boolean {
  if (!fields) return false;
  const r = reply.toLowerCase();
  if (
    fields.product &&
    /\b(what (product|are you sending)|which product|product will you)\b/i.test(r)
  ) {
    return true;
  }
  if (
    fields.destination &&
    /\b(which country|what country|where (are you|do you want to) (send|ship)|destination)\b/i.test(
      r
    )
  ) {
    return true;
  }
  if (
    (fields.min_packs || fields.max_packs) &&
    /\b(how many|roughly how many|packs or parcels|packs or cartons|envelopes or sets)\b/i.test(
      r
    )
  ) {
    return true;
  }
  return false;
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
