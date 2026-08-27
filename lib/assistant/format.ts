import {
  ComplaintTicket,
  InvoiceSummary,
  OrderJourney,
  OrderSummary,
  statusLabel,
} from "@/lib/supabase";
import { maskPhone } from "@/lib/sms/notifylk";

function money(n: number): string {
  return `LKR ${n.toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Masked list — no PII / timeline until OTP. */
export function formatMaskedOrdersReply(
  orders: OrderSummary[],
  phoneLabel: string
): string {
  const lines = orders.map((o, i) => {
    const role = o.role === "sender" ? "as sender" : "as receiver";
    return `${i + 1}. **${o.waybill}** — *${statusLabel(o.status)}* (${role})`;
  });

  return (
    `Found **${orders.length} active shipment${orders.length === 1 ? "" : "s"}** for **${phoneLabel}**:\n\n` +
    `${lines.join("\n")}\n\n` +
    `Reply with a **waybill** to continue. Full journey / invoices need **SMS OTP**.`
  );
}

export function formatMaskedSingleReply(order: OrderSummary): string {
  const redeliveryNote =
    order.status.toLowerCase() === "re_delivery"
      ? `\n_Already on re-delivery — you can still reply **1** after OTP to send a follow-up._\n`
      : "";

  return (
    `Shipment **${order.waybill}** — status *${statusLabel(order.status)}*.\n` +
    redeliveryNote +
    `\nVerify with **SMS OTP** for the full journey, invoices, or to log actions.\n\n` +
    `Reply **OTP** to receive a code, or **help**.`
  );
}

export function formatClosedOnlyReply(
  order: OrderSummary,
  phoneLabel: string
): string {
  return (
    `No **active** shipments for **${phoneLabel}**.\n\n` +
    `Most recent closed: **${order.waybill}** — *${statusLabel(order.status)}*\n\n` +
    `Customer Care: **+94 112 999 888**`
  );
}

export function formatOtpSentReply(maskedPhone: string, waybill: string): string {
  return (
    `I've sent a 6-digit code to **${maskedPhone}** for waybill **${waybill}**.\n\n` +
    `Reply with the code to unlock journey details, invoices, complaints, and actions.`
  );
}

export function formatJourneyReply(journey: OrderJourney): string {
  const timeline = journey.events
    .map((e) => {
      const when = new Date(e.occurredAt).toLocaleString("en-LK", {
        dateStyle: "medium",
        timeStyle: "short",
      });
      const loc = e.location ? ` · ${e.location}` : "";
      const note = e.note ? ` — ${e.note}` : "";
      return `• **${statusLabel(e.stage)}** (${when})${loc}${note}`;
    })
    .join("\n");

  const redeliveryHint =
    journey.status.toLowerCase() === "re_delivery"
      ? `\n_Status is already re-delivery — reply **1** anytime to escalate a follow-up._\n`
      : "";

  return (
    `📦 **Verified journey — ${journey.waybill}**\n\n` +
    `Status: *${statusLabel(journey.status)}*` +
    (journey.branch ? `\nBranch: **${journey.branch}**` : "") +
    `\nYou: **${journey.role}**` +
    `\nSender: ${journey.senderName} (${maskPhone(journey.senderPhone)})` +
    `\nReceiver: ${journey.receiverName} (${maskPhone(journey.receiverPhone)})` +
    redeliveryHint +
    `\n\n**Timeline**\n${timeline || "(no events yet)"}` +
    `\n\n➡️ ${journey.nextHint}` +
    `\n\n**1** — Re-delivery (or follow-up)\n**2** — Human agent\n` +
    `Say your issue → we draft a complaint → **yes** to raise · **complaint status** to check\n` +
    `Ask **pricing** or business quotes · **pending invoices** / **Download PDF**`
  );
}

export function formatComplaintsReply(tickets: ComplaintTicket[]): string {
  if (!tickets.length) {
    return (
      "No complaints on file for this account/waybill.\n\n" +
      "To file one, reply **complaint:** briefly describe the issue."
    );
  }
  const lines = tickets.map((t) => {
    const ref = t.id.slice(0, 8);
    const wb = t.waybill ? ` · ${t.waybill}` : "";
    const when = new Date(t.createdAt).toLocaleString("en-LK", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return (
      `• **${t.statusLabel}** \`${ref}\`${wb}\n` +
      `  ${t.text.slice(0, 120)}${t.text.length > 120 ? "…" : ""}\n` +
      `  ${t.solution} · ${when}`
    );
  });
  return (
    `📋 **Complaint status** (${tickets.length})\n\n` +
    lines.join("\n\n") +
    `\n\nTo file a new one: **complaint:** your issue`
  );
}

export function formatInvoiceSummaryReply(summary: InvoiceSummary): string {
  const pendingLines = summary.pending
    .slice(0, 5)
    .map(
      (i) =>
        `• **${i.invoice_no}** — ${money(i.amount_lkr)}` +
        (i.waybill ? ` (${i.waybill})` : "")
    )
    .join("\n");
  const paidLines = summary.paid
    .slice(0, 3)
    .map((i) => `• **${i.invoice_no}** — ${money(i.amount_lkr)}`)
    .join("\n");

  return (
    `🧾 **Invoices — ${summary.clientName}** (${maskPhone(summary.phoneE164)})\n\n` +
    `**Pending:** ${summary.pendingCount} · **${money(summary.pendingTotal)}**\n` +
    (pendingLines || "• (none)") +
    `\n\n**Paid:** ${summary.paidCount} · **${money(summary.paidTotal)}**\n` +
    (paidLines || "• (none)") +
    `\n\nUse the buttons below for a **PDF** list (pending or paid).`
  );
}

export function formatPdfReadyReply(kind: "pending" | "paid" | "all"): string {
  const label =
    kind === "pending"
      ? "pending"
      : kind === "paid"
        ? "paid"
        : "all";
  return (
    `Your **${label}** invoice PDF is ready.\n` +
    `Tap **Download PDF** below (valid while your OTP session lasts ~30 min).`
  );
}

export function summarizeOrderForTool(order: OrderSummary, verified: boolean) {
  if (!verified) {
    return {
      waybill: order.waybill,
      status: order.status,
      role: order.role,
      verified: false,
      can_request_redelivery: true,
      message: "OTP required for full journey / invoices.",
    };
  }
  return {
    waybill: order.waybill,
    status: order.status,
    branch: order.branch,
    role: order.role,
    sender_name: order.senderName,
    receiver_name: order.receiverName,
    verified: true,
    already_on_redelivery: order.status.toLowerCase() === "re_delivery",
    can_request_redelivery: true,
  };
}
