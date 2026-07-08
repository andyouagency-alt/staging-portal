/**
 * Virtual Staging Portal – Backend
 * - Schützt den fal.ai API-Key (bleibt auf dem Server)
 * - Verwaltet Guthaben (1 Credit = 1 Visualisierung = 2 €)
 * - Stripe Checkout für Guthaben-Kauf, Webhook schreibt Credits gut
 * - Architektur-Lock ist serverseitig fest eingebaut und vom Kunden nicht abschaltbar
 *
 * Benötigte Umgebungsvariablen (siehe .env.example / README):
 *   FAL_KEY                 fal.ai API-Key
 *   ACCESS_CODE             Zugangscode für deinen Kunden
 *   ADMIN_CODE              Dein Admin-Code (Guthaben manuell anpassen)
 *   STRIPE_SECRET_KEY       Stripe Secret Key (optional – ohne: nur manuelles Guthaben)
 *   STRIPE_WEBHOOK_SECRET   Stripe Webhook Signing Secret (optional)
 *   APP_URL                 öffentliche URL der App, z.B. https://meine-app.onrender.com
 *   DATA_DIR                Verzeichnis für die Datenbank-Datei (Default: ./data)
 */
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const FAL_KEY = process.env.FAL_KEY || "";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const ADMIN_CODE = process.env.ADMIN_CODE || "";
const APP_URL = process.env.APP_URL || "http://localhost:" + PORT;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PRICE_EUR_CENTS = 200; // 2 € pro Visualisierung

const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

// ---------- Mini-Datenbank (JSON-Datei) ----------
const DB_FILE = path.join(DATA_DIR, "db.json");
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch (e) { return { credits: 0, log: [], processedSessions: [] }; }
}
function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDb();
function logEvent(type, detail, delta) {
  db.log.unshift({ ts: new Date().toISOString(), type, detail, delta, balance: db.credits });
  db.log = db.log.slice(0, 500);
  saveDb(db);
}

// ---------- Stripe Webhook (muss VOR express.json() registriert sein) ----------
app.post("/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(400).send("Stripe nicht konfiguriert");
  let event;
  try {
    event = process.env.STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).send("Webhook-Signatur ungültig: " + err.message);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (!db.processedSessions.includes(session.id)) {
      const credits = parseInt(session.metadata && session.metadata.credits || "0", 10);
      if (credits > 0 && session.payment_status === "paid") {
        db.credits += credits;
        db.processedSessions.push(session.id);
        db.processedSessions = db.processedSessions.slice(-200);
        logEvent("kauf", credits + " Credits gekauft (Stripe " + session.id.slice(-8) + ")", +credits);
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Auth ----------
function requireCustomer(req, res, next) {
  const code = req.headers["x-access-code"] || req.query._ac;
  if (!ACCESS_CODE || code === ACCESS_CODE) return next();
  res.status(401).json({ error: "Falscher Zugangscode." });
}
function requireAdmin(req, res, next) {
  if (ADMIN_CODE && req.headers["x-admin-code"] === ADMIN_CODE) return next();
  res.status(401).json({ error: "Falscher Admin-Code." });
}

// ---------- Kunden-API ----------
app.post("/api/login", (req, res) => {
  if (!ACCESS_CODE || (req.body && req.body.code === ACCESS_CODE)) {
    return res.json({ ok: true, credits: db.credits, stripe: !!stripe });
  }
  res.status(401).json({ error: "Falscher Zugangscode." });
});

app.get("/api/credits", requireCustomer, (req, res) => {
  res.json({ credits: db.credits });
});

// Guthaben kaufen -> Stripe Checkout Session
app.post("/api/checkout", requireCustomer, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: "Online-Zahlung ist noch nicht eingerichtet. Bitte beim Anbieter melden." });
  const credits = Math.max(1, Math.min(500, parseInt(req.body.credits || "10", 10)));
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "eur",
          unit_amount: PRICE_EUR_CENTS,
          product_data: { name: "Virtual-Staging-Visualisierung (1 Credit)" }
        },
        quantity: credits
      }],
      metadata: { credits: String(credits) },
      success_url: APP_URL + "/?zahlung=ok",
      cancel_url: APP_URL + "/?zahlung=abbruch"
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Stripe-Fehler: " + err.message });
  }
});

