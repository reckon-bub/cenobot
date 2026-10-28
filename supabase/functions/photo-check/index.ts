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
const MODELS: string[] = [...new Set([MODEL_ENV, "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"])];
async function gemini(prompt: string, b64: string): Promise<any> {
  if (!KEY) throw new Error("GEMINI_API_KEY не задан в Secrets");
  const deadline = Date.now() + 40_000; // не дольше 40 секунд на всё
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
          signal: AbortSignal.timeout(Math.max(3000, Math.min(25_000, deadline - Date.now()))),
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  if (!key) return json({ error: "GEMINI_API_KEY is not set" }, 500);

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
    const out = await gemini(prompt, image);
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
