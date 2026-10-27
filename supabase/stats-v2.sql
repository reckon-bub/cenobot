-- Статистика v2: честные цифры. Запусти целиком в SQL Editor → Run.

-- 1. Кого не считать (тесты)
create table if not exists public.stats_exclude (uid text primary key, note text);
insert into public.stats_exclude (uid, note)
select distinct uid, 'тест до запуска 27.10.2026' from public.events
on conflict do nothing;
insert into public.stats_exclude (uid, note) values
  ('tg74839361', 'Дима'), ('tg927801122', 'жена')
on conflict do nothing;
alter table public.stats_exclude enable row level security;

-- 2. Убираем старые сводки (их нельзя изменить поверх)
drop view if exists public.stats_daily, public.stats_totals, public.stats_items, public.events_clean cascade;

-- Чистые события
create view public.events_clean as
select * from public.events e
where not exists (select 1 from public.stats_exclude x where x.uid = e.uid);

-- 3. По дням
create view public.stats_daily as
select (created_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
       count(distinct tg_id)                                         as tg_users,
       count(distinct uid) filter (where tg_id is null)              as web_visitors,
       count(distinct uid)                                           as users,
       count(*) filter (where type in ('open','bot_start'))          as opens,
       count(*) filter (where type = 'check')                        as checks,
       count(*) filter (where type = 'photo')                        as photos,
       count(*) filter (where type = 'partner')                      as partner_clicks
from public.events_clean
group by 1;

-- 4. Итоги
create view public.stats_totals as
select count(distinct tg_id)                                                         as tg_users_all,
       count(distinct tg_id) filter (where created_at > now() - interval '30 days') as tg_users_30d,
       count(distinct tg_id) filter (where created_at > now() - interval '7 days')  as tg_users_7d,
       count(distinct uid) filter (where tg_id is null and created_at > now() - interval '30 days') as web_visitors_30d,
       count(*) filter (where type in ('check','photo'))                             as checks_all,
       count(*) filter (where type in ('check','photo') and created_at > now() - interval '30 days') as checks_30d,
       -- старые поля, чтобы ничего не сломалось
       count(distinct coalesce(tg_id::text, uid))                                    as users_all,
       count(distinct coalesce(tg_id::text, uid)) filter (where created_at > now() - interval '30 days') as users_30d,
       count(distinct coalesce(tg_id::text, uid)) filter (where created_at > now() - interval '7 days')  as users_7d
from public.events_clean;

-- 5. Топ товаров
create view public.stats_items as
select item, count(*) as checks, count(distinct coalesce(tg_id::text, uid)) as users,
       count(*) filter (where verdict = 'tourist') as tourist_verdicts
from public.events_clean
where type in ('check','photo') and item is not null and created_at > now() - interval '30 days'
group by item order by checks desc;

grant select on public.stats_daily, public.stats_totals, public.stats_items to anon, authenticated;
revoke all on public.events_clean from anon, authenticated;
