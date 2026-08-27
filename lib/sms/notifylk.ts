/**
 * Notify.lk SMS — ported from MenuVire NotifyLkService.php
 * POST https://app.notify.lk/api/v1/send (form body)
 */

/** Sri Lankan mobile → 94XXXXXXXXX (no +). */
export function normalisePhoneTo94(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("0") && digits.length >= 10) {
    digits = "94" + digits.slice(1);
  }
  if (!digits.startsWith("94") && digits.length === 9) {
    digits = "94" + digits;
  }
  if (!/^94\d{9}$/.test(digits)) return null;
  return digits;
}

/** Local 9-digit form without country code (for matching older sheet values). */
export function phoneLocal9(phone94: string): string {
  return phone94.startsWith("94") ? phone94.slice(2) : phone94;
}

export function maskPhone(phone94: string): string {
  if (phone94.length < 4) return "****";
  return `****${phone94.slice(-4)}`;
}

export async function sendNotifyLkSms(
  phone: string,
  message: string
): Promise<void> {
  const userId = process.env.NOTIFYLK_USER_ID?.trim() ?? "";
  const apiKey = process.env.NOTIFYLK_API_KEY?.trim() ?? "";
  const senderId =
    process.env.NOTIFYLK_SENDER_ID?.trim() || "TransExpress";

  const to = normalisePhoneTo94(phone);
  if (!to) {
    throw new Error("Invalid phone number for SMS.");
  }
  if (!userId || !apiKey) {
    throw new Error(
      "Missing NOTIFYLK_USER_ID / NOTIFYLK_API_KEY in .env.local"
    );
  }

  const body = new URLSearchParams({
    user_id: userId,
    api_key: apiKey,
    sender_id: senderId,
    to,
    message,
  });

  const response = await fetch("https://app.notify.lk/api/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[notifylk] HTTP fail", response.status, text.slice(0, 200));
    throw new Error(`SMS delivery failed: ${response.status}`);
  }

  const json = (await response.json()) as {
    status?: string;
    message?: string;
  };

  if ((json.status ?? "") !== "success") {
    console.warn("[notifylk] non-success", json);
    throw new Error(`SMS gateway error: ${json.message ?? "unknown"}`);
  }
}
