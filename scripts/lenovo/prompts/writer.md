Run the career-ops `pdf` mode (modes/pdf.md, with modes/_shared.md, modes/_writing.md and voice-dna.md guardrails) for tracker report #__REPORT__ — report file: __REPORT_FILE__.

Context for this unattended run:
- The role already has an A–G evaluation report; read it (and its archived JD section) as the JD source. Do not re-evaluate.
- Produce the tailored HTML + PDF with `node generate-pdf.mjs ... --report=__REPORT__`, run `node verify-cv-facts.mjs` (hard gate: zero fabrications — every claim must trace to cv.md / article-digest.md / config/profile.yml), then `node keyword-match.mjs "__REPORT_FILE__" --cv "<html>"` and `node verify-ats.mjs <html>`.
- Humanize: follow voice-dna.md and modes/_writing.md; no AI-slop phrasing; reformulate real experience to match the JD's vocabulary, never invent. If a keyword is missing from the CV and cannot be honestly supported, leave it out and list it under "missing" in the report's PDF section.
- Append to the report a short `## CV` section: PDF path, keyword coverage %, missing/thin keywords, ATS score.
- Update the tracker row's PDF column to ✅ via the project's canonical path (merge-tracker / set-status conventions; never hand-edit the table).
- The apply threshold is Global ≥ 2.5 (house rule, modes/_custom.md). Do not refuse to generate on fit grounds; the decision was made upstream.
- Never ask questions; if a hard gate fails (fact check), write the failure into the report `## CV` section and stop without producing a PDF.
