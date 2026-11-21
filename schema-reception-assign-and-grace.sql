-- LAS NOCHES — reception assignment and 3-minute grace
-- Run this in Supabase SQL Editor once.

-- Add 3 minutes to every entry's expiry/time-out.
create or replace function public.entries_apply_paid_grace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.time_in is not null and new.duration_hrs is not null then
    new.expires_at := ((new.entry_date::timestamp + new.time_in)
                      + (new.duration_hrs * interval '1 hour')
                      + interval '3 minutes') at time zone 'Africa/Lagos';
  end if;
  return new;
end;
$$;

drop trigger if exists entries_apply_paid_grace on public.entries;
create trigger entries_apply_paid_grace
before insert or update of time_in, duration_hrs, entry_date on public.entries
for each row execute function public.entries_apply_paid_grace();

-- Allow a receptionist to assign an online entry to seat 1-15 or Couch (16).
create or replace function public.assign_entry_seat(
  p_entry_id uuid,
  p_seat_number int
)
returns public.entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.entries;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_seat_number not between 1 and 16 then
    raise exception 'INVALID_SEAT';
  end if;

  if p_seat_number between 1 and 15 and exists (
    select 1
    from public.entries
    where seat_number = p_seat_number
      and id <> p_entry_id
      and time_out is null
      and expires_at > now()
  ) then
    raise exception 'SEAT_OCCUPIED';
  end if;

  update public.entries
     set seat_number = p_seat_number
   where id = p_entry_id
  returning * into v_entry;

  if v_entry.id is null then
    raise exception 'ENTRY_NOT_FOUND';
  end if;

  return v_entry;
end;
$$;

grant execute on function public.assign_entry_seat(uuid, int) to authenticated;

-- Backfill entries already in the database.
update public.entries
set expires_at = (((entry_date::timestamp + time_in)
                  + (duration_hrs * interval '1 hour')
                  + interval '3 minutes') at time zone 'Africa/Lagos')
where time_in is not null and duration_hrs is not null;
