# Learn page, Tutor agent, usage-limit resume (2026-10-19)

Owner: kiro. Rulings from chat on 2026-10-19.

## 1. Tutor agent (new)

The Coach picks subjects nightly (`interview-prep/coach/index.json` + one `<slug>.md` per subject). The Tutor turns
them into study material, **one module per run** so each module gets a whole run's attention.

- **Model and cadence (ruled):** Opus 5.5, one module every 2 hours (`15 */2 * * *`), 40 min timeout.
- **Depth (ruled):** ~90-minute deep dives, 4–6 modules per subject, each with a hands-on exercise.
- **What runs next:** `scripts/lenovo/tutor-next.mjs` (zero LLM). The highest-impact Coach subject
  (same impact formula as the board) that is not finished. No plan yet → the run writes the plan. Otherwise the run
  writes the first missing module.
- **Files:** `interview-prep/learn/<slug>/plan.json` (modules: n, slug, title, minutes, goals, covers) and
  `interview-prep/learn/<slug>/<NN>-<module-slug>.md`. State is the files themselves. A missing module is
  written next, and a failed run leaves nothing behind, so it simply retries.
- **Module format:** `# Title`, then `## Goals`, `## Concepts`, `## Worked example`, `## Hands-on exercise`,
  `## Self-check` (`### ` per question, answer under it), `## Interview questions` (`### ` per question, model
  answer under it), `## Connect to your experience` (cv.md / story-bank.md only, never invented),
  `## Further reading` (named sources, no URLs). Mermaid fences allowed.
- **Validation:** after the run, `tutor-next.mjs check` verifies the file exists, has every section and is at
  least 250 lines; otherwise it is deleted and the run is marked failed.
- Slug = the Coach file's basename. If the Coach drops or renames a subject, its material stays and is listed
  under "Other material".

## 2. Learn page (separate from the board)

Served by `board-server.mjs`, rendered per request by `learn-html.mjs`, same theme tokens as the board.

- `GET /learn`: continue card (next unstudied written module, in impact order), the Coach's weekly notes,
  subjects ranked by impact with modules written / studied.
- `GET /learn/<slug>`: why it matters, which roles it serves, the module list (studied / ready / writing next /
  planned), the Coach's prep notes.
- `GET /learn/<slug>/<n>`: the module as a reading page: contents, self-check and interview answers behind a
  click, mark as studied, previous / next.
- `POST /api/learn/progress {slug, n, done}` → `data/learn-progress.json` (synced through the data repo, so
  progress is the same on phone and laptop).
- The board's Learn section shrinks to a link card (top 3 subjects + progress), and the header links to Learn.

## 3. Usage limits (all agents)

Observed: `You've hit your session limit · resets 12:50pm (UTC)` (154 times in the logs).

- `claude_run` (lib.sh) tees the CLI output; on a limit message it writes `data/.claude-limit`
  (`<reset epoch>\t<message>`) and returns 75. While the file's time is in the future, `claude_run` returns
  75 at once without calling Claude.
- `agent_fail` during an active limit records `wait` (once per window per agent), pushes partial work, exits 0.
  Cron reruns the agent after the reset, and every agent's queue is derived from files, so it resumes where
  it stopped.
- Writer stops its loop on 75. Scout skips Haiku triage while limited (entries are kept untriaged, as on a
  failed chunk). Researcher records the limit from the batch-runner log and re-picks `paused_rate_limit` URLs
  (they were filtered out forever: 27 stuck on 2026-10-19).
- Watcher keeps a pending marker so mail fetched during a limit is classified on the next run.
- Coach runs hourly with a once-a-day stamp, so a night lost to the limit is retried when the limit resets.
- Board: `wait` agent state and a banner with the reset time.
