import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mdPath = path.resolve(
  __dirname,
  "../../.cursor/projects/c-Users-TWINS-TECH-Documents-GitHub-supportchat/uploads/edit-0.md"
);
const altMdPath =
  "C:/Users/TWINS - TECH/.cursor/projects/c-Users-TWINS-TECH-Documents-GitHub-supportchat/uploads/edit-0.md";

const text = fs.readFileSync(fs.existsSync(mdPath) ? mdPath : altMdPath, "utf8");
const lines = text.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|/.test(l));

function esc(s) {
  if (s == null || s === "") return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

const rows = [];
for (const line of lines) {
  const cells = line
    .split("|")
    .map((c) => c.trim())
    .filter((_, i, arr) => i > 0 && i < arr.length - 1);

  if (cells.length < 12) continue;
  const id = Number(cells[1]);
  if (!Number.isFinite(id)) continue;

  let operator = cells[2];
  let client_no = cells[3];
  let client_yn = cells[4];
  let customer_name = cells[5];
  let waybill = cells[6];
  let complaint = cells[7];
  let branch = cells[8];
  let status = cells[9];
  let department = cells[10];
  let solution = cells[11] || "";

  // Row 60 is missing Operator in the sheet export
  if (id === 60 && /^\d+$/.test(operator)) {
    solution = department;
    department = status;
    status = branch;
    branch = complaint;
    complaint = waybill;
    waybill = customer_name;
    customer_name = client_yn;
    client_yn = client_no;
    client_no = operator;
    operator = "Mandari";
  }

  // Row 30 has shifted status/department columns
  if (id === 30 && branch === "Delivered" && status === "Customer Care") {
    solution = department || solution;
    department = status;
    status = branch;
    branch = "Piliyandala";
  }

  if (!waybill || waybill.length < 2) continue;

  rows.push({
    id,
    operator,
    client_no,
    client_yn,
    customer_name,
    waybill,
    complaint,
    branch,
    status,
    department,
    solution,
  });
}

const values = rows
  .map(
    (r) =>
      `(${r.id}, ${esc(r.operator)}, ${esc(r.client_no)}, ${esc(r.client_yn)}, ${esc(r.customer_name)}, ${esc(r.waybill)}, ${esc(r.complaint)}, ${esc(r.branch)}, ${esc(r.status)}, ${esc(r.department)}, ${esc(r.solution)})`
  )
  .join(",\n");

const sql = `-- Seed from TransExpress Google Sheet (first ~100 tickets)
-- Run after schema.sql in Supabase SQL Editor

truncate table public.shipments;

insert into public.shipments (
  id, operator, client_no, client_yn, customer_name,
  waybill, complaint, branch, status, department, solution
) values
${values};
`;

const out = path.resolve(__dirname, "../supabase/seed.sql");
fs.writeFileSync(out, sql);
console.log(`Wrote ${rows.length} rows to ${out}`);
