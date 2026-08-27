-- Seed after schema.sql (Supabase SQL Editor)
-- Phones stored as 94XXXXXXXXX. Existing sheet client_no = sender.

truncate table public.tracking_sessions, public.tracking_otps, public.invoices,
  public.support_tickets, public.shipment_events, public.orders, public.clients
  restart identity cascade;

-- Fixed IDs for stable demos
-- Senders
insert into public.clients (id, phone_e164, name) values
  ('11111111-1111-1111-1111-111111111001', '94764300731', 'Plusmart.Lk'),
  ('11111111-1111-1111-1111-111111111002', '94775942384', 'Megha 1 Palace (Pvt) Ltd'),
  ('11111111-1111-1111-1111-111111111003', '94760053626', 'Ceylon Store'),
  ('11111111-1111-1111-1111-111111111004', '94755379990', 'Dark Grace.Lk'),
  ('11111111-1111-1111-1111-111111111005', '94712772830', 'Tiny Tush Diapers'),
  ('11111111-1111-1111-1111-111111111006', '94701567800', 'Subito.Lk');

-- Receivers (sample end customers)
insert into public.clients (id, phone_e164, name) values
  ('22222222-2222-2222-2222-222222222001', '94771234567', 'Kasun Perera'),
  ('22222222-2222-2222-2222-222222222002', '94772345678', 'Nimali Fernando'),
  ('22222222-2222-2222-2222-222222222003', '94773456789', 'Ruwan Silva'),
  ('22222222-2222-2222-2222-222222222004', '94774567890', 'Ayesha Jay'),
  ('22222222-2222-2222-2222-222222222005', '94775678901', 'Dilshan Cooray'),
  ('22222222-2222-2222-2222-222222222006', '94776789012', 'Sajith Bandara'),
  ('22222222-2222-2222-2222-222222222007', '94777890123', 'Ishara Wick');

-- Orders (Plusmart has 3 active + 1 delivered for multi-track demo)
insert into public.orders (
  id, waybill, sender_id, receiver_id, current_status, current_branch, is_active
) values
  ('33333333-3333-3333-3333-333333333001', 'BE039645',
    '11111111-1111-1111-1111-111111111001', '22222222-2222-2222-2222-222222222001',
    're_delivery', 'Thalawathugoda', true),
  ('33333333-3333-3333-3333-333333333002', 'BE100701',
    '11111111-1111-1111-1111-111111111001', '22222222-2222-2222-2222-222222222002',
    'out_for_delivery', 'Gampaha', true),
  ('33333333-3333-3333-3333-333333333003', 'BE100702',
    '11111111-1111-1111-1111-111111111001', '22222222-2222-2222-2222-222222222003',
    'received_at_destination', 'Kaduwela', true),
  ('33333333-3333-3333-3333-333333333004', 'BE100703',
    '11111111-1111-1111-1111-111111111001', '22222222-2222-2222-2222-222222222004',
    'delivered', 'Colombo Metro', false),
  ('33333333-3333-3333-3333-333333333005', 'A4248931',
    '11111111-1111-1111-1111-111111111002', '22222222-2222-2222-2222-222222222005',
    'returned_to_branch', 'Thalawathugoda', true),
  ('33333333-3333-3333-3333-333333333006', 'BE086979',
    '11111111-1111-1111-1111-111111111003', '22222222-2222-2222-2222-222222222006',
    'returned_to_branch', 'Colombo Metro', true),
  ('33333333-3333-3333-3333-333333333007', 'A4387801',
    '11111111-1111-1111-1111-111111111004', '22222222-2222-2222-2222-222222222007',
    'returned_to_client', 'Baddagama', false),
  ('33333333-3333-3333-3333-333333333008', 'A4598750',
    '11111111-1111-1111-1111-111111111005', '22222222-2222-2222-2222-222222222001',
    'returned_to_branch', 'Homagama', true),
  ('33333333-3333-3333-3333-333333333009', 'BE077969',
    '11111111-1111-1111-1111-111111111006', '22222222-2222-2222-2222-222222222002',
    'returned_to_branch', 'Wennappuwa', true);

