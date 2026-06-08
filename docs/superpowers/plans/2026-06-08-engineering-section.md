# Engineering Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a 3-page A4 PDF (`output/engineering-section.pdf`) that is the engineering capabilities section of Sportstech's larger company profile, written in plain English for non-technical buyers.

**Architecture:** A single self-contained HTML file (`company/engineering-section/template.html`) holding all content, CSS, and inline SVG icons. Rendered to PDF by the existing `generate-pdf.mjs` Playwright pipeline. No build step, no markdown source split, no external assets. Edits = open one file, change text, regenerate.

**Tech Stack:** HTML5 + inline CSS + inline SVG, rendered by Playwright (`playwright@^1.58.1`, already in `package.json`) via the existing `generate-pdf.mjs` script.

---

## File Structure

**Create:**
- `company/engineering-section/template.html` — the single source HTML (all content, CSS, icons inline)
- `company/engineering-section/README.md` — 5-line usage note

**Modify:** none.

**Generated (gitignored):**
- `output/engineering-section.pdf` — Playwright render output

**Spec source:** `docs/superpowers/specs/2026-06-08-engineering-section-design.md` — read this before starting; it is the canonical reference for content and tone.

**Existing tooling reused:**
- `generate-pdf.mjs` — CLI: `node generate-pdf.mjs <input.html> <output.pdf>` (A4 default, 0.6in margins, `printBackground: true`).
- `output/.gitkeep` — output dir already exists and is gitignored.

---

## Task 1: Scaffold directory and README

**Files:**
- Create: `company/engineering-section/README.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p company/engineering-section
```

- [ ] **Step 2: Create the README**

Write `company/engineering-section/README.md` with this exact content:

```markdown
# Engineering Section

Source for the engineering capabilities section of Sportstech's company profile.

## Files
- `template.html` — single source: content + CSS + inline SVG icons.

## Regenerate the PDF
From the project root:

```
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

Output lands at `output/engineering-section.pdf` (gitignored).

## Spec
Design and content rationale: `docs/superpowers/specs/2026-06-08-engineering-section-design.md`.
```

- [ ] **Step 3: Verify**

```bash
ls company/engineering-section/
```

Expected output: `README.md`

- [ ] **Step 4: Commit**

```bash
git add company/engineering-section/README.md
git commit -m "scaffold engineering-section directory and README"
```

---

## Task 2: HTML skeleton with three A4 pages

**Files:**
- Create: `company/engineering-section/template.html`

- [ ] **Step 1: Write the minimal HTML with three empty pages and page-break CSS**

Write `company/engineering-section/template.html` with this exact content:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Engineering Capabilities — Sportstech</title>
    <style>
      /* ===== Reset & base ===== */
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
                     Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #1a1a1a;
        font-size: 11pt;
        line-height: 1.5;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      /* ===== Page rules ===== */
      .page {
        page-break-after: always;
        break-after: page;
      }
      .page:last-of-type {
        page-break-after: auto;
        break-after: auto;
      }
    </style>
  </head>
  <body>
    <section class="page" id="page-1"></section>
    <section class="page" id="page-2"></section>
    <section class="page" id="page-3"></section>
  </body>
</html>
```

- [ ] **Step 2: Render the PDF to confirm the page-break setup works**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

Expected output (last lines):

```
✅ PDF generated: .../output/engineering-section.pdf
📊 Pages: 3
📦 Size: <some KB>
```

The `Pages: 3` line is the verification — if it says anything other than 3, the page-break CSS is wrong.

- [ ] **Step 3: Commit**

```bash
git add company/engineering-section/template.html
git commit -m "skeleton: three empty A4 pages with page-break rules"
```

---

## Task 3: Add base typography, colour tokens, and layout helpers

**Files:**
- Modify: `company/engineering-section/template.html` (extend the `<style>` block; keep everything written in Task 2)

- [ ] **Step 1: Extend the CSS block with design tokens and helpers**

Replace the `<style>...</style>` block from Task 2 with the following — the existing rules from Task 2 are kept and the new rules are appended:

