# HazardLensAI — User Guide (Citizens & Field Reporters)

**Live demo:** http://localhost:3000 · report a hazard in three steps at `#/report`.
Companion docs: [ADMIN_GUIDE.md](ADMIN_GUIDE.md) (what happens after you submit), [SYSTEM_CARD.md](SYSTEM_CARD.md) (privacy engineering), [API_GUIDE.md](API_GUIDE.md).

---

## 1. Creating an Account & Signing In

You can use HazardLensAI **without an account** (guest reporting, §4), but an account lets you track your reports and get notified about repairs.

1. Open `http://localhost:3000` and click **Sign in** → **Create account** (or go to `#/signin`).
2. Provide your **name**, **email**, and a **password of at least 8 characters** (a strong passphrase is recommended — passwords are stored only as bcrypt hashes).
3. Submit: you're signed in immediately. Sessions use a 15-minute access token plus a 30-day refresh cookie, so you stay signed in across visits and can sign out any time from the header.
4. **Forgot your password?** Use **Forgot password** on the sign-in screen, enter your email, and follow the instructions you receive. The response is identical whether or not the email is registered (no account enumeration). *(Demo note: the demo environment has no email server — the reset token is returned in the `x-demo-reset-token` header so the flow can be completed; see [SYSTEM_CARD.md](SYSTEM_CARD.md) §5.)*
5. Demo accounts for trying the product end-to-end: citizen **citizen@roadguardatlas.dev / Atlas@User2024**, admin **admin@roadguardatlas.dev / Atlas@Admin2024**.

## 2. Reporting a Hazard — Step by Step (3-step wizard)

Open **Report a hazard** (`#/report`). The wizard has three steps:

### Step 1 — Capture evidence

| Constraint | Images | Video |
|---|---|---|
| Formats | JPEG, PNG, WebP | MP4, WebM, MOV |
| Max size | 12 MB | 60 MB |

- Take the photo **from a safe position** — never from moving traffic. A slightly angled shot showing the hazard and some road context works best.
- The upload is validated by content (magic-byte sniffing), not just file extension, so renamed files are rejected with a clear error (415).
- **Privacy by default:** EXIF metadata (device model, timestamps, GPS) is **always stripped** from the stored copy. If you grant location consent (§3), the GPS tag is read *before stripping* solely to suggest the map pin.
- After upload, the **AI preview** runs automatically (YOLO service → GLM vision → deterministic fallback engine chain, see [MODEL_CARD.md](MODEL_CARD.md) §1). You'll see **bounding boxes** drawn over your photo with labels like *pothole · 93%* and a suggested severity (1–5).
  - The preview is a **suggestion**. If the AI picked the wrong class or severity — e.g., it says "crack" but it's a pothole — simply **correct the class or severity** with the picker in Step 2. Human corrections are how the system learns.
  - Video uploads become an async job (frame sampling); the preview appears when processing finishes, usually within a minute.
- No AI box? You can still proceed — a moderator reviews every report, and your notes matter.

### Step 2 — Describe & place the pin

- **Location:** drag the map pin to the exact spot, or accept the suggested pin from your photo's GPS (only with consent). A precise pin matters: reports within ~60 m of each other are clustered together and scored as a group.
- **What you're asked for:** hazard class (pothole, crack, erosion, waterlogging, broken marking, debris, road-edge damage), severity (1 = minor … 5 = dangerous), optional notes ("two-wheelers swerve into the next lane here"), road name, and road class (highway / arterial / collector / residential — this feeds the road-criticality factor of the priority score).
- **Address & ward** are filled from the pin automatically (nearest-ward lookup).

### Step 3 — Submit & track

- Press **Submit**. Your report gets a unique reference code like **`RG-PX6NMM`** — save it or keep the confirmation screen; quoting it to the municipality lets staff find your report instantly.
- Rate limit: up to **5 reports per hour** per network, to prevent spam. Genuine urgent hazards can also be phoned in through your city's helpline.
- What happens next: a moderator approves, corrects, merges, or flags your report (typically within a few working days); approved reports go on the public map, are clustered with nearby reports, and may become a work order — you'll be notified at each step (§5).

