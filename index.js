/**
 * Host half of the Prompt Optimizer plugin.
 *
 * Two same-origin endpoints serve the composer and its settings row:
 * - `POST /prompt-optimizer/optimize` streams `meta`, `delta`, `done`, `error`.
 * - `GET  /prompt-optimizer/defaults` reports the profile-configured style.
 *
 * `outputStyle` selects the shape the engine emits: `plain` (heading-free
 * paragraphs), `sections` (## Role / ## Task / ## Context / ## Format) or
 * `role-task-goal` (Role: / Task: / Goal: lines). It is a profile-level `Config`
 * default, overridable per request by the Client's General settings row.
 *
 * The rewrite itself is not re-implemented here: the system prompt comes from
 * the `oss-prompt-optimizer` package (in-harness name "Prompt Optimizer"),
 * whose `buildOptimizePrompt()` builds the Role/Task/Context/Format meta-prompt
 * and `detectLanguage()` picks the meta-prompt language. This plugin only wires that
 * engine to the composer and streams the answer back; nothing is written to the
 * Session, and the user's draft is never modified by the Host.
 */

import z from '@deepseek-ai/schemastery'
import { buildOptimizePrompt, detectLanguage } from 'oss-prompt-optimizer'

export const name = 'prompt-optimizer'

export const inject = ['connection', 'llm', 'sessions', 'webServer']

/**
 * Profile-level default for the rewrite shape. Override it in `cordis.patch.yml`:
 *
 * ```yaml
 * - id: prompt-optimizer
 *   name: 'dsh-prompt-rewrite'
 *   config:
 *     outputStyle: sections
 * ```
 */
export const Config = z.object({
  outputStyle: z.union(['plain', 'sections', 'role-task-goal']).default('plain'),
})

/** Output shapes accepted by `buildOptimizePrompt()`. */
const STYLES = ['plain', 'sections', 'role-task-goal']

/** Fallback when neither the profile config nor the request names a style. */
const DEFAULT_STYLE = 'plain'

/** Same-origin streaming endpoint the Client half posts to. */
const ENDPOINT = '/prompt-optimizer/optimize'

/** Same-origin endpoint the settings row reads its effective default from. */
const DEFAULTS_ENDPOINT = '/prompt-optimizer/defaults'

/** Request bound: one draft per call. */
const MAX_BODY_BYTES = 32 * 1024

/** The rewrite target; the Client bounds it too. */
const MAX_DRAFT_CHARS = 6_000

/** Output budget for one rewrite. */
const MAX_OUTPUT_TOKENS = 1_600

/** Whole-call deadline; a rewrite is a single auxiliary model call. */
const TIMEOUT_MS = 90_000

/**
 * Closing instruction of the user turn. The draft itself is already embedded in
 * the meta-prompt by `buildOptimizePrompt()`, so the user turn only restates the
 * output contract — exactly what the upstream service sends.
 */
const USER_TURN = {
  zh: '请严格按上述要求，只输出优化后的提示词。',
  en: 'Follow the instructions above and output only the optimized prompt.',
}

/**
 * Register the rewrite and defaults endpoints.
 * @param ctx - context exposing llm, sessions, connection, and the web server.
 * @param config - validated `Config` row (plain values, or refs for the
 *   service-class form; both shapes are accepted).
 */
export function apply(ctx, config) {
  const defaults = { outputStyle: styleOf(config?.outputStyle) ?? DEFAULT_STYLE }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: (request, response) => serve(ctx, defaults, request, response),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: DEFAULTS_ENDPOINT,
      handler: (request, response) => serveDefaults(ctx, defaults, request, response),
    }),
  )
}

/** Read a style string from a plain config value or a schemastery ref. */
function styleOf(value) {
  const raw = typeof value === 'string' ? value : typeof value?.get === 'function' ? value.get() : undefined
  return typeof raw === 'string' && STYLES.includes(raw) ? raw : undefined
}

/**
 * Admit one defaults read and report the effective profile default.
 * @param ctx - plugin context.
 * @param defaults - resolved profile defaults.
 * @param request - Node request.
 * @param response - Node response.
 */
async function serveDefaults(ctx, defaults, request, response) {
  const admission = ctx.connection.admit(request)
  if ('rejection' in admission) {
    respond(response, admission.rejection, { reason: 'unauthorized' })
    return
  }
  if (admission.peer.principal.kind !== 'owner') {
    respond(response, 403, { reason: 'forbidden' })
    return
  }
  if (request.method !== 'GET') {
    respond(response, 405, { reason: 'method-not-allowed' })
    return
  }
  respond(response, 200, { outputStyle: defaults.outputStyle, styles: STYLES })
}

/**
 * Admit, validate, and stream one rewrite.
 * @param ctx - plugin context.
 * @param defaults - resolved profile defaults.
 * @param request - Node request.
 * @param response - Node response.
 */
