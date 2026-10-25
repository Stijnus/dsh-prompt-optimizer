/**
 * Integration test for the Host half.
 *
 * The Host half imports `oss-prompt-optimizer`, whose module graph expects the
 * Cordis runtime. The test builds a throwaway fixture: a copy of the installed
 * dependency tree plus a minimal `@deepseek-ai/cordis` shim, so the real route
 * handlers can be exercised without a Harness process.
 *
 * Covers: route registration, owner-only admission, request validation, session
 * route resolution, the reused rewrite engine producing the system prompt for
 * each output style, profile Config defaults, SSE framing, and error paths.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../', import.meta.url)

const OPTIMIZE = '/prompt-optimizer/optimize'
const DEFAULTS = '/prompt-optimizer/defaults'

const CORDIS_SHIM = `export class Service {
  constructor(ctx, config) { this.ctx = ctx; this.config = config ?? {} }
}
export class Context {}
export default Service
`

async function buildFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-optimizer-host-'))
  const modules = join(dir, 'node_modules')
  await cp(new URL('node_modules', ROOT), modules, { recursive: true })

  const cordisDir = join(modules, '@deepseek-ai', 'cordis')
  await rm(cordisDir, { recursive: true, force: true })
  await mkdir(cordisDir, { recursive: true })
  await writeFile(
    join(cordisDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/cordis', version: '0.0.0-test', type: 'module', main: 'index.js' }),
  )
  await writeFile(join(cordisDir, 'index.js'), CORDIS_SHIM)
  await cp(new URL('index.js', ROOT), join(dir, 'plugin.mjs'))
  return dir
}

function fakeRequest(body, method = 'POST') {
  const request = new EventEmitter()
  request.method = method
  request.headers = { 'content-type': 'application/json' }
  request.resume = () => {}
  setImmediate(() => {
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  })
  return request
}

function fakeResponse() {
  const response = new EventEmitter()
  response.headersSent = false
  response.writableEnded = false
  response.destroyed = false
  response.chunks = []
  response.status = null
  response.writeHead = (status, headers) => {
    response.status = status
    response.headersSent = true
    response.headers = headers
    return response
  }
  response.flushHeaders = () => {}
  response.write = (part) => {
    response.chunks.push(String(part))
    return true
  }
  response.end = (data) => {
    if (data !== undefined) response.chunks.push(String(data))
    response.writableEnded = true
  }
  return response
}

function eventsOf(response) {
  return response.chunks
    .join('')
    .split('\n\n')
    .filter((frame) => frame.includes('data:'))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf('data:') + 5).trim()))
}

async function createHarness(config) {
  const dir = await buildFixture()
  const module = await import(pathToFileURL(join(dir, 'plugin.mjs')).href)
  const calls = []
  const handlers = new Map()
  let systemSeen = ''

  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    sessions: {
      get: (id) =>
        id === 'sess-live'
          ? { requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }) }
          : undefined,
    },
    webServer: {
      register: ({ path, handler }) => {
        handlers.set(path, handler)
        return () => {}
      },
    },
    get: () => undefined,
    llm: {
      prepareCall: async (args) => {
        calls.push(args)
        return {
          config: { ...args, temperature: 0.3 },
          stream: (options) => {
            systemSeen = options.system
            calls.push({ messages: options.messages, system: options.system })
            return (async function* () {
              yield { type: 'text-delta', text: 'You are a senior ' }
              yield { type: 'text-delta', text: 'release manager.' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      },
    },
  }

  module.apply(ctx, config)
  return {
    module,
    dir,
    ctx,
    calls,
    handlers,
    optimize: handlers.get(OPTIMIZE),
    defaults: handlers.get(DEFAULTS),
    system: () => systemSeen,
  }
}

function optimizeOnce(h, body) {
  const response = fakeResponse()
  return h.optimize(fakeRequest(body), response).then(() => response)
}

test('exposes the bundle identity, Config schema and both routes', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  assert.equal(h.module.name, 'prompt-optimizer')
  assert.ok(h.module.inject.includes('llm'))
  assert.equal(typeof h.module.Config, 'function', 'Config schema export missing')
  assert.equal(h.optimize instanceof Function, true)
  assert.equal(h.defaults instanceof Function, true)
})

test('streams a rewritten prompt from a stub model', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))

  const draft = 'summarize this changelog into release notes'
  const response = await optimizeOnce(h, { sessionId: 'sess-live', draft })

  const events = eventsOf(response)
  assert.deepEqual(
    events.map((event) => event.type),
    ['meta', 'delta', 'delta', 'done'],
  )
  assert.equal(events[0].provider, 'deepseek-account')
  assert.equal(events[0].model, 'deepseek-flash')
  assert.equal(events[0].language, 'en')
  assert.equal(events[0].outputStyle, 'plain')
  assert.equal(events[3].text, 'You are a senior release manager.')

  assert.match(h.system(), new RegExp(draft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(h.system(), /输出语言固定为/)
  assert.doesNotMatch(h.system(), /## Role/)
  assert.equal(h.calls[0].maxTokens, 1600)
  assert.equal(
    h.calls[1].messages[0].content[0].text,
    'Follow the instructions above and output only the optimized prompt.',
  )
})

test('detects a Chinese draft', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  const response = await optimizeOnce(h, { sessionId: 'sess-live', draft: '帮我写个请假条' })
  assert.equal(eventsOf(response)[0].language, 'zh')
})

test('sections style asks for the four headings', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  const response = await optimizeOnce(h, {
    sessionId: 'sess-live',
    draft: 'review the release notes',
    outputStyle: 'sections',
  })
  assert.equal(eventsOf(response)[0].outputStyle, 'sections')
  assert.match(h.system(), /## Role/)
  assert.match(h.system(), /## Context/)
})

test('role-task-goal style asks for the three labeled lines', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  const response = await optimizeOnce(h, {
    sessionId: 'sess-live',
    draft: 'review the release notes',
    outputStyle: 'role-task-goal',
  })
  assert.equal(eventsOf(response)[0].outputStyle, 'role-task-goal')
  assert.match(h.system(), /Role:, Task:, Goal:/)
  assert.doesNotMatch(h.system(), /## Role/)
})

test('an unknown style falls back to the profile default', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  const response = await optimizeOnce(h, {
    sessionId: 'sess-live',
    draft: 'review the release notes',
    outputStyle: 'nonsense',
  })
  assert.equal(eventsOf(response)[0].outputStyle, 'plain')
  assert.doesNotMatch(h.system(), /## Role/)
})

test('a Config default applies when the request omits the style', async (t) => {
  const h = await createHarness({ outputStyle: 'sections' })
  t.after(() => rm(h.dir, { recursive: true, force: true }))

  const defaultsResponse = fakeResponse()
  await h.defaults(fakeRequest(undefined, 'GET'), defaultsResponse)
  const defaults = JSON.parse(defaultsResponse.chunks.join(''))
  assert.equal(defaults.outputStyle, 'sections')
  assert.deepEqual(defaults.styles, ['plain', 'sections', 'role-task-goal'])

  const response = await optimizeOnce(h, { sessionId: 'sess-live', draft: 'review the release notes' })
  assert.equal(eventsOf(response)[0].outputStyle, 'sections')
  assert.match(h.system(), /## Role/)
})

test('the defaults endpoint is owner-only', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  h.ctx.connection.admit = () => ({ peer: { principal: { kind: 'guest' } } })
  const response = fakeResponse()
  await h.defaults(fakeRequest(undefined, 'GET'), response)
  assert.equal(response.status, 403)
})

test('rejects an empty draft', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  const response = await optimizeOnce(h, { sessionId: 'sess-live', draft: '   ' })
  assert.equal(response.status, 400)
})

test('reports a session that is no longer live', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  const response = await optimizeOnce(h, { sessionId: 'gone', draft: 'hello' })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.chunks.join('')).reason, 'session-not-live')
})

test('rejects a non-owner caller', async (t) => {
  const h = await createHarness()
  t.after(() => rm(h.dir, { recursive: true, force: true }))
  h.ctx.connection.admit = () => ({ peer: { principal: { kind: 'guest' } } })
  const response = await optimizeOnce(h, { sessionId: 'sess-live', draft: 'hello' })
  assert.equal(response.status, 403)
})