// ---------- Generierung (fal.ai Proxy) ----------
const QUEUE = "https://queue.fal.run";
const IMG_MODEL = "fal-ai/nano-banana-pro/edit"; // bestes Editing-Modell (Qualität vor Kosten)

// Serverseitig fest verdrahteter Schutz – der Kunde kann das nicht umgehen.
// Bewusst KURZ und rein POSITIV formuliert (Verbote im Prompt bewirken bei
// Bildmodellen oft das Gegenteil – erwähnte Konzepte tauchen im Bild auf).

// Whitelists für Boden & Wandfarbe (Kunde sendet nur den Schlüssel)
const FLOOR_OPTIONS = {
  keep:       null,
  fischgraet: "elegant oak chevron/herringbone parquet",
  dielen:     "wide light oak plank flooring",
  nussbaum:   "dark walnut parquet flooring",
  stein:      "large-format natural stone / limestone tiles",
  beton:      "polished concrete / microcement flooring"
};
// Immobilientyp -> Einrichtungslogik (Whitelist)
const PROP_OPTIONS = {
  studio:    "a studio apartment where this single room is the entire living space — multifunctional, space-efficient furnishing with a high-quality sofa bed or compact bed, a wardrobe and a small dining table",
  w2:        "a 2-room apartment — furnish this room compactly and comfortably for its one dedicated function",
  w3:        "a 3-room apartment — furnish this room for its dedicated function with comfortable mid-size pieces",
  w4:        "a spacious 4+ room apartment — furnish generously",
  haus:      "a family house — furnish generously and warmly for family living",
  villa:     "a luxury villa — generous, high-end statement furnishing",
  penthouse: "a penthouse — generous, elegant high-end furnishing",
  loft:      "an open loft — generous furnishing with zoning through rugs and furniture groups"
};

const WALL_OPTIONS = {
  keep:     null,
  weiss:    "pure white, smooth matte finish",
  creme:    "warm off-white / cream",
  hellgrau: "light elegant grey",
  greige:   "warm greige (grey-beige)",
  salbei:   "soft sage green as accent, rest white"
};

// STUFE 1: KI-Innenarchitekt analysiert das Foto und schreibt einen konkreten
// Einrichtungsplan (Raumtyp, feste Elemente, exakte Möbelpositionen).
async function planStaging(imageDataUri, mode, userPrompt, propKey, sqm, facts) {
  const prop = PROP_OPTIONS[propKey] || null;
  const sqmNum = parseInt(sqm, 10);
  const factsTxt = (facts || "").toString().slice(0, 300);
  const context = [];
  if (prop) context.push("The property is " + prop);
  if (sqmNum && sqmNum >= 5 && sqmNum <= 500) context.push("This room is approx. " + sqmNum + " m2");
  if (factsTxt) context.push("Listing key facts: " + factsTxt);
  const modeTxt = mode === "rohbau"
    ? "The raw room will be renovated (new floor and wall finishes) and then furnished."
    : mode === "modern"
      ? "The existing furniture will be replaced by a new modern interior; the room shell stays unchanged."
      : "The empty room will be furnished; floor, walls and ceiling stay unchanged.";

  const r = await fetch("https://fal.run/fal-ai/any-llm/vision", {
    method: "POST",
    headers: { Authorization: "Key " + FAL_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      system_prompt: "You are a senior interior architect who writes staging plans for luxury real estate photography. Answer with the plan only, no preamble.",
      prompt: "Look carefully at this room photo. " + modeTxt + " Client wishes: " + userPrompt.trim() + ". " + context.join(". ") +
        "\nWrite a concise staging plan (max 130 words) that an image AI will execute:\n" +
        "1. State the room type and the fixed elements you can actually see (windows, doors, open passages, radiators, and for bathrooms: shower, bathtub, toilet, vanity positions).\n" +
        "2. List every furniture and decor piece to add — include EVERY item the client explicitly requested (e.g. a sofa bed must be a sofa bed, a large wardrobe must be a large wardrobe) — each with its exact position described relative to what is visible in the photo (e.g. 'sofa against the solid wall to the left of the window, facing the terrace doors').\n" +
        "3. End with exactly one line starting with 'MUST-HAVE:' listing every client-requested item in English, separated by semicolons (e.g. 'MUST-HAVE: sofa bed; dining table; TV; large wardrobe').\n" +
        "Hard rules for your plan: every window, door, passage and walkway stays completely free; nothing is placed inside a shower, bathtub or on fixtures; wall decor only on solid walls; realistic sizes; only pieces that genuinely fit this room type and size.",
      image_urls: [imageDataUri]
    })
  });
  if (!r.ok) return null;
  const d = await r.json();
  const plan = (d.output || "").trim();
  if (plan.length <= 20) return null;
  const m = plan.match(/MUST-HAVE:\s*(.+)/i);
  return { plan: plan.slice(0, 1200), mustHave: m ? m[1].trim().slice(0, 300) : null };
}

