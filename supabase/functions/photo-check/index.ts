// Supabase Edge Function: photo-check
// Принимает фото ценника/меню, отправляет в Gemini, возвращает товар и цену.
// Секреты (Edge Functions → Secrets): GEMINI_API_KEY (обязательно), GEMINI_MODEL (необязательно)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL_ENV = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
// ---------- Gemini: запасные модели, таймауты, честная ошибка ----------
const MODELS: string[] = [...new Set([MODEL_ENV, "gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite"])];
async function gemini(prompt: string, b64: string): Promise<any> {
  if (!KEY) throw new Error("GEMINI_API_KEY не задан в Secrets");
  const deadline = Date.now() + 90_000; // общий лимит (функция живёт до 150 с)
  let last = "gemini error";
  for (let i = 0; i < MODELS.length && Date.now() < deadline - 3000; i++) {
    const m = MODELS[i];
    // быстрый режим без долгих «размышлений»: 3.x — thinkingLevel, 2.x — thinkingBudget
    const think = /^gemini-[3-9]/.test(m) ? { thinkingLevel: "low" } : /flash/.test(m) ? { thinkingBudget: 0 } : null;
    for (const withThink of think ? [true, false] : [false]) {
      const gen: any = { response_mime_type: "application/json", temperature: 0.1 };
      if (withThink) gen.thinkingConfig = think;
      let r: Response, d: any;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }], generationConfig: gen }),
          signal: AbortSignal.timeout(Math.max(3000, Math.min(60_000, deadline - Date.now()))),
        });
        d = await r.json().catch(() => ({}));
      } catch (e) {
        last = `${m}: не ответил вовремя (${String((e as Error)?.name ?? e)})`;
        console.error("gemini", last);
        break; // следующая модель
      }
      const msg = String(d?.error?.message || "");
      if (r.ok) {
        const parts = d?.candidates?.[0]?.content?.parts ?? [];
        const raw = parts.map((x: any) => x.text ?? "").join("").replace(/```json|```/g, "").trim();
        const j = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
        try { return JSON.parse(j || "{}"); } catch { return {}; }
      }
      last = `${m}: ${r.status} ${msg}`.slice(0, 200);
      console.error("gemini", last);
      if (withThink && r.status === 400 && /think/i.test(msg)) continue; // не поддерживает настройку — повторим без неё
      const sug = /use models\/([\w.\-]+)/.exec(msg);
      if (sug && !MODELS.includes(sug[1])) MODELS.splice(i + 1, 0, sug[1]);
      if (r.status === 404 || r.status === 429 || r.status >= 500 || sug || /model/i.test(msg)) break; // пробуем следующую модель
      throw new Error(last); // ключ, доступ и т.п. — показываем причину
    }
  }
  throw new Error(last);
}

