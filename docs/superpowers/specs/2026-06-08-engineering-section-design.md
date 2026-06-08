# Engineering Section — Design Spec

**Date:** 2026-06-08
**Owner:** Banchan Kiro A Sangma (`b.sangma@sportstech.app`)
**Status:** Draft — awaiting user review

---

## 1. Context

Sportstech (operating domain `sportstech.app`) is positioning a tech-services arm and needs a multi-section **company profile** to provide confidence to prospective clients. This spec covers **only the engineering section** of that larger profile. Other sections (executive summary, services overview, marketing, contact, engagement models, pricing, etc.) are owned elsewhere and out of scope here.

The engineering section will eventually be compiled into the parent profile, so it should:

- Stand alone as a coherent set of pages with its own narrative arc.
- Avoid duplicating cover/contact/engagement content that the parent doc will own.
- Use neutral, restrained styling that can be slotted under a corporate cover without clashing.

## 2. Audience & use

- **Primary reader:** Non-technical decision-makers at prospective clients (founders, CFOs, COOs, procurement leads, marketing/product heads).
- **Reading mode:** Skimmed inside a longer PDF profile. Average attention per page: under one minute.
- **Confidence test the reader applies:** *"Have these people actually built things at scale, or are they slideware?"* Every claim must answer this with a concrete, ideally publicly verifiable, artifact.
- **Tone:** Plain English. No acronyms, no stack names except where they are themselves recognisable brands (Apple Watch, Oura Ring, App Store, Google Play, AWS).

## 3. Scope

**In scope:**

- A 3-page engineering section.
- Plain-English description of four capability domains: Cloud & Web Platforms, AI Features & Automation, Mobile Apps, Connected Devices & IoT.
- Proof points drawn from (a) Sportstech's current shipped products and (b) prior shipped work of senior engineers now on the team. Attribution is collective ("we") per agreed convention; no individual project bylines.

**Out of scope:**

- Cover, contact, engagement-model, pricing, case-study deep-dives — owned by the parent profile.
- Marketing capability — explicitly dropped (not part of engineering scope).
- Individual engineer bios, headcount tables, org charts.
- Live website or interactive web-deck version.

## 4. Positioning

**Headline positioning sentence** (appears on page 1):

> We build production software that real users depend on every day — across the web, mobile, AI, and connected devices. Everything we offer, we have shipped at consumer scale in our own products.

**Anchor credibility statement** (boxed callout on page 1):

> Our flagship fitness platform — Sportstech Live — is live on the Apple App Store and Google Play, running on iPhone, iPad, Apple TV, Apple Watch, and Android, powered by a cloud platform we built and operate ourselves across data centres in India and Europe.

The narrative wedge: every capability is provable via a public artifact (the Sportstech Live app on both stores, the platform that runs it, the wearable integrations a user can verify with their own Apple Watch or Oura Ring). This is a stronger confidence anchor than a list of stack logos.

## 5. Page-by-page content

### Page 1 — Engineering at a Glance

1. Positioning sentence (above).
2. Anchor credibility statement (above), visually distinct (boxed/highlighted).
3. Four capability tiles in a 2×2 grid (icon + title + one-line description):

   | Tile | One-liner |
   |---|---|
   | **Cloud & Web Platforms** | Scalable digital backbones for products that serve users worldwide. |
   | **AI Features & Automation** | Intelligent assistants and personalised recommendations embedded into real products. |
   | **Mobile Apps** | Cross-platform apps on iOS, iPad, Apple TV, Apple Watch, and Android, built for high-quality consumer experiences. |
   | **Connected Devices & IoT** | Software that talks to hardware — fitness equipment, wearables, sensors, custom electronics. |

### Page 2 — Software, Cloud & AI

Three sub-sections, each a short intro sentence followed by 2–3 plain-English proof bullets.

**Cloud & Web Platforms.** We build and operate the digital infrastructure that businesses run on, designed to stay available even as traffic and complexity grow.

- Operate a platform of 100+ connected services across cloud regions in India and Europe, with built-in resilience and 24/7 monitoring.
- Migrated complex legacy systems into modern modular architectures — including a full migration from a single application to dozens of independent services for a B2B agritech business.
- Delivered government-scale campaign software that guided 600,000+ students through public school admissions across multiple Indian states.

**AI Features & Automation.** We embed AI into products as features users rely on — not lab demos.

- An AI assistant that watches our own systems, explains incidents in plain language, and suggests fixes before a human is paged.
- Personalised recommendations and AI-driven coaching inside our consumer fitness app.
- Conversational and LLM-powered features integrated across mobile and web products.

**Mobile Apps.** We ship apps people actually use, with the platform-specific polish each one demands.

