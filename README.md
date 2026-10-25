# Prompt Optimizer (DSH plugin)

Adds a ✨ **Optimize prompt** control next to the composer send button. Clicking it
rewrites the current draft into a structured prompt (Role / Task / Context /
Format) and streams the result into a panel above the composer, with **Use**,
**Undo**, **Copy**, and **Close**. Nothing is sent to the agent; the draft is only
replaced when you click **Use**.

It runs on the model the session is already routed to (the same route the next
turn would use), and it never writes to the Session log.

## Where the rewrite logic lives

This plugin does **not** re-implement prompt rewriting. It imports the engine from
the already-published **Prompt Optimizer** implementation,
[`oss-prompt-optimizer`](https://www.npmjs.com/package/oss-prompt-optimizer)
(in-harness entry id and settings namespace: `prompt-optimizer`).

| Layer | Module | Symbol |
| --- | --- | --- |
| Meta-prompt builder | `node_modules/oss-prompt-optimizer/lib/meta.js` | `buildOptimizePrompt(input, language, extraInstructions, examples, outputStyle, metaLanguage, diagnosis, templates, context, taskType, maxOutputTokens, profile, level, builtinExamples, compact, sceneRefEnabled)` |
| Template data | `node_modules/oss-prompt-optimizer/lib/templates.js` | `META_PROMPT`, `META_PROMPT_EN`, `DEFAULT_TEMPLATES` |
| System-prompt wrapper | `node_modules/oss-prompt-optimizer/lib/prompt.js` | `buildOptimizeSystem(ctx, input, outputLanguage, diagnosis, profile)` |
| Rewrite executor (full service) | `node_modules/oss-prompt-optimizer/lib/optimizer.js` | `class PromptOptimizerService`, `optimize(rawInput, options)` |
| Output validation | `node_modules/oss-prompt-optimizer/lib/validate.js` | `REQUIRED_SECTIONS`, `hasValidSections`, `truncateInput`, … |

Those files sit behind the package's `exports` map, which only exposes the root,
`./client`, `./cordis.patch.yml`, and `./package.json`. The root re-exports the
functions this plugin needs, so the supported import is:

```js
import { buildOptimizePrompt, detectLanguage } from 'oss-prompt-optimizer'
```

`index.js` uses exactly that: it builds the meta-prompt with
`buildOptimizePrompt(draft, 'zh' | 'en', …, 'plain', …)`, sends the short user
turn `"只输出优化后的提示词。"` / `"Output only the optimized prompt."`, and
streams the answer back over SSE. That is the same shape the upstream
`PromptOptimizerService.optimize()` uses — the upstream service itself is not
mounted, so this plugin owns its own route, timeout, and SSE framing, and no
second ✨ button or settings panel appears.

> Deep imports such as `oss-prompt-optimizer/lib/meta.js` are **blocked** by the
> package `exports` map (`ERR_PACKAGE_PATH_NOT_EXPORTED`). If a future release
> removes the root re-exports, add an `exports` entry upstream or vendor
> `lib/meta.js` + `lib/templates.js` into this package.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: `POST /prompt-optimizer/optimize` (SSE), route resolution, timeout, disconnect handling. |
| `client.js` | Browser half: `conversation.input.right` control and `conversation.input.dock` panel. |
| `cordis.patch.yml` | Inserts the `prompt-optimizer` Host row. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager / Settings display metadata. |
| `icon.svg` | Original artwork (sparkle over a gradient tile). |

## Install (this profile)

```sh
plugin_manager { action: "install_bundle", target: "/Users/stijnus/Documents/deepseek-harness/default-workspace/prompt-optimizer" }
```

Installing links this directory into `~/.dsh/profiles/desktop/node_modules` and
adds the bundle to the profile.

### Dependency resolution note (important)

`install_bundle` links a local directory (`link:`) instead of copying it, so the
profile's pnpm install does **not** install this package's dependencies: Node
resolves imports from the plugin's *real* path, and the profile's
`node_modules` is not on that path. Install the rewrite engine inside the
package directory once, before (or after) the bundle install:

```sh
cd /Users/stijnus/Documents/deepseek-harness/default-workspace/prompt-optimizer
npm install --no-package-lock --legacy-peer-deps oss-prompt-optimizer@1.13.1
```

That creates `prompt-optimizer/node_modules/oss-prompt-optimizer` (git-ignored),
which is what the Host half imports. Harness packages such as
`@deepseek-ai/cordis` used *inside* `oss-prompt-optimizer` resolve from the DSH
installation at runtime, the same way `dsh-cost-meter` resolves
`@deepseek-ai/dsh-credentials`.

## Verification status

- Bundle installed, `application: applied`, no warnings.
- Host row `include:prompt-optimizer` present (no `Config` schema by design).
- Live Client occupants: `conversation.input.right` → `prompt-optimizer` (order 25)
  and `conversation.input.dock` → `prompt-optimizer` (order 25), both `active`.
- Endpoint rejects unauthenticated requests (`401 {"reason":"unauthorized"}`),
  i.e. the route is mounted and the owner-only guard runs.
- Rewrite engine verified in isolation: both a Chinese and an English draft
  produce a meta-prompt that embeds the draft verbatim, carries the
  plain-output contract and the instruction-as-data guardrail.
- **Not verified:** the rendered ✨ control, the streaming panel, and a real
  model round-trip need browser control over the running Harness page, which
  this session does not have. Replacing an installed package may also require a
  Harness restart to load a fresh Host JS generation.

## License

MIT. The imported rewrite engine is MIT-licensed by its author
([seven282/oss-prompt-optimizer](https://github.com/seven282/oss-prompt-optimizer)).
