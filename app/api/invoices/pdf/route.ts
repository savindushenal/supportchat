import { NextRequest, NextResponse } from "next/server";
import { hashSecret } from "@/lib/otp";
import { buildInvoiceListPdf } from "@/lib/invoices/pdf";
import {
  findValidSessionForPhone,
  getInvoiceSummaryForPhone,
} from "@/lib/supabase";
import { normalisePhoneTo94 } from "@/lib/sms/notifylk";

/**
 * GET /api/invoices/pdf?phone=07...&status=pending|paid|all&token=SESSION_TOKEN
 * Requires a valid OTP tracking session for that phone.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const phoneRaw = searchParams.get("phone") ?? "";
    const statusParam = (searchParams.get("status") ?? "all").toLowerCase();
    const token = searchParams.get("token") ?? "";

    const phone = normalisePhoneTo94(phoneRaw);
    if (!phone) {
      return NextResponse.json({ error: "Invalid phone" }, { status: 400 });
    }

    const filter =
      statusParam === "pending" || statusParam === "paid" ? statusParam : "all";

    if (!token) {
      return NextResponse.json(
        { error: "OTP session token required" },
        { status: 401 }
      );
    }

    const ok = await findValidSessionForPhone(hashSecret(token), phone);
    if (!ok) {
      return NextResponse.json(
        { error: "Session expired or invalid — verify OTP again" },
        { status: 401 }
      );
    }

    const summary = await getInvoiceSummaryForPhone(phone);
    if (!summary) {
      return NextResponse.json(
        { error: "No client/invoices found for this phone" },
        { status: 404 }
      );
    }

    const bytes = await buildInvoiceListPdf({ summary, filter });
    const filename = `transexpress-invoices-${filter}-${phone.slice(-4)}.pdf`;

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/invoices/pdf]", error);
    const detail = error instanceof Error ? error.message : "PDF error";
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
