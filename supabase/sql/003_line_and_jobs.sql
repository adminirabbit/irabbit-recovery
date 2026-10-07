-- =====================================================================
-- iRabbit Flood Recovery · 003_line_and_jobs.sql
-- ผูกบัญชี LINE + งานอัตโนมัติตามเวลา (ส่งงานเช้า, เตือน, ยกระดับ, สรุปเย็น)
-- เขียนเฉพาะ schema recovery
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- ผูก LINE ด้วยรหัส 6 หลัก (ขอจาก App → พิมพ์ส่งใน LINE OA)
-- ---------------------------------------------------------------------
create table recovery.line_link_codes (
  code       text primary key,
  user_id    text not null references recovery.app_users(id),
  expires_at timestamptz not null,
  used_at    timestamptz
);
alter table recovery.line_link_codes enable row level security;
grant all on recovery.line_link_codes to service_role;

create function recovery.create_line_link_code() returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_me text := recovery.me();
begin
  if v_me is null then raise exception 'กรุณาเข้าสู่ระบบ'; end if;
  delete from recovery.line_link_codes where user_id = v_me and used_at is null;
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from recovery.line_link_codes where code = v_code);
  end loop;
  insert into recovery.line_link_codes values (v_code, v_me, now() + interval '15 minutes', null);
  return v_code;
end $$;

