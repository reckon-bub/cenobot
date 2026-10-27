// Supabase Edge Function: tg-bot — Telegram-бот «Почём Нячанг»
// Что умеет:
//   /start            → приветствие + кнопка «Открыть Почём Нячанг»
//   фото ценника/меню → распознаёт товар и цену (Gemini) → вердикт + лестница цен
//   текст «кокос 50000» → вердикт без фото
// Секреты (Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN  — токен из @BotFather
//   TG_WEBHOOK_SECRET   — любая длинная строка (защита от чужих запросов)
//   GEMINI_API_KEY      — уже добавлен для photo-check
//   GEMINI_MODEL        — необязательно (по умолчанию gemini-2.5-flash)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.

const APP_URL = "https://reckon-bub.github.io/cenobot/";
const ITEMS_URL = APP_URL + "items.csv";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

type Tier = [number, number] | null;
type Item = { id: string; cat: string; emoji: string; name: string; vi: string; s: Tier; c: Tier; t: Tier; tip: string; alias: string };

// ---------- цены ----------
let cache: { at: number; items: Item[] } = { at: 0, items: [] };

function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(f); rows.push(row); row = []; f = "";
    } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows.shift() ?? [];
  return rows.filter((r) => r.length > 1 && r[0]).map((r) => {
    const o: Record<string, string> = {};
    h.forEach((k, j) => (o[k.trim()] = (r[j] ?? "").trim()));
    return o;
  });
}
function rng(a: string, b: string): Tier {
  let x = parseInt(a, 10), y = parseInt(b, 10);
  if (isNaN(x) && isNaN(y)) return null;
  if (isNaN(x)) x = y; if (isNaN(y)) y = x;
  return [x, y];
}
async function items(): Promise<Item[]> {
  if (cache.items.length && Date.now() - cache.at < 10 * 60 * 1000) return cache.items;
  const r = await fetch(ITEMS_URL + "?v=" + Date.now());
  const list = parseCSV(await r.text()).map((o) => ({
    id: o.id, cat: o.cat, emoji: o.emoji, name: o.name, vi: o.vi,
    s: rng(o.s_min, o.s_max), c: rng(o.c_min, o.c_max), t: rng(o.t_min, o.t_max), tip: o.tip, alias: o.alias ?? "",
  })).filter((x) => x.s || x.c || x.t);
  cache = { at: Date.now(), items: list };
  return list;
}

