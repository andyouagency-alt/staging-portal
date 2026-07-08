# Virtual Staging Portal

Web-App für dein Immobilien-Kundengeschäft: Dein Kunde lädt Fotos hoch, beschreibt die gewünschte Einrichtung, wählt eine Variante und exportiert sie als PNG/JPEG. Jede Visualisierung kostet 1 Credit (2 €). Guthaben kauft der Kunde per Stripe direkt in der App – das Geld geht auf dein Stripe-Konto.

**Sicherheit:** Dein fal.ai-Key bleibt auf dem Server. Der Architektur-Schutz (Wände, Fenster, Ausblick, Personen bleiben unverändert) ist serverseitig fest eingebaut – der Kunde kann ihn nicht umgehen.

## Deine Marge

- Kunde zahlt: 2,00 € pro Visualisierung
- Deine Kosten (fal.ai, Nano Banana Pro 2K): ca. $0,15 ≈ 0,14 €
- **Marge: ca. 1,85 € pro Bild** (abzgl. Stripe-Gebühr ~1,5 % + 0,25 € pro Zahlung)

## Setup (einmalig, ca. 20 Minuten)

### 1. fal.ai
1. Account auf [fal.ai](https://fal.ai), unter **Dashboard → Keys** einen API-Key erstellen.
2. Guthaben aufladen (Billing).

### 2. Stripe (für den Guthaben-Verkauf)
1. Account auf [stripe.com](https://stripe.com) (Business-Angaben nötig).
2. **Entwickler → API-Schlüssel**: den *Secret Key* kopieren (`sk_live_...`, zum Testen `sk_test_...`).
3. **Entwickler → Webhooks → Endpoint hinzufügen**:
   - URL: `https://DEINE-APP.onrender.com/webhook/stripe`
   - Event: `checkout.session.completed`
   - Den *Signing Secret* kopieren (`whsec_...`).

### 3. Render.com (Hosting)
1. Account auf [render.com](https://render.com), **New → Web Service**.
2. Code hochladen: entweder dieses Verzeichnis in ein GitHub-Repo pushen und verbinden, oder Renders Upload nutzen.
3. Einstellungen:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
4. **Environment Variables** setzen:

   | Variable | Wert |
   |---|---|
   | `FAL_KEY` | dein fal.ai-Key |
   | `ACCESS_CODE` | Zugangscode für deinen Kunden (frei wählbar) |
   | `ADMIN_CODE` | dein Admin-Code (frei wählbar, geheim halten) |
   | `STRIPE_SECRET_KEY` | `sk_live_...` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
   | `APP_URL` | `https://DEINE-APP.onrender.com` |
   | `DATA_DIR` | `/var/data` (siehe Punkt 5) |

5. **Wichtig – Guthaben dauerhaft speichern:** Im kostenlosen Render-Tarif geht die Datenbank-Datei bei jedem Neustart verloren. Nimm den **Starter-Tarif (~$7/Monat)** und füge unter **Disks** eine Disk hinzu (1 GB, Mount Path `/var/data`). Dann bleibt das Guthaben deines Kunden sicher gespeichert.

### 4. Testen
1. `https://DEINE-APP.onrender.com` öffnen, mit `ACCESS_CODE` anmelden.
2. Admin-Bereich: `https://DEINE-APP.onrender.com/admin.html` – mit `ADMIN_CODE` kannst du Guthaben manuell anpassen (z.B. Startguthaben schenken) und den Verlauf sehen.
3. Stripe erst mit `sk_test_...` testen (Testkarte `4242 4242 4242 4242`), dann auf Live-Keys wechseln.

## Ohne Stripe starten

Lass `STRIPE_SECRET_KEY` einfach weg: Der "Aufladen"-Button verschwindet, und du buchst Guthaben manuell im Admin-Bereich auf (z.B. nach Rechnungszahlung). Stripe kannst du jederzeit nachrüsten.

## Lokal ausprobieren

```bash
npm install
FAL_KEY=dein-key ACCESS_CODE=test ADMIN_CODE=admin node server.js
# -> http://localhost:3000  (Admin: http://localhost:3000/admin.html)
```

## Rechtlicher Hinweis

KI-Visualisierungen in Exposés immer als „Visualisierung" kennzeichnen (Irreführungsverbot). Der Hinweis wird dem Kunden auch in der App angezeigt.
