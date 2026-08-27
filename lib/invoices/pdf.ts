import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { InvoiceRow, InvoiceSummary } from "@/lib/supabase";

function money(n: number): string {
  return `LKR ${n.toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export async function buildInvoiceListPdf(options: {
  summary: InvoiceSummary;
  filter: "pending" | "paid" | "all";
}): Promise<Uint8Array> {
  const { summary, filter } = options;
  const rows: InvoiceRow[] =
    filter === "pending"
      ? summary.pending
      : filter === "paid"
        ? summary.paid
        : [...summary.pending, ...summary.paid];

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]); // A4
  let y = 800;

  const draw = (text: string, size = 11, useBold = false) => {
    if (y < 60) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    page.drawText(text, {
      x: 40,
      y,
      size,
      font: useBold ? bold : font,
      color: rgb(0.1, 0.1, 0.15),
    });
    y -= size + 6;
  };

  draw("TransExpress.lk — Invoice Statement", 16, true);
  draw(`Client: ${summary.clientName}`, 11, true);
  draw(`Generated: ${new Date().toLocaleString("en-LK")}`);
  draw(`Filter: ${filter.toUpperCase()}`);
  y -= 8;
  draw(
    `Pending: ${summary.pendingCount} · ${money(summary.pendingTotal)}`,
    11,
    true
  );
  draw(`Paid: ${summary.paidCount} · ${money(summary.paidTotal)}`, 11, true);
  y -= 10;
  draw("Invoice No          Status     Amount           Waybill / Note", 10, true);
  draw("----------------------------------------------------------------");

  for (const inv of rows) {
    const line = `${inv.invoice_no.padEnd(18)} ${inv.status.padEnd(9)} ${money(inv.amount_lkr).padEnd(14)} ${inv.waybill ?? inv.description ?? ""}`;
    draw(line.slice(0, 95), 9);
  }

  if (!rows.length) {
    draw("(No invoices in this filter)");
  }

  y -= 16;
  draw("This statement is for TransExpress account support.", 9);

  return doc.save();
}
