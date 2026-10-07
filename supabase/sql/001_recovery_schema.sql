-- =====================================================================
-- iRabbit Flood Recovery · 001_recovery_schema.sql
-- สร้างระบบติดตามงานฟื้นฟูหลังน้ำลด (Phase A) ใน schema "recovery"
--
-- กติกาความปลอดภัยต่อ HK03 / Payroll:
--   * สร้างของใหม่ใน schema recovery เท่านั้น
--   * ไม่มี DROP / ALTER / DELETE / UPDATE / INSERT ใดๆ ต่อ schema public
--   * อ่าน public.staff_roster ได้อย่างเดียว (ใช้จับคู่รหัสพนักงาน)
--   * ไม่อ่านตารางเงินเดือนใดๆ
--   * ไฟล์นี้รันซ้ำไม่ได้ ถ้ามี schema recovery อยู่แล้วจะหยุดทันที
-- =====================================================================

begin;  -- ทั้งไฟล์เป็นธุรกรรมเดียว: ถ้าผิดพลาดตรงไหน จะยกเลิกทั้งหมด ไม่มีอะไรค้าง

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'recovery') then
    raise exception 'schema recovery มีอยู่แล้ว — หยุดเพื่อป้องกันการสร้างซ้ำ';
  end if;
end $$;

create schema recovery;
comment on schema recovery is 'iRabbit ระบบติดตามงานฟื้นฟูหลังน้ำลด (แยกจาก HK03/Payroll)';

