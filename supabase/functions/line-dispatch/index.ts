// line-dispatch: เรียกโดย pg_cron ทุกนาที (และตามเวลา) → รันงานอัตโนมัติ แล้วส่งคิวแจ้งเตือนออก LINE
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const DISPATCH = Deno.env.get("RECOVERY_DISPATCH_SECRET") ?? "";
const APP_URL = (Deno.env.get("RECOVERY_APP_URL") ?? "").replace(/\/$/, "");
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "recovery" }, auth: { persistSession: false } });

const JOBS: Record<string, string> = {
  morning: "job_morning_brief", reminder: "job_update_reminder",
  escalation: "job_escalation", evening: "job_evening_summary",
};

async function push(to: string, texts: string[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ to, messages: texts.slice(0, 5).map((t) => ({ type: "text", text: t.slice(0, 4900) })) }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (!DISPATCH || req.headers.get("x-dispatch-secret") !== DISPATCH) return new Response("forbidden", { status: 403 });
  const job = new URL(req.url).searchParams.get("job");
  const out: Record<string, unknown> = {};
  if (job && JOBS[job]) {
    const { data, error } = await db.rpc(JOBS[job]);
    out.job = { job, data, error: error?.message };
  }

  const { data: rows, error } = await db.from("notifications")
    .select("id, kind, title, body, deep_link, to_group_id, to_user_id, app_users:to_user_id(line_user_id)")
    .eq("status", "รอส่ง").order("id").limit(200);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  // รวมข้อความต่อผู้รับ เพื่อลดจำนวนครั้งที่ส่ง
  const groups = new Map<string, typeof rows>();
  const skip: number[] = [];
  for (const r of rows ?? []) {
    // deno-lint-ignore no-explicit-any
    const to = r.to_group_id ?? (r as any).app_users?.line_user_id;
    if (!to) { skip.push(r.id); continue; }
    groups.set(to, [...(groups.get(to) ?? []), r]);
  }
  if (skip.length) await db.from("notifications").update({ status: "ข้าม", error: "ยังไม่ผูก LINE" }).in("id", skip);

  let sent = 0, failed = 0;
  for (const [to, list] of groups) {
    for (let i = 0; i < list.length; i += 5) {
      const chunk = list.slice(i, i + 5);
      const texts = chunk.map((r) =>
        `【${r.title ?? r.kind}】\n${r.body}` + (APP_URL ? `\n${APP_URL}/${r.deep_link ?? ""}` : ""));
      try {
        await push(to, texts);
        await db.from("notifications").update({ status: "ส่งแล้ว", sent_at: new Date().toISOString() }).in("id", chunk.map((r) => r.id));
        sent += chunk.length;
      } catch (e) {
        await db.from("notifications").update({ status: "ส่งไม่สำเร็จ", error: String(e).slice(0, 500) }).in("id", chunk.map((r) => r.id));
        failed += chunk.length;
      }
    }
  }
  return new Response(JSON.stringify({ ...out, sent, failed, skipped: skip.length }), { headers: { "content-type": "application/json" } });
});
