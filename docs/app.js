/* iRabbit ระบบติดตามงานฟื้นฟูหลังน้ำลด — App (Phase A)
 * หน้าเว็บนี้ไม่มีรหัสลับ สิทธิ์ทั้งหมดคุมด้วย RLS + trigger ในฐานข้อมูล (schema recovery)
 */
(() => {
"use strict";
const CFG = window.RECOVERY_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  db: { schema: "recovery" }, auth: { persistSession: true, autoRefreshToken: true },
});
const $view = document.getElementById("view");
const $tabs = document.getElementById("tabs");
const $top = document.getElementById("top");
const $who = document.getElementById("who");
const $toast = document.getElementById("toast");
let ME = null;            // แถวของฉันใน recovery.app_users
let USERS = [];           // รายชื่อทั้งหมด (id, nick, role)
let ZONES = [];

// ต้องตรงกับ Edge Function recovery-admin
const loginEmail = (id) => `${id.toLowerCase()}@recovery.irabbit.app`;
const loginPassword = (id, pin) => `irb-${pin}-${id.toLowerCase()}`;

// ---------- ภาษาพม่า (คำช่วยใต้ภาษาไทย — ต้องให้คนอ่านพม่าได้ตรวจทาน) ----------
const MY = {
  "งานของฉัน": "ကျွန်ုပ်၏ အလုပ်များ", "เริ่มงาน": "အလုပ် စတင်ရန်", "อัปเดต": "အခြေအနေ ပြင်ရန်",
  "ถ่ายรูป / เลือกรูป": "ဓာတ်ပုံ ရိုက်ရန် / ရွေးရန်", "แจ้งอุปสรรค": "အခက်အခဲ တင်ပြရန်",
  "ส่งตรวจ": "စစ်ဆေးရန် ပို့ရန်", "บันทึก": "သိမ်းဆည်းရန်", "ความปลอดภัย": "ဘေးကင်းရေး",
  "ก่อน": "မလုပ်ခင်", "ระหว่าง": "လုပ်နေစဉ်", "หลัง": "ပြီးနောက်", "เพิ่มขั้นตอน": "အဆင့် ထပ်ထည့်ရန်",
};
const T = (th) => (ME && ME.lang === "my" && MY[th]) ? `${th}<div class="my">${MY[th]}</div>` : th;

// ---------- เครื่องมือ ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtD = (d) => d ? new Date(d).toLocaleDateString("th-TH", { day: "numeric", month: "short" }) : "–";
const fmtDT = (d) => d ? new Date(d).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";
const isLead = () => ME && ["admin", "manager"].includes(ME.role);
const canQC = () => ME && ["admin", "manager", "inspector", "technician"].includes(ME.role);
const nick = (id) => USERS.find((u) => u.id === id)?.nick ?? id ?? "–";
function toast(msg, err = false) {
  $toast.textContent = msg; $toast.className = "toast" + (err ? " err" : ""); $toast.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => ($toast.hidden = true), err ? 6000 : 2600);
}
function errMsg(e) { return (e?.message || String(e)).replace(/^.*?ERROR:\s*/, ""); }
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(errMsg(e), true); throw e; }
}
async function q(p) { const { data, error } = await p; if (error) throw error; return data; }
const STATUS_CLS = { "พร้อมทำ": "t-ready", "กำลังทำ": "t-doing", "รอตรวจ": "t-qc", "แก้ไขงาน": "t-bad", "ติดอุปสรรค": "t-bad", "เสร็จ": "t-done" };
const tag = (s) => `<span class="tag ${STATUS_CLS[s] || ""}">${esc(s)}</span>`;
const cardCls = (t) => t.status === "เสร็จ" ? "s-ok" : ["ติดอุปสรรค", "แก้ไขงาน"].includes(t.status) || t.delay_days > 0 ? "s-bad" : ["กำลังทำ", "รอตรวจ"].includes(t.status) ? "s-amber" : "";