```html
<style>
  /* ===== Reset & base ===== */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
                 Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    font-size: 11pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ===== Design tokens ===== */
  :root {
    --ink: #1a1a1a;
    --muted: #5a6573;
    --accent: #3d4a5c;
    --rule: #d4d8de;
    --tint: #f6f7f9;
  }

  /* ===== Page rules ===== */
  .page {
    page-break-after: always;
    break-after: page;
    padding-top: 4pt;
  }
  .page:last-of-type {
    page-break-after: auto;
    break-after: auto;
  }

  /* ===== Typography ===== */
  h1.section-title {
    font-size: 22pt;
    font-weight: 700;
    color: var(--ink);
    margin: 0 0 10pt 0;
    letter-spacing: -0.01em;
  }
  h2.subhead {
    font-size: 13pt;
    font-weight: 600;
    color: var(--accent);
    margin: 16pt 0 4pt 0;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h3.cap {
    font-size: 12pt;
    font-weight: 600;
    color: var(--ink);
    margin: 14pt 0 4pt 0;
  }
  p { margin: 0 0 8pt 0; }
  ul.proof {
    list-style: none;
    margin: 0 0 6pt 0;
    padding: 0;
  }
  ul.proof li {
    position: relative;
    padding-left: 14pt;
    margin: 0 0 6pt 0;
  }
  ul.proof li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8pt;
    width: 6pt;
    height: 1.5pt;
    background: var(--accent);
  }

  /* ===== Common components ===== */
  .accent-rule {
    width: 36pt;
    height: 2pt;
    background: var(--accent);
    margin: 0 0 12pt 0;
  }
  .lede {
    font-size: 12pt;
    line-height: 1.55;
    color: var(--ink);
    margin: 0 0 16pt 0;
    max-width: 90%;
  }
  .callout {
    background: var(--tint);
    border-left: 3pt solid var(--accent);
    padding: 12pt 14pt;
    margin: 0 0 18pt 0;
    font-size: 10.5pt;
    line-height: 1.5;
    color: var(--ink);
  }
  .callout em { font-style: normal; font-weight: 600; }

  /* ===== Capability tile grid (Page 1) ===== */
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12pt;
    margin-top: 6pt;
  }
  .tile {
    border: 1pt solid var(--rule);
    border-radius: 4pt;
    padding: 14pt;
  }
  .tile-head {
    display: flex;
    align-items: center;
    gap: 10pt;
    margin-bottom: 6pt;
  }
  .tile-head svg {
    width: 26pt;
    height: 26pt;
    color: var(--accent);
    flex-shrink: 0;
  }
  .tile-head .tile-title {
    font-size: 11.5pt;
    font-weight: 600;
    color: var(--ink);
  }
  .tile-body {
    font-size: 10pt;
    color: var(--muted);
    line-height: 1.45;
  }

  /* ===== Closing line ===== */
  .closing {
    margin-top: 18pt;
    padding-top: 12pt;
    border-top: 1pt solid var(--rule);
    font-size: 11pt;
    font-style: italic;
    color: var(--ink);
  }
</style>
```

- [ ] **Step 2: Regenerate the PDF**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

Expected: still 3 blank pages, no errors. Visual: the pages are still empty, but no CSS errors should appear in the Playwright console.

- [ ] **Step 3: Commit**

```bash
git add company/engineering-section/template.html
git commit -m "base CSS: tokens, typography, components for engineering-section"
```

---

## Task 4: Page 1 — Engineering at a Glance

**Files:**
- Modify: `company/engineering-section/template.html` (fill the `<section class="page" id="page-1"></section>`)

- [ ] **Step 1: Replace the empty Page 1 with the full Page 1 content**

Replace the line `<section class="page" id="page-1"></section>` with this exact block:

