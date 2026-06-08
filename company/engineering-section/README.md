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
