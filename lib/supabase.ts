/**
 * Supabase data layer — normalized clients / orders / events / OTP sessions.
 * Run supabase/schema.sql then supabase/seed.sql in the SQL Editor.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  normalisePhoneTo94,
  phoneLocal9,
  sendNotifyLkSms,
} from "@/lib/sms/notifylk";

export type ClientRow = {
  id: string;
  phone_e164: string;
  name: string | null;
};

export type OrderRow = {
  id: string;
  waybill: string;
  sender_id: string;
  receiver_id: string;
  current_status: string;
  current_branch: string | null;
  is_active: boolean;
};

export type ShipmentEventRow = {
  id: string;
  order_id: string;
  stage: string;
  location: string | null;
  note: string | null;
  occurred_at: string;
};

export type OrderSummary = {
  id: string;
  waybill: string;
  status: string;
  branch: string;
  isActive: boolean;
  role: "sender" | "receiver";
  senderName: string;
  receiverName: string;
  senderPhone: string;
  receiverPhone: string;
};

export type JourneyEvent = {
  stage: string;
  location: string;
  note: string;
  occurredAt: string;
};

export type OrderJourney = OrderSummary & {
  events: JourneyEvent[];
  nextHint: string;
};

export type OtpRow = {
  id: string;
  phone_e164: string;
  code_hash: string;
  waybill: string;
  expires_at: string;
  consumed_at: string | null;
};

let client: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local."
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export function phoneLookupVariants(input: string): string[] {
  const as94 = normalisePhoneTo94(input);
  if (!as94) return [];
  const local = phoneLocal9(as94);
  return Array.from(new Set([as94, `0${local}`, local]));
}

export function looksLikePhone(input: string): boolean {
  const trimmed = input.trim();
  if (
    /^\+?94[\s-]?\d/.test(trimmed) ||
    /^0\d{8,9}$/.test(trimmed.replace(/[\s-]/g, ""))
  ) {
    return true;
  }
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 12 && !/[A-Za-z]/.test(trimmed);
}

export function normalizeClientNo(input: string): string | null {
  const as94 = normalisePhoneTo94(input);
  return as94 ? phoneLocal9(as94) : null;
}

export function isActiveStatus(status: string | null | undefined): boolean {
  const s = (status || "").trim().toLowerCase();
  if (!s) return true;
  if (s === "delivered") return false;
  if (s.includes("returned_to_client") || s.includes("returned to client")) {
    return false;
  }
  return true;
}

export function statusLabel(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function nextHintFor(status: string, branch: string): string {
  const s = status.toLowerCase();
  const at = branch ? ` at **${branch}**` : "";
  if (s === "booked") return "Next: receive at warehouse / HO.";
  if (s.includes("warehouse") || s === "received_at_ho") {
    return "Next: dispatch to destination branch.";
  }
  if (s === "dispatched") {
    return `Next: arrive at destination branch${at}.`;
  }
  if (s === "received_at_destination") {
    return `Next: out for delivery${at} (typically same or next business day).`;
  }
  if (s === "out_for_delivery") {
    return `With the rider${at} — expected delivery today if reachable.`;
  }
  if (s === "re_delivery") {
    return `Re-delivery scheduled${at} — keep your phone on.`;
  }
  if (s.includes("returned_to_branch")) {
    return `At branch${at} — awaiting re-attempt or pickup instructions.`;
  }
  if (s === "delivered") return "Delivered — no further transit steps.";
  if (s.includes("returned_to_client")) {
    return "Returned to sender — closed.";
  }
  return `Current status: ${statusLabel(status)}${at}.`;
}

async function clientsByPhoneVariants(
  variants: string[]
): Promise<ClientRow[]> {
  if (!variants.length) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("id, phone_e164, name")
    .in("phone_e164", variants);

  if (error) {
    throw new Error(`clientsByPhone failed: ${error.message}`);
  }
  return (data as ClientRow[]) ?? [];
}

function mapOrderSummary(
  order: OrderRow,
  sender: ClientRow,
  receiver: ClientRow,
  role: "sender" | "receiver"
): OrderSummary {
  return {
    id: order.id,
    waybill: order.waybill,
    status: order.current_status,
    branch: order.current_branch ?? "",
    isActive: order.is_active,
    role,
    senderName: sender.name ?? "",
    receiverName: receiver.name ?? "",
    senderPhone: sender.phone_e164,
    receiverPhone: receiver.phone_e164,
  };
}

export async function findActiveOrdersForPhone(
  phone: string
): Promise<OrderSummary[]> {
  const variants = phoneLookupVariants(phone);
  const people = await clientsByPhoneVariants(variants);
  if (!people.length) return [];

  const ids = people.map((p) => p.id);
  const supabase = getSupabase();
  const idList = ids.join(",");

  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, waybill, sender_id, receiver_id, current_status, current_branch, is_active"
    )
    .eq("is_active", true)
    .or(`sender_id.in.(${idList}),receiver_id.in.(${idList})`)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`findActiveOrdersForPhone failed: ${error.message}`);
  }

  return hydrateOrders((data as OrderRow[]) ?? [], new Set(ids));
}

async function hydrateOrders(
  orders: OrderRow[],
  selfIds: Set<string>
): Promise<OrderSummary[]> {
  if (!orders.length) return [];
  const supabase = getSupabase();
  const clientIds = Array.from(
    new Set(orders.flatMap((o) => [o.sender_id, o.receiver_id]))
  );
  const { data: clientsData, error: cErr } = await supabase
    .from("clients")
    .select("id, phone_e164, name")
    .in("id", clientIds);

  if (cErr) {
    throw new Error(`load clients failed: ${cErr.message}`);
  }

  const byId = new Map(
    ((clientsData as ClientRow[]) ?? []).map((c) => [c.id, c])
  );

  const out: OrderSummary[] = [];
  for (const order of orders) {
    const sender = byId.get(order.sender_id);
    const receiver = byId.get(order.receiver_id);
    if (!sender || !receiver) continue;
    const role: "sender" | "receiver" = selfIds.has(order.sender_id)
      ? "sender"
      : "receiver";
    out.push(mapOrderSummary(order, sender, receiver, role));
  }
  return out;
}

export async function findOrderByWaybill(
  waybill: string
): Promise<OrderSummary | null> {
  const supabase = getSupabase();
  const normalized = waybill.trim();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, waybill, sender_id, receiver_id, current_status, current_branch, is_active"
    )
    .ilike("waybill", normalized)
    .maybeSingle();

  if (error) {
    throw new Error(`findOrderByWaybill failed: ${error.message}`);
  }
  if (!data) return null;

  const order = data as OrderRow;
  const list = await hydrateOrders([order], new Set([order.sender_id]));
  return list[0] ?? null;
}

export type OrdersLookup = {
  matchedBy: "waybill" | "phone";
  orders: OrderSummary[];
  onlyClosed?: boolean;
};

/** Phone (sender or receiver) or waybill lookup. */
export async function lookupShipments(
  query: string
): Promise<OrdersLookup | null> {
  const q = query.trim();
  if (!q) return null;

  if (looksLikePhone(q) || normalisePhoneTo94(q)) {
    const active = await findActiveOrdersForPhone(q);
    if (active.length) return { matchedBy: "phone", orders: active };

    const variants = phoneLookupVariants(q);
    const people = await clientsByPhoneVariants(variants);
    if (!people.length) return null;

    const ids = people.map((p) => p.id);
    const supabase = getSupabase();
    const idList = ids.join(",");
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, waybill, sender_id, receiver_id, current_status, current_branch, is_active"
      )
      .or(`sender_id.in.(${idList}),receiver_id.in.(${idList})`)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (error) {
      throw new Error(`lookupShipments phone failed: ${error.message}`);
    }
    const all = await hydrateOrders((data as OrderRow[]) ?? [], new Set(ids));
    if (!all.length) return null;
    return { matchedBy: "phone", orders: [all[0]], onlyClosed: true };
  }

  const byWb = await findOrderByWaybill(q);
  if (!byWb) return null;
  if (!byWb.isActive) {
    return { matchedBy: "waybill", orders: [byWb], onlyClosed: true };
  }
  return { matchedBy: "waybill", orders: [byWb] };
}

