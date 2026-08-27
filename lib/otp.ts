import { createHash, randomInt, randomBytes } from "crypto";
import {
  consumeOtp,
  createTrackingSession,
  findRecentOtp,
  insertOtp,
  isOtpRateLimited,
} from "@/lib/supabase";
import {
  maskPhone,
  normalisePhoneTo94,
  sendNotifyLkSms,
} from "@/lib/sms/notifylk";

const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type SendOtpResult =
  | { ok: true; maskedPhone: string; expiresAt: string }
  | { ok: false; error: string };

export async function sendTrackingOtp(options: {
  phone: string;
  waybill: string;
}): Promise<SendOtpResult> {
  const phone94 = normalisePhoneTo94(options.phone);
  if (!phone94) return { ok: false, error: "Invalid phone number." };

  const waybill = options.waybill.trim().toUpperCase();
  if (!waybill) return { ok: false, error: "Waybill required." };

  if (await isOtpRateLimited(phone94, 60)) {
    return {
      ok: false,
      error: "Please wait about a minute before requesting another code.",
    };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await insertOtp({
    phoneE164: phone94,
    codeHash: hashSecret(code),
    waybill,
    expiresAt,
  });

  const message = `Your TransExpress tracking code for ${waybill} is: ${code}. Valid 5 minutes. Do not share.`;

  try {
    await sendNotifyLkSms(phone94, message);
  } catch (error) {
    console.error("[otp] SMS failed", error);
    return {
      ok: false,
      error: "Could not send SMS. Please try again shortly.",
    };
  }

  return {
    ok: true,
    maskedPhone: maskPhone(phone94),
    expiresAt: expiresAt.toISOString(),
  };
}

export type VerifyOtpResult =
  | {
      ok: true;
      sessionToken: string;
      waybill: string;
      phoneE164: string;
      expiresAt: string;
    }
  | { ok: false; error: string };

export async function verifyTrackingOtp(options: {
  phone: string;
  waybill: string;
  code: string;
}): Promise<VerifyOtpResult> {
  const phone94 = normalisePhoneTo94(options.phone);
  if (!phone94) return { ok: false, error: "Invalid phone number." };

  const waybill = options.waybill.trim().toUpperCase();
  const code = options.code.trim();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "Enter the 6-digit code from SMS." };
  }

  const row = await findRecentOtp(phone94, waybill);
  if (!row) {
    return { ok: false, error: "No active code. Request a new OTP." };
  }
  if (row.consumed_at) {
    return { ok: false, error: "Code already used. Request a new OTP." };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "Code expired. Request a new OTP." };
  }
  if (row.code_hash !== hashSecret(code)) {
    return { ok: false, error: "Invalid code. Try again." };
  }

  await consumeOtp(row.id);

  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createTrackingSession({
    phoneE164: phone94,
    waybill,
    tokenHash: hashSecret(sessionToken),
    expiresAt,
  });

  return {
    ok: true,
    sessionToken,
    waybill,
    phoneE164: phone94,
    expiresAt: expiresAt.toISOString(),
  };
}
