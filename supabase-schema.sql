create extension if not exists pgcrypto;

create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'lobby' check (status in ('lobby', 'choosing', 'playing', 'finished')),
  min_value integer not null,
  max_value integer not null,
  current_turn_slot integer,
  winner_slot integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_value < max_value),
  check (winner_slot is null or winner_slot in (1, 2)),
  check (current_turn_slot is null or current_turn_slot in (1, 2))
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  nickname text not null check (char_length(trim(nickname)) between 1 and 18),
  slot integer not null check (slot in (1, 2)),
  is_host boolean not null default false,
  has_submitted_secret boolean not null default false,
  created_at timestamptz not null default now(),
  unique (room_id, slot)
);

create table if not exists public.private_player_states (
  player_id uuid primary key references public.room_players(id) on delete cascade,
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  session_id text not null unique,
  secret_number integer,
  range_low integer,
  range_high integer,
  created_at timestamptz not null default now()
);

create table if not exists public.game_guesses (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  turn_no integer not null,
  guesser_player_id uuid not null references public.room_players(id) on delete cascade,
  guesser_slot integer not null check (guesser_slot in (1, 2)),
  guesser_nickname text not null,
  guess_value integer not null,
  result text not null check (result in ('higher', 'lower', 'correct')),
  visible_low integer not null,
  visible_high integer not null,
  created_at timestamptz not null default now(),
  unique (room_id, turn_no)
);

