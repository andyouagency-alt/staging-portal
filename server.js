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
const IMG_MODEL = "fal-ai/nano-banana-2/edit";

// Serverseitig fest verdrahteter Schutz – der Kunde kann das nicht umgehen.
// Geht als system_prompt an Nano Banana 2 (getrennt von der Kundenbeschreibung).
const SYSTEM_RULES =
`You are a professional virtual staging engine for luxury real estate photography. You edit the provided photo. Absolute rules, in priority order:

1. SAME PHOTO: The output is the same photograph of the same room — identical camera position, angle, perspective, lens and framing.
2. IMMUTABLE STRUCTURE: Every wall, wall opening, passage, door, window, ceiling line, beam and pillar stays exactly where and how it is in the input photo.
   - NEVER add a wall or fill/partially fill an opening or passage. If there is an open passage, it stays fully open.
   - NEVER remove, move or resize a window or door. Window frames, glazing bars and the exact view outside stay identical.
3. NO NEW BUILT-IN LIGHTING: never add LED strips, cove lighting or spotlights. Existing light fixtures, switches, sockets and radiators stay exactly as in the photo.
4. PEOPLE AND ANIMALS stay exactly as they are (position, pose, face, clothing, scale).
5. FURNITURE PLACEMENT like a senior interior designer staging a multi-million euro property:
   - All doors, passages and walkways stay completely free.
   - Nothing stands in front of or against a window or glass door; every window must remain openable; nothing overlaps a frame, glass or radiator.
   - Sofas and armchairs form a conversation group around a coffee table, facing the view or the room center. If no solid wall is available, the sofa stands free in the room with its back to the camera or room center — never with its back against glass.
   - TV units, shelves and cabinets only against solid closed walls that exist in the photo.
   - Correct scale, correct perspective, correct floor contact and shadows.
   - Uncluttered and realistic: only furniture a buyer could actually place there.
6. LIGHTING AND COLOR of the result match the original photo (same daylight, same direction).

Before generating, mentally map every window, door and opening in the input photo and verify your furniture plan violates none of the rules.`;

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

// Baut System-Regeln + Aufgabe je nach Modus und Oberflächen-Wünschen
function buildPrompts(mode, floorKey, wallKey, userPrompt) {
  const floor = FLOOR_OPTIONS[floorKey] || null;
  const wall = WALL_OPTIONS[wallKey] || null;
  let system = SYSTEM_RULES + "\n\nMODE: ";
  if (mode === "rohbau") {
    system += "RENOVATION + STAGING. The raw unfinished surfaces may be renovated (finished walls, finished ceiling, new flooring), strictly within the immutable structure (rules 1-3). "
      + "New flooring: " + (floor || "high-end flooring matching the described style") + ". "
      + "Wall finish: " + (wall || "smooth elegant walls in a bright neutral tone") + ". Then furnish per the task.";
  } else {
    system += "STAGING ONLY. Surfaces are locked: "
      + (floor ? "" : "the floor (material, color, pattern), ")
      + (wall ? "" : "all wall surfaces and wall colors, ")
      + "the ceiling and all fixtures stay exactly as in the input photo. "
      + (floor ? "Exception floor: replace the floor with " + floor + ", fitted perfectly to the existing perspective. " : "")
      + (wall ? "Exception walls: repaint wall surfaces in " + wall + " (positions and mounted elements stay identical). " : "")
      + "Beyond that, the only allowed change: place movable furniture, rugs, plants, framed art and decor into the existing room.";
  }
  return { system, prompt: "Stage this room: " + userPrompt.trim() };
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
    const built = buildPrompts(mode, floor, wall, prompt);
    const job = await falSubmit(IMG_MODEL, {
      prompt: built.prompt,
      system_prompt: built.system,
      thinking_level: "high",
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