async function serve(ctx, defaults, request, response) {
  try {
    const admission = ctx.connection.admit(request)
    if ('rejection' in admission) {
      respond(response, admission.rejection, { reason: 'unauthorized' })
      return
    }
    // Rewrites spend the owner's model tokens.
    if (admission.peer.principal.kind !== 'owner') {
      respond(response, 403, { reason: 'forbidden' })
      return
    }
    if (request.method !== 'POST') {
      respond(response, 405, { reason: 'method-not-allowed' })
      return
    }
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      respond(response, 415, { reason: 'unsupported-media-type' })
      return
    }

    let body
    try {
      body = await readJsonBody(request)
    } catch {
      respond(response, 400, { reason: 'invalid-body' })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      respond(response, 400, { reason: 'invalid-body' })
      return
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') {
      respond(response, 400, { reason: 'missing-session' })
      return
    }

    const draft = typeof body.draft === 'string' ? body.draft.slice(0, MAX_DRAFT_CHARS) : ''
    if (draft.trim() === '') {
      respond(response, 400, { reason: 'no-draft' })
      return
    }

    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      // The session list can move under us; the Client shows the reason.
      respond(response, 200, { reason: 'session-not-live' })
      return
    }

    const route = resolveRoute(ctx, session)
    if (route === undefined) {
      respond(response, 200, { reason: 'no-route' })
      return
    }

    // A per-request override wins; an unknown value falls back to the profile
    // default instead of failing the rewrite.
    const requestedStyle = typeof body.outputStyle === 'string' ? body.outputStyle : ''
    const outputStyle = STYLES.includes(requestedStyle) ? requestedStyle : defaults.outputStyle

    let metaLanguage
    let system
    try {
      // Mirror the upstream defaults: `metaPromptLanguage: 'auto'` resolves to
      // detectLanguage(input) and `outputLanguage: 'auto'` leaves the output
      // language unpinned, so the rewrite follows the draft instead of an
      // injected "- 输出语言固定为：en" line. `outputStyle: 'plain'` keeps the
      // answer a heading-free prompt body, which is what the composer holds.
      metaLanguage = detectLanguage(draft)
      system = buildOptimizePrompt(draft, 'auto', undefined, undefined, outputStyle, metaLanguage)
    } catch (error) {
      respond(response, 200, { reason: shortReason(error) })
      return
    }

    const disconnect = watchDisconnect(response)
    openStream(response)
    const deadline = timedSignal(disconnect.signal, TIMEOUT_MS)
    try {
      sendEvent(response, {
        type: 'meta',
        provider: route.provider,
        model: route.model,
        language: metaLanguage,
        outputStyle,
      })
      const text = await runModel(ctx, route, system, metaLanguage, deadline.signal, (delta) => {
        if (!deadline.signal.aborted) sendEvent(response, { type: 'delta', text: delta })
      })
      if (deadline.signal.aborted) return
      if (text.trim() === '') sendEvent(response, { type: 'error', reason: 'empty-output' })
      else sendEvent(response, { type: 'done', text })
    } catch (error) {
      if (!deadline.signal.aborted) sendEvent(response, { type: 'error', reason: shortReason(error) })
    } finally {
      deadline.dispose()
      closeStream(response)
    }
  } catch (error) {
    if (response.headersSent === true) closeStream(response)
    else respond(response, 500, { reason: shortReason(error) })
  }
}

/**
 * Run one model call over the supplied meta-prompt and return its text.
 * @returns the assembled answer; throws when the stream did not finish cleanly.
 */
async function runModel(ctx, route, system, metaLanguage, signal, onDelta) {
  const call = await ctx.llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS },
    signal,
    (controls) => controls,
  )
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: USER_TURN[metaLanguage] ?? USER_TURN.en }],
    },
  ]
  let text = ''
  let finish
  for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
    signal.throwIfAborted()
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      onDelta(chunk.text)
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (finish === undefined) throw new Error('unfinished')
  if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
    const failure = finish.failure
    throw new Error(
      typeof failure?.message === 'string' && failure.message !== ''
        ? failure.message
        : typeof failure?.code === 'string' && failure.code !== ''
          ? failure.code
          : 'failed',
    )
  }
  return text
}

/** Prefer the route the Session already used, then the profile default. */
function resolveRoute(ctx, session) {
  const config = session.requestHeader?.()?.config
  if (typeof config?.provider === 'string' && typeof config.model === 'string') return config
  const fallback = ctx.get('agentDefaultModel')?.currentSelection()
  if (typeof fallback?.provider === 'string' && typeof fallback.model === 'string') return fallback
  return undefined
}

/** Short, safe reason text for a client that only displays it. */
function shortReason(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 160 ? `${message.slice(0, 160)}…` : message
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      request.resume?.()
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('body-too-large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', fail)
    request.on('aborted', () => fail(new Error('request-aborted')))
    request.on('close', () => fail(new Error('request-closed')))
  })
}

function openStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  })
  response.flushHeaders?.()
}

function sendEvent(response, event) {
  if (response.writableEnded || response.destroyed) return
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function closeStream(response) {
  if (response.writableEnded || response.destroyed) return
  response.end()
}

function watchDisconnect(response) {
  const controller = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  return controller
}

function respond(response, status, payload) {
  if (response.writableEnded || response.headersSent === true) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function timedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    },
  }
}
