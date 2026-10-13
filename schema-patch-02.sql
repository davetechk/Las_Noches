-- ============================================================
-- LAS NOCHES — PATCH 02
-- Self-service purchase. Customers buy time online, pay with
-- Paystack, and the voucher is issued automatically.
--
-- Changes:
--   * seat_number becomes optional (online buyers have no seat)
--   * pricing lives in the database, never in the browser
--   * orders track each purchase so a payment can't count twice
--   * capacity view replaces the seat map on the public page
--   * issue_online_entry() is the only way a paid voucher is handed out
--
-- Safe to run on the existing database. No data is dropped.
-- ============================================================

-- ---------- 1. SEATS ARE NOW OPTIONAL ----------
-- An online buyer sitting at home has no seat. Forcing one would make
-- the seat map lie the moment purchases happen away from the building.
alter table public.entries alter column seat_number drop not null;


-- ---------- 2. PRICING ----------
-- Prices must live here. If they live in the page, someone edits the
-- JavaScript and buys 12 hours for fifty naira.
create table if not exists public.pricing (
  id           uuid primary key default gen_random_uuid(),
  duration_hrs numeric(5,2) not null unique,
  label        text not null,
  amount_ngn   integer not null check (amount_ngn > 0),
  is_active    boolean not null default true,
  sort_order   int not null default 0
);

insert into public.pricing (duration_hrs, label, amount_ngn, sort_order) values
  (0.5,  '30 minutes',  200, 1),
  (1,    '1 hour',      300, 2),
  (2,    '2 hours',     600, 3),
  (3,    '3 hours',     900, 4),
  (4,    '4 hours',    1200, 5),
  (6,    '6 hours',    1500, 6),
  (12,   '12 hours',   2500, 7)
on conflict (duration_hrs) do update
  set amount_ngn = excluded.amount_ngn,
      label      = excluded.label,
      sort_order = excluded.sort_order;


-- ---------- 3. ORDERS ----------
create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  reference    text not null unique,
  duration_hrs numeric(5,2) not null,
  amount_ngn   integer not null,
  email        text,
  phone        text,
  status       text not null default 'pending'
                 check (status in ('pending','paid','failed','sold_out')),
  voucher_code text,
  entry_id     uuid references public.entries(id),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);

create index if not exists orders_ref_idx    on public.orders (reference);
create index if not exists orders_status_idx on public.orders (status, created_at desc);


-- ---------- 4. CAPACITY (public) ----------
-- "9 of 15 in use" answers the same question the seat map did, without
-- pretending to know where anybody is sitting.
create or replace view public.capacity as
select
  (select count(*) from public.seats where is_active)::int as total,
  (select count(*) from public.entries
     where time_out is null and expires_at > now())::int   as in_use;


-- ---------- 5. SEAT VIEW STILL WORKS ----------
-- Entries with a null seat simply don't appear against any seat, which
-- is correct — the receptionist's desk view only tracks assigned seats.


-- ---------- 6. WALK-IN CLAIM: SEAT NOW OPTIONAL ----------
create or replace function public.claim_voucher_and_log_entry(
  p_session_id   uuid,
  p_entry_date   date,
  p_voucher_code text,
  p_seat_number  int,
  p_time_in      time,
  p_duration_hrs numeric,
  p_amount_paid  numeric
)
returns public.entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry   public.entries;
  v_claimed int;
begin
  insert into public.vouchers (code, duration_hrs, omada_status)
  values (p_voucher_code, p_duration_hrs, 'manual')
  on conflict (code) do nothing;

  update public.vouchers
     set status = 'in_use', claimed_at = now()
   where code = p_voucher_code
     and status = 'unused';

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'VOUCHER_UNAVAILABLE'
      using hint = 'That voucher has already been used.';
  end if;

  -- Only guard the seat when one was actually chosen.
  if p_seat_number is not null and exists (
    select 1 from public.entries
     where seat_number = p_seat_number
       and time_out is null
       and expires_at > now()
  ) then
    raise exception 'SEAT_OCCUPIED'
      using hint = 'That seat is still occupied.';
  end if;

  insert into public.entries (
    session_id, entry_date, voucher_code, seat_number,
    time_in, duration_hrs, amount_paid
  ) values (
    p_session_id, p_entry_date, p_voucher_code, p_seat_number,
    p_time_in, p_duration_hrs, p_amount_paid
  )
  returning * into v_entry;

  return v_entry;