-- Journey events (newest last in time; queries order by occurred_at)
insert into public.shipment_events (order_id, stage, location, note, occurred_at) values
-- BE039645
('33333333-3333-3333-3333-333333333001', 'booked', 'HO Colombo', 'Order created', now() - interval '4 days'),
('33333333-3333-3333-3333-333333333001', 'received_at_warehouse', 'HO Warehouse', 'Parcel scanned in', now() - interval '3 days'),
('33333333-3333-3333-3333-333333333001', 'dispatched', 'HO Colombo', 'Dispatched to Thalawathugoda', now() - interval '2 days'),
('33333333-3333-3333-3333-333333333001', 'received_at_destination', 'Thalawathugoda', 'Arrived at branch', now() - interval '1 day'),
('33333333-3333-3333-3333-333333333001', 'out_for_delivery', 'Thalawathugoda', 'First attempt — customer unavailable', now() - interval '12 hours'),
('33333333-3333-3333-3333-333333333001', 're_delivery', 'Thalawathugoda', 'Scheduled re-delivery (urgent)', now() - interval '2 hours'),
-- BE100701
('33333333-3333-3333-3333-333333333002', 'booked', 'HO Colombo', 'Order created', now() - interval '3 days'),
('33333333-3333-3333-3333-333333333002', 'received_at_warehouse', 'HO Warehouse', 'Parcel scanned in', now() - interval '2 days'),
('33333333-3333-3333-3333-333333333002', 'dispatched', 'HO Colombo', 'Dispatched to Gampaha', now() - interval '1 day'),
('33333333-3333-3333-3333-333333333002', 'out_for_delivery', 'Gampaha', 'With rider — expected today', now() - interval '3 hours'),
-- BE100702
('33333333-3333-3333-3333-333333333003', 'booked', 'HO Colombo', 'Order created', now() - interval '3 days'),
('33333333-3333-3333-3333-333333333003', 'dispatched', 'HO Colombo', 'Dispatched to Kaduwela', now() - interval '2 days'),
('33333333-3333-3333-3333-333333333003', 'received_at_destination', 'Kaduwela', 'At destination branch — next: out for delivery', now() - interval '6 hours'),
-- BE100703 delivered
('33333333-3333-3333-3333-333333333004', 'booked', 'HO Colombo', 'Order created', now() - interval '10 days'),
('33333333-3333-3333-3333-333333333004', 'out_for_delivery', 'Colombo Metro', 'With rider', now() - interval '8 days'),
('33333333-3333-3333-3333-333333333004', 'delivered', 'Colombo Metro', 'Delivered to receiver', now() - interval '7 days'),
-- A4248931
('33333333-3333-3333-3333-333333333005', 'booked', 'HO Colombo', 'Order created', now() - interval '5 days'),
('33333333-3333-3333-3333-333333333005', 'dispatched', 'HO Colombo', 'To Thalawathugoda', now() - interval '3 days'),
('33333333-3333-3333-3333-333333333005', 'returned_to_branch', 'Thalawathugoda', 'Rescheduled — awaiting re-attempt', now() - interval '1 day'),
-- BE086979
('33333333-3333-3333-3333-333333333006', 'booked', 'HO Colombo', 'Order created', now() - interval '4 days'),
('33333333-3333-3333-3333-333333333006', 'dispatched', 'HO Colombo', 'To Colombo Metro', now() - interval '2 days'),
('33333333-3333-3333-3333-333333333006', 'returned_to_branch', 'Colombo Metro', 'Rescheduled', now() - interval '1 day'),
-- A4387801 closed
('33333333-3333-3333-3333-333333333007', 'booked', 'HO Colombo', 'Order created', now() - interval '14 days'),
('33333333-3333-3333-3333-333333333007', 'returned_to_client', 'Baddagama', 'Returned to sender', now() - interval '5 days'),
-- A4598750
('33333333-3333-3333-3333-333333333008', 'booked', 'HO Colombo', 'Order created', now() - interval '3 days'),
('33333333-3333-3333-3333-333333333008', 'dispatched', 'HO Colombo', 'To Homagama', now() - interval '2 days'),
('33333333-3333-3333-3333-333333333008', 'returned_to_branch', 'Homagama', 'Rescheduled', now() - interval '8 hours'),
-- BE077969
('33333333-3333-3333-3333-333333333009', 'booked', 'HO Colombo', 'Order created', now() - interval '6 days'),
('33333333-3333-3333-3333-333333333009', 'dispatched', 'HO Colombo', 'To Wennappuwa', now() - interval '4 days'),
('33333333-3333-3333-3333-333333333009', 'returned_to_branch', 'Wennappuwa', 'Callback requested', now() - interval '2 days');

