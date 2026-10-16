# Agent system for job applications — design decisions (2026-10-16)

Owner: kiro. Status: infrastructure in progress. Source: two handwritten pages + chat rulings.

## Topology

Seven agents, five on the Lenovo server (`ssh lenovo-laptop`, 192.168.29.100, Ubuntu, no sudo for the agent),
one on the Mac, one nightly. Each agent reads one queue and writes the next; queues are user-layer files.

| Agent | Where / cadence | Model | Input queue → output queue | Existing modes/scripts |
|---|---|---|---|---|
| Scout | Lenovo, every 2h | none + Haiku 4.5 (triage) | ATS sweep → `data/pipeline.md` Pending | `scan-ats-full.mjs`, `scan.mjs`, `triage` |
| Researcher | Lenovo, every 2h | Sonnet 5.5 | Pending → `reports/` + tracker Evaluated | `oferta`/`auto-pipeline`, `deep`, liveness |
| Writer | Lenovo, after new Evaluated | Opus 5.5 only | Evaluated → `output/*.pdf`, PDF ✅ | `pdf`, `_writing.md`, `keyword-match.mjs`, `ats` |
| Applier | Mac, interactive | Opus 5.5 | PDF ✅ → tracker Applied (+followup-seed) | `apply` — user clicks Submit |
| Watcher | Lenovo, every 3h | Haiku 4.5 | Gmail → tracker state + `data/agent-inbox.md` | `reply-watch`, gmail plugin, `followup`, `set-status.mjs` |
| Prospector (freelance) | Lenovo, every 4h | Sonnet 5.5 (feasibility + draft) | freelance sources → `data/freelance/leads.tsv` → `data/freelance/outreach/*.md` (drafts) → dashboard Approve queue | new; `contacto`/`email` drafting rules, `voice-dna.md` |
| Coach | Lenovo, nightly | Opus 5.5 | reports (Evaluated+) → `interview-prep/coach/*.md` | `upskill.mjs`, `jd-skill-gap.mjs`, question-bank |

Dashboard: zero-model generator → static `index.html`, served on the Lenovo (port 8080), regenerated after every agent run.
Sections: queue gauges vs caps, funnel by state, agent heartbeat, "needs you", applications table, **Freelance** (leads found, feasibility verdicts, drafts awaiting approve with one-click/batch approve, sent log, replies), Learn (skill gaps → applications → likely questions).

## Rulings

1. **Data repo:** private `bkirosangma/career-ops-data`, branch `kiro` (one branch per person later). career-ops points at it via `.career-ops-data` = `../career-ops-data`. Local repo exists; push + marker pending (user runs, classifier blocked the agent).
2. **Caps:** Scout ≤100 Pending; Researcher ≤50 Evaluated-not-applied. Cron scripts count first, exit if full. 24/7.
3. **Targeting:** worldwide; **seniority/title/level do NOT matter** (junior to principal, IC or manager all in scope); role families in scope: software, data, AI/ML, DevOps/SRE/platform; only hard filters = fully remote (India-eligible) and in-hand ≥ ₹1.5 lakh/month (≈ ₹22–24 LPA gross for Indian employers; ≈ $1,800/month foreign). Replaces the ₹28 LPA floor in `config/profile.yml` — TODO update profile + memory.
4. **Apply threshold:** score ≥ 2.5 → generate + apply (user override of the 4.0 ethics guidance; record in `modes/_custom.md`). Submit always by the user.
5. **Haiku mitigation (Scout):** deterministic remote/location grep + ATS location fields run BEFORE Haiku; Haiku may drop only roles that are clearly not technical work (sales, HR, finance…). **In scope:** software engineering, data (engineering/analytics/science), AI/ML, DevOps/SRE/platform/cloud, never on seniority, title, level or location (Sept 30 lesson: Haiku skipped "fully remote, anywhere in India" roles).
6. **Freelance lane (ruled 2026-10-16, revised same day):** zero fit filters — the only gate is "can Kiro deliver this with Claude's help" (feasibility, judged by the Prospector). **Automated first contact, no human review** — Kiro's explicit override of the AGENTS.md review rule, scoped to freelance outreach only (job applications still stop before Submit). Prospector may use any of Kiro's accounts; credentials live only in `~/.config/career-ops/secrets.env` on the Lenovo, never in a repo.
   - **Sources:** unlimited, except sites with poor payment reputation (no escrow/payment protection, widespread non-payment reports) — maintained in `data/freelance/source-blacklist.md` with the reason per entry.
   - **Send channel per source:** auto-send where the platform permits automation or contact is by email (Freelancer.com official bid API; email addresses from HN "Seeking freelancer" thread, r/forhire, job boards, RFPs; contact forms). Platforms that ban bots and where a ban would cost Kiro the account (Upwork, LinkedIn, Contra, Toptal) → drafts to the dashboard Approve queue, Kiro sends in-app. This is account protection, not a review step.
   - **Guardrails:** daily send cap (start 20/day), per-source rate limit, kill switch (`data/freelance/PAUSE` file), every send logged to `data/freelance/sent.tsv` and shown on the dashboard; replies handled by the Watcher. Each message grounded in cv.md/profile (no fabricated past work), voice from `voice-dna.md`.
7. **Plan limits:** expect headless runs to pause on the usage window; caps bound the damage.

## Lenovo state (2026-10-16)

- Reachable on LAN, no default route (needs `sudo ip route add default via 192.168.29.1 dev enp2s0` + netplan fix). Git present; Node, Claude Code absent. Python 3.12. 4 cores, 7.7 GB.
- Headless auth: `claude setup-token` on the Mac → `CLAUDE_CODE_OAUTH_TOKEN` in the Lenovo cron env.

## Next steps

1. User runs: route fix, `gh repo create … --push`, marker file, `claude setup-token`.
2. Install fnm/Node 22 + Claude Code on Lenovo (no sudo), clone career-ops (fork branch) + career-ops-data (branch kiro), write marker.
3. `.claude/agents/{scout,researcher,writer,applier,watcher,coach}.md` + `scripts/lenovo/*.sh` cron entrypoints (pull → run → regen dashboard → commit/push data repo).
4. Dashboard generator + static server; Coach output format.
5. Update `config/profile.yml` comp floor, `modes/_custom.md` threshold rule, memory.