## 3. Location Permission & Privacy

| Question | Answer |
|---|---|
| Is my photo's EXIF kept? | **No.** EXIF is always stripped on upload — device info, timestamps and GPS never persist in the stored media ([SYSTEM_CARD.md](SYSTEM_CARD.md) §4). |
| Do you use my GPS? | **Only with your consent.** The consent toggle appears at upload. With consent, the GPS tag is read once to prefill the map pin, then removed with the rest of the EXIF. Without consent, you place the pin manually. |
| Can I withdraw consent later? | Yes — open **Profile → Privacy** and turn off location consent. This stops future uploads from using EXIF GPS. (Reports already submitted keep their map pin, which is the point of the platform.) |
| Who can see my media? | Only through **unlisted media links** (unguessable ids); there's no public gallery. Moderators see your evidence to verify it. |
| Who sees my name? | Signed-in reports show your name to moderators for follow-up. Guest reports are attributed to the name you type, with no account attached. |
| Is my data sold? | No. The platform is purpose-limited to road maintenance; see the out-of-scope commitments in [MODEL_CARD.md](MODEL_CARD.md) §4. |

## 4. Guest vs Tracked Reports

| | Guest report | Signed-in report |
|---|---|---|
| Submit with photo, pin, notes | ✅ | ✅ |
| Reference code (`RG-…`) | ✅ | ✅ |
| Appears on public map after approval | ✅ | ✅ |
| Status timeline & notifications | ❌ (keep your reference code) | ✅ in your dashboard |
| Progress alerts (approved / merged / crew assigned / repaired) | ❌ | ✅ |

## 5. Tracking Your Reports (Dashboard Timeline)

Open **Dashboard** (`#/dashboard`) while signed in. Each of your reports shows a **timeline**: submitted → reviewed (approved / rejected / flagged, with the moderator's note) → merged (if a duplicate, into which primary) → work order created → scheduled → in repair → **resolved**. Seeded example: Arjun Rao's Hosur Road pothole shows *approved · clustered with two nearby reports*, then *crew B assigned*, while his second photo of the same pothole shows *merged into the primary — duplicates raise the cluster's priority*.

**Notifications** arrive in the bell menu (in-app): report received, reviewed, merged, work-order moves, and repair verified. Unread items are bolded; "mark all read" clears the badge. Every notification links to the relevant dashboard item.

**Withdrawing / fixing your own report:** open the report from the dashboard to see its state; rejected reports show the moderator's reason (e.g., "out-of-focus image — please re-upload"), and you can submit a fresh report referencing the same location.

## 6. FAQ

**Q: The AI detected nothing. Can I still report?**
Yes. The AI preview is an aid; your class choice, severity, photo and note are enough for a moderator to act.

**Q: Why was my report "merged"?**
Someone else reported the same defect. Merging keeps the map honest — one hazard, one entry — while your report still strengthens the case for repair (recurrence and severity). You are notified with the primary report's code.

**Q: What do the priority bands mean for me?**
CRITICAL (≥80) — immediate action; HIGH (60–79) — schedule urgently; MEDIUM (35–59) — planned maintenance; LOW (<35) — monitor. Your report's band is visible on its dashboard card.

**Q: Can I report anonymously?**
You can report as a guest (§4) with a name you type in — no account needed. Fully anonymous *unattended* reporting isn't offered because moderators may need to clarify details.

**Q: How fast will something be fixed?**
HazardLensAI prioritizes; your city's crews schedule. CRITICAL hazards are intended for same-day triage, others per municipal cycles. The dashboard timeline is the honest answer to "where is my report now?"

**Q: My photo contains people or plates — is that a problem?**
Uploads support a blur request; EXIF is stripped regardless. Avoid capturing people where possible — the platform's purpose is the road surface.

**Q: Does it work on mobile?**
Yes — the UI is responsive (verified at 390 px width); the report wizard is designed for phone cameras.
