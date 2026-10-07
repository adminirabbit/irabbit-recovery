// recovery-admin: ตั้ง/รีเซ็ต PIN ของพนักงาน (เฉพาะปัญ หรือครั้งแรกด้วยรหัส bootstrap)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOOTSTRAP = Deno.env.get("RECOVERY_BOOTSTRAP_SECRET") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

// ต้องตรงกับฝั่ง App (app.js → loginEmail / loginPassword)
const emailOf = (id: string) => `${id.toLowerCase()}@recovery.irabbit.app`;
const passOf = (id: string, pin: string) => `irb-${pin}-${id.toLowerCase()}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const admin = createClient(URL, SERVICE, { db: { schema: "recovery" }, auth: { persistSession: false } });

    // ใครเป็นคนเรียก
    let callerRole: string | null = null;
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (jwt) {
      const { data } = await admin.auth.getUser(jwt);
      if (data?.user) {
        const { data: me } = await admin.from("app_users").select("role").eq("auth_user_id", data.user.id).maybeSingle();
        callerRole = me?.role ?? null;
      }
    }
    if (callerRole !== "admin") {
      const { count } = await admin.from("app_users").select("id", { count: "exact", head: true })
        .eq("role", "admin").not("auth_user_id", "is", null);
      const okBootstrap = BOOTSTRAP.length >= 8 && body.bootstrap_secret === BOOTSTRAP && (count ?? 0) === 0;
      if (!okBootstrap) return json({ error: "ต้องเป็นผู้ดูแลระบบ (ปัญ)" }, 403);
    }

    if (body.action !== "set_pin") return json({ error: "unknown action" }, 400);
    const id = String(body.user_id ?? "").trim();
    const pin = String(body.pin ?? "").trim();
    if (!/^\d{6}$/.test(pin)) return json({ error: "PIN ต้องเป็นตัวเลข 6 หลัก" }, 400);
    const { data: u, error: ue } = await admin.from("app_users").select("id,nick,auth_user_id").eq("id", id).maybeSingle();
    if (ue || !u) return json({ error: "ไม่พบผู้ใช้ " + id }, 404);

    if (u.auth_user_id) {
      const { error } = await admin.auth.admin.updateUserById(u.auth_user_id, { password: passOf(id, pin) });
      if (error) return json({ error: error.message }, 400);
    } else {
      const { data: cu, error } = await admin.auth.admin.createUser({
        email: emailOf(id), password: passOf(id, pin), email_confirm: true,
        user_metadata: { app: "irabbit-recovery", app_user_id: id },
      });
      if (error) return json({ error: error.message }, 400);
      const { error: le } = await admin.from("app_users").update({ auth_user_id: cu.user.id }).eq("id", id);
      if (le) return json({ error: le.message }, 400);
    }
    return json({ ok: true, nick: u.nick });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