create index if not exists idx_room_players_room_id on public.room_players(room_id);
create index if not exists idx_private_player_states_room_id on public.private_player_states(room_id);
create index if not exists idx_private_player_states_session_id on public.private_player_states(session_id);
create index if not exists idx_game_guesses_room_id on public.game_guesses(room_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_game_rooms_updated_at on public.game_rooms;
create trigger trg_touch_game_rooms_updated_at
before update on public.game_rooms
for each row
execute function public.touch_updated_at();

create or replace function public.generate_room_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
begin
  loop
    candidate := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (
      select 1
      from public.game_rooms
      where code = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function public.create_room(
  _session_id text,
  _nickname text,
  _min_value integer,
  _max_value integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_player_id uuid;
  v_code text;
  v_nickname text;
begin
  v_nickname := left(trim(coalesce(_nickname, '')), 18);

  if v_nickname = '' then
    raise exception 'nickname required';
  end if;

  if _session_id is null or trim(_session_id) = '' then
    raise exception 'session id required';
  end if;

  if _min_value is null or _max_value is null or _min_value >= _max_value then
    raise exception 'invalid range';
  end if;

  v_code := public.generate_room_code();

  insert into public.game_rooms (code, min_value, max_value, status, current_turn_slot, winner_slot)
  values (v_code, _min_value, _max_value, 'lobby', null, null)
  returning id into v_room_id;

  insert into public.room_players (room_id, nickname, slot, is_host, has_submitted_secret)
  values (v_room_id, v_nickname, 1, true, false)
  returning id into v_player_id;

  insert into public.private_player_states (player_id, room_id, session_id, secret_number, range_low, range_high)
  values (v_player_id, v_room_id, trim(_session_id), null, null, null);

  return jsonb_build_object('code', v_code);
end;
$$;

create or replace function public.join_room(
  _code text,
  _session_id text,
  _nickname text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_existing_player uuid;
  v_count integer;
  v_slot integer;
  v_player_id uuid;
  v_nickname text;
begin
  v_nickname := left(trim(coalesce(_nickname, '')), 18);

  if v_nickname = '' then
    raise exception 'nickname required';
  end if;

  if _session_id is null or trim(_session_id) = '' then
    raise exception 'session id required';
  end if;

  select *
  into v_room
  from public.game_rooms
  where code = upper(trim(_code));

  if not found then
    raise exception 'room not found';
  end if;

  select ps.player_id
  into v_existing_player
  from public.private_player_states ps
  where ps.room_id = v_room.id
    and ps.session_id = trim(_session_id)
  limit 1;

  if v_existing_player is not null then
    return jsonb_build_object('code', v_room.code, 'joined', true, 'rejoined', true);
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'already in progress';
  end if;

  select count(*)
  into v_count
  from public.room_players rp
  where rp.room_id = v_room.id;

  if v_count >= 2 then
    raise exception 'room is full';
  end if;

  select gs.slot
  into v_slot
  from generate_series(1, 2) as gs(slot)
  where not exists (
    select 1
    from public.room_players rp
    where rp.room_id = v_room.id
      and rp.slot = gs.slot
  )
  order by gs.slot
  limit 1;

  insert into public.room_players (room_id, nickname, slot, is_host, has_submitted_secret)
  values (v_room.id, v_nickname, v_slot, false, false)
  returning id into v_player_id;

  insert into public.private_player_states (player_id, room_id, session_id, secret_number, range_low, range_high)
  values (v_player_id, v_room.id, trim(_session_id), null, null, null);

  return jsonb_build_object('code', v_room.code, 'joined', true);
end;
$$;

create or replace function public.update_room_range(
  _code text,
  _session_id text,
  _min_value integer,
  _max_value integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_is_host boolean;
begin
  if _min_value is null or _max_value is null or _min_value >= _max_value then
    raise exception 'invalid range';
  end if;

  select *
  into v_room
  from public.game_rooms
  where code = upper(trim(_code))
  limit 1;

  if not found then
    raise exception 'room not found';
  end if;

  select rp.is_host
  into v_is_host
  from public.room_players rp
  join public.private_player_states ps on ps.player_id = rp.id
  where rp.room_id = v_room.id
    and ps.session_id = trim(_session_id)
  limit 1;

  if not found then
    raise exception 'not in room';
  end if;

  if not v_is_host then
    raise exception 'host only';
  end if;

  if v_room.status not in ('lobby', 'finished') then
    raise exception 'lobby only';
  end if;

  update public.game_rooms
  set min_value = _min_value,
      max_value = _max_value
  where id = v_room.id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.start_round(
  _code text,
  _session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_is_host boolean;
  v_count integer;
begin
  select *
  into v_room
  from public.game_rooms
  where code = upper(trim(_code))
  limit 1;

  if not found then
    raise exception 'room not found';
  end if;

  select rp.is_host
  into v_is_host
  from public.room_players rp
  join public.private_player_states ps on ps.player_id = rp.id
  where rp.room_id = v_room.id
    and ps.session_id = trim(_session_id)
  limit 1;

  if not found then
    raise exception 'not in room';
  end if;

  if not v_is_host then
    raise exception 'host only';
  end if;

  if v_room.status not in ('lobby', 'finished') then
    raise exception 'already in progress';
  end if;

  select count(*)
  into v_count
  from public.room_players rp
  where rp.room_id = v_room.id;

  if v_count <> 2 then
    raise exception 'two players required';
  end if;

  delete from public.game_guesses
  where room_id = v_room.id;

  update public.room_players
  set has_submitted_secret = false
  where room_id = v_room.id;

  update public.private_player_states
  set secret_number = null,
      range_low = null,
      range_high = null
  where room_id = v_room.id;

  update public.game_rooms
  set status = 'choosing',
      current_turn_slot = 1,
      winner_slot = null
  where id = v_room.id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.submit_secret_number(
  _code text,
  _session_id text,
  _secret_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_player_id uuid;
  v_ready_count integer;
begin
  select *
  into v_room
  from public.game_rooms
  where code = upper(trim(_code))
  limit 1;

  if not found then
    raise exception 'room not found';
  end if;

  select rp.id
  into v_player_id
  from public.room_players rp
  join public.private_player_states ps on ps.player_id = rp.id
  where rp.room_id = v_room.id
    and ps.session_id = trim(_session_id)
  limit 1;

  if not found then
    raise exception 'not in room';
  end if;

  if v_room.status <> 'choosing' then
    raise exception 'choosing phase required';
  end if;

  if _secret_number is null then
    raise exception 'secret number required';
  end if;

  if _secret_number < v_room.min_value or _secret_number > v_room.max_value then
    raise exception 'secret number out of range';
  end if;

  update public.private_player_states
  set secret_number = _secret_number,
      range_low = v_room.min_value,
      range_high = v_room.max_value
  where player_id = v_player_id;

  update public.room_players
  set has_submitted_secret = true
  where id = v_player_id;

  select count(*)
  into v_ready_count
  from public.room_players rp
  where rp.room_id = v_room.id
    and rp.has_submitted_secret = true;

  if v_ready_count = 2 then
    update public.game_rooms
    set status = 'playing',
        current_turn_slot = 1,
        winner_slot = null
    where id = v_room.id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.make_guess(
  _code text,
  _session_id text,
  _guess_value integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_player public.room_players%rowtype;
  v_private public.private_player_states%rowtype;
  v_opponent public.room_players%rowtype;
  v_opponent_private public.private_player_states%rowtype;
  v_new_low integer;
  v_new_high integer;
  v_result text;
  v_turn_no integer;
begin
  select *
  into v_room
  from public.game_rooms
  where code = upper(trim(_code))
  limit 1;

  if not found then
    raise exception 'room not found';
  end if;

  select rp.*
  into v_player
  from public.room_players rp
  join public.private_player_states ps on ps.player_id = rp.id
  where rp.room_id = v_room.id
    and ps.session_id = trim(_session_id)
  limit 1;

  if not found then
    raise exception 'not in room';
  end if;

  select *
  into v_private
  from public.private_player_states
  where player_id = v_player.id
  limit 1;

  if v_room.status <> 'playing' then
    raise exception 'playing phase required';
  end if;

  if v_room.current_turn_slot <> v_player.slot then
    raise exception 'not your turn';
  end if;

  if _guess_value is null then
    raise exception 'guess required';
  end if;

  if _guess_value < v_room.min_value or _guess_value > v_room.max_value then
    raise exception 'guess out of range';
  end if;

  if v_private.range_low is not null and _guess_value < v_private.range_low then
    raise exception 'guess out of visible range';
  end if;

  if v_private.range_high is not null and _guess_value > v_private.range_high then
    raise exception 'guess out of visible range';
  end if;

  select *
  into v_opponent
  from public.room_players rp
  where rp.room_id = v_room.id
    and rp.slot <> v_player.slot
  limit 1;

  if not found then
    raise exception 'two players required';
  end if;

  select *
  into v_opponent_private
  from public.private_player_states ps
  where ps.player_id = v_opponent.id
  limit 1;

  if v_opponent_private.secret_number is null then
    raise exception 'secret number missing';
  end if;

  if _guess_value < v_opponent_private.secret_number then
    v_result := 'higher';
    v_new_low := greatest(coalesce(v_private.range_low, v_room.min_value), _guess_value + 1);
    v_new_high := coalesce(v_private.range_high, v_room.max_value);
  elsif _guess_value > v_opponent_private.secret_number then
    v_result := 'lower';
    v_new_low := coalesce(v_private.range_low, v_room.min_value);
    v_new_high := least(coalesce(v_private.range_high, v_room.max_value), _guess_value - 1);
  else
    v_result := 'correct';
    v_new_low := _guess_value;
    v_new_high := _guess_value;
  end if;

  select coalesce(max(turn_no), 0) + 1
  into v_turn_no
  from public.game_guesses gg
  where gg.room_id = v_room.id;

  update public.private_player_states
  set range_low = v_new_low,
      range_high = v_new_high
  where player_id = v_player.id;

  insert into public.game_guesses (
    room_id,
    turn_no,
    guesser_player_id,
    guesser_slot,
    guesser_nickname,
    guess_value,
    result,
    visible_low,
    visible_high
  )
  values (
    v_room.id,
    v_turn_no,
    v_player.id,
    v_player.slot,
    v_player.nickname,
    _guess_value,
    v_result,
    v_new_low,
    v_new_high
  );

  if v_result = 'correct' then
    update public.game_rooms
    set status = 'finished',
        winner_slot = v_player.slot,
        current_turn_slot = v_player.slot
    where id = v_room.id;
  else
    update public.game_rooms
    set current_turn_slot = v_opponent.slot
    where id = v_room.id;
  end if;

  return jsonb_build_object(
    'result', v_result,
    'visible_low', v_new_low,
    'visible_high', v_new_high
  );
end;
$$;

create or replace function public.get_room_state(
  _code text,
  _session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.game_rooms%rowtype;
  v_you record;
  v_players jsonb;
  v_guesses jsonb;
  v_opponent jsonb;
begin
  select *
  into v_room
  from public.game_rooms
  where code = upper(trim(_code))
  limit 1;

  if not found then
    return null;
  end if;

  select
    rp.id,
    rp.nickname,
    rp.slot,
    rp.is_host,
    rp.has_submitted_secret,
    ps.secret_number,
    ps.range_low,
    ps.range_high
  into v_you
  from public.room_players rp
  join public.private_player_states ps on ps.player_id = rp.id
  where rp.room_id = v_room.id
    and ps.session_id = trim(_session_id)
  limit 1;

  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', rp.id,
        'nickname', rp.nickname,
        'slot', rp.slot,
        'is_host', rp.is_host,
        'has_submitted_secret', rp.has_submitted_secret,
        'is_you', rp.id = v_you.id
      )
      order by rp.slot
    ),
    '[]'::jsonb
  )
  into v_players
  from public.room_players rp
  where rp.room_id = v_room.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', gg.id,
        'turn_no', gg.turn_no,
        'guesser_player_id', gg.guesser_player_id,
        'guesser_slot', gg.guesser_slot,
        'guesser_nickname', gg.guesser_nickname,
        'guess_value', gg.guess_value,
        'result', gg.result,
        'visible_low', gg.visible_low,
        'visible_high', gg.visible_high,
        'created_at', gg.created_at
      )
      order by gg.turn_no
    ),
    '[]'::jsonb
  )
  into v_guesses
  from public.game_guesses gg
  where gg.room_id = v_room.id;

  select jsonb_build_object(
    'id', rp.id,
    'nickname', rp.nickname,
    'slot', rp.slot,
    'is_host', rp.is_host,
    'has_submitted_secret', rp.has_submitted_secret,
    'revealed_secret_number', case when v_room.status = 'finished' then ps.secret_number else null end
  )
  into v_opponent
  from public.room_players rp
  join public.private_player_states ps on ps.player_id = rp.id
  where rp.room_id = v_room.id
    and rp.id <> v_you.id
  limit 1;

  return jsonb_build_object(
    'room', jsonb_build_object(
      'id', v_room.id,
      'code', v_room.code,
      'status', v_room.status,
      'min_value', v_room.min_value,
      'max_value', v_room.max_value,
      'current_turn_slot', v_room.current_turn_slot,
      'winner_slot', v_room.winner_slot,
      'created_at', v_room.created_at,
      'updated_at', v_room.updated_at
    ),
    'you', jsonb_build_object(
      'id', v_you.id,
      'nickname', v_you.nickname,
      'slot', v_you.slot,
      'is_host', v_you.is_host,
      'has_submitted_secret', v_you.has_submitted_secret,
      'secret_number', v_you.secret_number,
      'range_low', v_you.range_low,
      'range_high', v_you.range_high
    ),
    'opponent', coalesce(v_opponent, '{}'::jsonb),
    'players', v_players,
    'guesses', v_guesses
  );
end;
$$;

alter table public.game_rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.private_player_states enable row level security;
alter table public.game_guesses enable row level security;

grant execute on function public.generate_room_code() to anon, authenticated, service_role;
grant execute on function public.create_room(text, text, integer, integer) to anon, authenticated, service_role;
grant execute on function public.join_room(text, text, text) to anon, authenticated, service_role;
grant execute on function public.update_room_range(text, text, integer, integer) to anon, authenticated, service_role;
grant execute on function public.start_round(text, text) to anon, authenticated, service_role;
grant execute on function public.submit_secret_number(text, text, integer) to anon, authenticated, service_role;
grant execute on function public.make_guess(text, text, integer) to anon, authenticated, service_role;
grant execute on function public.get_room_state(text, text) to anon, authenticated, service_role;
