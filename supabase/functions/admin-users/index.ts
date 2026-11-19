import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_DOMAIN = "staff.tent-booking.app";
const emailOf = (u: string) => `${u}@${EMAIL_DOMAIN}`;
const USER_RE = /^[a-z0-9_.]{3,30}$/;
const MAX_RECOVER_FAILS = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body.action || "");

  const cleanUser = (u: unknown) => String(u ?? "").trim().toLowerCase();
  const cleanName = (n: unknown) => String(n ?? "").trim().slice(0, 60);
  const checkPass = (p: unknown) => typeof p === "string" && p.length >= 6 && p.length <= 72;
  const secret = async (k: string) => {
    const { data } = await admin.from("app_secrets").select("v").eq("k", k).maybeSingle();
    return data ? String(data.v) : null;
  };

  // ---- first-time setup: create the owner (only while no owner exists, needs the setup code)
  if (action === "bootstrap") {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "owner");
    if ((count ?? 0) > 0) return json({ error: "owner_exists" }, 403);
    const sc = await secret("setup_code");
    if (!sc || String(body.code ?? "").trim() !== sc) return json({ error: "bad_code" }, 403);
    const username = cleanUser(body.username), display_name = cleanName(body.display_name) || username;
    if (!USER_RE.test(username)) return json({ error: "bad_username" }, 400);
    if (!checkPass(body.password)) return json({ error: "bad_password" }, 400);
    const { data, error } = await admin.auth.admin.createUser({ email: emailOf(username), password: body.password, email_confirm: true });
    if (error || !data.user) return json({ error: "create_failed", detail: error?.message }, 400);
    const { error: pe } = await admin.from("profiles").insert({ id: data.user.id, username, display_name, role: "owner", can_book: true });
    if (pe) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: "profile_failed", detail: pe.message }, 400); }
    return json({ ok: true });
  }

  // ---- owner forgot password: recovery code + new password (locks after too many wrong codes)
  if (action === "recover") {
    const fails = Number(await secret("recover_fails") || "0");
    if (fails >= MAX_RECOVER_FAILS) return json({ error: "recover_locked" }, 403);
    const rc = await secret("recovery_code");
    if (!rc || String(body.code ?? "").trim() !== rc) {
      await admin.from("app_secrets").upsert({ k: "recover_fails", v: String(fails + 1) });
      return json({ error: "bad_code" }, 403);
    }
    if (!checkPass(body.password)) return json({ error: "bad_password" }, 400);
    const { data: ownerP } = await admin.from("profiles").select("id, username").eq("role", "owner").maybeSingle();
    if (!ownerP) return json({ error: "not_found" }, 404);
    const { error } = await admin.auth.admin.updateUserById(ownerP.id, { password: body.password });
    if (error) return json({ error: "password_failed", detail: error.message }, 400);
    await admin.from("app_secrets").upsert({ k: "recover_fails", v: "0" });
    return json({ ok: true, username: ownerP.username });
  }

  // ---- everything else: caller must be the owner
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who.user) return json({ error: "unauthorized" }, 401);
  const { data: me } = await admin.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
  if (!me || me.role !== "owner") return json({ error: "forbidden" }, 403);

  const cafeOrNull = async (c: unknown) => {
    if (!c) return null;
    const { data } = await admin.from("cafes").select("id").eq("id", String(c)).maybeSingle();
    return data ? data.id : null;
  };

  if (action === "create") {
    const username = cleanUser(body.username), display_name = cleanName(body.display_name) || username;
    if (!USER_RE.test(username)) return json({ error: "bad_username" }, 400);
    if (!checkPass(body.password)) return json({ error: "bad_password" }, 400);
    const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
    if (taken) return json({ error: "username_taken" }, 409);
    const cafe_id = await cafeOrNull(body.cafe_id);
    const { data, error } = await admin.auth.admin.createUser({ email: emailOf(username), password: body.password, email_confirm: true });
    if (error || !data.user) return json({ error: "create_failed", detail: error?.message }, 400);
    const { error: pe } = await admin.from("profiles").insert({ id: data.user.id, username, display_name, role: "staff", cafe_id, can_book: !!body.can_book && !!cafe_id, see_all: !!body.see_all || !cafe_id });
    if (pe) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: "profile_failed", detail: pe.message }, 400); }
    return json({ ok: true, id: data.user.id });
  }

  if (action === "update") {
    const id = String(body.id || "");
    const { data: target } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
    if (!target) return json({ error: "not_found" }, 404);
    const patch: Record<string, unknown> = {};
    if (body.display_name !== undefined) patch.display_name = cleanName(body.display_name) || "موظف";
    if (target.role !== "owner") {
      if (body.cafe_id !== undefined) patch.cafe_id = await cafeOrNull(body.cafe_id);
      if (body.can_book !== undefined) patch.can_book = !!body.can_book;
      if (body.see_all !== undefined) patch.see_all = !!body.see_all;
      if (patch.cafe_id === null){ patch.can_book = false; patch.see_all = true; }
    }
    if (Object.keys(patch).length) {
      const { error } = await admin.from("profiles").update(patch).eq("id", id);
      if (error) return json({ error: "update_failed", detail: error.message }, 400);
    }
    if (body.password !== undefined && body.password !== "") {
      if (!checkPass(body.password)) return json({ error: "bad_password" }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password: body.password });
      if (error) return json({ error: "password_failed", detail: error.message }, 400);
    }
    return json({ ok: true });
  }

  if (action === "delete") {
    const id = String(body.id || "");
    if (id === who.user.id) return json({ error: "cannot_delete_self" }, 400);
    const { data: target } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
    if (!target) return json({ error: "not_found" }, 404);
    if (target.role === "owner") return json({ error: "cannot_delete_owner" }, 400);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return json({ error: "delete_failed", detail: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