// ---------- รูป: ย่อบนมือถือก่อนอัปโหลด ----------
async function compress(file, maxDim) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    return { blob, w, h, type: "image/jpeg" };
  } catch { return { blob: file, w: null, h: null, type: file.type || "application/octet-stream" }; }
}
async function uploadEvidence(files, objType, objId, stage, claimTier, caption) {
  const maxDim = claimTier ? 2048 : 1600;
  let n = 0;
  for (const f of files) {
    const isImg = (f.type || "").startsWith("image/");
    const c = isImg ? await compress(f, maxDim) : { blob: f, w: null, h: null, type: f.type };
    const ext = c.type === "image/jpeg" ? "jpg" : (f.name.split(".").pop() || "bin");
    const path = `${objType}/${objId}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const up = await sb.storage.from(CFG.BUCKET).upload(path, c.blob, { contentType: c.type, upsert: false });
    if (up.error) throw up.error;
    const ev = await q(sb.from("evidence").insert({
      storage_path: path, original_name: f.name, mime_type: c.type, size_bytes: c.blob.size,
      width_px: c.w, height_px: c.h, quality_tier: claimTier ? "claim" : "general", stage,
      caption: caption || null, taken_at: f.lastModified ? new Date(f.lastModified).toISOString() : null,
      uploaded_by: ME.id, sort_order: n,
    }).select("id").single());
    await q(sb.from("evidence_links").insert({ evidence_id: ev.id, object_type: objType, object_id: objId, linked_by: ME.id }));
    n++;
  }
  return n;
}
async function photosOf(objType, objId) {
  const links = await q(sb.from("evidence_links").select("evidence_id, evidence(*)")
    .eq("object_type", objType).eq("object_id", objId).is("unlinked_at", null));
  const ev = links.map((l) => l.evidence).filter((e) => e && !e.is_cancelled);
  if (!ev.length) return [];
  const { data } = await sb.storage.from(CFG.BUCKET).createSignedUrls(ev.map((e) => e.storage_path), 3600);
  const urls = Object.fromEntries((data || []).map((d) => [d.path, d.signedUrl]));
  return ev.map((e) => ({ ...e, url: urls[e.storage_path] })).sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at));
}
const thumbs = (list) => list.length ? `<div class="thumbs">${list.map((p) =>
  `<figure><a href="${esc(p.url)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(p.url)}" alt=""></a><figcaption>${esc(p.stage || "")}${p.quality_tier === "claim" ? " · เคลม" : ""}</figcaption></figure>`).join("")}</div>`
  : `<div class="muted">ยังไม่มีรูป</div>`;

// ---------- Export Excel ----------
const TASK_COLS = { id: "รหัสงาน", category: "หมวด", zone_name: "พื้นที่", area_text: "พื้นที่ตามแผน", title: "งาน",
  owner_display: "ผู้รับผิดชอบ", team_text: "ทีม", priority: "ความสำคัญ", dep_mode: "เงื่อนไข", status: "สถานะ",
  progress: "ความคืบหน้า %", baseline_start: "เริ่มตามแผน", baseline_finish: "กำหนดเสร็จเดิม", forecast_finish: "คาดว่าจะเสร็จ",
  actual_start: "เริ่มจริง", actual_finish: "เสร็จจริง", delay_days: "ล่าช้า (วัน)", delay_reason: "สาเหตุล่าช้า",
  qc_gate_id: "จุดตรวจ QC", waiting_for: "รองานก่อนหน้า", photo_count: "จำนวนรูป", parent_id: "งานหลัก",
  source: "ที่มา", approval_status: "การอนุมัติ", definition_of_done: "เกณฑ์ว่างานเสร็จ", note: "หมายเหตุ", last_update_at: "อัปเดตล่าสุด" };
const mapCols = (rows, cols) => rows.map((r) => Object.fromEntries(Object.entries(cols).map(([k, h]) => [h, Array.isArray(r[k]) ? r[k].join(", ") : r[k] ?? ""])));
function saveXlsx(sheets, name) {
  const wb = XLSX.utils.book_new();
  for (const [title, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ "ไม่มีข้อมูล": "" }]), title.slice(0, 31));
  }
  XLSX.writeFile(wb, `${name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
async function exportAll() {
  const [tasks, upd, qc, iss, ev] = await Promise.all([
    q(sb.from("v_tasks").select("*").order("id")),
    q(sb.from("task_updates").select("*").order("id")),
    q(sb.from("qc_reviews").select("*").order("id")),
    q(sb.from("issues").select("*").order("id")),
    q(sb.from("evidence_links").select("object_type, object_id, linked_at, evidence(id, storage_path, stage, quality_tier, caption, uploaded_by, uploaded_at, size_bytes, is_cancelled)")),
  ]);
  const sheets = {
    "งาน": mapCols(tasks, TASK_COLS),
    "ประวัติอัปเดต": upd.map((u) => ({ "เวลา": fmtDT(u.created_at), "งาน": u.task_id, "ผู้อัปเดต": nick(u.user_id), "สถานะเดิม": u.old_status, "สถานะใหม่": u.new_status, "% เดิม": u.old_progress, "% ใหม่": u.new_progress, "หมายเหตุ": u.note })),
    "ผลตรวจ QC": qc.map((r) => ({ "เวลา": fmtDT(r.created_at), "งาน": r.task_id, "จุดตรวจ": r.gate_id, "รอบ": r.round_no, "ขั้น": r.stage, "ผู้ตรวจ": nick(r.inspector_id), "ผล": r.result, "เหตุผล": r.reason, "Issue": r.issue_id })),
    "ปัญหา": iss.map((r) => ({ "รหัส": r.id, "งาน": r.task_id, "พื้นที่": r.zone_id, "ปัญหา": r.title, "สาเหตุ": r.reason, "ความรุนแรง": r.severity, "ขวางการเปิด": r.blocks_opening ? "ใช่" : "", "ที่มา": r.source, "สถานะ": r.status, "ผู้แจ้ง": nick(r.created_by), "แจ้งเมื่อ": fmtDT(r.created_at), "ยกระดับ": r.escalation_level })),
    "รูปหลักฐาน": ev.filter((l) => l.evidence).map((l) => ({ "ผูกกับ": l.object_type, "รหัส": l.object_id, "รหัสรูป": l.evidence.id, "ไฟล์": l.evidence.storage_path, "ช่วง": l.evidence.stage, "ระดับ": l.evidence.quality_tier, "คำอธิบาย": l.evidence.caption, "ผู้ถ่าย": nick(l.evidence.uploaded_by), "อัปโหลด": fmtDT(l.evidence.uploaded_at), "ยกเลิก": l.evidence.is_cancelled ? "ใช่" : "" })),
  };
  if (ME.role === "admin") {
    const audit = await q(sb.from("audit_log").select("*").order("id", { ascending: false }).limit(5000));
    sheets["Audit"] = audit.map((a) => ({ "เวลา": fmtDT(a.created_at), "ตาราง": a.table_name, "รหัส": a.row_id, "การกระทำ": a.action, "ผู้ทำ": nick(a.actor), "ค่าเดิม": JSON.stringify(a.old_data), "ค่าใหม่": JSON.stringify(a.new_data) }));
  }
  saveXlsx(sheets, "iRabbit_Recovery_ทั้งหมด");
}

// =====================================================================
// Login
// =====================================================================
async function viewLogin() {
  $top.hidden = true; $tabs.hidden = true;
  const pre = new URLSearchParams(location.search).get("u") || localStorage.getItem("irb_last_user") || "";
  let names = [];
  try { names = await q(sb.rpc("login_names")); } catch (e) { toast("โหลดรายชื่อไม่ได้: " + errMsg(e), true); }
  $view.innerHTML = `<form class="login card" id="lf">
    <h1>iRabbit ระบบฟื้นฟูหลังน้ำท่วม</h1>
    <label class="f">ชื่อของฉัน<select id="lu" required><option value="">— เลือกชื่อ —</option>
      ${names.map((n) => `<option value="${esc(n.id)}" ${n.id === pre ? "selected" : ""}>${esc(n.nick)}</option>`).join("")}</select></label>
    <label class="f">PIN 6 หลัก<input id="lp" type="password" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="current-password" required></label>
    <button class="b pri big" type="submit">เข้าสู่ระบบ</button>
    <div class="muted">ลืม PIN ให้แจ้งปัญรีเซ็ต · ครั้งแรกกด "เพิ่มลงหน้าจอหลัก" ในเมนูเบราว์เซอร์</div>
    ${names.length ? "" : `<details><summary class="muted">ตั้งค่าครั้งแรก (ผู้ดูแล)</summary>
      <div style="display:grid;gap:8px;margin-top:8px">
      <label class="f">รหัสตั้งค่าครั้งแรก<input id="bs" type="password"></label>
      <label class="f">PIN ใหม่ของปัญ (6 หลัก)<input id="bp" type="password" inputmode="numeric" maxlength="6"></label>
      <button class="b" type="button" id="bgo">ตั้ง PIN ผู้ดูแล</button></div></details>`}
  </form>`;
  document.getElementById("lf").onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById("lu").value, pin = document.getElementById("lp").value;
    const { error } = await sb.auth.signInWithPassword({ email: loginEmail(id), password: loginPassword(id, pin) });
    if (error) return toast("ชื่อหรือ PIN ไม่ถูกต้อง", true);
    localStorage.setItem("irb_last_user", id);
    boot();
  };
  const bgo = document.getElementById("bgo");
  if (bgo) bgo.onclick = () => run(async () => {
    const { data, error } = await sb.functions.invoke("quick-processor", { body: {
      action: "set_pin", user_id: "USER-001", pin: document.getElementById("bp").value, bootstrap_secret: document.getElementById("bs").value } });
    if (error || data?.error) throw new Error(data?.error || error.message);
    location.reload();
  }, "ตั้ง PIN ผู้ดูแลแล้ว");
}

// =====================================================================
// แถบเมนู
// =====================================================================
function renderTabs(active) {
  const items = [["my", "📋", "งานของฉัน"], ["plan", "🗂", "งานทั้งหมด"]];
  if (canQC()) items.push(["qc", "✅", "ตรวจงาน"]);
  if (isLead()) items.push(["dash", "📊", "ภาพรวม"]);
  items.push(["me", "👤", "ฉัน"]);
  $tabs.innerHTML = items.map(([k, i, l]) => `<a href="#${k}" class="${active === k ? "on" : ""}"><b>${i}</b>${l}</a>`).join("");
  $tabs.hidden = false; $top.hidden = false;
  $who.textContent = `${ME.nick} · ${{ admin: "ผู้ดูแล", manager: "ผู้จัดการ", finance: "บัญชี", admin_support: "ธุรการ", inspector: "ผู้ตรวจ", technician: "ช่าง", staff: "พนักงาน", contractor: "ผู้รับเหมา" }[ME.role] || ME.role}`;
}

// =====================================================================
// งานของฉัน
// =====================================================================
function taskCard(t) {
  const wait = t.waiting_for?.length ? `<div class="muted">🔒 รอ ${esc(t.waiting_for.join(", "))}</div>` : "";
  return `<a class="card ${cardCls(t)}" href="#task/${encodeURIComponent(t.id)}" style="text-decoration:none;color:inherit">
    <div class="row"><b>${esc(t.id)} ${esc(t.title)}</b>${tag(t.status)}</div>
    <div class="muted">${esc(t.zone_name || t.area_text || "")} · ${esc(t.owner_display || "")} · กำหนด ${fmtD(t.baseline_finish)}${t.delay_days > 0 ? ` · <b style="color:var(--bad)">ช้า ${t.delay_days} วัน</b>` : ""}</div>
    <div class="prog"><i style="width:${t.progress}%"></i></div>
    <div class="row muted"><span>${t.progress}% · รูป ${t.photo_count}</span><span>อัปเดต ${fmtDT(t.last_update_at)}</span></div>${wait}</a>`;
}
async function viewMy() {
  renderTabs("my");
  const rows = await q(sb.from("v_tasks").select("*").is("parent_id", null)
    .or(`owner_user_id.eq.${ME.id},team_user_ids.cs.{${ME.id}}`).order("baseline_finish", { nullsFirst: false }));
  const ORDER = { "แก้ไขงาน": 0, "ติดอุปสรรค": 1, "กำลังทำ": 2, "พร้อมทำ": 3, "รอตรวจ": 4, "ยังไม่เริ่ม": 5, "พัก/รอตัดสินใจ": 6, "เสร็จ": 9 };
  rows.sort((a, b) => (ORDER[a.status] ?? 7) - (ORDER[b.status] ?? 7));
  const open = rows.filter((t) => t.status !== "เสร็จ"), done = rows.filter((t) => t.status === "เสร็จ");
  $view.innerHTML = `<div class="row"><h1>${T("งานของฉัน")}</h1><span class="muted">${open.length} งานค้าง</span></div>
    ${open.map(taskCard).join("") || `<div class="card">ยังไม่มีงานที่มอบหมาย</div>`}
    <button class="b" id="prop">+ เสนองานใหม่ (รอปัญ/ปูอนุมัติ)</button>
    ${done.length ? `<details><summary class="muted">งานที่เสร็จแล้ว ${done.length} งาน</summary>${done.map(taskCard).join("")}</details>` : ""}`;
  document.getElementById("prop").onclick = () => proposeForm();
}
function proposeForm() {
  $view.innerHTML = `<form class="card" id="pf"><h2>เสนองานหลักใหม่</h2>
    <label class="f">ชื่องาน<input type="text" id="pt" required></label>
    <label class="f">พื้นที่<select id="pz">${ZONES.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join("")}</select></label>
    <label class="f">หมวดงาน<input type="text" id="pc" value="ทำความสะอาด"></label>
    <label class="f">เหตุผล/รายละเอียด<textarea id="pn"></textarea></label>
    <button class="b pri big">ส่งให้ปัญ/ปูอนุมัติ</button></form>`;
  document.getElementById("pf").onsubmit = (e) => { e.preventDefault(); run(async () => {
    const z = document.getElementById("pz").value;
    await q(sb.from("tasks").insert({ title: document.getElementById("pt").value, zone_id: z, category: document.getElementById("pc").value,
      note: document.getElementById("pn").value, source: "field_proposal", owner_user_id: ME.id, qc_requirement: "ต้องมี", qc_gate_id: "QC-CLN" }));
    location.hash = "#my";
  }, "ส่งเสนองานแล้ว"); };
}

// =====================================================================
// รายละเอียดงาน
// =====================================================================
async function viewTask(id) {
  renderTabs("");
  const [t] = await q(sb.from("v_tasks").select("*").eq("id", id));
  if (!t) { $view.innerHTML = `<div class="card">ไม่พบงาน ${esc(id)}</div>`; return; }
  const [steps, hist, qcs, photos, parent] = await Promise.all([
    q(sb.from("v_tasks").select("*").eq("parent_id", id).order("step_no")),
    q(sb.from("task_updates").select("*").eq("task_id", id).order("id", { ascending: false }).limit(30)),
    q(sb.from("qc_reviews").select("*").eq("task_id", id).order("id", { ascending: false })),
    photosOf("task", id),
    t.parent_id ? q(sb.from("tasks").select("id,title").eq("id", t.parent_id)) : Promise.resolve([]),
  ]);
  const mine = t.owner_user_id === ME.id || (t.team_user_ids || []).includes(ME.id) || isLead()
    || (parent.length && steps); // ขั้นตอนย่อย: สิทธิ์เช็กที่ฐานข้อมูล
  const blocked = t.dep_mode === "ห้ามข้าม" && t.waiting_for?.length;
  const canStart = ["ยังไม่เริ่ม", "พร้อมทำ"].includes(t.status) && !blocked && t.approval_status === "อนุมัติแล้ว";
  const working = ["กำลังทำ", "แก้ไขงาน", "ติดอุปสรรค"].includes(t.status);
  const after = photos.filter((p) => p.stage === "หลัง").length;
  const needQC = t.qc_requirement !== "ไม่เกี่ยวข้อง";

  $view.innerHTML = `
  <a href="#${t.parent_id ? "task/" + encodeURIComponent(t.parent_id) : "my"}" class="muted">‹ กลับ</a>
  <div class="card ${cardCls(t)}">
    <div class="row"><h1 style="margin:0">${esc(t.id)}</h1>${tag(t.status)}</div>
    <h2>${esc(t.title)}</h2>
    ${parent.length ? `<div class="muted">ขั้นตอนย่อยของ ${esc(parent[0].id)} ${esc(parent[0].title)}</div>` : ""}
    <div class="muted">${esc(t.zone_name || t.area_text || "")} · ผู้รับผิดชอบ ${esc(t.owner_display || "–")}${t.team_text ? " · ทีม " + esc(t.team_text) : ""}</div>
    <div class="muted">แผน ${fmtD(t.baseline_start)}–${fmtD(t.baseline_finish)} · คาดว่าจะเสร็จ ${fmtD(t.forecast_finish)}${t.delay_days > 0 ? ` · <b style="color:var(--bad)">ช้า ${t.delay_days} วัน</b>` : ""}</div>
    <div class="prog"><i style="width:${t.progress}%"></i></div><div class="muted">${t.progress}% · QC ${esc(t.qc_gate_id || "ไม่ต้องตรวจแยก")} · ${esc(t.dep_mode)}</div>
    ${t.waiting_for?.length ? `<div class="muted">🔒 รองานก่อนหน้า: ${esc(t.waiting_for.join(", "))}</div>` : ""}
    ${t.definition_of_done ? `<div><b>เกณฑ์ว่างานเสร็จ:</b> ${esc(t.definition_of_done)}</div>` : ""}
    ${t.safety_note ? `<div><b>${T("ความปลอดภัย")}:</b> ${esc(t.safety_note)}${t.safety_note_my ? `<div class="my">${esc(t.safety_note_my)}</div>` : ""}</div>` : ""}
    ${t.approval_status !== "อนุมัติแล้ว" ? `<div class="tag t-qc">${esc(t.approval_status)}</div>` : ""}
  </div>

  ${mine ? `<div class="card" id="act">
    ${canStart ? `<button class="b pri big" data-act="start">${T("เริ่มงาน")}</button>` : ""}
    ${working ? `<label class="f">${T("อัปเดต")} ความคืบหน้า</label>
      <div class="btns">${[25, 50, 75, 90].map((p) => `<button class="b ${t.progress === p ? "on" : ""}" data-p="${p}">${p}%</button>`).join("")}</div>
      <label class="f">หมายเหตุ<input type="text" id="note" placeholder="เช่น เหลือมุมห้องเก็บเอกสาร"></label>
      <button class="b pri" data-act="save">${T("บันทึก")}</button>` : ""}
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <label class="f">${T("ถ่ายรูป / เลือกรูป")} (เลือกหลายรูปได้)</label>
    <div class="btns">${["ก่อน", "ระหว่าง", "หลัง"].map((s, i) => `<button class="b ${i === (working ? 2 : 0) ? "on" : ""}" data-stage="${s}">${T(s)}</button>`).join("")}</div>
    <label class="row muted"><span><input type="checkbox" id="claim"> รูปหลักฐานเคลม (ความละเอียดสูง)</span></label>
    <input type="text" id="cap" placeholder="คำอธิบายรูป (ไม่บังคับ)">
    <input type="file" id="files" accept="image/*,application/pdf" multiple>
    ${working ? `<hr style="border:0;border-top:1px solid var(--line);width:100%">
      <div class="btns"><button class="b bad" data-act="block">${T("แจ้งอุปสรรค")}</button>
      ${needQC ? `<button class="b ok" data-act="qc" ${after ? "" : "disabled"}>${T("ส่งตรวจ")}${after ? "" : " (ต้องมีรูปหลัง)"}</button>`
                 : `<button class="b ok" data-act="done">เสร็จ</button>`}</div>` : ""}
    ${t.status === "รอตรวจ" ? `<div class="muted">ส่งตรวจแล้ว รอผู้ตรวจ</div>` : ""}
  </div>` : ""}

  ${!t.parent_id ? `<div class="card"><div class="row"><h2>ขั้นตอนหน้างาน</h2><span class="muted">${steps.filter((s) => s.status === "เสร็จ").length}/${steps.length}</span></div>
    ${steps.map((s) => `<a href="#task/${encodeURIComponent(s.id)}" class="row" style="text-decoration:none;color:inherit;border-bottom:1px solid var(--line);padding:6px 0">
      <span>${s.step_no}. ${esc(s.title)}${s.waiting_for?.length ? " 🔒" : ""}</span>${tag(s.status)}</a>`).join("") || `<div class="muted">ยังไม่มีขั้นตอนย่อย</div>`}
    ${mine ? `<div class="row" style="gap:6px"><input type="text" id="stepTitle" placeholder="เช่น เช็ดล้างเก้าอี้ 24 ตัว" style="flex:1">
      <label class="muted"><input type="checkbox" id="stepWait" ${steps.length ? "checked" : ""}> ต้องรอขั้นก่อน</label>
      <button class="b" data-act="step">${T("เพิ่มขั้นตอน")}</button></div>` : ""}
  </div>` : ""}

  <div class="card"><h2>รูปหลักฐาน (${photos.length})</h2>${thumbs(photos)}</div>
  ${qcs.length ? `<div class="card"><h2>ผลตรวจ QC</h2><div class="hist">${qcs.map((r) => `<div>${fmtDT(r.created_at)} · รอบ ${r.round_no} ขั้น ${r.stage} · <b>${esc(r.result)}</b> โดย ${esc(nick(r.inspector_id))}${r.reason ? " · " + esc(r.reason) : ""}</div>`).join("")}</div></div>` : ""}
  <div class="card"><h2>ประวัติ</h2><div class="hist">${hist.map((h) => `<div>${fmtDT(h.created_at)} · ${esc(nick(h.user_id))} · ${esc(h.old_status || "")}→${esc(h.new_status || "")} · ${h.new_progress ?? ""}%${h.note ? " · " + esc(h.note) : ""}</div>`).join("") || `<div class="muted">–</div>`}</div></div>`;

  let pct = null, stage = working ? "หลัง" : "ก่อน";
  const act = document.getElementById("act");
  if (!act && !t.parent_id) return wireStep();
  act?.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => { pct = +b.dataset.p; act.querySelectorAll("[data-p]").forEach((x) => x.classList.toggle("on", x === b)); });
  act?.querySelectorAll("[data-stage]").forEach((b) => b.onclick = () => { stage = b.dataset.stage; act.querySelectorAll("[data-stage]").forEach((x) => x.classList.toggle("on", x === b)); });
  const reload = () => viewTask(id);
  act?.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]")?.dataset.act; if (!a) return;
    const note = document.getElementById("note")?.value || null;
    if (a === "start") run(() => q(sb.rpc("update_task", { p_task_id: id, p_status: "กำลังทำ", p_note: "เริ่มงาน" })), "เริ่มงานแล้ว").then(reload);
    if (a === "save") run(() => q(sb.rpc("update_task", { p_task_id: id, p_progress: pct ?? t.progress, p_note: note, p_status: t.status === "ติดอุปสรรค" ? "กำลังทำ" : null })), "บันทึกแล้ว").then(reload);
    if (a === "qc") run(() => q(sb.rpc("update_task", { p_task_id: id, p_status: "รอตรวจ", p_note: note })), "ส่งตรวจแล้ว").then(reload);
    if (a === "done") run(() => q(sb.rpc("update_task", { p_task_id: id, p_status: "เสร็จ", p_note: note })), "บันทึกว่าเสร็จแล้ว").then(reload);
    if (a === "block") blockerForm(t);
  });
  const files = document.getElementById("files");
  if (files) files.onchange = () => run(async () => {
    toast("กำลังอัปโหลด…");
    const n = await uploadEvidence([...files.files], "task", id, stage, document.getElementById("claim").checked, document.getElementById("cap").value);
    toast(`อัปโหลด ${n} รูปแล้ว`);
    reload();
  });
  wireStep();
  function wireStep() {
    const b = document.querySelector('[data-act="step"]'); if (!b) return;
    b.onclick = () => run(async () => {
      const title = document.getElementById("stepTitle").value.trim(); if (!title) throw new Error("ใส่ชื่อขั้นตอนก่อน");
      const prev = steps[steps.length - 1];
      const row = await q(sb.from("tasks").insert({ parent_id: id, title, source: "field_step", category: t.category }).select("id").single());
      if (prev && document.getElementById("stepWait").checked) {
        await q(sb.from("task_dependencies").insert({ task_id: row.id, predecessor_id: prev.id }));
      }
    }, "เพิ่มขั้นตอนแล้ว").then(reload);
  }
}
function blockerForm(t) {
  const R = ["ช่าง/ผู้รับเหมา", "วัสดุ", "คน", "อุปกรณ์", "งานก่อนหน้า", "พบความเสียหายใหม่", "ไม่ปลอดภัย", "สภาพอากาศ", "น้ำ/สภาพพื้นที่", "รอเจ้าของอนุมัติ", "พักเพื่อเคลม", "ไฟฟ้า", "ระบบไอที/ข้อมูล", "อื่นๆ"];
  $view.innerHTML = `<form class="card" id="bf"><h2>${T("แจ้งอุปสรรค")} · ${esc(t.id)}</h2>
    <label class="f">สาเหตุ</label><div class="btns">${R.map((r, i) => `<button type="button" class="b ${i === 3 ? "on" : ""}" data-r="${r}">${r}</button>`).join("")}</div>
    <label class="f">รายละเอียด<textarea id="bd" required placeholder="เช่น เครื่องเป่าลมเสีย 1 ตัว"></textarea></label>
    <input type="file" id="bfiles" accept="image/*" multiple>
    <div class="muted">ระบบจะแจ้งปูทันที ถ้าเกิน 2 ชม. ยังไม่แก้ ระบบจะแจ้งปัญ</div>
    <button class="b bad big">ส่งแจ้งอุปสรรค</button></form>`;
  let reason = R[3];
  document.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { reason = b.dataset.r; document.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("on", x === b)); });
  document.getElementById("bf").onsubmit = (e) => { e.preventDefault(); run(async () => {
    const issue = await q(sb.rpc("report_blocker", { p_task_id: t.id, p_reason: reason, p_detail: document.getElementById("bd").value }));
    const fs = [...document.getElementById("bfiles").files];
    if (fs.length) await uploadEvidence(fs, "issue", issue, "อื่นๆ", false, null);
    location.hash = "#task/" + encodeURIComponent(t.id);
  }, "แจ้งอุปสรรคแล้ว"); };
}

