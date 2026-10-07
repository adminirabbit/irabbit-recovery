// line-webhook: รับข้อความจาก LINE OA (ผูกบัญชีด้วยรหัส 6 หลัก, บันทึกกลุ่มที่เชิญบอทเข้า)
// Deploy โดยปิด "Verify JWT" (LINE ไม่ได้ส่ง JWT มา) — ตรวจลายเซ็นด้วย Channel secret แทน
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const APP_URL = Deno.env.get("RECOVERY_APP_URL") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "recovery" }, auth: { persistSession: false } });

async function validSignature(raw: string, sig: string | null) {
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === sig;
}

async function reply(token: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ replyToken: token, messages: [{ type: "text", text }] }),
  });
}

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-line-signature")))) {
    return new Response("bad signature", { status: 401 });
  }
  const { events = [] } = JSON.parse(raw || "{}");
  for (const ev of events) {
    try {
      if (ev.type === "follow") {
        await reply(ev.replyToken,
          "สวัสดีครับ นี่คือระบบติดตามงานฟื้นฟู iRabbit\nผูกบัญชี: เปิด App → เมนู \"ฉัน\" → กด \"ผูก LINE\" แล้วพิมพ์รหัส 6 หลักส่งมาที่นี่" +
          (APP_URL ? `\n\nเปิด App: ${APP_URL}` : ""));
      } else if (ev.type === "join" && ev.source?.groupId) {
        await db.from("settings").upsert({ key: "line_group_pending", value: ev.source.groupId, updated_at: new Date().toISOString() });
        await reply(ev.replyToken, "บอทเข้ากลุ่มแล้ว ให้ปัญกดยืนยันกลุ่มนี้ใน App (เมนู ตั้งค่า) เพื่อรับสรุปงานประจำวัน");
      } else if (ev.type === "message" && ev.message?.type === "text" && ev.source?.type === "user") {
        const text = String(ev.message.text).trim();
        if (/^\d{6}$/.test(text)) {
          const { data, error } = await db.rpc("link_line", { p_code: text, p_line_user_id: ev.source.userId });
          await reply(ev.replyToken, !error && data
            ? `ผูกบัญชีสำเร็จ: ${data}\nจากนี้ระบบจะส่งงานและการแจ้งเตือนมาที่ LINE นี้`
            : "รหัสไม่ถูกต้องหรือหมดอายุ (15 นาที) กรุณากดขอรหัสใหม่ใน App");
        } else {
          await reply(ev.replyToken, "บันทึกงาน อัปเดต และส่งรูปได้ใน App เท่านั้น" + (APP_URL ? `\n${APP_URL}` : ""));
        }
      }
    } catch (e) {
      console.error("event error", e);
    }
  }
  return new Response("ok");
});
