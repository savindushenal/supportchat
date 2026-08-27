-- Additive migration if you already ran the previous normalized schema.
-- Prefer full schema.sql + seed.sql for a clean reset.

alter table public.support_tickets
  alter column order_id drop not null;

alter table public.support_tickets
  add column if not exists client_id uuid references public.clients (id) on delete set null;

alter table public.support_tickets
  add column if not exists ticket_type text not null default 'inquiry';

create index if not exists support_tickets_client_id_idx on public.support_tickets (client_id);
create index if not exists support_tickets_type_idx on public.support_tickets (ticket_type);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  invoice_no text not null unique,
  amount_lkr numeric(12, 2) not null check (amount_lkr >= 0),
  status text not null default 'pending',
  description text,
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists invoices_client_id_idx on public.invoices (client_id);
create index if not exists invoices_status_idx on public.invoices (status);

alter table public.invoices enable row level security;

create index if not exists tracking_sessions_phone_idx on public.tracking_sessions (phone_e164);
