# Changelog

## 0.2.0 — 2026-10-25

### Added

- `outputStyle` setting: choose how the rewritten prompt is shaped.
  - `plain` (default) — one continuous, heading-free prompt.
  - `sections` — `## Role` / `## Task` / `## Context` / `## Format` headings.
  - `role-task-goal` — `Role:` / `Task:` / `Goal:` labeled lines.
- Settings → General row ("Prompt style") that stores a per-browser override.
- Host `Config` schema so a profile can set the default in `cordis.patch.yml`.
- `GET /prompt-optimizer/defaults` reports the effective profile default, so the
  settings row reflects config before the user overrides it.
- The result dock names the style that produced the rewrite, next to the model.

## 0.1.0 — 2026-10-25

### Added

- Composer ✨ control (`conversation.input.right`) that rewrites the current
  draft and a non-modal result dock (`conversation.input.dock`) with
  Use / Undo / Copy / Close.
- Host half: `POST /prompt-optimizer/optimize` streaming SSE
  (`meta` / `delta` / `done` / `error`), owner-only admission, session route
  resolution, 90 s deadline, disconnect abort.
- Reuses the `oss-prompt-optimizer` rewrite engine (`buildOptimizePrompt`,
  `detectLanguage`) instead of re-implementing prompt rewriting; the engine is
  imported but not mounted, so no duplicate control or settings page appears.
- English and Chinese UI strings and plugin inventory metadata; original icon.
- Panel adopts the host dock geometry (`--dsh-chat-content-width`, composer
  stack tuck, top-only radius) so it aligns with the composer column, and makes
  Undo the primary action after a draft is replaced.