// ---------- вердикт ----------
const fmt = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₫";
const k = (v: number) => (v >= 1000 ? String(Math.round(v / 100) / 10).replace(".", ",").replace(/,0$/, "") + "k" : String(v));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ceil(it: Item, p: "s" | "c" | "t"): { v: number; est: boolean } {
  if (it[p]) return { v: it[p]![1], est: false };
  const b = (it.c || it.s || it.t)!;
  if (p === "s") return { v: (it.c || b)[1], est: true };
  if (p === "c") return { v: it.s ? Math.round(it.s[1] * 1.6 / 1000) * 1000 : b[1], est: true };
  return { v: Math.round((it.c || b)[1] * 1.6 / 1000) * 1000, est: true };
}
type P = "s" | "c" | "t";
function names(it: Item): Record<P, { label: string; where: string }> {
  if (it.cat === "Экскурсии") return {
    s: { label: "🛵 Улица", where: "на улице" },
    c: { label: "🎟 Напрямую / на кассе", where: "напрямую на кассе" },
    t: { label: "🧳 Через агентство", where: "через агентство" },
  };
  if (it.cat === "Услуги") return {
    s: { label: "🛵 Улица / рынок", where: "на улице" },
    c: { label: "🏪 Обычный салон", where: "в обычном салоне" },
    t: { label: "🏖 Туристический центр", where: "в туристическом центре" },
  };
  return {
    s: { label: "🛵 Улица / рынок", where: "на улице и рынке" },
    c: { label: "🏪 Кафе / магазин", where: "в обычном кафе или магазине" },
    t: { label: "🏖 Набережная / отель", where: "на набережной и в отелях" },
  };
}
function ladder(it: Item): string {
  const n = names(it);
  return (["s", "c", "t"] as P[]).map((p) => {
    const t = it[p];
    if (t) return `${n[p].label}: <b>${t[0] === t[1] ? k(t[0]) : k(t[0]) + "–" + k(t[1])} ₫</b>`;
    if (p === "t") return `${n[p].label}: до ~${k(ceil(it, "t").v)} ₫ <i>(оценка)</i>`;
    return null;
  }).filter(Boolean).join("\n");
}
function verdictAt(it: Item, price: number, p: P): { text: string; v: string } {
  const n = names(it), c = ceil(it, p);
  let head: string, v: string, say = "";
  if (price <= c.v) { v = "ok"; head = `🟢 <b>Норм цена</b> — ${n[p].where} обычно до ${fmt(c.v)}${c.est ? " (оценка)" : ""}.`; }
  else if (price <= c.v * 1.5) { v = "warn"; head = `🟠 <b>Дороговато.</b> ${n[p].where[0].toUpperCase() + n[p].where.slice(1)} обычно до ${fmt(c.v)} — можно поторговаться.`; say = "Bớt được không? — Можно дешевле?"; }
  else { v = "tourist"; head = `🔴 <b>Цена для туриста.</b> Переплата в ${(price / c.v).toFixed(1).replace(".", ",")} раза — ${n[p].where} обычно до ${fmt(c.v)}.`; say = "Đắt quá! (дат куá) — Слишком дорого!"; }
  let out = `${it.emoji} <b>${esc(it.name)}</b> · ${esc(it.vi)}\nПросят: <b>${fmt(price)}</b> · ${n[p].label}\n\n${head}\n\n<b>Лестница цен</b>\n${ladder(it)}`;
  if (it.tip) out += `\n\n💡 ${esc(it.tip)}`;
  if (say) out += `\n\n🗣 Скажи продавцу: <b>${say}</b>`;
  return { text: out, v };
}
function placeOf(text: string): P | null {
  const t = text.toLowerCase();
  if (/набережн|отел|пляж|тран фу|чан фу|tran phu|туристич|ресторан|агентств/.test(t)) return "t";
  if (/улиц|рынк|рынок|тележк|лавк|уличн|с рук|кассе|касса|напрямую/.test(t)) return "s";
  if (/кафе|магазин|супермаркет|кофейн|салон|доставк|граб|grab/.test(t)) return "c";
  return null;
}
function verdict(it: Item, price: number, place: P | null = null): { text: string; v: string } {
  if (place) {
    // для экскурсий «на кассе/напрямую» — это ступень c
    if (it.cat === "Экскурсии" && place === "s") place = "c";
    return verdictAt(it, price, place);
  }
  const n = names(it);
  // ступени: реальные данные + оценка для верхней, если её нет
  const steps: { p: P; v: number }[] = (["s", "c", "t"] as P[])
    .filter((p) => it[p] || p === "t")
    .map((p) => ({ p, v: ceil(it, p).v }));
  const hit = steps.findIndex((st) => price <= st.v);
  const top = steps[steps.length - 1];
  let head: string, v: string, say = "";
  if (hit === 0) {
    v = "ok";
    head = steps[0].p === "s" ? "🟢 <b>Норм цена</b> — так берут даже на улице." : "🟢 <b>Норм цена.</b>";
  } else if (hit > 0) {
    const cur = steps[hit], prev = steps[hit - 1];
    v = cur.p === "t" ? "warn" : "ok";
    head = `${cur.p === "t" ? "🟠" : "🟡"} <b>Так берут ${n[cur.p].where}.</b> ${n[prev.p].where[0].toUpperCase() + n[prev.p].where.slice(1)} — до ${fmt(prev.v)}${it.cat === "Экскурсии" ? ", выгоднее самому" : ", можно поторговаться"}.`;
    say = "Bớt được không? — Можно дешевле?";
  } else {
    v = "tourist";
    head = `🔴 <b>Цена для туриста.</b> Переплата в ${(price / top.v).toFixed(1).replace(".", ",")} раза — даже ${n[top.p].where} обычно до ${fmt(top.v)}.`;
    say = "Đắt quá! (дат куá) — Слишком дорого!";
  }
  let out = `${it.emoji} <b>${esc(it.name)}</b> · ${esc(it.vi)}\nПросят: <b>${fmt(price)}</b>\n\n${head}\n\n<b>Лестница цен</b>\n${ladder(it)}`;
  if (it.tip) out += `\n\n💡 ${esc(it.tip)}`;
  if (say) out += `\n\n🗣 Скажи продавцу: <b>${say}</b>`;
  return { text: out, v };
}

