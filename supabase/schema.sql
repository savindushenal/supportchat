-- TransExpress normalized schema (dev: run in Supabase SQL Editor)
-- Drops legacy flat shipments table, then creates clients / orders / events / tickets / OTP.

drop table if exists public.tracking_sessions cascade;
drop table if exists public.tracking_otps cascade;
drop table if exists public.invoices cascade;
drop table if exists public.support_tickets cascade;
drop table if exists public.shipment_events cascade;
drop table if exists public.orders cascade;
drop table if exists public.clients cascade;
drop table if exists public.shipments cascade;

create extension if not exists pgcrypto;

-- Unique people (senders and receivers)
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_phone_e164_key unique (phone_e164)
);

create index clients_phone_e164_idx on public.clients (phone_e164);

-- One row per waybill / consignment
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  waybill text not null,
  sender_id uuid not null references public.clients (id),
  receiver_id uuid not null references public.clients (id),
  current_status text not null default 'booked',
  current_branch text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_waybill_key unique (waybill)
);

create index orders_waybill_lower_idx on public.orders (lower(waybill));
create index orders_sender_id_idx on public.orders (sender_id);
create index orders_receiver_id_idx on public.orders (receiver_id);
create index orders_is_active_idx on public.orders (is_active);

-- Journey timeline
create table public.shipment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  stage text not null,
  location text,
  note text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index shipment_events_order_id_idx on public.shipment_events (order_id);
create index shipment_events_occurred_at_idx on public.shipment_events (occurred_at);

-- Support / inquiry / complaint history
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  ticket_type text not null default 'inquiry',
  -- inquiry | complaint | redelivery | agent
  complaint text,
  department text,
  solution text,
  operator text,
  priority text not null default 'normal',
  -- normal | high
  contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_tickets_order_id_idx on public.support_tickets (order_id);
create index support_tickets_client_id_idx on public.support_tickets (client_id);
create index support_tickets_type_idx on public.support_tickets (ticket_type);

-- Client invoices (COD / shipping charges)
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  invoice_no text not null,
  amount_lkr numeric(12, 2) not null check (amount_lkr >= 0),
  status text not null default 'pending',
  -- pending | paid | cancelled
  description text,
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invoices_invoice_no_key unique (invoice_no)
);

create index invoices_client_id_idx on public.invoices (client_id);
create index invoices_status_idx on public.invoices (status);
create index invoices_order_id_idx on public.invoices (order_id);

-- OTP for unlocking full journey details
create table public.tracking_otps (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  code_hash text not null,
  waybill text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index tracking_otps_phone_idx on public.tracking_otps (phone_e164);
create index tracking_otps_waybill_idx on public.tracking_otps (waybill);

-- Short-lived verified tracking sessions
create table public.tracking_sessions (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  waybill text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index tracking_sessions_token_hash_idx on public.tracking_sessions (token_hash);
create index tracking_sessions_waybill_idx on public.tracking_sessions (waybill);
create index tracking_sessions_phone_idx on public.tracking_sessions (phone_e164);

alter table public.clients enable row level security;
alter table public.orders enable row level security;
alter table public.shipment_events enable row level security;
alter table public.support_tickets enable row level security;
alter table public.invoices enable row level security;
alter table public.tracking_otps enable row level security;
alter table public.tracking_sessions enable row level security;

comment on table public.clients is 'Senders and receivers (unique by phone_e164 94XXXXXXXXX).';
comment on table public.orders is 'Consignments; client_no from sheet maps to sender_id.';
comment on table public.shipment_events is 'Journey stages: booked → warehouse → dispatched → OFD → delivered.';
comment on table public.support_tickets is 'Inquiries, complaints, re-delivery and agent requests.';
comment on table public.invoices is 'Pending/paid invoices per client (sender billing).';
comment on table public.tracking_otps is 'Hashed SMS OTPs before full tracking details.';
comment on table public.tracking_sessions is 'Post-OTP session tokens (hashed) ~30 minutes.';