export const lookupOrders = lookupShipments;

export async function getOrderJourney(
  waybill: string
): Promise<OrderJourney | null> {
  const summary = await findOrderByWaybill(waybill);
  if (!summary) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("shipment_events")
    .select("id, order_id, stage, location, note, occurred_at")
    .eq("order_id", summary.id)
    .order("occurred_at", { ascending: true });

  if (error) {
    throw new Error(`getOrderJourney failed: ${error.message}`);
  }

  const events: JourneyEvent[] = ((data as ShipmentEventRow[]) ?? []).map(
    (e) => ({
      stage: e.stage,
      location: e.location ?? "",
      note: e.note ?? "",
      occurredAt: e.occurred_at,
    })
  );

  return {
    ...summary,
    events,
    nextHint: nextHintFor(summary.status, summary.branch),
  };
}

/**
 * Party phone to SMS for this waybill: prefer the caller's phone if they
 * match sender/receiver; otherwise sender phone.
 */
export function partyPhoneForOtp(
  order: OrderSummary,
  callerPhone?: string | null
): string {
  if (callerPhone) {
    const as94 = normalisePhoneTo94(callerPhone);
    if (as94 === order.senderPhone || as94 === order.receiverPhone) {
      return as94;
    }
  }
  return order.role === "receiver" ? order.receiverPhone : order.senderPhone;
}