// ---------- Telegram ----------
async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const appButton = { inline_keyboard: [[{ text: "🥥 Открыть Почём Нячанг", web_app: { url: APP_URL } }]] };
async function send(chat: number, text: string, button = true) {
  await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(button ? { reply_markup: appButton } : {}) });
}

// ---------- статистика ----------
async function log(user: any, type: string, d: { item?: string | null; price?: number | null; verdict?: string | null } = {}) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/events`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ uid: "tg" + user.id, tg_id: user.id, source: "bot", lang: user.language_code ?? null, type, item: d.item ?? null, price: d.price ?? null, verdict: d.verdict ?? null }),
    });
  } catch (_) { /* статистика не должна ломать бота */ }
}

// ---------- распознавание фото ----------
async function recognize(b64: string, list: Item[]) {
  const ids = list.map((i) => `${i.id}: ${i.name} (${i.vi})`).join("\n");
  const prompt =
`Ты помогаешь туристу во Вьетнаме (Нячанг). На фото ценник, меню, прайс или прилавок.
Определи главный товар/блюдо/услугу и его цену во вьетнамских донгах.
Цены пишут как "25.000", "25,000", "25k", "25K", "25" (значит 25 000). Если цена в $, переведи по курсу 1$ = 25 900 донгов.
Выбери item_id из списка, если подходит. Если не подходит — null.
Список:
${ids}

Ответь ТОЛЬКО JSON: {"item_id": "id или null", "name_ru": "коротко по-русски", "price_vnd": число или null}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || "gemini error");
  const out = JSON.parse(d?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
  const price = Number(out.price_vnd);
  return {
    item: list.find((i) => i.id === out.item_id) ?? null,
    name: typeof out.name_ru === "string" ? out.name_ru.slice(0, 80) : null,
    price: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
  };
}
function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- текст «кокос 50000» ----------
function parseText(text: string, list: Item[]) {
  const low = text.toLowerCase();
  const m = low.replace(/(\d)[ .,](?=\d{3}\b)/g, "$1").match(/(\d+(?:[.,]\d+)?)\s*(k|к|тыс|тысяч)?/);
  let price: number | null = null;
  if (m) {
    let v = parseFloat(m[1].replace(",", "."));
    if (m[2] || v < 1000) v *= 1000;
    price = Math.round(v);
  }
  const STOP = new Set(["на","в","во","за","с","со","у","и","а","по","до","от","просят","просит","стоит","сколько","цена","улице","улица","рынке","рынок","кафе","магазине","магазин","набережной","отеле","пляже","это","мне","нам","тыс","тысяч","k","к","vnd","донгов","донг"]);
  const words = low.replace(/[\d.,]+/g, " ").split(/[^\p{L}]+/u).filter((w) => w.length >= 2 && !STOP.has(w));
  let best: Item | null = null, score = 0;
  for (const it of list) {
    const hay = (it.name + " " + it.vi + " " + (it.alias || "")).toLowerCase();
    const toks = hay.split(/[^\p{L}]+/u);
    let sc = 0;
    for (const w of words) {
      if (w.length <= 3) { if (toks.includes(w)) sc += 2; }
      else if (hay.includes(w.slice(0, Math.max(4, w.length - 2)))) sc += 1;
    }
    if (sc > score) { score = sc; best = it; }
  }
  return { item: score ? best : null, price, place: placeOf(text) };
}

