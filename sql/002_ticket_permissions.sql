-- Apply in Supabase SQL Editor as the project database owner.
-- Uses the current email identity mapping and BY: owner tags.
-- Does not migrate identity IDs, change ticket data or add transaction RPCs.
begin;

create or replace function public.ticket_board_member_v1()
returns text language sql stable security invoker set search_path = ''
as $$
  select m.name from public.members m
  where auth.uid() is not null
    and lower(m.email) = lower(auth.jwt() ->> 'email')
    and m.name in ('大瓜', '星黎', '薯饼', '村民', 'X')
$$;

create or replace function public.ticket_board_admin_v1()
returns boolean language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where auth.uid() is not null
      and lower(m.email) = lower(auth.jwt() ->> 'email')
      and m.is_admin is true
      and m.name in ('大瓜', '星黎', '薯饼', '村民', 'X')
  )
$$;

-- Match the frontend's first BY: tag, but reject ambiguous multiple tags.
create or replace function public.ticket_board_owner_v1(note_text text)
returns text language sql immutable security invoker set search_path = ''
as $$
  select case when count(*) = 1 then min(btrim(parts[1])) else null end
  from pg_catalog.regexp_matches(coalesce(note_text, ''), 'BY:([^]]+)', 'g') as r(parts)
$$;

revoke all on function public.ticket_board_member_v1() from public, anon;
revoke all on function public.ticket_board_admin_v1() from public, anon;
revoke all on function public.ticket_board_owner_v1(text) from public, anon;
grant execute on function public.ticket_board_member_v1() to authenticated;
grant execute on function public.ticket_board_admin_v1() to authenticated;
grant execute on function public.ticket_board_owner_v1(text) to authenticated;

-- Match the five claimable names already used by the website.
alter policy members_self_insert on public.members to authenticated
with check (
  auth.uid() is not null
  and lower(email) = lower(auth.jwt() ->> 'email')
  and name in ('大瓜', '星黎', '薯饼', '村民', 'X')
  and is_admin is false
);

alter table public.tickets enable row level security;
alter table public.ticket_logs enable row level security;

-- Remove the broad permissive policies: adding narrow ones alone is insufficient.
drop policy if exists auth_full_tickets on public.tickets;
drop policy if exists auth_full_logs on public.ticket_logs;

drop policy if exists board_tickets_read_v1 on public.tickets;
create policy board_tickets_read_v1 on public.tickets
for select to authenticated
using (public.ticket_board_member_v1() is not null);

drop policy if exists board_tickets_insert_v1 on public.tickets;
create policy board_tickets_insert_v1 on public.tickets
for insert to authenticated
with check (
  public.ticket_board_admin_v1()
  or public.ticket_board_owner_v1(note) = public.ticket_board_member_v1()
);

drop policy if exists board_tickets_update_v1 on public.tickets;
create policy board_tickets_update_v1 on public.tickets
for update to authenticated
using (
  public.ticket_board_admin_v1()
  or public.ticket_board_owner_v1(note) = public.ticket_board_member_v1()
)
with check (
  public.ticket_board_admin_v1()
  or (
    public.ticket_board_member_v1() is not null
    and public.ticket_board_owner_v1(note) in ('大瓜', '星黎', '薯饼', '村民', 'X')
  )
);

-- USING checks the old owner; WITH CHECK allows that owner to transfer the ticket.
-- Unclaimed names remain valid transfer targets, matching the existing dropdown.
drop policy if exists board_tickets_delete_v1 on public.tickets;
create policy board_tickets_delete_v1 on public.tickets
for delete to authenticated
using (
  public.ticket_board_admin_v1()
  or public.ticket_board_owner_v1(note) = public.ticket_board_member_v1()
);

drop policy if exists board_logs_read_v1 on public.ticket_logs;
create policy board_logs_read_v1 on public.ticket_logs
for select to authenticated
using (public.ticket_board_member_v1() is not null);

-- Keep current frontend logging compatible; bind its operator to the caller.
-- Action/detail are still client-supplied, not a tamper-proof audit trail.
drop policy if exists board_logs_insert_v1 on public.ticket_logs;
create policy board_logs_insert_v1 on public.ticket_logs
for insert to authenticated
with check (operator = public.ticket_board_member_v1());

drop policy if exists board_logs_delete_v1 on public.ticket_logs;
create policy board_logs_delete_v1 on public.ticket_logs
for delete to authenticated
using (public.ticket_board_admin_v1());

-- There is intentionally no log UPDATE policy. RLS does not cover TRUNCATE.
revoke truncate on public.members, public.tickets, public.ticket_logs
from public, anon, authenticated;

commit;