end;
$$;


-- ---------- 7. ONLINE ISSUANCE ----------
-- Called ONLY by the Paystack webhook, with the service role key.
-- Never callable from a browser. This is the single point where a paid
-- voucher is handed out, and it is idempotent: calling it twice with the
-- same reference returns the same code instead of issuing a second one.
create or replace function public.issue_online_entry(p_reference text)
returns table (voucher_code text, duration_hrs numeric, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_code    text;
  v_session uuid;
  v_entry   public.entries%rowtype;
  v_today   date := (now() at time zone interval '+01:00')::date;
  v_now     time := (now() at time zone interval '+01:00')::time;
begin
  select * into v_order from public.orders where reference = p_reference for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- Already issued — hand back the same voucher, don't mint another.
  if v_order.status = 'paid' then
    return query
      select v_order.voucher_code, v_order.duration_hrs, e.expires_at
      from public.entries e where e.id = v_order.entry_id;
    return;
  end if;

  -- Take one unused voucher of the right length. SKIP LOCKED means two
  -- simultaneous purchases can never grab the same code.
  select v.code into v_code
  from public.vouchers v
  where v.status = 'unused'
    and v.duration_hrs = v_order.duration_hrs
    and coalesce(v.omada_status, 'unused') <> 'expired'
  order by v.synced_at
  limit 1
  for update skip locked;

  if v_code is null then
    update public.orders set status = 'sold_out' where id = v_order.id;
    raise exception 'NO_VOUCHER_AVAILABLE'
      using hint = 'No unused voucher of that length is in stock.';
  end if;

  update public.vouchers
     set status = 'in_use', claimed_at = now()
   where code = v_code;

  -- All online sales land in one session per day, named "Online".
  select id into v_session
  from public.sessions
  where session_date = v_today and receptionist_name = 'Online';

  if v_session is null then
    insert into public.sessions (session_date, receptionist_name)
    values (v_today, 'Online')
    returning id into v_session;
  end if;

  insert into public.entries (
    session_id, entry_date, voucher_code, seat_number,
    time_in, duration_hrs, amount_paid
  ) values (
    v_session, v_today, v_code, null,
    v_now, v_order.duration_hrs, v_order.amount_ngn
  )
  returning * into v_entry;

  update public.orders
     set status = 'paid',
         voucher_code = v_code,
         entry_id = v_entry.id,
         paid_at = now()
   where id = v_order.id;

  return query select v_code, v_order.duration_hrs, v_entry.expires_at;
end;
$$;


-- ---------- 8. RLS ----------
alter table public.pricing enable row level security;
alter table public.orders  enable row level security;

drop policy if exists "anyone reads pricing" on public.pricing;
create policy "anyone reads pricing" on public.pricing
  for select to anon, authenticated using (is_active);

-- Orders are never readable from a browser. The success page looks a
-- purchase up through an edge function, not directly.
-- (No policy = no access for anon/authenticated.)


-- ---------- 9. GRANTS ----------
grant select on public.pricing  to anon, authenticated;
grant select on public.capacity to anon, authenticated;

grant select, insert, update on public.orders to service_role;
grant select, insert, update on public.sessions to service_role;
grant select, insert, update on public.entries  to service_role;
grant select on public.pricing to service_role;

grant execute on function public.issue_online_entry to service_role;
grant execute on function public.claim_voucher_and_log_entry to authenticated;

-- The public page needs live capacity, so entries changes must broadcast.
-- (entries is already in supabase_realtime from schema.sql.)