- Sportstech Live, published on the iOS App Store and Google Play, supports iPhone, iPad, Apple TV, and Apple Watch (watchOS 10.2+).
- Localised content delivered in English and German.
- Streams to phones, tablets, smart TVs, and proprietary fitness hardware.

### Page 3 — Connected Devices & IoT

This is the differentiator — software that meets the physical world. Three sub-sections.

**IoT at scale.** We build systems that talk to thousands of physical devices in real time.

- An IoT platform supporting silk farmers, handling 100,000+ concurrent updates from rearing devices.
- Real-time pipelines that ingest, process, and visualise data flows from connected hardware fleets.

**Bluetooth & wearable integrations.** We make mobile apps talk to fitness equipment, smart sensors, and wearables.

- Bluetooth connectivity to speedbikes, cross trainers, and treadmills using the industry-standard FTMS protocol.
- A proprietary heart-rate band (sPulse) integrated through custom Bluetooth firmware.
- Apple Watch, Apple Health, and Oura Ring sync — pulling sleep, recovery, heart rate, and activity into a single user experience.

**Hardware-near software.** We are comfortable in the rare territory between drivers and the cloud.

- Drivers and access layers for industrial RFID readers running on custom Linux operating systems.
- Serial protocol and Arduino integrations for physical access control (boom barriers, entry systems).

**Closing line** (last line of the section):

> Whether the work is a cloud platform, a mobile app, an AI feature, or a connected device — we have shipped it before, and we can ship it for you.

## 6. Visual treatment

**Direction:** Clean & corporate. Neutral palette, system or sans-serif font, generous whitespace, simple flat icons. The section reads as a serious engineering org — fits inside a corporate parent document without restyling friction.

**Specifics:**

- Page size: A4 portrait (parent profile likely uses A4; matches India + EU norms).
- Margins: 0.6 inch all sides (matches existing `generate-pdf.mjs` defaults).
- Typography: One sans-serif for headings, one for body, both system-safe.
- Accent colour: a single neutral accent (slate blue or charcoal) used sparingly for headings, dividers, and callouts. Avoid bright brand colours that may clash with parent doc.
- Icons: simple, monochrome line icons for capability tiles and sub-section headers.
- Boxed anchor statement: subtle border or background tint, not loud.
- No photos, no client logos (deferred — none confirmed for use).

## 7. Build approach

**Reuse the existing HTML → PDF pipeline.** The career-ops project already has Puppeteer-based PDF generation:

- `generate-pdf.mjs` — Puppeteer rendering script.
- `templates/cv-template.html` — example HTML template using local fonts and CSS.

**New files to create** (under a dedicated sub-directory; final home configurable per §9):

```
company/
  engineering-section/
    content.md         # Plain-English markdown source (single source of truth)
    template.html      # Self-contained HTML for the 3 pages, includes inline CSS
    icons/             # Optional monochrome SVG icons
output/
  engineering-section.pdf   # Generated PDF (gitignored, like other outputs)
```

**Generation command:**

```
node generate-pdf.mjs --input company/engineering-section/template.html --output output/engineering-section.pdf
```

The HTML template will inline the content from `content.md` (either via build step or by maintaining the content directly in the HTML — to be decided at plan time).

## 8. Acceptance criteria

The engineering section is "done" when:

1. A 3-page PDF exists at `output/engineering-section.pdf`.
2. All copy reads as plain English — verifiable by a non-technical reader without an engineering glossary.
3. Every proof bullet maps to a real shipped artifact (Sportstech Live, the sportstech-live platform, ReshaMandi work, Hashtaag KGJ work, Indus Action work).
4. No client logos or claims appear without prior confirmation (none in this draft).
5. Styling does not visually fight a corporate parent profile — neutral, restrained, A4 portrait.
6. The PDF can be regenerated reproducibly from the markdown/HTML source by anyone with the repo and Node installed.

## 9. Open items

1. **Final home.** ✅ Resolved — artifact lives under `career-ops/company/engineering-section/`.
2. **Mac support claim.** ✅ Resolved — Mac is dropped. Mobile claims are iPhone, iPad, Apple TV, Apple Watch, and Android only.
3. **Marketing.** Confirmed out-of-scope for this section.
4. **Visual companion / mockup review.** Layout details (tile arrangement, icon style, callout treatment) will be visible in the rendered HTML preview before PDF generation; an explicit mockup review step can be added at plan time if useful.
5. **Source-of-truth split.** Whether to maintain `content.md` separately and inject into HTML at build time, or write directly in HTML, will be settled in the implementation plan based on user preference for editability.

---

*End of spec.*
