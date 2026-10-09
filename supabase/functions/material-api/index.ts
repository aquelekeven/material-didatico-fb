import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

function getBackendSecretKey() {
  const newKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (newKeys) {
    try {
      const parsed = JSON.parse(newKeys);
      if (parsed?.default) return parsed.default as string;
    } catch {
      // Fallback para a variável legada abaixo.
    }
  }

  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;

  throw new Error("Nenhuma secret key do Supabase disponível na Edge Function.");
}

const BACKEND_SECRET_KEY = getBackendSecretKey();
const admin = createClient(SUPABASE_URL, BACKEND_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-session, x-admin-session, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeNameKey(name: string) {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hashPin(pin: string, salt: string) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(salt),
      iterations: 120_000,
    },
    material,
    256,
  );

  return bytesToBase64Url(new Uint8Array(bits));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function observedIp(req: Request) {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

async function writeAudit(
  req: Request,
  user: { id: string; display_name: string },
  deviceId: string | null,
  action: string,
  details: Record<string, unknown> = {},
) {
  const { error } = await admin.from("material_didatico_audit_log").insert({
    user_id: user.id,
    user_name: user.display_name,
    device_id: deviceId,
    ip_observed: observedIp(req),
    user_agent: req.headers.get("user-agent"),
    action,
    details,
  });

  if (error) console.error("audit insert failed", error);
}

function getAdminPin() {
  return Deno.env.get("ADMIN_LOG_PIN")?.trim() || null;
}

async function getAdminSession(req: Request) {
  const raw = req.headers.get("x-admin-session")?.trim();
  if (!raw) return null;

  const tokenHash = await sha256(raw);
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("material_didatico_admin_sessions")
    .select("id,device_id,expires_at,revoked_at")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

async function writeAdminAudit(
  req: Request,
  deviceId: string | null,
  action: string,
) {
  const { error } = await admin.from("material_didatico_audit_log").insert({
    user_id: null,
    user_name: "Administrador",
    device_id: deviceId,
    ip_observed: observedIp(req),
    user_agent: req.headers.get("user-agent"),
    action,
    details: {},
  });
  if (error) console.error("admin audit insert failed", error);
}

async function getSession(req: Request) {
  const raw = req.headers.get("x-app-session")?.trim();
  if (!raw) return null;

  const tokenHash = await sha256(raw);
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("material_didatico_sessions")
    .select("id,user_id,device_id,expires_at,revoked_at,material_didatico_users!inner(id,display_name)")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error || !data) return null;

  await admin
    .from("material_didatico_sessions")
    .update({ last_seen_at: now })
    .eq("id", data.id);

  const linked = Array.isArray(data.material_didatico_users)
    ? data.material_didatico_users[0]
    : data.material_didatico_users;

  return {
    session_id: data.id as string,
    user: {
      id: linked.id as string,
      display_name: linked.display_name as string,
    },
    device_id: (data.device_id as string | null) ?? null,
  };
}

function diffState(oldState: any, nextState: any) {
  const changes: any[] = [];
  const settings = ["physicalDeadline", "printDays", "daysPerBook", "readyOutside"];

  for (const field of settings) {
    if (JSON.stringify(oldState?.[field]) !== JSON.stringify(nextState?.[field])) {
      changes.push({
        scope: "settings",
        field,
        from: oldState?.[field] ?? null,
        to: nextState?.[field] ?? null,
      });
    }
  }

  if (JSON.stringify(oldState?.team ?? []) !== JSON.stringify(nextState?.team ?? [])) {
    changes.push({
      scope: "team",
      field: "designers",
      from: oldState?.team ?? [],
      to: nextState?.team ?? [],
    });
  }

  const oldMaterials = new Map((oldState?.materials ?? []).map((m: any) => [m.id, m]));
  const newMaterials = new Map((nextState?.materials ?? []).map((m: any) => [m.id, m]));

  for (const [id, next] of newMaterials) {
    const prev: any = oldMaterials.get(id);

    if (!prev) {
      changes.push({
        scope: "material",
        material_id: id,
        material_name: (next as any).name,
        field: "created",
        from: null,
        to: next,
      });
      continue;
    }

    for (const field of ["name", "owner", "plannedStart", "currentPage", "totalPages"]) {
      if (JSON.stringify(prev[field]) !== JSON.stringify((next as any)[field])) {
        changes.push({
          scope: "material",
          material_id: id,
          material_name: (next as any).name || prev.name,
          field,
          from: prev[field] ?? null,
          to: (next as any)[field] ?? null,
        });
      }
    }

    for (const stage of ["start", "inProgress", "review", "amendments", "fileClosing", "sentToPrint", "completed"]) {
      const before = prev?.flow?.[stage] ?? "";
      const after = (next as any)?.flow?.[stage] ?? "";
      if (before !== after) {
        changes.push({
          scope: "material",
          material_id: id,
          material_name: (next as any).name || prev.name,
          field: `flow.${stage}`,
          from: before || null,
          to: after || null,
        });
      }
    }
  }

  for (const [id, prev] of oldMaterials) {
    if (!newMaterials.has(id)) {
      changes.push({
        scope: "material",
        material_id: id,
        material_name: (prev as any).name,
        field: "deleted",
        from: prev,
        to: null,
      });
    }
  }

  const oldOrder = (oldState?.materials ?? []).map((m: any) => m.id);
  const newOrder = (nextState?.materials ?? []).map((m: any) => m.id);
  if (JSON.stringify(oldOrder) !== JSON.stringify(newOrder)) {
    changes.push({
      scope: "materials",
      field: "order",
      from: oldOrder,
      to: newOrder,
    });
  }

  return changes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const action = String(body?.action || "");
  const deviceId = typeof body?.device_id === "string" ? body.device_id.slice(0, 200) : null;

  if (action === "admin_login") {
    const configuredPin = getAdminPin();
    if (!configuredPin) {
      return json({ error: "O PIN administrativo ainda não foi configurado no Supabase." }, 503);
    }

    const pin = String(body?.pin || "");
    if (!/^\d{6}$/.test(pin)) {
      return json({ error: "O PIN administrativo precisa ter 6 números." }, 400);
    }

    const attemptKey = await sha256((deviceId || "no-device") + "|" + (observedIp(req) || "no-ip"));
    const { data: attempt } = await admin
      .from("material_didatico_admin_attempts")
      .select("failed_attempts,locked_until")
      .eq("attempt_key", attemptKey)
      .maybeSingle();

    if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
      return json({ error: "Muitas tentativas incorretas. Aguarde 15 minutos." }, 423);
    }

    const valid = safeEqual(await sha256(pin), await sha256(configuredPin));
    if (!valid) {
      const attempts = Number(attempt?.failed_attempts || 0) + 1;
      await admin.from("material_didatico_admin_attempts").upsert({
        attempt_key: attemptKey,
        failed_attempts: attempts >= 5 ? 0 : attempts,
        locked_until: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "attempt_key" });

      return json({ error: "PIN administrativo incorreto." }, 401);
    }

    await admin.from("material_didatico_admin_attempts").upsert({
      attempt_key: attemptKey,
      failed_attempts: 0,
      locked_until: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "attempt_key" });

    const sessionToken = randomToken(32);
    const tokenHash = await sha256(sessionToken);
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

    const { error: sessionError } = await admin
      .from("material_didatico_admin_sessions")
      .insert({
        id: sessionId,
        token_hash: tokenHash,
        device_id: deviceId,
        expires_at: expiresAt,
      });

    if (sessionError) {
      console.error(sessionError);
      return json({ error: "Não foi possível abrir a sessão administrativa." }, 500);
    }

    await writeAdminAudit(req, deviceId, "admin_login");
    return json({ session_token: sessionToken, expires_at: expiresAt });
  }

  if (action === "admin_check_session") {
    const adminSession = await getAdminSession(req);
    if (!adminSession) return json({ error: "Sessão administrativa inválida ou expirada." }, 401);
    return json({ ok: true, expires_at: adminSession.expires_at });
  }

  if (action === "admin_get_logs") {
    const adminSession = await getAdminSession(req);
    if (!adminSession) return json({ error: "Sessão administrativa inválida ou expirada." }, 401);

    const limit = Math.max(1, Math.min(1500, Number(body?.limit || 750)));
    const { data, error } = await admin
      .from("material_didatico_audit_log")
      .select("id,user_name,device_id,ip_observed,user_agent,action,details,created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error(error);
      return json({ error: "Não foi possível carregar o histórico." }, 500);
    }

    return json({ logs: data || [] });
  }

  if (action === "admin_logout") {
    const adminSession = await getAdminSession(req);
    if (!adminSession) return json({ ok: true });

    await admin
      .from("material_didatico_admin_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", adminSession.id);

    await writeAdminAudit(req, deviceId || adminSession.device_id, "admin_logout");
    return json({ ok: true });
  }

  if (action === "login") {
    const displayName = String(body?.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const nameKey = normalizeNameKey(displayName);
    const pin = String(body?.pin || "");

    if (displayName.length < 2) return json({ error: "Digite seu nome." }, 400);
    if (!/^\d{4}$/.test(pin)) return json({ error: "O PIN precisa ter 4 números." }, 400);

    const { data: existing, error: readError } = await admin
      .from("material_didatico_users")
      .select("id,display_name,name_key,pin_hash,pin_salt,failed_attempts,locked_until")
      .eq("name_key", nameKey)
      .maybeSingle();

    if (readError) {
      console.error(readError);
      return json({ error: "Erro ao consultar usuário." }, 500);
    }

    let user: any = existing;
    let created = false;

    if (user) {
      if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        return json({ error: "Muitas tentativas incorretas. Aguarde alguns minutos." }, 423);
      }

      const candidate = await hashPin(pin, user.pin_salt);
      if (!safeEqual(candidate, user.pin_hash)) {
        const attempts = Number(user.failed_attempts || 0) + 1;
        const update: Record<string, unknown> = { failed_attempts: attempts };

        if (attempts >= 5) {
          update.failed_attempts = 0;
          update.locked_until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        }

        await admin.from("material_didatico_users").update(update).eq("id", user.id);
        return json({ error: "PIN incorreto para esse nome." }, 401);
      }

      await admin.from("material_didatico_users").update({
        failed_attempts: 0,
        locked_until: null,
        last_seen_at: new Date().toISOString(),
      }).eq("id", user.id);
    } else {
      const salt = randomToken(16);
      const pinHash = await hashPin(pin, salt);
      const id = crypto.randomUUID();

      const { data: inserted, error: insertError } = await admin
        .from("material_didatico_users")
        .insert({
          id,
          display_name: displayName,
          name_key: nameKey,
          pin_hash: pinHash,
          pin_salt: salt,
          last_seen_at: new Date().toISOString(),
        })
        .select("id,display_name")
        .single();

      if (insertError) {
        console.error(insertError);
        return json({ error: "Não foi possível criar esse perfil. Tente novamente." }, 409);
      }

      user = inserted;
      created = true;
    }

    const sessionToken = randomToken(32);
    const tokenHash = await sha256(sessionToken);
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const { error: sessionError } = await admin
      .from("material_didatico_sessions")
      .insert({
        id: sessionId,
        user_id: user.id,
        token_hash: tokenHash,
        device_id: deviceId,
        expires_at: expiresAt,
      });

    if (sessionError) {
      console.error(sessionError);
      return json({ error: "Não foi possível abrir sua sessão." }, 500);
    }

    await writeAudit(req, user, deviceId, "login", { created_user: created });

    return json({
      session_token: sessionToken,
      created,
      user: { id: user.id, display_name: user.display_name },
      expires_at: expiresAt,
    });
  }

  const session = await getSession(req);
  if (!session) return json({ error: "Sessão inválida ou expirada." }, 401);

  if (action === "check_session") {
    return json({ user: session.user });
  }

  if (action === "logout") {
    await admin
      .from("material_didatico_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", session.session_id);

    await writeAudit(req, session.user, deviceId || session.device_id, "logout");
    return json({ ok: true });
  }

  if (action === "save_state") {
    const nextState = body?.state;
    const requestedRevision = Number(body?.revision ?? -1);
    const clientInstanceId =
      typeof body?.client_instance_id === "string" ? body.client_instance_id.slice(0, 200) : null;

    if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) {
      return json({ error: "Estado inválido." }, 400);
    }

    const { data: current, error: stateError } = await admin
      .from("material_didatico_state")
      .select("state,revision")
      .eq("id", "main")
      .single();

    if (stateError || !current) {
      console.error(stateError);
      return json({ error: "Estado compartilhado não encontrado." }, 500);
    }

    const currentRevision = Number(current.revision || 0);

    if (requestedRevision !== currentRevision) {
      return json({
        error: "O painel foi atualizado por outra pessoa.",
        conflict: true,
        state: current.state,
        revision: currentRevision,
      }, 409);
    }

    const changes = diffState(current.state || {}, nextState);
    if (changes.length === 0) {
      return json({ ok: true, revision: currentRevision });
    }

    const nextRevision = currentRevision + 1;
    const now = new Date().toISOString();

    const { data: updated, error: updateError } = await admin
      .from("material_didatico_state")
      .update({
        state: nextState,
        revision: nextRevision,
        updated_at: now,
        updated_by: session.user.id,
        updated_client_id: clientInstanceId,
      })
      .eq("id", "main")
      .eq("revision", currentRevision)
      .select("revision")
      .maybeSingle();

    if (updateError) {
      console.error(updateError);
      return json({ error: "Erro ao salvar o painel." }, 500);
    }

    if (!updated) {
      const { data: latest } = await admin
        .from("material_didatico_state")
        .select("state,revision")
        .eq("id", "main")
        .single();

      return json({
        error: "O painel foi atualizado por outra pessoa.",
        conflict: true,
        state: latest?.state,
        revision: Number(latest?.revision || currentRevision),
      }, 409);
    }

    await writeAudit(req, session.user, deviceId || session.device_id, "state_update", {
      revision_from: currentRevision,
      revision_to: nextRevision,
      changes,
    });

    return json({ ok: true, revision: nextRevision });
  }

  return json({ error: "Ação desconhecida." }, 400);
});
