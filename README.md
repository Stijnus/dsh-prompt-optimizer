# @stijnus/dsh-prompt-optimizer

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
optimizes the prompt you are about to send.

It adds a ✨ **Optimize prompt** control next to the composer send button.
Clicking it rewrites the current draft into a structured prompt and streams the
result into a panel above the composer, with **Use**, **Undo**, **Copy**, and
**Close**. Nothing is sent to the agent; the draft is only replaced when you
click **Use**.

It runs on the model the session is already routed to (the same route the next
turn would use), and it never writes to the Session log.

### Prompt style

The rewritten prompt can take three shapes, chosen in **Settings → General →
Prompt style**:

| Style | Output |
| --- | --- |
| `plain` (default) | One continuous, heading-free prompt. |
| `sections` | `## Role` / `## Task` / `## Context` / `## Format` headings. |
| `role-task-goal` | `Role:` / `Task:` / `Goal:` labeled lines. |

The row stores a per-browser override. A profile can set the default for
everyone through the plugin's `Config`:

```yaml
- id: prompt-optimizer
  name: '@stijnus/dsh-prompt-optimizer'
  config:
    outputStyle: sections
```

Until the row is changed, it shows that profile default; an override in the row
wins for requests from that browser. The result panel names the style that
produced it.

> **Naming:** this package is scoped because the unscoped name
> `dsh-prompt-optimizer` already belongs to a different author on npm. This
> plugin is unrelated to that package; both optimize composer prompts, but this
> one reuses [`oss-prompt-optimizer`](https://www.npmjs.com/package/oss-prompt-optimizer)
> as its rewrite engine.

## Install

```sh
dsh plugin --profile web add @stijnus/dsh-prompt-optimizer
```

Then restart the Harness (or refresh the page for the Client half). The plugin
appears in Settings → Plugins as **Prompt Optimizer**.

Compatibility: DSH `>=0.2.1-rc.3 <0.3.0-0`, Node `>=20`.

## Where the rewrite logic lives

This plugin does **not** re-implement prompt rewriting. It imports the engine
from the published **Prompt Optimizer** implementation,
[`oss-prompt-optimizer`](https://www.npmjs.com/package/oss-prompt-optimizer).

| Layer | Module | Symbol |
| --- | --- | --- |
| Meta-prompt builder | `oss-prompt-optimizer/lib/meta.js` | `buildOptimizePrompt(input, language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, templates, context, taskType, maxOutputTokens, profile, level, builtinExamples, compact, sceneRefEnabled)` |
| Template data | `oss-prompt-optimizer/lib/templates.js` | `META_PROMPT`, `META_PROMPT_EN`, `DEFAULT_TEMPLATES` |
| System-prompt wrapper | `oss-prompt-optimizer/lib/prompt.js` | `buildOptimizeSystem(ctx, input, outputLanguage, diagnosis, profile)` |
| Rewrite executor (full service) | `oss-prompt-optimizer/lib/optimizer.js` | `class PromptOptimizerService`, `optimize(rawInput, options)` |
| Output validation | `oss-prompt-optimizer/lib/validate.js` | `REQUIRED_SECTIONS`, `hasValidSections`, `truncateInput`, … |

Those files sit behind the package's `exports` map, which only exposes the root,
`./client`, `./cordis.patch.yml`, and `./package.json`. The root re-exports the
functions this plugin needs, so the supported import is:

```js
import { buildOptimizePrompt, detectLanguage } from 'oss-prompt-optimizer'
```

`index.js` builds the meta-prompt with
`buildOptimizePrompt(draft, 'auto', …, 'plain', metaLanguage)`, sends the short
user turn `"只输出优化后的提示词。"` / `"Output only the optimized prompt."`, and
streams the answer back over SSE. That mirrors the upstream
`PromptOptimizerService.optimize()` call shape — but the upstream service itself
is **not** mounted, so this plugin owns its own route, timeout, and SSE framing,
and no second ✨ control or settings panel appears.

Those defaults match upstream: `outputLanguage: 'auto'` (no forced-language
line, the rewrite follows the draft) and `outputStyle: 'plain'` (a heading-free
prompt body, which is what the composer holds).

> Deep imports such as `oss-prompt-optimizer/lib/meta.js` are blocked by the
> package `exports` map (`ERR_PACKAGE_PATH_NOT_EXPORTED`). If a future release
> removes the root re-exports, add an `exports` entry upstream or vendor
> `lib/meta.js` + `lib/templates.js` into this package.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: `POST /prompt-optimizer/optimize` (SSE), owner guard, route resolution, timeout, disconnect handling. |
| `client.js` | Browser half: `conversation.input.right` control and `conversation.input.dock` panel. |
| `cordis.patch.yml` | Inserts the `prompt-optimizer` Host row. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager / Settings display metadata. |
| `icon.svg` | Original artwork. |

## UI layout notes

`conversation.input.dock` renders entries with **no** width wrapper, so a dock
entry that does not constrain itself becomes full-bleed. The panel adopts the
host's own dock geometry:

- `max-width: var(--dsh-chat-content-width, 920px)` — the inherited transcript /
  composer column (`clamp(680px, column * .64, 920px)`, user-draggable).
- `margin: 0 auto calc(0px - var(--dsh-composer-stack-gap, 6px) - 3px)` and
  top-only `border-radius` with no bottom border, so the panel merges into the
  composer card instead of floating above it.

After a draft is replaced, **Undo** becomes the primary action and the applied
note is an `aria-live` status region.

## Development

```sh
npm install
npm test
```

`npm test` runs the Client render tests (module format, slot registrations,
dock geometry, state transitions) and a Host integration test that streams a
stubbed model call through the real route handler.

### Local profile install

```sh
plugin_manager { action: "install_bundle", target: "<checkout>" }
```

`install_bundle` links a local directory (`link:`), so the profile's pnpm
install does not install this package's dependencies — Node resolves imports
from the plugin's real path. Run `npm install` in the checkout first, which
creates the local `node_modules/oss-prompt-optimizer` the Host half imports.
Harness packages used inside `oss-prompt-optimizer` (such as
`@deepseek-ai/cordis`) resolve from the DSH installation at runtime.

## Release

Releases are tag-driven: pushing `vX.Y.Z` runs
`.github/workflows/release.yml`, which checks the tag against `package.json`,
runs the tests, and publishes to npm with a provenance attestation. See
[RELEASING.md](RELEASING.md) for the one-time trusted-publishing setup.

## License

MIT. The imported rewrite engine is MIT-licensed by its author
([seven282/oss-prompt-optimizer](https://github.com/seven282/oss-prompt-optimizer)).