// =====================================================================
// ตรวจงาน (QC)
// =====================================================================
async function viewQC() {
  renderTabs("qc");
  const rows = await q(sb.from("v_tasks").select("*").eq("status", "รอตรวจ").order("last_update_at"));
  const gates = Object.fromEntries((await q(sb.from("qc_gates").select("*"))).map((g) => [g.id, g]));
  const stage1 = await q(sb.from("qc_reviews").select("task_id, round_no, stage, result, inspector_id").in("task_id", rows.map((r) => r.id).concat([""])));
  $view.innerHTML = `<h1>งานรอตรวจ (${rows.length})</h1>` + (rows.map((t) => {
    const g = gates[t.qc_gate_id] || {};
    const s1 = stage1.filter((x) => x.task_id === t.id && x.stage === 1 && x.result === "ผ่าน").length > 0 && g.stages === 2;
    return `<div class="card ${s1 ? "s-bad" : "s-amber"}" data-id="${esc(t.id)}">
      <div class="row"><b>${esc(t.id)} ${esc(t.title)}</b><span class="tag ${g.stages === 2 ? "t-bad" : "t-qc"}">${esc(t.qc_gate_id || "")}${g.stages === 2 ? (s1 ? " · รอขั้น 2" : " · 2 ขั้น") : ""}</span></div>
      <div class="muted">${esc(t.zone_name || t.area_text || "")} · ${esc(t.owner_display)} · ส่งเมื่อ ${fmtDT(t.last_update_at)}</div>
      ${g.pass_criteria ? `<div class="muted">เกณฑ์ผ่าน: ${esc(g.pass_criteria)}</div>` : ""}
      <div class="ph muted">กำลังโหลดรูป…</div>
      <input type="text" class="reason" placeholder="เหตุผล (บังคับเมื่อให้แก้ไข/พบปัญหาใหม่)">
      <div class="btns"><button class="b ok" data-r="ผ่าน">${s1 ? "อนุมัติขั้น 2" : "ผ่าน"}</button><button class="b warn" data-r="ให้แก้ไข">ให้แก้ไข</button><button class="b bad" data-r="พบปัญหาใหม่">พบปัญหาใหม่</button></div>
      <a href="#task/${encodeURIComponent(t.id)}" class="muted">ดูรายละเอียดงาน ›</a></div>`;
  }).join("") || `<div class="card">ไม่มีงานรอตรวจ</div>`);
  for (const el of $view.querySelectorAll("[data-id]")) {
    const id = el.dataset.id;
    photosOf("task", id).then((p) => el.querySelector(".ph").outerHTML = thumbs(p));
    el.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => run(() =>
      q(sb.rpc("submit_qc", { p_task_id: id, p_result: b.dataset.r, p_reason: el.querySelector(".reason").value || null })),
      "บันทึกผลตรวจแล้ว").then(viewQC));
  }
}