```html
<section class="page" id="page-1">
  <h1 class="section-title">Engineering at a glance</h1>
  <div class="accent-rule"></div>

  <p class="lede">
    We build production software that real users depend on every day —
    across the web, mobile, AI, and connected devices. Everything we offer,
    we have shipped at consumer scale in our own products.
  </p>

  <div class="callout">
    <em>Our flagship fitness platform — Sportstech Live —</em> is live on the
    Apple App Store and Google Play, running on iPhone, iPad, Apple TV, Apple
    Watch, and Android, powered by a cloud platform we built and operate
    ourselves across data centres in India and Europe.
  </div>

  <h2 class="subhead">What we deliver</h2>

  <div class="tiles">
    <div class="tile">
      <div class="tile-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
        <span class="tile-title">Cloud &amp; Web Platforms</span>
      </div>
      <div class="tile-body">
        Scalable digital backbones for products that serve users worldwide.
      </div>
    </div>

    <div class="tile">
      <div class="tile-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
        <span class="tile-title">AI Features &amp; Automation</span>
      </div>
      <div class="tile-body">
        Intelligent assistants and personalised recommendations embedded
        into real products.
      </div>
    </div>

    <div class="tile">
      <div class="tile-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>
        <span class="tile-title">Mobile Apps</span>
      </div>
      <div class="tile-body">
        Cross-platform apps on iOS, iPad, Apple TV, Apple Watch, and Android,
        built for high-quality consumer experiences.
      </div>
    </div>

    <div class="tile">
      <div class="tile-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 9h2M20 15h2M9 2v2M9 20v2"/></svg>
        <span class="tile-title">Connected Devices &amp; IoT</span>
      </div>
      <div class="tile-body">
        Software that talks to hardware — fitness equipment, wearables,
        sensors, custom electronics.
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Regenerate the PDF**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

- [ ] **Step 3: Open the PDF and visually verify Page 1**

Open `output/engineering-section.pdf` (on macOS: `open output/engineering-section.pdf`).

Verify, in order:

1. **Page 1 only is populated**; pages 2 and 3 are still blank.
2. **Title**: "Engineering at a glance" is at the top.
3. **Positioning paragraph** is present below the title with the exact text from Step 1.
4. **Callout box** with the Sportstech Live anchor statement is visible (tinted background, accent-coloured left border).
5. **Four tiles** appear in a 2×2 grid, each with: a small line icon on the left of the tile header, the capability name, and a one-line description.
6. **Nothing overflows** the page margins.

If any of these fail, fix the HTML or CSS before continuing. Common issue: the tile grid is rendering as a single column — confirm the `.tiles` rule has `grid-template-columns: 1fr 1fr`.

- [ ] **Step 4: Commit**

```bash
git add company/engineering-section/template.html
git commit -m "page 1: engineering at a glance + four capability tiles"
```

---

## Task 5: Page 2 — Software, Cloud & AI

**Files:**
- Modify: `company/engineering-section/template.html` (fill the `<section class="page" id="page-2"></section>`)

- [ ] **Step 1: Replace the empty Page 2 with the full Page 2 content**

Replace the line `<section class="page" id="page-2"></section>` with this exact block:

```html
<section class="page" id="page-2">
  <h1 class="section-title">Software, cloud &amp; AI</h1>
  <div class="accent-rule"></div>

  <h3 class="cap">Cloud &amp; web platforms</h3>
  <p>
    We build and operate the digital infrastructure that businesses run on,
    designed to stay available even as traffic and complexity grow.
  </p>
  <ul class="proof">
    <li>
      Operate a platform of <strong>100+ connected services</strong> across
      cloud regions in <strong>India and Europe</strong>, with built-in
      resilience and 24/7 monitoring.
    </li>
    <li>
      Migrated complex legacy systems into modern modular architectures —
      including a full migration from a single application to dozens of
      independent services for a B2B agritech business.
    </li>
    <li>
      Delivered government-scale campaign software that guided
      <strong>600,000+ students</strong> through public school admissions
      across multiple Indian states.
    </li>
  </ul>

  <h3 class="cap">AI features &amp; automation</h3>
  <p>
    We embed AI into products as features users rely on — not lab demos.
  </p>
  <ul class="proof">
    <li>
      An AI assistant that watches our own systems, explains incidents in
      plain language, and suggests fixes — before a human is paged.
    </li>
    <li>
      Personalised recommendations and AI-driven coaching inside our
      consumer fitness app.
    </li>
    <li>
      Conversational and LLM-powered features integrated across mobile
      and web products.
    </li>
  </ul>

  <h3 class="cap">Mobile apps</h3>
  <p>
    We ship apps people actually use, with the platform-specific polish
    each one demands.
  </p>
  <ul class="proof">
    <li>
      <strong>Sportstech Live</strong>, published on the iOS App Store and
      Google Play, supports iPhone, iPad, Apple TV, and Apple Watch
      (watchOS 10.2+).
    </li>
    <li>Localised content delivered in English and German.</li>
    <li>
      Streams to phones, tablets, smart TVs, and proprietary fitness
      hardware.
    </li>
  </ul>
