# Changelog

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