// =====================================================================
// ภาพรวม (ปัญ/ปู)
// =====================================================================
async function viewDash() {
  renderTabs("dash");
  const [[d], zones, attn, pend, issues] = await Promise.all([
    q(sb.from("v_dashboard").select("*")),
    q(sb.from("v_zone_progress").select("*").order("sort_order")),
    q(sb.from("v_tasks").select("*").is("parent_id", null).or("status.in.(ติดอุปสรรค,แก้ไขงาน),delay_days.gt.0").neq("status", "เสร็จ").order("delay_days", { ascending: false }).limit(30)),
    q(sb.from("v_tasks").select("*").eq("approval_status", "รออนุมัติ")),
    q(sb.from("issues").select("*").in("status", ["เปิด", "กำลังแก้"]).order("created_at")),
  ]);
  const days = Math.ceil((new Date("2026-10-20T00:00:00+07:00") - new Date()) / 864e5);
  $view.innerHTML = `
    <div class="row"><h1>เป้าหมายเปิด 20 ต.ค.${days >= 0 ? ` · เหลือ ${days} วัน` : ""}</h1>
      <div class="btns"><button class="b" id="rf">รีเฟรช</button><button class="b pri" id="xa">⬇ Export Excel ทั้งหมด</button></div></div>
    <div class="kpis">
      <div class="kpi"><b>${d.progress_avg ?? 0}%</b><span>คืบหน้า</span></div>
      <div class="kpi ok"><b>${d.tasks_done}/${d.tasks_total}</b><span>เสร็จ</span></div>
      <div class="kpi"><b>${d.tasks_doing}</b><span>กำลังทำ</span></div>
      <div class="kpi warn"><b>${d.tasks_qc}</b><span>รอตรวจ</span></div>
      <div class="kpi bad"><b>${d.tasks_late}</b><span>ล่าช้า</span></div>
      <div class="kpi bad"><b>${d.tasks_blocked}</b><span>ติดอุปสรรค</span></div>
      <div class="kpi warn"><b>${d.tasks_pending_approval}</b><span>รออนุมัติ</span></div>
      <div class="kpi bad"><b>${d.issues_open}</b><span>ปัญหาเปิด</span></div>
    </div>
    <div class="two">
      <div class="card"><h2>ความคืบหน้าราย Zone</h2>${zones.filter((z) => z.tasks).map((z) => `<div class="zbar"><span>${esc(z.name)}</span><div class="prog"><i style="width:${z.progress}%;${z.blocked ? "background:var(--bad)" : ""}"></i></div><span class="n">${z.progress}%</span></div>`).join("")}</div>
      <div style="display:grid;gap:10px">
        ${pend.length ? `<div class="card"><h2>รออนุมัติ (${pend.length})</h2>${pend.map((p) => `<div class="card" data-ap="${esc(p.id)}"><b>${esc(p.id)} ${esc(p.title)}</b><div class="muted">${esc(p.zone_name || "")} · เสนอโดย ${esc(nick(p.created_by))}${p.note ? " · " + esc(p.note) : ""}</div>
          <div class="row"><input type="date" class="bs" value="${new Date().toISOString().slice(0, 10)}"><input type="date" class="bf" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="btns"><button class="b ok" data-ok>อนุมัติ</button><button class="b bad" data-no>ไม่อนุมัติ</button></div></div>`).join("")}</div>` : ""}
        <div class="card"><h2>ต้องดูตอนนี้ (${attn.length})</h2>${attn.map(taskCard).join("") || `<div class="muted">ไม่มี</div>`}</div>
        <div class="card"><h2>ปัญหาเปิด (${issues.length})</h2>${issues.map((i) => `<div class="row" style="border-bottom:1px solid var(--line);padding:4px 0"><span><b>${esc(i.id)}</b> ${esc(i.title)}${i.task_id ? ` · <a href="#task/${encodeURIComponent(i.task_id)}">${esc(i.task_id)}</a>` : ""}</span><span class="muted">${fmtDT(i.created_at)}${i.escalation_level ? " · ยกระดับ " + i.escalation_level : ""}</span></div>`).join("") || `<div class="muted">ไม่มี</div>`}</div>
      </div></div>`;
  document.getElementById("rf").onclick = viewDash;
  document.getElementById("xa").onclick = () => run(exportAll, "สร้างไฟล์ Excel แล้ว");
  $view.querySelectorAll("[data-ap]").forEach((el) => {
    const id = el.dataset.ap;
    el.querySelector("[data-ok]").onclick = () => run(() => q(sb.from("tasks").update({ approval_status: "อนุมัติแล้ว",
      baseline_start: el.querySelector(".bs").value, baseline_finish: el.querySelector(".bf").value }).eq("id", id)), "อนุมัติแล้ว").then(viewDash);
    el.querySelector("[data-no]").onclick = () => run(() => q(sb.from("tasks").update({ approval_status: "ไม่อนุมัติ" }).eq("id", id)), "บันทึกแล้ว").then(viewDash);
  });
  clearTimeout(viewDash.t); viewDash.t = setTimeout(() => location.hash === "#dash" && viewDash(), 60000);
}