// STUFE 2: Baut den Bild-Prompt je nach Modus, Oberflächen-Wünschen und Plan – kurz und positiv
function buildPrompts(mode, floorKey, wallKey, userPrompt, propKey, sqm, facts, plan) {
  const floor = FLOOR_OPTIONS[floorKey] || null;
  const wall = WALL_OPTIONS[wallKey] || null;
  const prop = PROP_OPTIONS[propKey] || null;
  const sqmNum = parseInt(sqm, 10);
  const factsTxt = (facts || "").toString().slice(0, 300);
  const task = plan ? "Execute exactly this staging plan from the interior architect: " + plan + " " : null;
  let p = "Virtual home staging of this exact photo. ";
  const shell = "same camera angle and framing, same walls, "
    + "same open passages and doorways with the adjacent space visible through them, "
    + "same windows and exterior doors with the same frames and the same view outside, same proportions";

  if (mode === "rohbau") {
    p += "Renovate the raw surfaces: " + (floor || "high-end flooring matching the style") + " as new flooring, "
      + (wall || "smooth walls in a bright neutral tone") + " as wall finish, and a finished ceiling. "
      + "The room structure stays identical to the input photo: " + shell + ". ";
    p += task ? task : "Add freestanding furniture and decor: " + userPrompt.trim() + " ";
  } else if (mode === "modern") {
    p += "Replace the existing furniture, freestanding lamps, rugs, curtains and decor with a completely new modern interior. "
      + "The room shell stays identical to the input photo: " + shell + ", "
      + (floor ? "" : "same floor, ")
      + (wall ? "" : "same wall colors, ")
      + "same ceiling with the same built-in lamps, same switches and radiators. "
      + (floor ? "Replace only the floor with " + floor + ", fitted to the existing perspective. " : "")
      + (wall ? "Repaint only the wall surfaces in " + wall + ". " : "");
    p += task ? task : "New interior: " + userPrompt.trim() + " ";
  } else {
    p += "Keep the room itself identical to the input photo: " + shell + ", "
      + (floor ? "" : "same floor, ")
      + (wall ? "" : "same wall colors, ")
      + "same ceiling with the same existing lamps, same switches and radiators. "
      + (floor ? "Replace only the floor with " + floor + ", fitted to the existing perspective. " : "")
      + (wall ? "Repaint only the wall surfaces in " + wall + ". " : "");
    p += task ? task : "Add freestanding furniture and decor: " + userPrompt.trim() + " ";
  }
  // Immobilien-Kontext aus dem Exposé (nur wenn kein Architektenplan – der enthält ihn schon)
  if (!plan && (prop || sqmNum || factsTxt)) {
    p += "Property context: this room is part of " + (prop || "the property") + ". ";
    if (sqmNum && sqmNum >= 5 && sqmNum <= 500) p += "The room is approx. " + sqmNum + " m2 — scale the amount and size of furniture to this. ";
    if (factsTxt) p += "Key facts from the listing: " + factsTxt + ". ";
  }

  p += "Place all furniture on the open floor area in the middle of the room, leaving a generous clear zone in front of every window, glass door, doorway and walkway. "
    + "Arrange sofa and armchairs as a conversation group around a coffee table, oriented toward the windows and the view. "
    + "Cabinets, shelves and the TV stand only against the solid closed wall areas that exist in the photo. "
    + "Staged like a senior interior architect: every piece in its natural position, clear walkways, balanced proportions, realistic scale and shadows. "
    + "Photorealistic, same daylight and lighting as the original photo.";

  return { prompt: p };
}

