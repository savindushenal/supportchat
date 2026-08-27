-- Add priority + contact_phone to existing support_tickets (safe to re-run)
alter table public.support_tickets
  add column if not exists priority text not null default 'normal';

alter table public.support_tickets
  add column if not exists contact_phone text;

comment on column public.support_tickets.priority is 'normal | high (business inquiries / urgent complaints)';
comment on column public.support_tickets.contact_phone is 'Callback mobile 94XXXXXXXXX for SMS / follow-up';