const HELP =
`Привет! Я <b>Почём Нячанг</b> 🥥 — проверяю цены, чтобы тебя не развели.

<b>Как пользоваться:</b>
📷 Пришли фото ценника, меню или прайса — скажу, норм цена или для туриста.
✍️ Или напиши, например: <code>кокос 50000 на улице</code> или <code>массаж 300k</code>
📍 Можно добавить, где ты: <i>на улице, в кафе, на набережной</i> — вердикт будет точнее.
📱 Или открой приложение кнопкой ниже: там все цены, лестница «улица → кафе → набережная» и фразы на вьетнамском.`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) return new Response("forbidden", { status: 403 });

  let upd: any;
  try { upd = await req.json(); } catch { return new Response("ok"); }
  const msg = upd.message ?? upd.edited_message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return new Response("ok");
  const chat = msg.chat.id, user = msg.from ?? { id: chat };

  try {
    const text: string = msg.text ?? "";
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await log(user, text.startsWith("/start") ? "bot_start" : "bot_help");
      await send(chat, HELP);
      return new Response("ok");
    }

    if (msg.photo?.length) {
      await tg("sendChatAction", { chat_id: chat, action: "typing" });
      const list = await items();
      const ph = msg.photo[msg.photo.length - 1];
      const f = await tg("getFile", { file_id: ph.file_id });
      const path = f?.result?.file_path;
      if (!path) { await send(chat, "Не смог скачать фото. Попробуй отправить ещё раз."); return new Response("ok"); }
      const img = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`);
      const buf = await img.arrayBuffer();
      if (buf.byteLength > 6_000_000) { await send(chat, "Фото слишком большое. Отправь обычным фото, не файлом."); return new Response("ok"); }
      const r = await recognize(toB64(buf), list);
      const pl = placeOf(msg.caption ?? "");
      if (r.item && r.price) {
        const v = verdict(r.item, r.price, pl);
        await log(user, "photo", { item: r.item.id, price: r.price, verdict: v.v });
        await send(chat, v.text);
      } else if (r.item) {
        await log(user, "photo", { item: r.item.id });
        await send(chat, `${r.item.emoji} Вижу: <b>${esc(r.item.name)}</b>, но цену не разобрал.\n\n<b>Лестница цен</b>\n${ladder(r.item)}\n\nНапиши цену, например: <code>${esc(r.item.name.split(/[ ,(]/)[0].toLowerCase())} 50000</code>`);
      } else {
        await log(user, "photo", { item: r.name ?? "unknown", price: r.price });
        await send(chat, `Вижу: <b>${esc(r.name ?? "не понял, что это")}</b>${r.price ? ", " + fmt(r.price) : ""}.\nЭтого пока нет в моей базе — я её пополняю каждый день. Открой приложение и выбери похожий товар 👇`);
      }
      return new Response("ok");
    }

    if (text) {
      const list = await items();
      const r = parseText(text, list);
      if (r.item && r.price) {
        const v = verdict(r.item, r.price, r.place);
        await log(user, "check", { item: r.item.id, price: r.price, verdict: v.v });
        await send(chat, v.text);
      } else if (r.item) {
        await log(user, "bot_text", { item: r.item.id });
        await send(chat, `${r.item.emoji} <b>${esc(r.item.name)}</b>\n\n<b>Лестница цен</b>\n${ladder(r.item)}${r.item.tip ? "\n\n💡 " + esc(r.item.tip) : ""}\n\nНапиши ещё и цену — скажу, норм или нет.`);
      } else {
        await log(user, "bot_text");
        await send(chat, `Не понял 🙈 Пришли фото ценника или напиши, например: <code>кокос 50000</code>`);
      }
    }
  } catch (_e) {
    try { await send(chat, "Что-то пошло не так 🙈 Попробуй ещё раз через минуту или открой приложение 👇"); } catch (_) { /* ignore */ }
  }
  return new Response("ok");
});