async function falSubmit(model, input) {
  const r = await fetch(QUEUE + "/" + model, {
    method: "POST",
    headers: { Authorization: "Key " + FAL_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!r.ok) throw new Error("fal.ai Submit " + r.status + ": " + (await r.text()).slice(0, 300));
  return r.json();
}
async function falWait(job) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await (await fetch(job.status_url, { headers: { Authorization: "Key " + FAL_KEY } })).json();
    if (s.status === "COMPLETED") {
      const res = await fetch(job.response_url, { headers: { Authorization: "Key " + FAL_KEY } });
      if (!res.ok) throw new Error("fal.ai Ergebnis " + res.status);
      return res.json();
    }
    if (s.status === "FAILED" || s.status === "ERROR") throw new Error("Generierung fehlgeschlagen");
  }
  throw new Error("Zeitüberschreitung bei der Generierung");
}

// Generiert 'count' Bilder mit dem gebauten Prompt
async function generateImages(count, builtPrompt, imageDataUri) {
  const job = await falSubmit(IMG_MODEL, {
    prompt: builtPrompt,
    image_urls: [imageDataUri],
    aspect_ratio: "auto",   // IMMER Originalformat – anderes Seitenverhältnis würde
    output_format: "png",   // die KI zwingen, den Raum neu zu erfinden.
    num_images: count,
    resolution: "2K"
  });
  const result = await falWait(job);
  return (result.images || []).map(im => im.url);
}

// Automatischer Qualitäts-Check: vergleicht Original und Ergebnis strukturell.
// Bei FAIL wird neu generiert, bevor der Kunde das Bild sieht.
async function verifyStructure(originalDataUri, resultUrl, mustHave) {
  try {
    const r = await fetch("https://fal.run/fal-ai/any-llm/vision", {
      method: "POST",
      headers: { Authorization: "Key " + FAL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        system_prompt: "You are a strict quality inspector for virtual staging images. Answer with exactly 'PASS' or 'FAIL: <short reason>'.",
        prompt: "Image 1 is the original room photo. Image 2 is a virtually staged version of it. " +
          "Wall paint and floor material may differ — do not fail for those. " +
          "Answer FAIL if there is any STRUCTURAL difference: a wall was added or removed, an open passage or doorway was closed, narrowed or blocked by a new wall, " +
          "a window or balcony/exterior door was added, removed, moved or resized, the view outside a window changed to a different scene, or the camera angle/framing changed. " +
          "ALSO answer FAIL if the furniture placement is physically implausible: furniture blocking a door, doorway or walkway; tall furniture directly in front of a window; " +
          "objects placed inside a shower or bathtub or on top of fixtures; pictures/decor hanging inside a shower or on glass; floating furniture; or grossly wrong furniture scale. " +
          (mustHave ? "ALSO answer FAIL if any of these client-requested items is missing or was replaced by a different furniture type in image 2: " + mustHave + ". " : "") +
          "Otherwise answer PASS.",
        image_urls: [originalDataUri, resultUrl]
      })
    });
    if (!r.ok) return { ok: true, note: "check-unavailable" };
    const d = await r.json();
    const out = (d.output || "").trim().toUpperCase();
    return { ok: out.startsWith("PASS"), reason: d.output };
  } catch (e) { return { ok: true, note: "check-error" }; }
}