export type RedeliveryResult = {
  order: OrderSummary;
  alreadyScheduled: boolean;
  message: string;
};

export type ComplaintResult = {
  id: string;
  waybill: string | null;
  summary: string;
  smsSent: boolean;
};

export type InvoiceRow = {
  id: string;
  invoice_no: string;
  amount_lkr: number;
  status: string;
  description: string | null;
  issued_at: string;
  paid_at: string | null;
  waybill: string | null;
};

export type InvoiceSummary = {
  phoneE164: string;
  clientName: string;
  pendingCount: number;
  pendingTotal: number;
  paidCount: number;
  paidTotal: number;
  pending: InvoiceRow[];
  paid: InvoiceRow[];
};

export async function requestRedelivery(
  waybill: string,
  note?: string
): Promise<RedeliveryResult> {
  const order = await findOrderByWaybill(waybill);
  if (!order) {
    throw new Error(`Waybill "${waybill}" not found.`);
  }

  const alreadyScheduled =
    order.status.toLowerCase() === "re_delivery" ||
    order.status.toLowerCase().includes("re_delivery");

  const supabase = getSupabase();
  const complaintText = alreadyScheduled
    ? `Follow-up re-delivery request${note ? `: ${note}` : ""} (already scheduled)`
    : `Automated Re-delivery Request${note ? `: ${note}` : ""}`;

  const { error } = await supabase.from("support_tickets").insert({
    order_id: order.id,
    ticket_type: "redelivery",
    complaint: complaintText,
    department: "Branch Operations",
    solution: alreadyScheduled
      ? "Follow-up logged — branch notified again"
      : "Logged via chat",
    operator: "Support Agent",
  });

  if (error) {
    throw new Error(`requestRedelivery ticket failed: ${error.message}`);
  }

  await supabase
    .from("orders")
    .update({
      current_status: "re_delivery",
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  await supabase.from("shipment_events").insert({
    order_id: order.id,
    stage: "re_delivery",
    location: order.branch || null,
    note: alreadyScheduled
      ? `Customer follow-up while already on re-delivery${note ? ` — ${note}` : ""}`
      : `Re-delivery requested via chat${note ? ` — ${note}` : ""}`,
    occurred_at: new Date().toISOString(),
  });

  const refreshed = (await findOrderByWaybill(waybill))!;
  const at = order.branch ? ` at **${order.branch}**` : "";

  const message = alreadyScheduled
    ? `**${waybill}** is already scheduled for **re-delivery**${at}. I've logged your follow-up so the branch prioritizes it again.`
    : `Done — **re-delivery** has been scheduled for **${waybill}**${at}. Keep your phone on for the rider.`;

  return { order: refreshed, alreadyScheduled, message };
}

export async function fileComplaint(options: {
  waybill?: string | null;
  phone?: string | null;
  text: string;
}): Promise<ComplaintResult> {
  const text = options.text.trim();
  if (text.length < 5) {
    throw new Error("Please describe the complaint in a bit more detail.");
  }

  const supabase = getSupabase();
  let orderId: string | null = null;
  let clientId: string | null = null;
  let waybill: string | null = null;

  if (options.waybill) {
    const order = await findOrderByWaybill(options.waybill);
    if (order) {
      orderId = order.id;
      waybill = order.waybill;
      const { data: ord } = await supabase
        .from("orders")
        .select("sender_id")
        .eq("id", order.id)
        .maybeSingle();
      clientId = (ord?.sender_id as string) ?? null;
    }
  }

  if (!clientId && options.phone) {
    const people = await clientsByPhoneVariants(
      phoneLookupVariants(options.phone)
    );
    clientId = people[0]?.id ?? null;
  }

  const { data, error } = await supabase
    .from("support_tickets")
    .insert({
      order_id: orderId,
      client_id: clientId,
      ticket_type: "complaint",
      complaint: text,
      department: "Customer Care",
      solution: "Open — logged via chat",
      operator: "Support Agent",
      priority: "high",
      contact_phone: options.phone
        ? normalisePhoneTo94(options.phone) || options.phone
        : null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`fileComplaint failed: ${error.message}`);
  }

  const id = data.id as string;
  const ref = id.slice(0, 8);
  let smsSent = false;
  const smsPhone = options.phone ? normalisePhoneTo94(options.phone) : null;
  if (smsPhone) {
    try {
      const sms =
        `TransExpress: Complaint received` +
        (waybill ? ` for ${waybill}` : "") +
        `. Ref ${ref}. Care +94112999888`;
      await sendNotifyLkSms(smsPhone, sms);
      smsSent = true;
    } catch (e) {
      console.warn("[fileComplaint] SMS failed", e);
    }
  }

  return {
    id,
    waybill,
    smsSent,
    summary: waybill
      ? `Complaint logged for **${waybill}**. Our care team will follow up.`
      : "Complaint logged. Our care team will follow up.",
  };
}

export type InquirySaveResult = {
  id: string;
  smsSent: boolean;
  summary: string;
};

export async function saveOrganizedInquiry(options: {
  phone: string | null;
  organized: string;
  priority: "high" | "normal";
  department?: string;
}): Promise<InquirySaveResult> {
  const phone94 = options.phone ? normalisePhoneTo94(options.phone) : null;
  if (!phone94) {
    throw new Error(
      "A contact mobile number is required to save the inquiry for follow-up."
    );
  }

  const supabase = getSupabase();
  const people = await clientsByPhoneVariants(phoneLookupVariants(phone94));
  let clientId = people[0]?.id ?? null;

  if (!clientId) {
    const { data: created, error: cErr } = await supabase
      .from("clients")
      .insert({ phone_e164: phone94, name: "Chat inquiry" })
      .select("id")
      .single();
    if (cErr) throw new Error(`saveInquiry client failed: ${cErr.message}`);
    clientId = created.id as string;
  }

  const department =
    options.department ||
    (options.priority === "high" ? "Sales" : "Customer Care");

  const { data, error } = await supabase
    .from("support_tickets")
    .insert({
      client_id: clientId,
      ticket_type: "inquiry",
      complaint: options.organized,
      department,
      solution:
        options.priority === "high"
          ? "HIGH priority — pending sales/support review"
          : "Open — pending agent review",
      operator: "Support Agent",
      priority: options.priority,
      contact_phone: phone94,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`saveOrganizedInquiry failed: ${error.message}`);
  }

  const id = data.id as string;
  const ref = id.slice(0, 8);
  let smsSent = false;
  try {
    await sendNotifyLkSms(
      phone94,
      `TransExpress: Your inquiry is noted (Ref ${ref}). We will get back to you soon.`
    );
    smsSent = true;
  } catch (e) {
    console.warn("[saveOrganizedInquiry] SMS failed", e);
  }

  return {
    id,
    smsSent,
    summary:
      `Inquiry saved for the team (Ref \`${ref}\`, **${options.priority}** priority).` +
      (smsSent ? " Confirmation SMS sent." : " (SMS could not be sent.)"),
  };
}

export type ComplaintTicket = {
  id: string;
  waybill: string | null;
  text: string;
  solution: string;
  department: string;
  createdAt: string;
  statusLabel: string;
};

/**
 * List complaint tickets for a verified caller (by phone and/or waybill).
 */
export async function listComplaints(options: {
  phone?: string | null;
  waybill?: string | null;
  limit?: number;
}): Promise<ComplaintTicket[]> {
  const supabase = getSupabase();
  const limit = options.limit ?? 10;

  let clientIds: string[] = [];
  if (options.phone) {
    const people = await clientsByPhoneVariants(
      phoneLookupVariants(options.phone)
    );
    clientIds = people.map((p) => p.id);
  }

  let orderId: string | null = null;
  if (options.waybill) {
    const order = await findOrderByWaybill(options.waybill);
    orderId = order?.id ?? null;
  }

  if (!clientIds.length && !orderId) return [];

  type RawTicket = {
    id: string;
    complaint: string | null;
    solution: string | null;
    department: string | null;
    created_at: string;
    order_id: string | null;
  };

  const byId = new Map<string, RawTicket>();

  if (orderId) {
    const { data, error } = await supabase
      .from("support_tickets")
      .select(
        "id, complaint, solution, department, created_at, order_id, ticket_type"
      )
      .eq("ticket_type", "complaint")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listComplaints failed: ${error.message}`);
    for (const r of data ?? []) {
      byId.set(r.id as string, r as RawTicket);
    }
  }

  if (clientIds.length) {
    const { data, error } = await supabase
      .from("support_tickets")
      .select(
        "id, complaint, solution, department, created_at, order_id, ticket_type"
      )
      .eq("ticket_type", "complaint")
      .in("client_id", clientIds)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listComplaints failed: ${error.message}`);
    for (const r of data ?? []) {
      byId.set(r.id as string, r as RawTicket);
    }
  }

  const rows = [...byId.values()]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, limit);
  const orderIds = [
    ...new Set(
      rows
        .map((r) => r.order_id as string | null)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const waybillByOrder = new Map<string, string>();
  if (orderIds.length) {
    const { data: orders } = await supabase
      .from("orders")
      .select("id, waybill")
      .in("id", orderIds);
    for (const o of orders ?? []) {
      waybillByOrder.set(o.id as string, o.waybill as string);
    }
  }

  return rows.map((r) => {
    const solution = ((r.solution as string) || "").trim() || "Open";
    const open = /open|pending|logged|follow/i.test(solution);
    return {
      id: r.id as string,
      waybill: r.order_id
        ? waybillByOrder.get(r.order_id as string) ?? null
        : null,
      text: ((r.complaint as string) || "").trim() || "(no details)",
      solution,
      department: ((r.department as string) || "Customer Care").trim(),
      createdAt: r.created_at as string,
      statusLabel: open ? "Open" : "Closed",
    };
  });
}

async function mapInvoiceRows(
  rows: {
    id: string;
    invoice_no: string;
    amount_lkr: number | string;
    status: string;
    description: string | null;
    issued_at: string;
    paid_at: string | null;
    order_id: string | null;
  }[]
): Promise<InvoiceRow[]> {
  if (!rows.length) return [];
  const orderIds = rows
    .map((r) => r.order_id)
    .filter((id): id is string => Boolean(id));
  const waybillByOrder = new Map<string, string>();
  if (orderIds.length) {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("orders")
      .select("id, waybill")
      .in("id", orderIds);
    for (const o of data ?? []) {
      waybillByOrder.set(o.id as string, o.waybill as string);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    invoice_no: r.invoice_no,
    amount_lkr: Number(r.amount_lkr),
    status: r.status,
    description: r.description,
    issued_at: r.issued_at,
    paid_at: r.paid_at,
    waybill: r.order_id ? waybillByOrder.get(r.order_id) ?? null : null,
  }));
}

export async function getInvoiceSummaryForPhone(
  phone: string
): Promise<InvoiceSummary | null> {
  const variants = phoneLookupVariants(phone);
  const people = await clientsByPhoneVariants(variants);
  if (!people.length) return null;

  const client = people[0];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, invoice_no, amount_lkr, status, description, issued_at, paid_at, order_id"
    )
    .eq("client_id", client.id)
    .in("status", ["pending", "paid"])
    .order("issued_at", { ascending: false });

  if (error) {
    throw new Error(`getInvoiceSummaryForPhone failed: ${error.message}`);
  }

  const all = await mapInvoiceRows(data ?? []);
  const pending = all.filter((i) => i.status === "pending");
  const paid = all.filter((i) => i.status === "paid");

  return {
    phoneE164: client.phone_e164,
    clientName: client.name ?? "Client",
    pendingCount: pending.length,
    pendingTotal: pending.reduce((s, i) => s + i.amount_lkr, 0),
    paidCount: paid.length,
    paidTotal: paid.reduce((s, i) => s + i.amount_lkr, 0),
    pending,
    paid,
  };
}

