import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// ينادى كل دقيقة من pg_cron: إشعار قبل نهاية الحجز، ولما يخلص الوقت، ولما يوصل حجز أونلاين جديد.
// وفيه action: "test" عشان المستخدم يجرب الإشعارات على جهازه.
// الأوقات بالدقايق (start_m / end_m) من نص الليل.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DEFAULT_SOON = 15;
const OVER_REPEAT_MIN = 5;
const OVER_MAX = 6;
const ESCALATE_MIN = 10;

// 1174 → "7:34م"
const hm = (min: number) => {
  min = Math.round(min);
  let h = Math.floor(min / 60) % 24; const m = ((min % 60) + 60) % 60;
  const mm = m ? ":" + String(m).padStart(2, "0") : "";
  if (h === 0) return "12" + mm + "ص"; if (h === 12) return "12" + mm + "ظ";
  return h < 12 ? h + mm + "ص" : (h - 12) + mm + "م";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: sec } = await admin.from("app_secrets").select("k, v").in("k", ["vapid_public", "vapid_private", "cron_key"]);
  const S: Record<string, string> = {}; (sec || []).forEach((r: any) => S[r.k] = r.v);
  webpush.setVapidDetails("mailto:admin@tent-booking.app", S.vapid_public, S.vapid_private);

  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }

  const sendTo = async (userIds: string[], payload: Record<string, unknown>) => {
    if (!userIds.length) return 0;
    const { data: subs } = await admin.from("push_subs").select("id, endpoint, p256dh, auth").in("user_id", userIds);
    let ok = 0;
    await Promise.all((subs || []).map(async (s: any) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 600, urgency: "high" });
        ok++;
      } catch (e: any) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await admin.from("push_subs").delete().eq("id", s.id);
      }
    }));
    return ok;
  };

  if (body.action === "test") {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(token);
    if (!who?.user) return json({ error: "unauthorized" }, 401);
    const n = await sendTo([who.user.id], { title: "🔔 الإشعارات شغّالة", body: "بيوصلك تنبيه قبل نهاية وقت الحجز ولما يخلص.", tag: "test" });
    return json({ ok: true, sent: n });
  }

  if (!S.cron_key || req.headers.get("x-cron-key") !== S.cron_key) return json({ error: "forbidden" }, 403);

  const k = new Date(Date.now() + 3 * 3600e3);
  const today = k.toISOString().slice(0, 10);
  const yday = new Date(k.getTime() - 86400e3).toISOString().slice(0, 10);
  const nowMin = k.getUTCHours() * 60 + k.getUTCMinutes();

  const { data: cafes } = await admin.from("cafes").select("id, name, soon_min");
  const cafeOf = (id: string) => (cafes || []).find((c: any) => c.id === id) as any;
  const cafeName = (id: string) => cafeOf(id)?.name || "";
  const soonOf = (id: string) => { const v = Number(cafeOf(id)?.soon_min); return v >= 1 ? v : DEFAULT_SOON; };
  const { data: profs } = await admin.from("profiles").select("id, role, cafe_id");
  const owners = (profs || []).filter((p: any) => p.role === "owner").map((p: any) => p.id);
  const { data: subUsers } = await admin.from("push_subs").select("user_id");
  const subscribed = new Set((subUsers || []).map((s: any) => s.user_id));
  const staffOf = (cid: string) => {
    const st = (profs || []).filter((p: any) => p.role === "staff" && p.cafe_id === cid).map((p: any) => p.id);
    return st.some((id: string) => subscribed.has(id)) ? st : owners;
  };

  // push_sent.end_h يحفظ نهاية الحجز بالدقايق، عشان لو تمدد الحجز ينبه من جديد
  const sentFor = async (ids: string[]) => {
    const m = new Map<string, any>();
    if (!ids.length) return m;
    const { data } = await admin.from("push_sent").select("*").in("booking_id", ids);
    (data || []).forEach((r: any) => m.set(`${r.booking_id}:${r.kind}:${r.end_h}`, r));
    return m;
  };
  const mark = async (sent: Map<string, any>, b: any, kind: string) => {
    const prev = sent.get(`${b.id}:${kind}:${b.end_m}`);
    await admin.from("push_sent").upsert({ booking_id: b.id, kind, end_h: b.end_m, n: (prev?.n || 0) + 1, last_at: new Date().toISOString() });
  };
  let pushes = 0;

  // ---- حجوزات أونلاين جديدة (آخر 15 دقيقة)
  const { data: fresh } = await admin.from("bookings")
    .select("id, cafe_id, date, tent, start_m, end_m, name, price")
    .eq("source", "online").gte("created_at", new Date(Date.now() - 15 * 60e3).toISOString());
  if (fresh && fresh.length) {
    const sentN = await sentFor(fresh.map((r: any) => r.id));
    for (const b of fresh as any[]) {
      if (sentN.get(`${b.id}:new:${b.end_m}`)) continue;
      const when = b.date === today ? "اليوم" : b.date.slice(8) + "/" + b.date.slice(5, 7);
      pushes += await sendTo(staffOf(b.cafe_id), {
        title: `🌐 حجز أونلاين جديد · خيمة ${b.tent}`,
        body: `${cafeName(b.cafe_id)} · ${b.name} · ${when} ${hm(b.start_m)}–${hm(b.end_m)} · ${Number(b.price)} د.ك · ينلغي إذا ما دفع قبل ${hm(b.start_m - 30)}`,
        tag: `new-${b.id}`, url: `./?d=${b.date}&c=${b.cafe_id}&t=${b.tent}` });
      await mark(sentN, b, "new");
    }
  }

  // ---- قبل النهاية ولما يخلص الوقت
  const { data: rows } = await admin.from("bookings")
    .select("id, cafe_id, date, tent, start_m, end_m, name, price, paid, paid_amount")
    .in("date", [today, yday]).eq("done", false);
  if (!rows || !rows.length) return json({ ok: true, checked: 0, pushes });
  const sent = await sentFor(rows.map((r: any) => r.id));

  for (const b of rows as any[]) {
    const m = b.date === today ? nowMin : nowMin + 1440;
    if (b.date === yday && b.end_m <= 1440) continue;
    const left = b.end_m - m, started = b.start_m <= m;
    const due = Math.max(0, Number(b.price) - (b.paid ? Number(b.paid_amount) : 0));
    const where = `${cafeName(b.cafe_id)} · ${b.name} · ${hm(b.start_m)}–${hm(b.end_m)}`;
    const url = `./?d=${b.date}&c=${b.cafe_id}&t=${b.tent}`;

    if (started && left > 0 && left <= soonOf(b.cafe_id) && !sent.get(`${b.id}:soon:${b.end_m}`)) {
      pushes += await sendTo(staffOf(b.cafe_id), { title: `⏳ خيمة ${b.tent} باقي ${left} دقيقة`, body: where, tag: `b-${b.id}`, url });
      await mark(sent, b, "soon");
    }
    if (left <= 0 && left > -180) {
      const prev = sent.get(`${b.id}:over:${b.end_m}`);
      const ago = prev ? (Date.now() - new Date(prev.last_at).getTime()) / 60000 : Infinity;
      if (!prev || (prev.n < OVER_MAX && ago >= OVER_REPEAT_MIN - 0.2)) {
        pushes += await sendTo(staffOf(b.cafe_id), { title: `⏰ خيمة ${b.tent} خلص وقتها`, body: where + (due > 0 ? ` · باقي ${due} د.ك` : "") + " · سجّل طلع الزبون أو مدّد", tag: `b-${b.id}`, url, urgent: true });
        await mark(sent, b, "over");
      }
      if (-left >= ESCALATE_MIN && !sent.get(`${b.id}:esc:${b.end_m}`)) {
        pushes += await sendTo(owners, { title: `🚨 خيمة ${b.tent} خلص وقتها من ${-left} دقيقة`, body: where + (due > 0 ? ` · ما انحسب ${due} د.ك` : "") + " · محد سجّل طلع الزبون", tag: `esc-${b.id}`, url, urgent: true });
        await mark(sent, b, "esc");
      }
    }
  }
  return json({ ok: true, checked: rows.length, pushes });
});