-- ---------------------------------------------------------------------
-- 1. ตั้งค่า
-- ---------------------------------------------------------------------
create table recovery.settings (
  key        text primary key,
  value      text not null,
  note       text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. ผู้ใช้และสิทธิ์
--    role: admin | manager | finance | admin_support | inspector | technician | staff | contractor
-- ---------------------------------------------------------------------
create table recovery.app_users (
  id            text primary key,                 -- USER-001 (จาก Master XLSX)
  nick          text not null unique,             -- ชื่อเล่นที่ใช้ในงาน
  position      text,
  duty          text,
  role          text not null default 'staff'
                check (role in ('admin','manager','finance','admin_support','inspector','technician','staff','contractor')),
  lang          text not null default 'th' check (lang in ('th','my')),
  staff_code    text,                             -- รหัสใน public.staff_roster (อ่านอย่างเดียว ไม่ผูก FK)
  auth_user_id  uuid unique,                      -- Supabase Auth user
  line_user_id  text unique,                      -- LINE userId หลังผูกบัญชี
  active        boolean not null default true,
  day1_status   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. พื้นที่
-- ---------------------------------------------------------------------
create table recovery.zones (
  id            text primary key,                 -- ZONE-OFF
  name          text not null unique,             -- ออฟฟิศ
  owner_text    text,
  priority      text check (priority in ('วิกฤต','สูง','ปานกลาง','ต่ำ')),
  initial_state text,
  sort_order    int,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. จุดตรวจ QC
-- ---------------------------------------------------------------------
create table recovery.qc_gates (
  id           text primary key,                  -- QC-CLN
  name         text not null,
  stages       int  not null check (stages in (1,2)),
  inspector    text,
  pass_criteria text,
  evidence_req text,
  on_fail      text
);

-- ---------------------------------------------------------------------
-- 5. งาน (งานหลัก + ขั้นตอนย่อยหน้างาน)
-- ---------------------------------------------------------------------
create table recovery.tasks (
  id               text primary key,              -- OFF-001 / ขั้นตอนย่อย: OFF-001.S01
  parent_id        text references recovery.tasks(id),
  step_no          int,                           -- ลำดับขั้นตอนย่อย
  category         text not null,
  zone_id          text references recovery.zones(id),
  area_text        text,                          -- ชื่อพื้นที่ตาม Master (บางงานคร่อมหลายพื้นที่)
  title            text not null,
  title_my         text,                          -- คำสั่งภาษาพม่า (ถ้ามี)
  owner_user_id    text references recovery.app_users(id),
  owner_text       text,                          -- เจ้าของงานที่ไม่ใช่พนักงาน เช่น ช่างไฟภายนอก
  team_text        text,
  team_user_ids    text[] not null default '{}',
  priority         text check (priority in ('วิกฤต','สูง','ปานกลาง','ต่ำ')),
  dep_mode         text not null default 'ยืดหยุ่น' check (dep_mode in ('ห้ามข้าม','ยืดหยุ่น')),
  status           text not null default 'ยังไม่เริ่ม'
                   check (status in ('ยังไม่เริ่ม','พร้อมทำ','กำลังทำ','รอตรวจ','แก้ไขงาน','เสร็จ','ติดอุปสรรค','พัก/รอตัดสินใจ')),
  progress         int  not null default 0 check (progress between 0 and 100),
  -- แผน: Baseline (ล็อกแล้วห้ามแก้) / Forecast / Actual
  baseline_start   date,
  baseline_finish  date,
  forecast_finish  date,
  actual_start     timestamptz,
  actual_finish    timestamptz,
  delay_reason     text check (delay_reason in ('ช่าง/ผู้รับเหมา','วัสดุ','คน','อุปกรณ์','งานก่อนหน้า','พบความเสียหายใหม่',
                                                 'ไม่ปลอดภัย','สภาพอากาศ','น้ำ/สภาพพื้นที่','รอเจ้าของอนุมัติ','พักเพื่อเคลม',
                                                 'ไฟฟ้า','ระบบไอที/ข้อมูล','อื่นๆ')),
  qc_requirement   text check (qc_requirement in ('ต้องมี','ต้องอนุมัติ','ไม่เกี่ยวข้อง')),
  qc_gate_id       text references recovery.qc_gates(id),
  evidence_req     text,
  definition_of_done text,
  safety_note      text,
  safety_note_my   text,
  claimable        text check (claimable in ('เคลมได้','อาจเคลมได้','ไม่เคลม','รอตรวจ')),
  -- งานที่ผู้ใช้เสนอเพิ่มหน้างาน
  source           text not null default 'master' check (source in ('master','field_step','field_proposal')),
  approval_status  text not null default 'อนุมัติแล้ว' check (approval_status in ('รออนุมัติ','อนุมัติแล้ว','ไม่อนุมัติ')),
  approved_by      text references recovery.app_users(id),
  approved_at      timestamptz,
  created_by       text references recovery.app_users(id),
  note             text,
  last_update_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create index on recovery.tasks(parent_id);
create index on recovery.tasks(zone_id);
create index on recovery.tasks(owner_user_id);
create index on recovery.tasks(status);

-- งานที่ต้องเสร็จก่อน
create table recovery.task_dependencies (
  task_id         text not null references recovery.tasks(id) on delete cascade,
  predecessor_id  text not null references recovery.tasks(id),
  primary key (task_id, predecessor_id),
  check (task_id <> predecessor_id)
);

-- ประวัติการอัปเดตงาน
create table recovery.task_updates (
  id           bigint generated always as identity primary key,
  task_id      text not null references recovery.tasks(id),
  user_id      text references recovery.app_users(id),
  old_status   text,
  new_status   text,
  old_progress int,
  new_progress int,
  note         text,
  created_at   timestamptz not null default now()
);
create index on recovery.task_updates(task_id, created_at desc);

-- ---------------------------------------------------------------------
-- 6. หลักฐาน (รูป/ไฟล์) — 1 รายการ = 1 ไฟล์, ผูกได้หลายเรื่อง
-- ---------------------------------------------------------------------
create table recovery.evidence (
  id             bigint generated always as identity primary key,
  storage_path   text not null unique,            -- path ใน bucket recovery-evidence
  original_name  text,
  mime_type      text,
  size_bytes     bigint,
  width_px       int,
  height_px      int,
  quality_tier   text not null default 'general' check (quality_tier in ('claim','general')),
  stage          text check (stage in ('ก่อน','ระหว่าง','หลัง','ทดสอบ','ใบเสร็จ','สลิป','อื่นๆ')),
  caption        text,
  sort_order     int not null default 0,
  taken_at       timestamptz,
  uploaded_by    text references recovery.app_users(id),
  uploaded_at    timestamptz not null default now(),
  is_cancelled   boolean not null default false,
  cancel_reason  text
);

create table recovery.evidence_links (
  evidence_id   bigint not null references recovery.evidence(id),
  object_type   text   not null check (object_type in ('task','issue','qc','damage','expense','claim','asset','zone')),
  object_id     text   not null,
  linked_by     text references recovery.app_users(id),
  linked_at     timestamptz not null default now(),
  unlinked_at   timestamptz,
  unlink_reason text,
  primary key (evidence_id, object_type, object_id)
);
create index on recovery.evidence_links(object_type, object_id);

-- ---------------------------------------------------------------------
-- 7. ปัญหา/อุปสรรค (Issue)
-- ---------------------------------------------------------------------
create sequence recovery.issue_seq;
create table recovery.issues (
  id            text primary key default 'ISS-' || lpad(nextval('recovery.issue_seq')::text, 4, '0'),
  task_id       text references recovery.tasks(id),
  zone_id       text references recovery.zones(id),
  title         text not null,
  reason        text,
  severity      text not null default 'ปานกลาง' check (severity in ('วิกฤต','สูง','ปานกลาง','ต่ำ')),
  blocks_opening boolean not null default false,
  source        text not null default 'field' check (source in ('field','qc')),
  owner_user_id text references recovery.app_users(id),
  status        text not null default 'เปิด' check (status in ('เปิด','กำลังแก้','แก้แล้ว','ปิด')),
  due_at        timestamptz,
  resolved_at   timestamptz,
  created_by    text references recovery.app_users(id),
  created_at    timestamptz not null default now(),
  escalated_at  timestamptz,
  escalation_level int not null default 0
);

-- ---------------------------------------------------------------------
-- 8. ผลตรวจ QC (เก็บทุกรอบ = Rework history)
-- ---------------------------------------------------------------------
create table recovery.qc_reviews (
  id           bigint generated always as identity primary key,
  task_id      text not null references recovery.tasks(id),
  gate_id      text references recovery.qc_gates(id),
  round_no     int  not null default 1,
  stage        int  not null default 1 check (stage in (1,2)),
  inspector_id text references recovery.app_users(id),
  result       text not null check (result in ('ผ่าน','ให้แก้ไข','พบปัญหาใหม่')),
  reason       text,
  issue_id     text references recovery.issues(id),
  created_at   timestamptz not null default now(),
  check (result = 'ผ่าน' or coalesce(length(trim(reason)),0) > 0)
);
create index on recovery.qc_reviews(task_id, created_at desc);

-- ---------------------------------------------------------------------
-- 9. การแจ้งเตือน (คิวส่ง LINE + ประวัติ)
-- ---------------------------------------------------------------------
create table recovery.notifications (
  id           bigint generated always as identity primary key,
  kind         text not null,          -- morning_brief | unlock | reminder | escalation | qc_queue | evening_summary | issue
  to_user_id   text references recovery.app_users(id),
  to_group_id  text,                   -- LINE groupId
  title        text,
  body         text not null,
  deep_link    text,
  ref_type     text,
  ref_id       text,
  status       text not null default 'รอส่ง' check (status in ('รอส่ง','ส่งแล้ว','ส่งไม่สำเร็จ','ข้าม')),
  error        text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index on recovery.notifications(status, created_at);

-- ---------------------------------------------------------------------
-- 10. Audit log
-- ---------------------------------------------------------------------
create table recovery.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  row_id      text,
  action      text not null,
  actor       text,                    -- app_users.id หรือ 'system'
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);
create index on recovery.audit_log(table_name, row_id);

create sequence recovery.task_new_seq;

-- =====================================================================
-- ฟังก์ชันช่วยเรื่องสิทธิ์
-- =====================================================================
create function recovery.me() returns text
language sql stable security definer set search_path = '' as $$
  select id from recovery.app_users where auth_user_id = auth.uid() and active
$$;

create function recovery.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from recovery.app_users where auth_user_id = auth.uid() and active
$$;

create function recovery.is_lead() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role in ('admin','manager') from recovery.app_users
                   where auth_user_id = auth.uid() and active), false)
$$;

create function recovery.setting(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select value from recovery.settings where key = p_key
$$;

-- เวลาไทย
create function recovery.today_th() returns date
language sql stable as $$ select (now() at time zone 'Asia/Bangkok')::date $$;

-- =====================================================================
-- Audit log (ทุกตารางสำคัญ)
-- =====================================================================
create function recovery.tg_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  v_id := coalesce(
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'id',
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'task_id');
  insert into recovery.audit_log(table_name, row_id, action, actor, old_data, new_data)
  values (tg_table_name, v_id, tg_op, coalesce(recovery.me(), 'system'),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return null;
end $$;

-- =====================================================================
-- แจ้งเตือน: ใส่คิว (ตัวส่ง LINE จะมาหยิบไปส่ง)
-- =====================================================================
create function recovery.enqueue(p_kind text, p_to text, p_title text, p_body text,
                                 p_ref_type text default null, p_ref_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_to is null then return; end if;
  insert into recovery.notifications(kind, to_user_id, title, body, ref_type, ref_id, deep_link)
  values (p_kind, p_to, p_title, p_body, p_ref_type, p_ref_id,
          case when p_ref_type = 'task' then '#task/' || p_ref_id end);
end $$;

-- =====================================================================
-- Trigger งาน: ก่อนบันทึก
-- =====================================================================
create function recovery.tg_tasks_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_lead   boolean := recovery.is_lead() or current_setting('recovery.system', true) = 'on';
  v_me     text    := recovery.me();
  v_n      int;
  v_open   text;
begin
  -- ---------- INSERT ----------
  if tg_op = 'INSERT' then
    if new.source = 'field_step' then
      if new.parent_id is null then raise exception 'ขั้นตอนย่อยต้องอยู่ใต้งานหลัก'; end if;
      select coalesce(max(step_no), 0) + 1 into v_n from recovery.tasks where parent_id = new.parent_id;
      new.step_no := coalesce(new.step_no, v_n);
      new.id := coalesce(new.id, new.parent_id || '.S' || lpad(new.step_no::text, 2, '0'));
      -- สืบค่าจากงานหลัก
      select t.category, t.zone_id, t.area_text, coalesce(new.owner_user_id, t.owner_user_id), t.qc_gate_id
        into new.category, new.zone_id, new.area_text, new.owner_user_id, new.qc_gate_id
        from recovery.tasks t where t.id = new.parent_id;
      new.qc_requirement := coalesce(new.qc_requirement, 'ไม่เกี่ยวข้อง');  -- ขั้นตอนย่อยไม่ต้อง QC แยก (ตรวจที่งานหลัก)
      new.approval_status := 'อนุมัติแล้ว';
      if new.status is null or new.status = 'ยังไม่เริ่ม' then new.status := 'พร้อมทำ'; end if;
    elsif new.source = 'field_proposal' then
      new.id := coalesce(new.id, 'NEW-' || lpad(nextval('recovery.task_new_seq')::text, 3, '0'));
      new.approval_status := 'รออนุมัติ';
      new.status := 'ยังไม่เริ่ม';
      new.baseline_start := null;  new.baseline_finish := null;   -- Baseline กำหนดตอนอนุมัติ
    elsif not v_lead and current_setting('recovery.seed', true) is distinct from 'on' then
      raise exception 'เพิ่มงานหลักในแผนได้เฉพาะปัญ/ปู (พนักงานใช้ "เสนองานใหม่")';
    end if;
    new.created_by := coalesce(new.created_by, v_me);
    return new;
  end if;

  -- ---------- UPDATE ----------
  new.updated_at := now();

  -- Baseline ห้ามเขียนทับ (กำหนดได้ครั้งแรกเท่านั้น)
  if coalesce(recovery.setting('baseline_locked'), 'true') = 'true' then
    if (old.baseline_start is not null and new.baseline_start is distinct from old.baseline_start)
       or (old.baseline_finish is not null and new.baseline_finish is distinct from old.baseline_finish) then
      raise exception 'ห้ามแก้ Baseline ของ % — ให้แก้ "คาดว่าจะเสร็จ" (Forecast) แทน', old.id;
    end if;
  end if;

  -- พนักงานทั่วไปแก้ได้เฉพาะความคืบหน้า/สถานะ/หมายเหตุ/คาดว่าจะเสร็จ/สาเหตุล่าช้า
  if not v_lead then
    if new.owner_user_id is distinct from old.owner_user_id
       or new.zone_id is distinct from old.zone_id
       or new.qc_gate_id is distinct from old.qc_gate_id
       or new.qc_requirement is distinct from old.qc_requirement
       or new.dep_mode is distinct from old.dep_mode
       or new.title is distinct from old.title and old.source = 'master'
       or new.approval_status is distinct from old.approval_status then
      raise exception 'สิทธิ์ไม่พอ: แก้ผู้รับผิดชอบ/พื้นที่/QC/การอนุมัติ ได้เฉพาะปัญ/ปู';
    end if;
  end if;

  -- อนุมัติงานที่เสนอใหม่
  if new.approval_status = 'อนุมัติแล้ว' and old.approval_status = 'รออนุมัติ' then
    new.approved_by := v_me; new.approved_at := now();
    if new.status = 'ยังไม่เริ่ม' then new.status := 'พร้อมทำ'; end if;
  end if;
  if new.approval_status <> 'อนุมัติแล้ว' and new.status not in ('ยังไม่เริ่ม') then
    raise exception 'งาน % ยังไม่ได้รับอนุมัติ', old.id;
  end if;

  if new.progress is distinct from old.progress or new.status is distinct from old.status then
    new.last_update_at := now();
  end if;

  if new.status is distinct from old.status then
    -- เริ่มงาน: Dependency แบบห้ามข้ามต้องผ่าน QC ครบ
    if new.status = 'กำลังทำ' and old.status in ('ยังไม่เริ่ม','พร้อมทำ') then
      if new.dep_mode = 'ห้ามข้าม' then
        select string_agg(d.predecessor_id, ', ') into v_open
          from recovery.task_dependencies d join recovery.tasks p on p.id = d.predecessor_id
         where d.task_id = new.id and p.status <> 'เสร็จ';
        if v_open is not null then
          raise exception 'เริ่ม % ไม่ได้: งานก่อนหน้ายังไม่ผ่าน QC (%)', new.id, v_open;
        end if;
      end if;
      new.actual_start := coalesce(new.actual_start, now());
    end if;

    -- ส่งตรวจ: ต้องมีรูป "หลัง" อย่างน้อย 1 รูป
    if new.status = 'รอตรวจ' and coalesce(new.qc_requirement,'ต้องมี') <> 'ไม่เกี่ยวข้อง' then
      select count(*) into v_n
        from recovery.evidence_links l join recovery.evidence e on e.id = l.evidence_id
       where l.object_type = 'task' and l.object_id = new.id and l.unlinked_at is null
         and not e.is_cancelled and e.stage = 'หลัง';
      if v_n = 0 then raise exception 'ส่งตรวจไม่ได้: ยังไม่มีรูป "หลังทำ"'; end if;
    end if;

    -- เสร็จ: ต้องผ่าน QC (ยกเว้นงานที่ไม่ต้องตรวจ)
    if new.status = 'เสร็จ' then
      if coalesce(new.qc_requirement,'ต้องมี') <> 'ไม่เกี่ยวข้อง'
         and current_setting('recovery.via_qc', true) is distinct from 'on' then
        raise exception 'งาน % ต้องผ่าน QC ก่อนจึงจะเป็น "เสร็จ"', new.id;
      end if;
      new.progress := 100;
      new.actual_finish := coalesce(new.actual_finish, now());
    elsif old.status = 'เสร็จ' and not v_lead then
      raise exception 'งานที่เสร็จแล้วเปิดใหม่ได้เฉพาะปัญ/ปู';
    end if;
  end if;
  return new;
end $$;

create trigger tasks_before before insert or update on recovery.tasks
for each row execute function recovery.tg_tasks_before();

-- =====================================================================
-- Trigger งาน: หลังบันทึก (ประวัติ, ปลดล็อกงานถัดไป, % งานหลัก, แจ้งเตือน)
-- =====================================================================
create function recovery.tg_tasks_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_total int; v_done int; v_avg int;
begin
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.progress is distinct from old.progress) then
    insert into recovery.task_updates(task_id, user_id, old_status, new_status, old_progress, new_progress, note)
    values (new.id, recovery.me(), old.status, new.status, old.progress, new.progress,
            nullif(current_setting('recovery.note', true), ''));
  end if;

  -- ปลดล็อกงานถัดไปเมื่อเสร็จ (ผ่าน QC)
  if tg_op = 'UPDATE' and new.status = 'เสร็จ' and old.status <> 'เสร็จ' then
    for r in
      select t.id, t.title, t.owner_user_id
        from recovery.task_dependencies d join recovery.tasks t on t.id = d.task_id
       where d.predecessor_id = new.id and t.status = 'ยังไม่เริ่ม' and t.approval_status = 'อนุมัติแล้ว'
         and not exists (select 1 from recovery.task_dependencies d2 join recovery.tasks p on p.id = d2.predecessor_id
                          where d2.task_id = t.id and p.status <> 'เสร็จ')
    loop
      perform set_config('recovery.system', 'on', true);
      update recovery.tasks set status = 'พร้อมทำ' where id = r.id;
      perform set_config('recovery.system', 'off', true);
      perform recovery.enqueue('unlock', r.owner_user_id, 'ปลดล็อกงานแล้ว',
        r.id || ' ' || r.title || ' พร้อมทำ เพราะ ' || new.id || ' ผ่าน QC แล้ว', 'task', r.id);
    end loop;
  end if;

  -- % งานหลัก คำนวณจากขั้นตอนย่อย
  if new.parent_id is not null then
    select count(*), count(*) filter (where status = 'เสร็จ'), coalesce(avg(progress),0)::int
      into v_total, v_done, v_avg
      from recovery.tasks where parent_id = new.parent_id and approval_status = 'อนุมัติแล้ว';
    perform set_config('recovery.system', 'on', true);
    update recovery.tasks
       set progress = least(case when status = 'เสร็จ' then 100 else 99 end, v_avg)
     where id = new.parent_id and status <> 'เสร็จ' and progress is distinct from least(99, v_avg);
    perform set_config('recovery.system', 'off', true);
  end if;

  -- แจ้งเตือนตามสถานะ
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'รอตรวจ' then
      for r in select id from recovery.app_users where active and role in ('manager','inspector') loop
        perform recovery.enqueue('qc_queue', r.id, 'มีงานรอตรวจ', new.id || ' ' || new.title, 'task', new.id);
      end loop;
    elsif new.status = 'ติดอุปสรรค' then
      for r in select id from recovery.app_users where active and role = 'manager' loop
        perform recovery.enqueue('blocked', r.id, 'งานติดอุปสรรค',
          new.id || ' ' || new.title || coalesce(' · ' || new.delay_reason, ''), 'task', new.id);
      end loop;
    end if;
  end if;

  if tg_op = 'INSERT' and new.source = 'field_proposal' then
    for r in select id from recovery.app_users where active and role in ('admin','manager') loop
      perform recovery.enqueue('approval', r.id, 'มีงานใหม่รออนุมัติ', new.id || ' ' || new.title, 'task', new.id);
    end loop;
  end if;
  return null;
end $$;

create trigger tasks_after after insert or update on recovery.tasks
for each row execute function recovery.tg_tasks_after();

create trigger audit_tasks after insert or update or delete on recovery.tasks
for each row execute function recovery.tg_audit();

-- =====================================================================
-- RPC: อัปเดตงาน (พร้อมหมายเหตุ)
-- =====================================================================
create function recovery.update_task(p_task_id text, p_status text default null, p_progress int default null,
                                     p_note text default null, p_delay_reason text default null,
                                     p_forecast date default null)
returns recovery.tasks language plpgsql security invoker set search_path = '' as $$
declare v recovery.tasks;
begin
  perform set_config('recovery.note', coalesce(p_note, ''), true);
  update recovery.tasks set
    status          = coalesce(p_status, status),
    progress        = coalesce(p_progress, progress),
    delay_reason    = coalesce(p_delay_reason, delay_reason),
    forecast_finish = coalesce(p_forecast, forecast_finish),
    note            = coalesce(p_note, note)
  where id = p_task_id
  returning * into v;
  if v.id is null then raise exception 'ไม่พบงาน % หรือไม่มีสิทธิ์แก้', p_task_id; end if;
  return v;
end $$;

-- =====================================================================
-- RPC: แจ้งอุปสรรค (เปลี่ยนสถานะ + สร้าง Issue)
-- =====================================================================
create function recovery.report_blocker(p_task_id text, p_reason text, p_detail text)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_issue text; v_zone text;
begin
  perform recovery.update_task(p_task_id, 'ติดอุปสรรค', null, p_detail, p_reason, null);
  select zone_id into v_zone from recovery.tasks where id = p_task_id;
  insert into recovery.issues(task_id, zone_id, title, reason, created_by, owner_user_id)
  values (p_task_id, v_zone, coalesce(p_detail, p_reason), p_reason, recovery.me(),
          (select id from recovery.app_users where role = 'manager' and active limit 1))
  returning id into v_issue;
  return v_issue;
end $$;

-- =====================================================================
-- RPC: ผลตรวจ QC (1 หรือ 2 ขั้นตามจุดตรวจ)
-- =====================================================================
create function recovery.submit_qc(p_task_id text, p_result text, p_reason text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me    text := recovery.me();
  v_role  text := recovery.my_role();
  t       recovery.tasks;
  g       recovery.qc_gates;
  v_round int;
  v_stage int;
  v_issue text;
  r record;
begin
  if v_me is null then raise exception 'ไม่พบผู้ใช้'; end if;
  select * into t from recovery.tasks where id = p_task_id for update;
  if t.id is null then raise exception 'ไม่พบงาน %', p_task_id; end if;
  if t.status <> 'รอตรวจ' then raise exception 'งาน % ไม่ได้อยู่ในสถานะรอตรวจ', p_task_id; end if;
  select * into g from recovery.qc_gates where id = t.qc_gate_id;

  select count(*) filter (where result = 'ให้แก้ไข') + 1 into v_round
    from recovery.qc_reviews where task_id = p_task_id;
  v_stage := case
    when coalesce(g.stages,1) = 2 and exists (select 1 from recovery.qc_reviews
           where task_id = p_task_id and round_no = v_round and stage = 1 and result = 'ผ่าน') then 2
    else 1 end;

  if v_stage = 1 and v_role not in ('admin','manager','inspector','technician') then
    raise exception 'สิทธิ์ไม่พอสำหรับการตรวจงาน';
  end if;
  if v_stage = 2 and v_role not in ('admin','manager') then
    raise exception 'ขั้นที่ 2 (อนุมัติ) ต้องเป็นปัญหรือปู';
  end if;
  if v_stage = 2 and v_me = (select inspector_id from recovery.qc_reviews
                             where task_id = p_task_id and round_no = v_round and stage = 1
                             order by id desc limit 1) then
    raise exception 'ผู้อนุมัติขั้นที่ 2 ต้องไม่ใช่คนเดียวกับผู้ตรวจขั้นที่ 1';
  end if;

  if p_result in ('ให้แก้ไข','พบปัญหาใหม่') and coalesce(length(trim(p_reason)),0) = 0 then
    raise exception 'กรุณาใส่เหตุผลเมื่อเลือก "%"', p_result;
  end if;

  if p_result = 'พบปัญหาใหม่' then
    insert into recovery.issues(task_id, zone_id, title, source, created_by, owner_user_id)
    values (p_task_id, t.zone_id, p_reason, 'qc', v_me, t.owner_user_id) returning id into v_issue;
  end if;

  insert into recovery.qc_reviews(task_id, gate_id, round_no, stage, inspector_id, result, reason, issue_id)
  values (p_task_id, t.qc_gate_id, v_round, v_stage, v_me, p_result, p_reason, v_issue);

  perform set_config('recovery.system', 'on', true);
  if p_result = 'ผ่าน' then
    if coalesce(g.stages,1) = 1 or v_stage = 2 then
      perform set_config('recovery.via_qc', 'on', true);
      update recovery.tasks set status = 'เสร็จ' where id = p_task_id;
      perform set_config('recovery.via_qc', 'off', true);
      perform recovery.enqueue('qc_pass', t.owner_user_id, 'งานผ่าน QC', p_task_id || ' ' || t.title, 'task', p_task_id);
    else
      for r in select id from recovery.app_users where active and role in ('admin','manager') and id <> v_me loop
        perform recovery.enqueue('qc_stage2', r.id, 'รออนุมัติ QC ขั้นที่ 2', p_task_id || ' ' || t.title, 'task', p_task_id);
      end loop;
    end if;
  elsif p_result = 'ให้แก้ไข' then
    update recovery.tasks set status = 'แก้ไขงาน' where id = p_task_id;
    perform recovery.enqueue('qc_rework', t.owner_user_id, 'งานถูกส่งกลับให้แก้ไข',
      p_task_id || ' ' || t.title || ' · ' || p_reason, 'task', p_task_id);
  elsif p_result = 'พบปัญหาใหม่' then
    update recovery.tasks set status = 'กำลังทำ' where id = p_task_id;
    perform recovery.enqueue('issue', t.owner_user_id, 'พบปัญหาใหม่จากการตรวจ',
      p_task_id || ' · ' || v_issue || ' ' || p_reason, 'task', p_task_id);
  else
    raise exception 'ผลตรวจต้องเป็น ผ่าน / ให้แก้ไข / พบปัญหาใหม่';
  end if;
  perform set_config('recovery.system', 'off', true);
  return coalesce(v_issue, 'ok');
end $$;

create trigger audit_qc after insert on recovery.qc_reviews for each row execute function recovery.tg_audit();
create trigger audit_issues after insert or update on recovery.issues for each row execute function recovery.tg_audit();
create trigger audit_users after insert or update on recovery.app_users for each row execute function recovery.tg_audit();
create trigger audit_settings after insert or update on recovery.settings for each row execute function recovery.tg_audit();
create trigger audit_links after insert or update on recovery.evidence_links for each row execute function recovery.tg_audit();
create trigger audit_deps after insert or delete on recovery.task_dependencies for each row execute function recovery.tg_audit();

-- =====================================================================
-- Views (ใช้สิทธิ์ของผู้เรียก)
-- =====================================================================
create view recovery.v_tasks with (security_invoker = true) as
select t.*,
       z.name  as zone_name,
       u.nick  as owner_nick,
       coalesce(u.nick, t.owner_text) as owner_display,
       case
         when t.baseline_finish is null then 0
         when t.status = 'เสร็จ' then greatest(0, t.actual_finish::date - t.baseline_finish)
         else greatest(0, greatest(coalesce(t.forecast_finish, t.baseline_finish), recovery.today_th()) - t.baseline_finish)
       end as delay_days,
       (select array_agg(d.predecessor_id order by d.predecessor_id)
          from recovery.task_dependencies d join recovery.tasks p on p.id = d.predecessor_id
         where d.task_id = t.id and p.status <> 'เสร็จ') as waiting_for,
       (select count(*) from recovery.evidence_links l join recovery.evidence e on e.id = l.evidence_id
         where l.object_type = 'task' and l.object_id = t.id and l.unlinked_at is null and not e.is_cancelled) as photo_count
  from recovery.tasks t
  left join recovery.zones z on z.id = t.zone_id
  left join recovery.app_users u on u.id = t.owner_user_id;

create view recovery.v_dashboard with (security_invoker = true) as
select
  count(*) filter (where parent_id is null and approval_status = 'อนุมัติแล้ว')                    as tasks_total,
  count(*) filter (where parent_id is null and status = 'เสร็จ')                                   as tasks_done,
  count(*) filter (where parent_id is null and status = 'กำลังทำ')                                 as tasks_doing,
  count(*) filter (where parent_id is null and status = 'รอตรวจ')                                  as tasks_qc,
  count(*) filter (where parent_id is null and status = 'ติดอุปสรรค')                              as tasks_blocked,
  count(*) filter (where parent_id is null and status = 'แก้ไขงาน')                                as tasks_rework,
  count(*) filter (where parent_id is null and approval_status = 'รออนุมัติ')                      as tasks_pending_approval,
  count(*) filter (where parent_id is null and status <> 'เสร็จ' and baseline_finish < recovery.today_th()) as tasks_late,
  round(avg(progress) filter (where parent_id is null and approval_status = 'อนุมัติแล้ว'))::int   as progress_avg,
  (select count(*) from recovery.issues where status in ('เปิด','กำลังแก้'))                       as issues_open,
  (select count(*) from recovery.issues where status in ('เปิด','กำลังแก้') and blocks_opening)    as issues_blocking_opening
from recovery.tasks;

create view recovery.v_zone_progress with (security_invoker = true) as
select z.id, z.name, z.priority, z.sort_order,
       count(t.id)                                    as tasks,
       count(t.id) filter (where t.status = 'เสร็จ')  as done,
       coalesce(round(avg(t.progress)),0)::int        as progress,
       count(t.id) filter (where t.status = 'ติดอุปสรรค') as blocked
  from recovery.zones z
  left join recovery.tasks t on t.zone_id = z.id and t.parent_id is null and t.approval_status = 'อนุมัติแล้ว'
 group by z.id;

-- =====================================================================
-- RLS + สิทธิ์
-- =====================================================================
alter table recovery.settings          enable row level security;
alter table recovery.app_users         enable row level security;
alter table recovery.zones             enable row level security;
alter table recovery.qc_gates          enable row level security;
alter table recovery.tasks             enable row level security;
alter table recovery.task_dependencies enable row level security;
alter table recovery.task_updates      enable row level security;
alter table recovery.evidence          enable row level security;
alter table recovery.evidence_links    enable row level security;
alter table recovery.issues            enable row level security;
alter table recovery.qc_reviews        enable row level security;
alter table recovery.notifications     enable row level security;
alter table recovery.audit_log         enable row level security;

-- อ่าน: ผู้ใช้ระบบทุกคนเห็นงานทั้งหมด (โปร่งใส)
create policy read_all on recovery.settings          for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.app_users         for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.zones             for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.qc_gates          for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.tasks             for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.task_dependencies for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.task_updates      for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.evidence          for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.evidence_links    for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.issues            for select to authenticated using (recovery.me() is not null);
create policy read_all on recovery.qc_reviews        for select to authenticated using (recovery.me() is not null);
create policy read_own on recovery.notifications     for select to authenticated using (recovery.is_lead() or to_user_id = recovery.me());
create policy read_admin on recovery.audit_log       for select to authenticated using (recovery.my_role() = 'admin');

-- เขียน
create policy admin_write on recovery.settings for all to authenticated
  using (recovery.my_role() = 'admin') with check (recovery.my_role() = 'admin');
create policy lead_write on recovery.zones for all to authenticated using (recovery.is_lead()) with check (recovery.is_lead());
create policy lead_write on recovery.qc_gates for all to authenticated using (recovery.is_lead()) with check (recovery.is_lead());
create policy self_or_admin on recovery.app_users for update to authenticated
  using (id = recovery.me() or recovery.my_role() = 'admin');

create policy task_insert on recovery.tasks for insert to authenticated with check (
  recovery.is_lead()
  or (source = 'field_proposal' and recovery.me() is not null)
  or (source = 'field_step' and exists (select 1 from recovery.tasks p where p.id = tasks.parent_id
        and (p.owner_user_id = recovery.me() or recovery.me() = any(p.team_user_ids)))));
create policy task_update on recovery.tasks for update to authenticated using (
  recovery.is_lead() or owner_user_id = recovery.me() or recovery.me() = any(team_user_ids)
  or (tasks.parent_id is not null and exists (select 1 from recovery.tasks p where p.id = tasks.parent_id
        and (p.owner_user_id = recovery.me() or recovery.me() = any(p.team_user_ids)))));

create policy dep_write on recovery.task_dependencies for insert to authenticated with check (
  recovery.is_lead() or exists (select 1 from recovery.tasks t where t.id = task_dependencies.task_id and t.source = 'field_step'
        and t.created_by = recovery.me()));
create policy dep_delete on recovery.task_dependencies for delete to authenticated using (recovery.is_lead());

create policy ev_insert on recovery.evidence for insert to authenticated with check (uploaded_by = recovery.me());
create policy ev_update on recovery.evidence for update to authenticated using (uploaded_by = recovery.me() or recovery.is_lead());
create policy link_insert on recovery.evidence_links for insert to authenticated with check (linked_by = recovery.me());
create policy link_update on recovery.evidence_links for update to authenticated using (linked_by = recovery.me() or recovery.is_lead());

create policy issue_insert on recovery.issues for insert to authenticated with check (created_by = recovery.me());
create policy issue_update on recovery.issues for update to authenticated using (
  recovery.is_lead() or owner_user_id = recovery.me() or created_by = recovery.me());

-- สิทธิ์ระดับตาราง (ไม่ให้ anon เลย)
revoke all on all tables in schema recovery from anon, public;
grant usage on schema recovery to authenticated, service_role;
grant select on all tables in schema recovery to authenticated;
grant insert, update on recovery.tasks, recovery.evidence, recovery.evidence_links, recovery.issues to authenticated;
grant insert, delete on recovery.task_dependencies to authenticated;
grant insert, update, delete on recovery.zones, recovery.qc_gates, recovery.settings to authenticated;
grant update (lang) on recovery.app_users to authenticated;
grant usage on all sequences in schema recovery to authenticated;
grant all on all tables in schema recovery to service_role;
grant all on all sequences in schema recovery to service_role;
revoke all on all functions in schema recovery from public, anon;
grant execute on all functions in schema recovery to authenticated, service_role;

-- =====================================================================
-- ที่เก็บรูป (private bucket)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recovery-evidence', 'recovery-evidence', false, 15728640,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

create policy recovery_evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'recovery-evidence' and recovery.me() is not null);
create policy recovery_evidence_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'recovery-evidence' and recovery.me() is not null);
-- ไม่มีสิทธิ์ลบ/แก้ไฟล์: รักษาต้นฉบับไว้ใช้เป็นหลักฐานเคลม

-- =====================================================================
-- ค่าตั้งต้น
-- =====================================================================
insert into recovery.settings(key, value, note) values
  ('project_name',        'iRabbit Hotel Flood Recovery', null),
  ('baseline_version',    'v1.0', 'Master XLSX v3'),
  ('baseline_locked',     'true', 'ห้ามแก้ Baseline'),
  ('day1',                '2026-10-08', null),
  ('mock_open',           '2026-10-18', null),
  ('gate_decision',       '2026-10-19', null),
  ('target_open',         '2026-10-20', 'Target ไม่ใช่ Guarantee'),
  ('morning_brief_time',  '07:30', null),
  ('reminder_times',      '12:00,15:00', null),
  ('evening_summary_time','18:00', null),
  ('escalate_blocked_hours','2', null),
  ('escalate_qc_hours',   '4', null),
  ('photo_claim_px',      '2048', 'ด้านยาวรูปหลักฐานเคลม/ใบเสร็จ'),
  ('photo_general_px',    '1600', 'ด้านยาวรูปทั่วไป'),
  ('storage_alert_pct',   '80', null);

commit;

-- ตรวจผล: ควรเห็น 13 ตาราง ใน schema recovery
select count(*) as recovery_tables from information_schema.tables where table_schema = 'recovery' and table_type = 'BASE TABLE';