export async function listInvoicesForPhone(
  phone: string,
  status?: "pending" | "paid" | "all"
): Promise<InvoiceRow[]> {
  const summary = await getInvoiceSummaryForPhone(phone);
  if (!summary) return [];
  if (status === "pending") return summary.pending;
  if (status === "paid") return summary.paid;
  return [...summary.pending, ...summary.paid];
}

/** Valid session for this phone (any waybill). */
export async function findValidSessionForPhone(
  tokenHash: string,
  phoneE164: string
): Promise<boolean> {
  if (!tokenHash || !phoneE164) return false;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tracking_sessions")
    .select("id")
    .eq("token_hash", tokenHash)
    .eq("phone_e164", phoneE164)
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  if (error) {
    throw new Error(`findValidSessionForPhone failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

export async function updateOrderAction(
  waybill: string,
  actionText: string
): Promise<OrderSummary> {
  if (/re-delivery/i.test(actionText)) {
    const result = await requestRedelivery(waybill);
    return result.order;
  }

  const order = await findOrderByWaybill(waybill);
  if (!order) {
    throw new Error(`Waybill "${waybill}" not found.`);
  }

  const supabase = getSupabase();
  const ticketType = /agent/i.test(actionText) ? "agent" : "inquiry";
  const { error } = await supabase.from("support_tickets").insert({
    order_id: order.id,
    ticket_type: ticketType,
    complaint: actionText,
    department: "Customer Care",
    solution: "Logged via chat",
    operator: "Support Agent",
  });

  if (error) {
    throw new Error(`updateOrderAction failed: ${error.message}`);
  }

  return (await findOrderByWaybill(waybill))!;
}

/** @deprecated alias */
export async function updateWaybillAction(
  waybill: string,
  actionText: string
): Promise<{ waybill: string }> {
  const row = await updateOrderAction(waybill, actionText);
  return { waybill: row.waybill };
}

/* ---------- OTP / sessions ---------- */

export async function isOtpRateLimited(
  phoneE164: string,
  cooldownSeconds: number
): Promise<boolean> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - cooldownSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from("tracking_otps")
    .select("id")
    .eq("phone_e164", phoneE164)
    .gte("created_at", since)
    .limit(1);

  if (error) {
    throw new Error(`isOtpRateLimited failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

export async function insertOtp(options: {
  phoneE164: string;
  codeHash: string;
  waybill: string;
  expiresAt: Date;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("tracking_otps").insert({
    phone_e164: options.phoneE164,
    code_hash: options.codeHash,
    waybill: options.waybill,
    expires_at: options.expiresAt.toISOString(),
  });
  if (error) {
    throw new Error(`insertOtp failed: ${error.message}`);
  }
}

export async function findRecentOtp(
  phoneE164: string,
  waybill: string
): Promise<OtpRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tracking_otps")
    .select("id, phone_e164, code_hash, waybill, expires_at, consumed_at")
    .eq("phone_e164", phoneE164)
    .ilike("waybill", waybill)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`findRecentOtp failed: ${error.message}`);
  }
  return (data as OtpRow) ?? null;
}

export async function consumeOtp(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("tracking_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`consumeOtp failed: ${error.message}`);
  }
}

export async function createTrackingSession(options: {
  phoneE164: string;
  waybill: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("tracking_sessions").insert({
    phone_e164: options.phoneE164,
    waybill: options.waybill,
    token_hash: options.tokenHash,
    expires_at: options.expiresAt.toISOString(),
  });
  if (error) {
    throw new Error(`createTrackingSession failed: ${error.message}`);
  }
}

export async function findValidTrackingSession(
  tokenHash: string,
  waybill?: string | null
): Promise<{ phone_e164: string; waybill: string } | null> {
  if (!tokenHash) return null;
  const supabase = getSupabase();
  let q = supabase
    .from("tracking_sessions")
    .select("phone_e164, waybill, expires_at")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (waybill) {
    q = q.ilike("waybill", waybill);
  }

  const { data, error } = await q.maybeSingle();
  if (error) {
    throw new Error(`findValidTrackingSession failed: ${error.message}`);
  }
  if (!data) return null;
  return {
    phone_e164: data.phone_e164 as string,
    waybill: data.waybill as string,
  };
}

/** Legacy shape used by older format helpers — thin adapter. */
export type WaybillRow = {
  id: string;
  operator: string;
  clientNo: string;
  clientYN: string;
  customerName: string;
  waybill: string;
  complaint: string;
  branch: string;
  status: string;
  department: string;
  solution: string;
};

export async function findShipment(
  query: string
): Promise<{ row: WaybillRow; matchedBy: "waybill" | "phone" } | null> {
  const result = await lookupShipments(query);
  const order = result?.orders[0];
  if (!order) return null;
  return {
    matchedBy: result!.matchedBy,
    row: {
      id: order.id,
      operator: "",
      clientNo: phoneLocal9(order.senderPhone),
      clientYN: "",
      customerName: order.senderName,
      waybill: order.waybill,
      complaint: "",
      branch: order.branch,
      status: statusLabel(order.status),
      department: "",
      solution: "",
    },
  };
}