</section>
```

- [ ] **Step 2: Regenerate the PDF**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

- [ ] **Step 3: Open the PDF and visually verify Page 2**

Verify:

1. Title "Software, cloud & AI" at top of page 2.
2. Three sub-sections in order: **Cloud & web platforms**, **AI features & automation**, **Mobile apps** — each with one intro sentence then a bulleted proof list.
3. Bullets use the short horizontal-rule marker (defined by `ul.proof li::before` in the base CSS).
4. Bold runs render correctly: "100+ connected services", "India and Europe", "600,000+ students", "Sportstech Live".
5. **No content spills onto a fourth page.** If it does, reduce the `--lede` `margin-bottom` or `h3.cap` `margin-top` in the base CSS by 2pt and re-render.
6. Margins look balanced against page 1.

- [ ] **Step 4: Commit**

```bash
git add company/engineering-section/template.html
git commit -m "page 2: software, cloud & AI with three subsections"
```

---

## Task 6: Page 3 — Connected Devices & IoT

**Files:**
- Modify: `company/engineering-section/template.html` (fill the `<section class="page" id="page-3"></section>`)

- [ ] **Step 1: Replace the empty Page 3 with the full Page 3 content**

Replace the line `<section class="page" id="page-3"></section>` with this exact block:

```html
<section class="page" id="page-3">
  <h1 class="section-title">Connected devices &amp; IoT</h1>
  <div class="accent-rule"></div>

  <p class="lede">
    Software that meets the physical world — the rare territory between
    drivers, devices, and the cloud.
  </p>

  <h3 class="cap">IoT at scale</h3>
  <p>
    We build systems that talk to thousands of physical devices in real
    time.
  </p>
  <ul class="proof">
    <li>
      An IoT platform supporting silk farmers, handling
      <strong>100,000+ concurrent updates</strong> from rearing devices.
    </li>
    <li>
      Real-time pipelines that ingest, process, and visualise data flows
      from connected hardware fleets.
    </li>
  </ul>

  <h3 class="cap">Bluetooth &amp; wearable integrations</h3>
  <p>
    We make mobile apps talk to fitness equipment, smart sensors, and
    wearables.
  </p>
  <ul class="proof">
    <li>
      Bluetooth connectivity to <strong>speedbikes, cross trainers, and
      treadmills</strong> using the industry-standard FTMS protocol.
    </li>
    <li>
      A proprietary heart-rate band (<strong>sPulse</strong>) integrated
      through custom Bluetooth firmware.
    </li>
    <li>
      <strong>Apple Watch, Apple Health, and Oura Ring</strong> sync —
      pulling sleep, recovery, heart rate, and activity into a single
      user experience.
    </li>
  </ul>

  <h3 class="cap">Hardware-near software</h3>
  <p>
    We are comfortable in the rare territory between drivers and the
    cloud.
  </p>
  <ul class="proof">
    <li>
      Drivers and access layers for industrial RFID readers running on
      <strong>custom Linux operating systems</strong>.
    </li>
    <li>
      Serial protocol and Arduino integrations for
      <strong>physical access control</strong> (boom barriers, entry
      systems).
    </li>
  </ul>

  <p class="closing">
    Whether the work is a cloud platform, a mobile app, an AI feature, or
    a connected device — we have shipped it before, and we can ship it
    for you.
  </p>