// ---------- OpenAI (основной, если задан OPENAI_API_KEY) ----------
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OAI_MODELS: string[] = [...new Set([Deno.env.get("OPENAI_MODEL") || "gpt-6.1-terra", "gpt-5.6-terra", "gpt-4.1-mini", "gpt-4o-mini"])];
let oaiDiscovered = false;
// если ни одна модель из списка не подошла — спрашиваем у OpenAI, какие модели доступны, и берём быструю
async function discoverModels(): Promise<string[]> {
  if (oaiDiscovered) return []; oaiDiscovered = true;
  try {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${OPENAI_KEY}` }, signal: AbortSignal.timeout(10_000) });
    const d = await r.json();
    const ids: string[] = (d?.data ?? []).map((m: any) => String(m.id))
      .filter((id: string) => /^(gpt|o\d)/.test(id) && !/audio|realtime|tts|transcribe|search|image|embed|codex|instruct|preview/.test(id));
    const rank = (id: string) => (/terra/.test(id) ? 0 : /mini/.test(id) ? 1 : /nano/.test(id) ? 2 : 3);
    return ids.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a)).slice(0, 4);
  } catch { return []; }
}
async function openai(prompt: string, b64: string): Promise<any> {
  let last = "openai error";
  const deadline = Date.now() + 60_000;
  for (let i = 0; i < OAI_MODELS.length && Date.now() < deadline; i++) {
    const m = OAI_MODELS[i];
    const reasoning = /^(gpt-[5-9]|o\d)/.test(m);
    // первая попытка — с быстрыми настройками, вторая — без них (если модель их не принимает)
    for (const tuned of [true, false]) {
      const body: any = {
        model: m,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64, detail: "high" } },
        ] }],
        response_format: { type: "json_object" },
      };
      if (tuned) { if (reasoning) body.reasoning_effort = "low"; else body.temperature = 0.1; }
      let r: Response, d: any;
      try {
        r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(3000, Math.min(30_000, deadline - Date.now()))),
        });
        d = await r.json().catch(() => ({}));
      } catch (e) {
        last = `${m}: не ответил вовремя (${String((e as Error)?.name ?? e)})`; console.error("openai", last); break;
      }
      if (r.ok) {
        const raw = String(d?.choices?.[0]?.message?.content ?? "").replace(/```json|```/g, "").trim();
        try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) || "{}"); } catch { return {}; }
      }
      const msg = String(d?.error?.message || ""), code = String(d?.error?.code || "");
      last = `${m}: ${r.status} ${code} ${msg}`.slice(0, 220); console.error("openai", last);
      if (tuned && r.status === 400 && /reasoning|temperature|unsupported/i.test(msg)) continue; // повтор без настроек
      if (r.status === 404 || code === "model_not_found" || /model/i.test(msg) || r.status >= 500) {
        if (i === OAI_MODELS.length - 1) for (const x of await discoverModels()) if (!OAI_MODELS.includes(x)) OAI_MODELS.push(x);
        break; // следующая модель
      }
      throw new Error(last); // ключ, оплата (insufficient_quota), лимит — показываем причину
    }
  }
  throw new Error(last);
}
// Сначала OpenAI (если есть ключ), при сбое — Gemini (если есть ключ)
async function ai(prompt: string, b64: string): Promise<any> {
  const hasGemini = !!(Deno.env.get("GEMINI_API_KEY"));
  if (OPENAI_KEY) {
    try { return await openai(prompt, b64); }
    catch (e) { if (!hasGemini) throw e; console.error("openai failed, fallback to gemini", e); }
  }
  return await gemini(prompt, b64);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  if (!key && !OPENAI_KEY) return json({ error: "Нет ключа: добавь OPENAI_API_KEY в Secrets" }, 500);

  let image = "", items: { id: string; name: string; vi: string }[] = [];
  try {
    const b = await req.json();
    image = String(b.image || "");
    items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!image || image.length > 4_000_000) return json({ error: "no image or too big" }, 400);

  const list = items.map((i) => `${i.id}: ${i.name} (${i.vi})`).join("\n");
  const prompt =
`Ты помогаешь туристу во Вьетнаме (Нячанг). На фото ценник, меню или прилавок.
Определи главный товар/блюдо и его цену в вьетнамских донгах.
Цены пишут как "25.000", "25,000", "25k", "25K", "25" (значит 25 000). Верни целое число донгов.
Выбери item_id из списка ниже, если товар подходит. Если не подходит — null.
Список:
${list}

Ответь ТОЛЬКО JSON без пояснений:
{"item_id": "id или null", "name_ru": "название по-русски коротко", "price_vnd": число или null}`;

  try {
    const out = await ai(prompt, image);
    const ids = new Set(items.map((i) => i.id));
    return json({
      item_id: ids.has(out.item_id) ? out.item_id : null,
      name_ru: typeof out.name_ru === "string" ? out.name_ru.slice(0, 80) : null,
      price_vnd: Number.isFinite(Number(out.price_vnd)) && Number(out.price_vnd) > 0 ? Math.round(Number(out.price_vnd)) : null,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 200) }, 502);
  }
});