insert into public.support_tickets (
  order_id, client_id, ticket_type, complaint, department, solution, operator
) values
('33333333-3333-3333-3333-333333333001', '11111111-1111-1111-1111-111111111001', 'inquiry', 'Arrange To Deliver Today / Top Urgant', 'Branch Operations', 'Informed Branch', 'Mandari'),
('33333333-3333-3333-3333-333333333002', '11111111-1111-1111-1111-111111111001', 'inquiry', 'Arrange To Deliver Today', 'Branch Operations', 'Informed Branch', 'Mandari'),
('33333333-3333-3333-3333-333333333003', '11111111-1111-1111-1111-111111111001', 'inquiry', 'Check Status', 'Branch Operations', 'Informed Branch', 'Mandari'),
('33333333-3333-3333-3333-333333333005', '11111111-1111-1111-1111-111111111002', 'inquiry', 'Arrange To Deliver Today / Top Urgant', 'Branch Operations', 'Informed Branch', 'Mandari'),
('33333333-3333-3333-3333-333333333006', '11111111-1111-1111-1111-111111111003', 'inquiry', 'Arrange To Deliver Today / Top Urgant', 'Branch Operations', 'Informed Branch', 'Mandari'),
('33333333-3333-3333-3333-333333333007', '11111111-1111-1111-1111-111111111004', 'complaint', 'Return Package', 'Customer Care', 'Done', 'Mandari'),
('33333333-3333-3333-3333-333333333008', '11111111-1111-1111-1111-111111111005', 'inquiry', 'Urgent Today', 'Branch Operations', 'Informed Branch', 'Lakshani'),
('33333333-3333-3333-3333-333333333009', '11111111-1111-1111-1111-111111111006', 'inquiry', 'Check & Call Back', 'Branch Operations', 'Done', 'Mandari');

-- Invoices for Plusmart sender (pending + paid)
insert into public.invoices (
  id, client_id, order_id, invoice_no, amount_lkr, status, description, issued_at, paid_at
) values
('44444444-4444-4444-4444-444444444001', '11111111-1111-1111-1111-111111111001',
  '33333333-3333-3333-3333-333333333001', 'INV-2026-1001', 1850.00, 'pending',
  'Delivery charges — BE039645', now() - interval '2 days', null),
('44444444-4444-4444-4444-444444444002', '11111111-1111-1111-1111-111111111001',
  '33333333-3333-3333-3333-333333333002', 'INV-2026-1002', 2100.00, 'pending',
  'Delivery charges — BE100701', now() - interval '1 day', null),
('44444444-4444-4444-4444-444444444003', '11111111-1111-1111-1111-111111111001',
  '33333333-3333-3333-3333-333333333004', 'INV-2026-0988', 1500.00, 'paid',
  'Delivery charges — BE100703', now() - interval '12 days', now() - interval '7 days'),
('44444444-4444-4444-4444-444444444004', '11111111-1111-1111-1111-111111111001',
  null, 'INV-2026-0950', 5000.00, 'paid',
  'Monthly account settlement', now() - interval '30 days', now() - interval '25 days'),
('44444444-4444-4444-4444-444444444005', '11111111-1111-1111-1111-111111111002',
  '33333333-3333-3333-3333-333333333005', 'INV-2026-1010', 2200.00, 'pending',
  'Delivery charges — A4248931', now() - interval '3 days', null);