</section>
```

- [ ] **Step 2: Regenerate the PDF**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

- [ ] **Step 3: Open the PDF and visually verify Page 3**

Verify:

1. Title "Connected devices & IoT" at top of page 3.
2. Lede paragraph immediately under the title.
3. Three sub-sections in order: **IoT at scale**, **Bluetooth & wearable integrations**, **Hardware-near software**.
4. Bold runs visible: "100,000+ concurrent updates", "speedbikes, cross trainers, and treadmills", "sPulse", "Apple Watch, Apple Health, and Oura Ring", "custom Linux operating systems", "physical access control".
5. **Closing line** in italic, separated from the last bullet list by a thin horizontal rule.
6. Total PDF is exactly **3 pages** (check `📊 Pages: 3` in the generator output).

- [ ] **Step 4: Commit**

```bash
git add company/engineering-section/template.html
git commit -m "page 3: connected devices & IoT with closing line"
```

---

## Task 7: Cross-page polish and final acceptance check

**Files:**
- Modify (if needed): `company/engineering-section/template.html`

- [ ] **Step 1: Regenerate from clean state**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

Expected: `📊 Pages: 3`.

- [ ] **Step 2: Run the acceptance checklist from the spec (§8)**

Open `output/engineering-section.pdf` side-by-side with `docs/superpowers/specs/2026-06-08-engineering-section-design.md` and check each criterion. Tick the spec's §8 list mentally:

1. PDF exists at `output/engineering-section.pdf` — yes.
2. Copy reads as plain English (no acronyms a non-tech reader would not recognise — Apple Watch, App Store, Google Play, Oura Ring, FTMS, Bluetooth, Linux, Arduino are OK; "OpenTelemetry", "Kafka", "EKS", "agentic AI" are not). Skim every bullet against this rule and rewrite any offender.
3. Every proof bullet maps to a real shipped artifact.
4. No client logos or unconfirmed claims.
5. Styling is neutral A4 portrait — no clashing colours.
6. PDF regenerates reproducibly.

If anything fails, fix it directly in `company/engineering-section/template.html` and rerun.

- [ ] **Step 3: Cross-page consistency pass**

Open all three pages and check:

- **Vertical rhythm**: section titles, sub-heads, and body text use the same spacing on each page (controlled by the shared base CSS — if any page looks different, the page-local HTML has added inline spacing it should not have; remove it).
- **Accent colour usage**: the accent rule under each section title is identical on all 3 pages.
- **No widows/orphans**: no single bullet stranded at the bottom or top of a page. If one exists, shorten the preceding paragraph or trim a bullet.
- **Section titles are not orphaned** at the bottom of a previous page (page-break should keep them with their content — they are inside the `.page` div so this should already hold).

- [ ] **Step 4: Final regen + commit**

```bash
node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
git add company/engineering-section/template.html
git commit -m "polish: cross-page consistency for engineering-section"
```

- [ ] **Step 5: Surface result to user**

Report:

```
Engineering section PDF generated at: output/engineering-section.pdf
Pages: 3
Source: company/engineering-section/template.html
Regen: node generate-pdf.mjs company/engineering-section/template.html output/engineering-section.pdf
```

Then ask the user to open the PDF and confirm before any sharing or compilation into the parent profile.

---

## Self-review notes

**Spec coverage check (against `docs/superpowers/specs/2026-06-08-engineering-section-design.md`):**

| Spec section | Covered by |
|---|---|
| §1 Context (engineering section of larger profile) | File location + scope statement in README |
| §2 Audience & tone (plain-English, non-tech) | Task 7 Step 2 explicitly re-checks plain-English |
| §3 Scope (4 capabilities; no cover/contact/marketing) | Tasks 4-6 cover all 4 capability domains; no cover/contact/marketing tasks |
| §4 Positioning sentence + anchor callout | Task 4 Step 1 |
| §5 Page 1 (4 capability tiles 2×2) | Task 4 |
| §5 Page 2 (Cloud/AI/Mobile) | Task 5 |
| §5 Page 3 (IoT/BLE/Hardware + closing line) | Task 6 |
| §6 Visual treatment (clean & corporate, neutral, A4) | Task 3 (tokens) + Task 7 (consistency) |
| §7 Build approach (HTML→PDF via `generate-pdf.mjs`) | Every task regenerates with the existing script |
| §8 Acceptance criteria | Task 7 Step 2 walks the list |
| §9 Open items (final home, Mac drop, marketing) | All resolved in spec; Mac is absent from Page 1 tile and Page 2 mobile bullets |

**No placeholders.** Every content step contains the exact HTML/CSS to paste. Every command line is complete. No "TBD", "TODO", "appropriate", or "similar to Task N" patterns.

**Type/identifier consistency:** CSS classes referenced across tasks (`section-title`, `accent-rule`, `lede`, `callout`, `tiles`, `tile`, `tile-head`, `tile-title`, `tile-body`, `subhead`, `cap`, `proof`, `closing`) are all defined in Task 3 and used consistently in Tasks 4-6.