// =====================================================================
// งานทั้งหมด / แผนงาน
// =====================================================================
async function viewPlan() {
  renderTabs("plan");
  const all = await q(sb.from("v_tasks").select("*").order("id"));
  const st = ["", "ยังไม่เริ่ม", "พร้อมทำ", "กำลังทำ", "รอตรวจ", "แก้ไขงาน", "ติดอุปสรรค", "พัก/รอตัดสินใจ", "เสร็จ"];
  const f = JSON.parse(sessionStorage.getItem("irb_plan_f") || "{}");
  $view.innerHTML = `<div class="row"><h1>งานทั้งหมด</h1><button class="b pri" id="xp">⬇ Export Excel ตามตัวกรอง</button></div>
    <div class="filters">
      <select id="fz"><option value="">ทุกพื้นที่</option>${ZONES.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join("")}</select>
      <select id="fo"><option value="">ทุกคน</option>${USERS.map((u) => `<option value="${u.id}">${esc(u.nick)}</option>`).join("")}</select>
      <select id="fs">${st.map((s) => `<option value="${s}">${s || "ทุกสถานะ"}</option>`).join("")}</select>
      <select id="fl"><option value="">ทั้งหมด</option><option value="late">เฉพาะล่าช้า</option><option value="steps">รวมขั้นตอนย่อย</option></select>
      <input type="text" id="fq" placeholder="ค้นหา รหัส/ชื่องาน">
    </div><div class="muted" id="cnt"></div>
    <div class="card scroll"><table><thead><tr><th>รหัส</th><th>งาน</th><th>พื้นที่</th><th>ผู้รับผิดชอบ</th><th>สถานะ</th><th>%</th><th>แผนเสร็จ</th><th>คาดว่าเสร็จ</th><th>เสร็จจริง</th><th>ช้า</th></tr></thead><tbody id="tb"></tbody></table></div>`;
  const el = (i) => document.getElementById(i);
  for (const [k, i] of [["z", "fz"], ["o", "fo"], ["s", "fs"], ["l", "fl"], ["q", "fq"]]) el(i).value = f[k] || "";
  let rows = [];
  const apply = () => {
    const F = { z: el("fz").value, o: el("fo").value, s: el("fs").value, l: el("fl").value, q: el("fq").value.trim().toLowerCase() };
    sessionStorage.setItem("irb_plan_f", JSON.stringify(F));
    rows = all.filter((t) => (F.l === "steps" || !t.parent_id) && (!F.z || t.zone_id === F.z)
      && (!F.o || t.owner_user_id === F.o || (t.team_user_ids || []).includes(F.o)) && (!F.s || t.status === F.s)
      && (F.l !== "late" || t.delay_days > 0) && (!F.q || (t.id + " " + t.title).toLowerCase().includes(F.q)));
    el("cnt").textContent = `${rows.length} งาน`;
    el("tb").innerHTML = rows.map((t) => `<tr data-id="${esc(t.id)}" style="cursor:pointer"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.zone_name || t.area_text || "")}</td><td>${esc(t.owner_display || "")}</td><td>${tag(t.status)}</td><td class="n">${t.progress}</td><td>${fmtD(t.baseline_finish)}</td><td>${fmtD(t.forecast_finish)}</td><td>${fmtD(t.actual_finish)}</td><td class="n" style="${t.delay_days > 0 ? "color:var(--bad);font-weight:700" : ""}">${t.delay_days || ""}</td></tr>`).join("");
  };
  ["fz", "fo", "fs", "fl"].forEach((i) => el(i).onchange = apply); el("fq").oninput = apply;
  el("tb").onclick = (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#task/" + encodeURIComponent(tr.dataset.id); };
  el("xp").onclick = () => saveXlsx({ "งาน": mapCols(rows, TASK_COLS) }, "iRabbit_Recovery_งาน");
  apply();
}

// =====================================================================
// ฉัน / ตั้งค่า
// =====================================================================
async function viewMe() {
  renderTabs("me");
  const isAdmin = ME.role === "admin";
  const [users, settings, notif] = await Promise.all([
    isAdmin ? q(sb.from("app_users").select("*").order("id")) : Promise.resolve([]),
    q(sb.from("settings").select("*")),
    isLead() ? q(sb.from("notifications").select("status")) : Promise.resolve([]),
  ]);
  const S = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const nc = notif.reduce((a, n) => (a[n.status] = (a[n.status] || 0) + 1, a), {});
  $view.innerHTML = `<h1>${esc(ME.nick)}</h1>
    <div class="card"><h2>ภาษา</h2><div class="btns"><button class="b ${ME.lang === "th" ? "on" : ""}" data-lang="th">ไทย</button><button class="b ${ME.lang === "my" ? "on" : ""}" data-lang="my">ไทย + မြန်မာ</button></div></div>
    <div class="card"><h2>LINE</h2><div class="muted">${ME.line_user_id ? "✅ ผูก LINE แล้ว" : "ยังไม่ได้ผูก LINE"}</div>
      <button class="b pri" id="lk">ขอรหัสผูก LINE</button><div id="lkout"></div></div>
    ${isAdmin ? `<div class="card"><h2>ผู้ใช้และ PIN</h2><div class="scroll"><table><tr><th>รหัส</th><th>ชื่อ</th><th>สิทธิ์</th><th>Login</th><th>LINE</th><th>ตั้ง PIN ใหม่</th></tr>
      ${users.map((u) => `<tr><td>${esc(u.id)}</td><td>${esc(u.nick)}</td><td>${esc(u.role)}</td><td>${u.auth_user_id ? "✅" : "–"}</td><td>${u.line_user_id ? "✅" : "–"}</td>
        <td><div class="row" style="flex-wrap:nowrap"><input type="text" inputmode="numeric" maxlength="6" placeholder="6 หลัก" data-pin="${esc(u.id)}" style="width:90px"><button class="b" data-setpin="${esc(u.id)}">ตั้ง</button></div></td></tr>`).join("")}</table></div>
      <div class="muted">ส่งลิงก์ให้พนักงาน: ${esc(location.origin + location.pathname)}?u=รหัสพนักงาน</div></div>
      <div class="card"><h2>กลุ่ม LINE สำหรับสรุปประจำวัน</h2>
        <div class="muted">กลุ่มที่ใช้อยู่: ${S.line_group_id ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}${S.line_group_pending && S.line_group_pending !== S.line_group_id ? " · มีกลุ่มใหม่รอยืนยัน" : ""}</div>
        ${S.line_group_pending && S.line_group_pending !== S.line_group_id ? `<button class="b ok" id="grp">ยืนยันกลุ่มที่เพิ่งเชิญบอท</button>` : `<div class="muted">เชิญบัญชี LINE OA เข้ากลุ่ม แล้วกลับมากดยืนยันที่นี่</div>`}</div>` : ""}
    ${isLead() ? `<div class="card"><h2>การแจ้งเตือน</h2><div class="muted">${Object.entries(nc).map(([k, v]) => `${k} ${v}`).join(" · ") || "ยังไม่มี"}</div></div>
      <div class="card"><button class="b pri" id="xa">⬇ Export Excel ทั้งหมด</button></div>` : ""}
    <button class="b" id="out">ออกจากระบบ</button>`;
  $view.querySelectorAll("[data-lang]").forEach((b) => b.onclick = () => run(() => q(sb.from("app_users").update({ lang: b.dataset.lang }).eq("id", ME.id)), "เปลี่ยนภาษาแล้ว").then(boot));
  document.getElementById("lk").onclick = () => run(async () => {
    const code = await q(sb.rpc("create_line_link_code"));
    document.getElementById("lkout").innerHTML = `<div style="font-size:30px;font-weight:700;letter-spacing:4px">${esc(code)}</div>
      <div class="muted">1) เพิ่มเพื่อน LINE OA ของโรงแรม 2) พิมพ์รหัสนี้ส่งในแชท OA ภายใน 15 นาที</div>`;
  });
  document.getElementById("out").onclick = async () => { await sb.auth.signOut(); location.hash = ""; boot(); };
  const xa = document.getElementById("xa"); if (xa) xa.onclick = () => run(exportAll, "สร้างไฟล์ Excel แล้ว");
  const grp = document.getElementById("grp"); if (grp) grp.onclick = () => run(() => q(sb.from("settings").upsert({ key: "line_group_id", value: S.line_group_pending })), "ตั้งกลุ่มแล้ว").then(viewMe);
  $view.querySelectorAll("[data-setpin]").forEach((b) => b.onclick = () => run(async () => {
    const id = b.dataset.setpin, pin = $view.querySelector(`[data-pin="${id}"]`).value;
    const { data, error } = await sb.functions.invoke("quick-processor", { body: { action: "set_pin", user_id: id, pin } });
    if (error || data?.error) throw new Error(data?.error || error.message);
  }, "ตั้ง PIN แล้ว").then(viewMe));
}

// =====================================================================
// เริ่มต้น + เส้นทาง
// =====================================================================
async function route() {
  if (!ME) return;
  const h = decodeURIComponent(location.hash.slice(1)) || "my";
  try {
    if (h.startsWith("task/")) return await viewTask(h.slice(5));
    if (h === "qc" && canQC()) return await viewQC();
    if (h === "dash" && isLead()) return await viewDash();
    if (h === "plan") return await viewPlan();
    if (h === "me") return await viewMe();
    return await viewMy();
  } catch (e) {
    $view.innerHTML = `<div class="card">เกิดข้อผิดพลาด: ${esc(errMsg(e))}<br><button class="b" onclick="location.reload()">ลองใหม่</button></div>`;
  }
}
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { ME = null; return viewLogin(); }
  try {
    const [me] = await q(sb.from("app_users").select("*").eq("auth_user_id", session.user.id));
    if (!me) { await sb.auth.signOut(); return viewLogin(); }
    ME = me;
    [USERS, ZONES] = await Promise.all([
      q(sb.from("app_users").select("id,nick,role").eq("active", true).order("nick")),
      q(sb.from("zones").select("id,name").order("sort_order")),
    ]);
    route();
  } catch (e) { toast(errMsg(e), true); viewLogin(); }
}
window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
})();