app.post("/api/stage", requireCustomer, async (req, res) => {
  try {
    const { imageDataUri, prompt, format, variants, mode, floor, wall, propType, sqm, facts } = req.body || {};
    const n = variants === 2 ? 2 : 1;
    if (!imageDataUri || !imageDataUri.startsWith("data:image/")) return res.status(400).json({ error: "Kein gültiges Bild übermittelt." });
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Bitte eine Beschreibung angeben." });
    if (db.credits < n) return res.status(402).json({ error: "Nicht genug Guthaben (" + db.credits + " Credits). Bitte Guthaben aufladen.", credits: db.credits });

    // Stufe 1: Innenarchitekten-Plan (bei Fehler der Plan-KI: Fallback auf direkten Prompt)
    let plan = null, mustHave = null;
    try {
      const planRes = await planStaging(imageDataUri, mode, prompt, propType, sqm, facts);
      if (planRes) { plan = planRes.plan; mustHave = planRes.mustHave; }
    } catch (e) { plan = null; }
    // Auch ohne Plan: explizite Kundenwünsche als Checkliste an die Endkontrolle geben
    if (!mustHave) mustHave = "the items the client requested: " + String(prompt).slice(0, 200);
    const built = buildPrompts(mode, floor, wall, prompt, propType, sqm, facts, plan);

    // Bis zu 3 Runden: generieren -> prüfen -> Fehlversuche neu generieren
    const MAX_ROUNDS = 3;
    let passed = [], lastFailed = [], need = n;
    for (let round = 0; round < MAX_ROUNDS && need > 0; round++) {
      const urls = await generateImages(need, built.prompt, imageDataUri);
      const checks = await Promise.all(urls.map(u => verifyStructure(imageDataUri, u, mustHave)));
      lastFailed = [];
      urls.forEach((u, i) => { if (checks[i].ok) passed.push(u); else lastFailed.push(u); });
      need = n - passed.length;
    }
    // Wenn nach 3 Runden nicht genug fehlerfreie Bilder: beste Fehlversuche mit Warnhinweis liefern
    let warnings = 0;
    if (need > 0) {
      const fill = lastFailed.slice(0, need);
      passed.push(...fill);
      warnings = fill.length;
    }
    if (!passed.length) throw new Error("Kein Bild erhalten.");

    db.credits -= passed.length;
    logEvent("visualisierung", passed.length + " Variante(n), Modus " + (mode || "moebeln") + ", " + (plan ? "mit Architektenplan" : "OHNE Plan (Fallback)") + (warnings ? ", " + warnings + " mit Warnung" : ""), -passed.length);
    res.json({ images: passed, credits: db.credits, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bild-Proxy fürs Canvas-Export (umgeht CORS beim Download in exakter Pixelgröße)
app.get("/api/proxy-image", requireCustomer, async (req, res) => {
  try {
    const url = req.query.url || "";
    if (!/^https:\/\/[a-z0-9.-]+\.fal\.(media|run|ai)\//.test(url) && !/^https:\/\/[a-z0-9.-]*(cloudfront|googleapis)\.[a-z.]+\//.test(url) && !/^https:\/\/v[0-9a-z]*\.fal\.media\//.test(url))
      return res.status(400).send("URL nicht erlaubt");
    const r = await fetch(url);
    res.set("Content-Type", r.headers.get("content-type") || "image/png");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).send("Proxy-Fehler"); }
});

// ---------- Admin ----------
app.post("/api/admin/credits", requireAdmin, (req, res) => {
  const delta = parseInt(req.body.delta || "0", 10);
  db.credits = Math.max(0, db.credits + delta);
  logEvent("admin", "Guthaben manuell angepasst", delta);
  res.json({ credits: db.credits });
});
app.get("/api/admin/log", requireAdmin, (req, res) => {
  res.json({ credits: db.credits, log: db.log });
});

app.listen(PORT, () => console.log("Staging-Portal läuft auf Port " + PORT));
