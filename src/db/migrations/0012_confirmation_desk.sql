-- Batch H, first half (2.1 review note 1, 3.2 note S7): the Confirmation Desk, Step 11.
--
-- An agent's attempts are the facts: each WhatsApp message or call, its outcome and who made it,
-- append-only. A confirmation is what they add up to: its state, attempt count and next due time
-- are derived from the attempts on every change (rule 7), by the confirmation recompute, and
-- never written by a route. Before the desk's first attempt on an order, the state comes from
-- the Shopify tags the team used until now (S7), so the history carries over.

create table confirmations (
  id              bigint generated always as identity primary key,
  -- One per online order. PR and consignment orders are never confirmed by phone.
  order_id        bigint not null unique references orders (id) on delete restrict,
  state           text not null check (state in ('pending', 'confirmed', 'no_answer', 'changed', 'cancelled', 'unreachable')),
  -- Where the state came from: the desk's attempts, the Shopify tags, or neither yet.
  source          text not null check (source in ('desk', 'shopify_tags', 'none')),
  -- Whoever recorded the latest attempt.
  agent_id        bigint references users (id) on delete restrict,
  -- Contacts made: every attempt except a follow-up scheduled without one.
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  outcome_reason  text,
  -- When the customer confirmed at the desk. Tag confirmations carry no time; the order's state
  -- log says when the system first saw them.
  confirmed_at    timestamptz,
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (source <> 'desk' or (state in ('confirmed', 'changed')) = (confirmed_at is not null)),
  check (source = 'desk' or attempts = 0)
);

-- The queue: open confirmations by when they are due.
create index confirmations_queue_idx on confirmations (next_attempt_at nulls first, order_id) where state in ('pending', 'no_answer');
create index confirmations_state_idx on confirmations (state);
create index confirmations_agent_idx on confirmations (agent_id) where agent_id is not null;

create trigger confirmations_updated_at before update on confirmations
  for each row execute function set_updated_at();

create table confirmation_attempts (
  id              bigint generated always as identity primary key,
  confirmation_id bigint not null references confirmations (id) on delete restrict,
  agent_id        bigint not null references users (id) on delete restrict,
  -- Null only for a follow-up scheduled without contacting the customer.
  channel         text check (channel in ('whatsapp', 'call')),
  at              timestamptz not null,
  outcome         text not null check (outcome in ('confirmed', 'changed', 'cancelled', 'no_answer', 'callback', 'wrong_number', 'rescheduled')),
  -- When to try again: the customer's requested time (callback), or the agent's (rescheduled).
  follow_up_at    timestamptz,
  -- Why the customer cancelled, or what they changed.
  reason          text,
  note            text,
  created_at      timestamptz not null default now(),
  check ((outcome = 'rescheduled') = (channel is null)),
  check ((outcome in ('callback', 'rescheduled')) = (follow_up_at is not null)),
  check (follow_up_at is null or follow_up_at > at)
);

create index confirmation_attempts_confirmation_idx on confirmation_attempts (confirmation_id, at, id);
-- Agent performance is per agent over a period.
create index confirmation_attempts_agent_idx on confirmation_attempts (agent_id, at);
create index confirmation_attempts_at_idx on confirmation_attempts (at);

-- Append-only, with one exception: GDPR redaction may clear the free text an agent typed, where
-- an address or a name can end up. Nothing else about an attempt ever changes.
create function confirmation_attempt_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'note' - 'reason') = (to_jsonb(old) - 'note' - 'reason')
     and new.note is null and new.reason is null then
    return new;
  end if;
  raise exception 'confirmation_attempts is append-only: % is not allowed', tg_op;
end;
$$;

create trigger confirmation_attempts_append_only before update or delete on confirmation_attempts
  for each row execute function confirmation_attempt_guard();

-- The customer-history card compares the order's city with the return rate of parcels there.
create index addresses_city_idx on addresses (lower(trim(city))) where city is not null;