-- เรียกโดย LINE webhook (service_role) เท่านั้น
create function recovery.link_line(p_code text, p_line_user_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select * into r from recovery.line_link_codes
   where code = p_code and used_at is null and expires_at > now();
  if r.code is null then return null; end if;
  update recovery.app_users set line_user_id = null where line_user_id = p_line_user_id;
  update recovery.app_users set line_user_id = p_line_user_id, updated_at = now() where id = r.user_id;
  update recovery.line_link_codes set used_at = now() where code = p_code;
  return (select nick from recovery.app_users where id = r.user_id);
end $$;
revoke all on function recovery.link_line(text, text) from public, anon, authenticated;
grant execute on function recovery.link_line(text, text) to service_role;

-- รายชื่อสำหรับหน้า Login (ชื่อเล่น + รหัส เท่านั้น)
create function recovery.login_names() returns table(id text, nick text)
language sql stable security definer set search_path = '' as $$
  select id, nick from recovery.app_users where active and auth_user_id is not null order by nick
$$;
revoke all on function recovery.login_names() from public;
grant execute on function recovery.login_names() to anon, authenticated, service_role;
grant usage on schema recovery to anon;

-- ---------------------------------------------------------------------
-- งานตามเวลา
-- ---------------------------------------------------------------------
create function recovery.task_line(t recovery.tasks) returns text
language sql immutable as $$
  select t.id || ' ' || t.title || ' · ' || t.status ||
         case when t.baseline_finish is not null then ' · กำหนด ' || to_char(t.baseline_finish, 'DD/MM') else '' end
$$;

-- 07:30 ส่งงานวันนี้รายคน
create function recovery.job_morning_brief() returns int
language plpgsql security definer set search_path = '' as $$
declare u record; v_body text; n int := 0;
begin
  for u in select * from recovery.app_users where active and line_user_id is not null loop
    select string_agg(recovery.task_line(t), E'\n' order by t.baseline_finish nulls last, t.id)
      into v_body
      from (select * from recovery.tasks t
             where t.parent_id is null and t.approval_status = 'อนุมัติแล้ว'
               and t.status in ('พร้อมทำ','กำลังทำ','แก้ไขงาน','ติดอุปสรรค')
               and (t.owner_user_id = u.id or u.id = any(t.team_user_ids))
             order by t.baseline_finish nulls last limit 8) t;
    if v_body is not null then
      perform recovery.enqueue('morning_brief', u.id, 'งานวันนี้ของ' || u.nick,
        v_body || E'\n\nสวม PPE ทุกครั้ง · ห้ามแตะปลั๊ก/ตู้ไฟจนกว่าจะมีประกาศปลดล็อก', null, null);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- 12:00 / 15:00 เตือนคนที่ยังไม่อัปเดต
create function recovery.job_update_reminder() returns int
language plpgsql security definer set search_path = '' as $$
declare u record; n int := 0;
begin
  for u in
    select a.id, a.nick, string_agg(t.id, ', ') as ids
      from recovery.app_users a
      join recovery.tasks t on (t.owner_user_id = a.id)
     where a.active and t.status in ('กำลังทำ','แก้ไขงาน')
       and coalesce(t.last_update_at, t.actual_start, '-infinity') < now() - interval '3 hours'
     group by a.id, a.nick
  loop
    perform recovery.enqueue('reminder', u.id, 'ยังไม่ได้อัปเดตงาน', u.ids || ' — กรุณาอัปเดต % และถ่ายรูป', null, null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ทุกชั่วโมง: ยกระดับปัญหา / งานรอตรวจนาน
create function recovery.job_escalation() returns int
language plpgsql security definer set search_path = '' as $$
declare
  h_block int := coalesce(recovery.setting('escalate_blocked_hours')::int, 2);
  h_qc    int := coalesce(recovery.setting('escalate_qc_hours')::int, 4);
  r record; m record; n int := 0;
begin
  -- ระดับ 1: แจ้งปู
  for r in select * from recovery.issues
            where status in ('เปิด','กำลังแก้') and escalation_level = 0
              and created_at < now() - make_interval(hours => h_block) loop
    for m in select id from recovery.app_users where active and role = 'manager' loop
      perform recovery.enqueue('escalation', m.id, 'ปัญหาค้างเกิน ' || h_block || ' ชม.',
        r.id || ' ' || r.title || coalesce(' (งาน ' || r.task_id || ')', ''), 'task', r.task_id);
    end loop;
    update recovery.issues set escalation_level = 1, escalated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  -- ระดับ 2: แจ้งปัญ
  for r in select * from recovery.issues
            where status in ('เปิด','กำลังแก้') and escalation_level = 1
              and created_at < now() - make_interval(hours => h_block * 2) loop
    for m in select id from recovery.app_users where active and role = 'admin' loop
      perform recovery.enqueue('escalation', m.id, 'ปัญหาค้างเกิน ' || (h_block * 2) || ' ชม.',
        r.id || ' ' || r.title || coalesce(' (งาน ' || r.task_id || ')', ''), 'task', r.task_id);
    end loop;
    update recovery.issues set escalation_level = 2, escalated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  -- งานรอตรวจนานเกินกำหนด (แจ้งวันละครั้งต่องาน)
  for r in select * from recovery.tasks
            where status = 'รอตรวจ' and last_update_at < now() - make_interval(hours => h_qc)
              and not exists (select 1 from recovery.notifications x
                               where x.kind = 'qc_overdue' and x.ref_id = tasks.id
                                 and x.created_at > now() - interval '20 hours') loop
    for m in select id from recovery.app_users where active and role in ('manager','inspector') loop
      perform recovery.enqueue('qc_overdue', m.id, 'งานรอตรวจเกิน ' || h_qc || ' ชม.', recovery.task_line(r), 'task', r.id);
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 18:00 สรุปเย็นถึงปัญ/ปู
create function recovery.job_evening_summary() returns int
language plpgsql security definer set search_path = '' as $$
declare d record; v_body text; v_late text; v_block text; v_done_today int; m record;
begin
  select * into d from recovery.v_dashboard;
  select count(*) into v_done_today from recovery.tasks
   where status = 'เสร็จ' and (actual_finish at time zone 'Asia/Bangkok')::date = recovery.today_th();
  select string_agg(id, ', ') into v_block from recovery.tasks where status = 'ติดอุปสรรค';
  select string_agg(id, ', ') into v_late from recovery.tasks
   where parent_id is null and status <> 'เสร็จ' and baseline_finish < recovery.today_th();
  v_body := 'คืบหน้ารวม ' || coalesce(d.progress_avg,0) || '% · เสร็จ ' || d.tasks_done || '/' || d.tasks_total ||
            E'\nเสร็จวันนี้ ' || v_done_today || ' · กำลังทำ ' || d.tasks_doing || ' · รอตรวจ ' || d.tasks_qc ||
            E'\nติดอุปสรรค ' || d.tasks_blocked || coalesce(' (' || v_block || ')', '') ||
            E'\nล่าช้า ' || d.tasks_late || coalesce(' (' || v_late || ')', '') ||
            E'\nรออนุมัติ ' || d.tasks_pending_approval || ' · ปัญหาเปิด ' || d.issues_open;
  for m in select id from recovery.app_users where active and role in ('admin','manager') loop
    perform recovery.enqueue('evening_summary', m.id, 'สรุปงานฟื้นฟู ' || to_char(recovery.today_th(), 'DD/MM'), v_body, null, null);
  end loop;
  if recovery.setting('line_group_id') is not null then
    insert into recovery.notifications(kind, to_group_id, title, body)
    values ('evening_summary', recovery.setting('line_group_id'), 'สรุปงานฟื้นฟู ' || to_char(recovery.today_th(), 'DD/MM'), v_body);
  end if;
  return 1;
end $$;

revoke all on function recovery.job_morning_brief(), recovery.job_update_reminder(),
                       recovery.job_escalation(), recovery.job_evening_summary() from public, anon, authenticated;
grant execute on function recovery.job_morning_brief(), recovery.job_update_reminder(),
                         recovery.job_escalation(), recovery.job_evening_summary() to service_role;


-- ---------------------------------------------------------------------
-- เพิ่ม "งานที่ต้องเสร็จก่อน" ภายหลัง: ถ้างานก่อนหน้ายังไม่เสร็จ ให้งานนี้กลับเป็น "ยังไม่เริ่ม"
-- ---------------------------------------------------------------------
create function recovery.tg_dep_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from recovery.tasks p where p.id = new.predecessor_id and p.status <> 'เสร็จ') then
    perform set_config('recovery.system', 'on', true);
    update recovery.tasks set status = 'ยังไม่เริ่ม' where id = new.task_id and status = 'พร้อมทำ';
    perform set_config('recovery.system', 'off', true);
  end if;
  return null;
end $$;
create trigger deps_after_insert after insert on recovery.task_dependencies
for each row execute function recovery.tg_dep_after_insert();

commit;
