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
const IMG_MODEL = "fal-ai/nano-banana-pro/edit";

// Serverseitig fest verdrahteter Schutz – der Kunde kann das nicht umgehen.
// Gemeinsamer Lock für beide Modi:
const COMMON_LOCK =
  "THIS IS A VIRTUAL STAGING TASK ON THE PROVIDED PHOTO — NOT a new image. " +
  "The output must be the SAME photograph, same room, same shot. " +
  "NON-NEGOTIABLE LOCKS: identical camera position, camera angle, perspective, lens and framing as the input photo. " +
  "Every window stays exactly the same (size, position, frame, glazing bars and the EXACT view outside). " +
  "Every door and every wall opening stays exactly the same (size, position, shape). " +
  "The room layout, all wall positions, ceiling lines, beams and pillars stay exactly the same. " +
  "Do not invent, move, resize, add or remove ANY structural element. Do not change the room's proportions. " +
  "Keep any person and any animal exactly as they are — same position, pose, face, clothing and scale. " +
  "Lighting direction and daylight must match the original photo. " +
  "FURNITURE PLACEMENT RULES (professional home staging for luxury real estate — must be physically realistic, exactly as a real interior designer would stage it): " +
  "NEVER place any furniture, shelf, TV unit or decor in front of or inside a door, doorway, open passage or walkway — all doors, openings and circulation paths must remain completely free and usable. " +
  "NEVER block a window: windows must remain fully visible and accessible; no tall furniture in front of glass. " +
  "TV units, shelves and cabinets ONLY against solid closed walls. " +
  "Sofas, armchairs and beds must NEVER stand directly against or in front of a window or glass door — keep clear distance so every window can be opened; nothing may touch or overlap a window frame, glass or radiator. " +
  "Orient seating the way an interior designer would: sofas and armchairs face the windows/view or the center of the room, arranged around a coffee table as a conversation group. " +
  "All furniture parallel or deliberately angled to the room axes, correctly scaled to the room, standing plausibly on the floor with correct perspective and correct shadows. " +
  "Less is more: a realistic, uncluttered arrangement that a buyer could recreate exactly. ";

// Whitelists für Boden & Wandfarbe (Kunde sendet nur den Schlüssel)
const FLOOR_OPTIONS = {
  keep:       null,
  fischgraet: "elegant oak chevron/herringbone parquet",
  dielen:     "wide light oak plank flooring",
  nussbaum:   "dark walnut parquet flooring",
  stein:      "large-format natural stone / limestone tiles",
  beton:      "polished concrete / microcement flooring"
};
const WALL_OPTIONS = {
  keep:     null,
  weiss:    "pure white, smooth matte finish",
  creme:    "warm off-white / cream",
  hellgrau: "light elegant grey",
  greige:   "warm greige (grey-beige)",
  salbei:   "soft sage green as accent, rest white"
};

// Baut den Lock je nach Modus + gewünschten Oberflächen-Änderungen
function buildLock(mode, floorKey, wallKey) {
  const floor = FLOOR_OPTIONS[floorKey] || null;
  const wall = WALL_OPTIONS[wallKey] || null;
  let lock = COMMON_LOCK;
  if (mode === "rohbau") {
    lock += "IN THIS MODE the raw unfinished surfaces may be renovated: finished walls, finished ceiling, new flooring — " +
      "but strictly WITHIN the locked structure above: windows, doors, openings, layout, proportions and camera stay 1:1. ";
    lock += "New flooring: " + (floor || "high-end flooring matching the described style") + ". ";
    lock += "Wall finish: " + (wall || "smooth elegant walls in a bright neutral tone") + ". ";
    lock += "Then furnish the renovated room as described. ";
  } else {
    const locked = ["the ceiling", "all light fixtures and switches"];
    if (!floor) locked.push("the floor (material, color, pattern)");
    if (!wall) locked.push("all wall surfaces and wall colors");
    lock += "ADDITIONALLY LOCKED IN THIS MODE: " + locked.join(", ") + " stay EXACTLY as in the input photo — zero changes. ";
    if (floor) lock += "EXCEPTION floor: replace the floor with " + floor + ", perfectly fitted to the existing room perspective. ";
    if (wall) lock += "EXCEPTION walls: repaint the wall surfaces in " + wall + " (wall positions and everything mounted on them stay identical). ";
    lock += "Beyond that, the ONLY allowed change: place furniture, rugs, plants and decor items INTO the existing room. Nothing else may differ. ";
  }
  return lock;
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

app.post("/api/stage", requireCustomer, async (req, res) => {
  try {
    const { imageDataUri, prompt, format, variants, mode, floor, wall } = req.body || {};
    const n = variants === 2 ? 2 : 1;
    if (!imageDataUri || !imageDataUri.startsWith("data:image/")) return res.status(400).json({ error: "Kein gültiges Bild übermittelt." });
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Bitte eine Beschreibung angeben." });
    if (db.credits < n) return res.status(402).json({ error: "Nicht genug Guthaben (" + db.credits + " Credits). Bitte Guthaben aufladen.", credits: db.credits });

    // Wichtig: IMMER im Originalformat generieren ("auto") – ein anderes Seitenverhältnis
    // würde die KI zwingen, den Raum neu zu erfinden. Zuschnitt passiert erst beim Export.
    const lock = buildLock(mode, floor, wall);
    const fullPrompt = lock + "FURNISHING TASK: " + prompt.trim();
    const job = await falSubmit(IMG_MODEL, {
      prompt: fullPrompt,
      image_urls: [imageDataUri],
      aspect_ratio: "auto",
      output_format: "png",
      num_images: n,
      resolution: "2K"
    });
    const result = await falWait(job);
    const images = (result.images || []).map(im => im.url);
    if (!images.length) throw new Error("Kein Bild erhalten.");

    db.credits -= images.length;
    logEvent("visualisierung", images.length + " Variante(n), Format " + (format || "original"), -images.length);
    res.json({ images, credits: db.credits });
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
