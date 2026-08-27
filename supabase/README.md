# Database setup (Supabase SQL Editor)

1. Prefer clean reset: run `schema.sql`, then `seed.sql`.
2. Or additive: `migrate_invoices.sql`, `migrate_inquiry_priority.sql`, then seed invoices.

Phones are `94XXXXXXXXX`. Sheet `client_no` = **sender**.
Invoices are billed to the **sender** client.
Complaints are **draft → approve → save + SMS**. Inquiries buffer in the chat session, then one organized row on **done** / close.
