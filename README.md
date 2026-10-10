# Driver Attendance, Face Verification & Location System

A production system for ~400 drivers, built as **two separate-feeling web
apps sharing one backend**:

- **Employee portal** (`attendance.yourcompany.com`) — a driver opens the
  link on their phone and, in order: allows location → enters their
  Employee Number → takes a selfie (verified against their enrolled face,
  with a head-turn liveness check) → types their truck / number plate →
  attendance is recorded. No app install, no login, no truck list to pick
  from.
- **Admin portal** (`admin.yourcompany.com`) — a completely separate login
  screen and dashboard. Admins never see the driver flow; drivers never see
  anything admin-related.

---

## 1. ARCHITECTURE

### One backend, two front doors
Both portals are served by **the same Node/Express server and the same
Postgres database** — but which one a visitor sees is decided entirely by
which subdomain they're on (`attendance.` vs `admin.`). This is
deliberately *not* two separate deployments: running two backends and two
databases would double your hosting bill for no real benefit at 400
drivers. From the outside they behave like two independent apps — different
URLs, different screens, no cross-navigation, no shared session — while
underneath you only maintain and pay for one server.

### Component choices

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite | Simple, fast, cheap to host |
| Backend | Node.js + Express + TypeScript | Well understood, cheap to run |
| Database | PostgreSQL | Real ACID guarantees, unique constraints for duplicate prevention |
| ORM | Prisma | Type-safe queries, easy migrations |
| Auth | Server-side sessions (Postgres-backed) + bcrypt | No third-party auth bill; fully under your control |
| Face verification | Self-hosted, open-source (`@vladmandic/face-api` on `@tensorflow/tfjs-node`) | **Free**, runs on your own server, no per-verification API cost, biometric data never leaves your infrastructure |
| Liveness | Head-turn challenge-response (server-checked from face landmarks) | Free, stops the most common "hold up a photo" spoof. **Not** bank-grade liveness — see limitations below |
| Photo audit trail | Verification selfie kept 3 days (configurable), then auto-deleted | Lets an admin manually confirm a disputed record without storing biometric photos indefinitely |
| Truck entry | Free text, typed by the driver | No truck registry to maintain; matches your exact requested flow |
| Maps | Plain `https://www.google.com/maps?q=lat,lng` links | Zero cost — no Google Maps API billing |
| Hosting | Single VPS (Docker Compose: app + Postgres + Caddy) | Cheapest way to run everything with room to spare in your budget |
| HTTPS | Caddy (automatic free Let's Encrypt certificates for both subdomains) | Zero cost, zero manual renewal |

### The exact driver flow (as specified)
1. **Allow Location** — GPS is captured first, before the driver is even
   identified.
2. **Enter Employee Number** — a short number assigned at registration
   (e.g. `101`, `102`, ...). This is a *claim*, not proof — the next step
   is what actually verifies identity.
3. **Camera opens** — a straight-on selfie, then a "turn your head
   slightly left/right" shot for liveness. The selfie is matched **1:1**
   against the ONE employee number just entered (never a 1-to-400 search).
4. **Enter Truck Number** — free text, typed by the driver.
5. **Attendance recorded** — the server independently re-derives every
   value (identity via face match, location via GPS, time via server
   clock); nothing the browser claims is trusted directly.

### Why the face check is 1:1, not a database search
Because the driver types their Employee Number first, the server only
needs to compare the live selfie against *that one driver's* stored face
data — not search across all 400. This is faster, cheaper, and is why the
admin dashboard can confidently show *who* marked attendance: the name
shown is the one whose face was actually matched, not just whichever
number was typed in.

### Why NOT a commercial face API (AWS Rekognition, Azure Face, etc.)
At ~10,400 verifications/month, a commercial API bills every month and
sends employee biometric photos to a third party. The self-hosted
open-source model (MIT license) does the same 1:1 verification entirely on
your own server for $0 in API fees. Trade-off: you're responsible for the
server it runs on (already covered by the VPS) and its accuracy isn't
independently certified the way a commercial vendor's is — for an
attendance system (not a bank KYC system), that's the right trade for your
budget.

### Liveness — honest limitation
The head-turn check compares the position of the nose relative to the eyes
between two photos. It stops the cheapest, most common spoof (holding up a
static photo without moving it). It is **not** equivalent to commercial
liveness detection (no depth sensing, no texture analysis). If higher
assurance is ever needed, a commercial liveness API can be swapped in
later — it's a contained change in `server/faceService.ts`, not a redesign.

### The 3-day photo retention
Every time a selfie passes face + liveness verification, it's saved to
disk. When the driver submits, that photo is attached to the attendance
record with an expiry timestamp (default: 3 days, configurable in Settings
as `Photo Retention (days)`). An admin can click **View** next to any
attendance row to see it. A background job runs every hour and permanently
deletes any photo past its expiry — the file is removed from disk and the
database reference is cleared, not just hidden. This gives you a short
window to manually resolve disputes ("was that really him?") without
keeping biometric photos indefinitely.

---

## 2. EXPECTED MONTHLY COST (Pakistan, 400 drivers)

| Item | Minimum-cost | **Recommended (implemented)** | Higher-security |
|---|---|---|---|
| VPS (app + Postgres) | $4–5/mo (1 vCPU/2GB) | **$6–8/mo (2 vCPU/4GB — needed for the face model)** | $15–20/mo (managed DB separate from app) |
| Domain | ~$10–12/year (~PKR 250–350/mo) | same | same |
| HTTPS | $0 (Caddy/Let's Encrypt) | $0 | $0 |
| Face verification | $0 (self-hosted) | **$0 (self-hosted)** | Commercial API: ~$10–100/mo at this volume |
| Photo storage (3-day retention) | negligible | **negligible (~a few hundred MB, auto-purged)** | same |
| Maps | $0 (plain links, no API) | **$0** | $0 |
| Backups (off-server, e.g. Backblaze B2) | $0–1/mo | **~$0.50/mo** | Same + geo-redundant tier |
| **Total** | **~PKR 1,700–2,000/mo** | **~PKR 2,000–2,800/mo** | ~PKR 4,000–7,000/mo |

All options are comfortably under your **PKR 15,000/month** budget. I
implemented the **Recommended** column.

---

## 3. WHAT I HAVE ALREADY DONE

- Full PostgreSQL schema (`prisma/schema.prisma`): employees, attendance,
  attendance_sessions, admin_users, audit_logs, attendance_corrections,
  company_settings, sheets_config
- Real bcrypt-based admin authentication with Postgres-backed sessions,
  rate-limited login, RBAC (ADMIN / MANAGER / VIEWER)
- Self-hosted face verification (1:1, claimed-identity-only) with a model
  download script (`npm run models:download`, pulls open-source MIT weights)
- Head-turn liveness challenge-response
- **3-day (configurable) verification-photo retention** with an automatic
  hourly cleanup job that permanently deletes expired photos
- Server-side `attendance_sessions` state machine, in the exact order
  requested (Location → Employee Number → Face → Truck → Submit), so a
  forged POST straight to the submit endpoint cannot fabricate attendance
- GPS accuracy validation against a configurable threshold — no fake
  fallback location ever
- **Free-text truck / number-plate entry** — no dropdown, no truck table
  to maintain
- Database-level duplicate-attendance prevention
  (`UNIQUE(employee_id, attendance_date)`), not just a JS check
- Configurable Present/Late calculation from `company_settings`, evaluated
  in `Asia/Karachi` (not the device clock)
- Full admin dashboard: overview stats, attendance list with filters,
  Google Maps links, **verification photo viewer**, CSV export, attendance
  corrections (audited, no silent edits/deletes), driver management + face
  enrollment, company settings editor, audit log viewer
- Two independent-feeling portals from one deployment, split by subdomain
- Google Sheets sync kept as an optional, async, non-blocking secondary
  export (Postgres is always the source of truth)
- Audit logging on all admin mutations
- Dockerfile, docker-compose.yml (app + Postgres + Caddy), Caddyfile with
  automatic HTTPS for both subdomains
- Backup + restore scripts (`scripts/backup-db.sh`, `scripts/restore-db.sh`)
- Health check endpoint (`/api/health`)
- `.env.example` documenting every variable

---

## 4. WHAT YOU MUST DO (external accounts / one-time setup)

### 4.1 Get a VPS
**Why:** to run the app, database, and face model.
**Cheapest suitable option:** Hostinger VPS KVM 2 (~$6–8/mo) or DigitalOcean
Basic Droplet 2GB (~$12/mo) or Contabo VPS (~€5–6/mo, more RAM for the
price). Pick one with **at least 2GB RAM**.

**Steps:**
1. Sign up, choose Ubuntu 22.04 or Debian 12, 2GB+ RAM.
2. Note the server's public IP address.
3. SSH in: `ssh root@YOUR_SERVER_IP`
4. Install Docker + Docker Compose:
   ```bash
   curl -fsSL https://get.docker.com | sh
   apt-get install -y docker-compose-plugin
   ```

### 4.2 Buy a domain and configure DNS
**Why:** so drivers/admins access the app via a real link, and Caddy can
issue HTTPS certificates for both subdomains.
**Cheapest option:** Namecheap or Porkbun, ~$10–12/year for a `.com`.

**Steps:**
1. Buy a domain, e.g. `yourcompany.com`.
2. In your DNS provider, add two **A records** pointing at your VPS IP:
   - `attendance.yourcompany.com` → `YOUR_SERVER_IP`
   - `admin.yourcompany.com` → `YOUR_SERVER_IP`
3. Wait for DNS to propagate (usually minutes, sometimes a few hours).
4. Edit `Caddyfile` in this project and replace `yourcompany.com` with your
   real domain in both blocks.

### 4.3 Deploy
```bash
git clone <your repo> /opt/attendance   # or scp this project up
cd /opt/attendance
cp .env.example .env
nano .env   # fill in SESSION_SECRET (openssl rand -base64 48), POSTGRES_PASSWORD

docker compose up -d --build
docker compose exec app npx prisma migrate deploy

# create the first admin account:
docker compose exec -e SEED_ADMIN_EMAIL=owner@yourcompany.com \
  -e SEED_ADMIN_PASSWORD="Choose-A-Strong-Password-1!" \
  app npm run db:seed
```
Caddy automatically obtains HTTPS certificates the first time it starts
(needs ports 80/443 open and DNS already pointing at the server).

### 4.4 (Optional) Google Sheets export
**Why:** convenience export/reporting, not required for the system to work.
**Cost:** $0 (uses a free Google Apps Script Web App, not the billed Sheets
API).
**Steps:**
1. Create a Google Sheet.
2. Extensions → Apps Script. Paste the template available via
   `GET /api/admin/sheets/script-template` (while logged in as admin).
3. Deploy → Web app → Execute as "Me", Access "Anyone". Copy the deployment
   URL.
4. In the admin dashboard Settings, paste that URL into the Google Sheets
   webhook field and enable auto-sync.

### 4.5 Off-server backups (recommended)
**Why:** protects you if the VPS is lost/corrupted.
**Cheapest option:** Backblaze B2 (pennies/month at this data volume).
**Steps:**
1. Create a free Backblaze account, create a bucket, get an application key.
2. On the VPS: `curl https://rclone.org/install.sh | sudo bash`, then
   `rclone config` to add the B2 remote.
3. Add to the cron entry: after `backup-db.sh` runs, add
   `rclone copy /opt/attendance/backups b2remote:your-bucket-name`.
4. Cron it daily: `crontab -e` →
   `0 2 * * * /opt/attendance/scripts/backup-db.sh >> /var/log/attendance-backup.log 2>&1`

---

## 5. CLIENT MUST DO (getting the 400 employees registered)

1. **Decide the Employee Number scheme.** Any short unique value works —
   sequential numbers like `101`, `102`, `103` ... are simplest and match
   what you described. The system doesn't enforce a format, so this is
   purely the client's convention.
2. **Collect one clear, front-facing reference photo per employee** (or
   have each employee come by once to be enrolled in person via the admin
   dashboard's camera capture — either works).
3. **For each employee, in the admin dashboard:**
   - Drivers tab → **Add Driver** → enter their Employee Number and name.
   - Click the camera icon next to their row → capture/enroll their
     reference face photo.
   - Repeat for all ~400 (see the note below on bulk import if this is too
     slow one-by-one).
4. **Decide shift start time, grace period, and GPS accuracy threshold**
   (defaults: 08:00, 15 minutes, 100m — all editable in Settings).
5. Choose the final domain name if not already decided.

**Practical note on registering 400 people:** doing this one-by-one in the
admin UI works but is slow for 400 people. I'd recommend a short in-person
registration day: set a laptop/tablet at the admin dashboard, each
employee tells the admin their assigned number, and the admin adds them +
captures their photo on the spot (takes well under a minute per person).
If you'd rather I build a bulk-CSV import (upload a spreadsheet of
names/numbers, then have employees self-enroll their face on first use
instead), I can add that — see §9.

---

## 6. HOW THE CLIENT USES IT

- **Drivers:** open `https://attendance.yourcompany.com` on their phone —
  no app install, no login. Allow location → enter Employee Number → take
  selfie → turn head as prompted → type truck number → confirm.
- **Admins:** open `https://admin.yourcompany.com`, log in with the email/
  password created during setup (§4.3). From there: Overview (today's
  stats), Attendance (filterable table, map links, photo viewer, CSV
  export, corrections), Drivers (add/enroll face/deactivate), Settings,
  Audit Log.

---

## 7. PRODUCTION LAUNCH CHECKLIST

- [ ] VPS provisioned, Docker installed
- [ ] Domain purchased, both A records pointing at the VPS
- [ ] `.env` filled in with real `SESSION_SECRET` and `POSTGRES_PASSWORD`
      (never commit `.env`)
- [ ] `docker compose up -d --build` succeeds, all 3 services healthy
- [ ] `npx prisma migrate deploy` run successfully
- [ ] First admin created via `npm run db:seed`
- [ ] HTTPS working on both subdomains (check for the padlock)
- [ ] Add a test driver, enroll their face
- [ ] From a real phone, complete the full driver flow end-to-end: Location
      → Employee Number → selfie + head-turn → truck number → submit
- [ ] Confirm a second attendance attempt the same day is correctly blocked
- [ ] Confirm the attendance record's "Open Maps" link opens the correct
      location
- [ ] Confirm the "View" photo button shows the verification selfie, and
      that it disappears after the retention window
- [ ] Export CSV and confirm it opens correctly in Excel
- [ ] Set up the cron backup job and confirm a `.sql.gz` file appears
- [ ] Register all real employees + walk the client through the admin
      dashboard once, live

---

## 8. LOCAL DEVELOPMENT (without Docker)

```bash
npm install
cp .env.example .env      # point DATABASE_URL at a local Postgres
npm run models:download   # one-time, downloads face model weights
npx prisma migrate dev
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD="DevPassword123!" npm run db:seed
npm run dev                # http://localhost:3000
```
To preview both subdomain behaviors locally, edit your hosts file to map
`attendance.local` / `admin.local` to `127.0.0.1`, or use the `#attendance`
/ `#admin` hash switcher that appears automatically on `localhost`.

---

## 9. WHAT'S NOT INCLUDED (flagged, not hidden)

- Automated test suite — not written in this pass; the manual launch
  checklist above covers the critical paths. Happy to add Vitest/Supertest
  coverage as a follow-up.
- Bulk CSV import for the initial 400 drivers — currently one-by-one via
  the admin UI (see §5 for the practical workaround). Straightforward to
  add if the one-by-one flow proves too slow.
- Excel (.xlsx) export — CSV is implemented (opens fine in Excel); native
  .xlsx export can be added if needed.
- Embedded map view with pins on the admin dashboard — "Open Google Maps"
  per-record link is implemented (per the original cost-conscious
  request); an inline pin map can be added as a follow-up.
- SMS/email notifications — out of scope, not built.

---

## 10. SECURITY & PRIVACY NOTES

- Never trust browser-supplied identity, location, or face-verification
  results — the backend independently re-derives all of them via the
  `attendance_sessions` state machine.
- Enrolled reference photos are stored on disk (not the database), served
  only via an authenticated admin-only endpoint, never public.
- Daily verification selfies are kept only for the configured retention
  window (default 3 days), then permanently deleted by an automatic hourly
  job — not kept indefinitely.
- Face descriptors (the mathematical representation used for matching) are
  stored per driver; this is separate from the photo retention above and
  is what's used for ongoing 1:1 matching.
- All admin mutations are audit-logged with who/what/when.
- Attendance records are never silently edited or deleted — only corrected
  via an audited correction record with a required reason.
