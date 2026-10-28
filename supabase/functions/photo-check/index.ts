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

  const models: string[] = [...new Set([model, "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"])];
  let last = "gemini error";
  for (const m of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: image } }] }],
            generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
          }),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        last = `${m}: ${r.status} ${d?.error?.message || ""}`.slice(0, 200);
        console.error("gemini", last);
        const sug = /use models\/([\w.\-]+)/.exec(d?.error?.message || ""); if (sug && !models.includes(sug[1])) models.splice(models.indexOf(m) + 1, 0, sug[1]);
        if (r.status === 404 || sug || /model/i.test(last)) continue;
        return json({ error: last }, 502);
      }
      const parts = d?.candidates?.[0]?.content?.parts ?? [];
      const raw = parts.map((x: any) => x.text ?? "").join("").replace(/```json|```/g, "").trim();
      let out: any = {};
      try { out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) || "{}"); } catch { out = {}; }
      const ids = new Set(items.map((i) => i.id));
      return json({
        item_id: ids.has(out.item_id) ? out.item_id : null,
        name_ru: typeof out.name_ru === "string" ? out.name_ru.slice(0, 80) : null,
        price_vnd: Number.isFinite(Number(out.price_vnd)) && Number(out.price_vnd) > 0 ? Math.round(Number(out.price_vnd)) : null,
      });
    } catch (e) {
      last = `${m}: ${String((e as Error)?.message ?? e)}`.slice(0, 200);
      console.error("photo-check", last);
    }
  }
  return json({ error: last }, 502);
});
