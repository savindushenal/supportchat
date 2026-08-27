/**
 * Scope guard — only TransExpress courier support is allowed.
 * General knowledge (even “what is logistics”) is refused.
 */

const REFUSAL =
  "I can only help with **TransExpress** courier support — tracking your shipment, re-delivery, or connecting you to customer care.\n\n" +
  "Please send a **waybill** or **contact number**, or type **help**.\n" +
  "Care line: **+94 112 999 888**";

/** Keywords that clearly belong to TransExpress operational support. */
const IN_SCOPE =
  /\b(transexpress|waybill|tracking|track|parcel|package|shipment|courier|deliver(y|ies|ed)?|re[\s-]?deliver|reschedule|branch|cod|cash\s*on\s*delivery|return|pickup|pick[\s-]?up|dispatch|rider|driver|agent|customer\s*care|callback|call\s*back|status|failed\s*to\s*deliver|out\s*for\s*delivery|invoice|consignment|otp|verify|warehouse|journey|timeline|next\s+(stop|place|stage)|complaint|complain|pending\s*invoice|total\s*paid|pdf|pric(e|ing)|rate|rates|quote|quotation|business|corporate|bulk|inquir(y|ies)|enquiry|export|import|australia|kurundu|cinnamon|spice|packs?|cartons?|volume)\b/i;

/**
 * Off-topic / general questions that must be blocked — including industry
 * definitions like “what is logistics”.
 */
const OFF_TOPIC =
  /\b(what\s+is\s+(a\s+)?(logistic|logistics|supply\s*chain|freight|shipping\s+industry)|define\s+(logistic|logistics)|explain\s+(logistic|logistics|ai|machine\s*learning)|who\s+(is|are|was|were)\s+|tell\s+me\s+a\s+joke|write\s+(a\s+)?(poem|essay|code|story)|homework|recipe|weather|cricket|football|movie|song|politics|religion|bitcoin|crypto|stock\s*market|chatgpt|openai|gemini\b(?!\s*api)|how\s+to\s+(make|cook|code|hack)|capital\s+of)\b/i;

export function scopeRefusalReply(): string {
  return REFUSAL;
}

export function isOffTopic(message: string): boolean {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (OFF_TOPIC.test(text)) return true;

  // “What is X?” style definitions that are not about a customer’s shipment
  if (
    /^(what\s+(is|are|was|were)|who\s+(is|are)|explain|define|describe)\b/.test(
      text
    ) &&
    !IN_SCOPE.test(text)
  ) {
    return true;
  }

  return false;
}

/** True if the message is about TransExpress operational support. */
export function isInBusinessScope(message: string): boolean {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (isOffTopic(text)) return false;
  if (IN_SCOPE.test(text)) return true;
  // Bare waybill/phone handled elsewhere via extractLookupQuery
  return false;
}
