/**
 * Render tests for the browser half.
 *
 * The Client artifact is a plain `window.__ModuleLoader__.load()` module, so it
 * is evaluated in a `vm` sandbox with a mocked `require('react')` and then
 * rendered by calling the registered slot components directly. This checks the
 * parts a type checker would normally cover for a compiled plugin: module
 * identity, slot registrations, host dock geometry, the style preference row,
 * and every state transition.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const STYLE_KEY = 'dsh-prompt-optimizer.outputStyle'

async function loadDefinition(seed = [], fetchOverride) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const storage = new Map(seed)
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
      localStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
      },
    },
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchOverride ?? (async () => {
      throw new Error('fetch must not run in a render test')
    }),
    AbortController,
    TextDecoder,
    JSON,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'module did not call window.__ModuleLoader__.load')
  return { definition, storage }
}

const IDLE = {
  open: false,
  status: 'idle',
  live: '',
  result: '',
  error: '',
  sessionId: null,
  provider: '',
  model: '',
  outputStyle: '',
  backup: null,
}

async function createHarness(seed = [], fetchOverride) {
  const { definition, storage } = await loadDefinition(seed, fetchOverride)
  const holder = { state: IDLE }
  const dicts = {}
  const registrations = []

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => fetchOverride ? getSnapshot() : holder.state,
  }

  const mod = definition.factory((id) => {
    assert.equal(id, 'react', `unexpected require(${id})`)
    return React
  })

  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      bind: (ns) => (key, vars) => {
        let out = (dicts[ns] ?? {})[key] ?? key
        if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
        return out
      },
      register: (ns, tables) => {
        dicts[ns] = tables.en
        return () => {}
      },
    },
    slots: {
      inject: (_slot, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ ...options, component })
        return () => {}
      },
    },
  }

  mod.apply(ctx)

  const bySlot = (slot) => registrations.find((entry) => entry.name === slot)
  return {
    definition,
    dict: dicts['prompt-optimizer'],
    registrations,
    storage,
    setState: (next) => {
      holder.state = next
    },
    Dock: bySlot('conversation.input.dock')?.component,
    Button: bySlot('conversation.input.right')?.component,
    Settings: bySlot('settings.general.item')?.component,
  }
}

const text = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return (node.children ?? []).map(text).join('')
}

const nodes = (node, acc = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, acc)
    return acc
  }
  acc.push(node)
  for (const child of node.children ?? []) nodes(child, acc)
  return acc
}

const buttons = (tree) => nodes(tree).filter((node) => node.type === 'button')
const selects = (tree) => nodes(tree).filter((node) => node.type === 'select')

const slotProps = (sessionId = 'sess-a') => ({
  sessionId,
  useInput: (selector) => selector({ draft: 'my draft' }),
  inputActions: { setDraft() {}, captureInsertion() {}, insertText() {} },
})

test('module identity, injection and registrations', async () => {
  const h = await createHarness()
  assert.equal(h.definition.id, 'dsh-prompt-rewrite')
  assert.deepEqual(h.registrations.map((r) => r.name).sort(), [
    'conversation.input.dock',
    'conversation.input.right',
    'settings.general.item',
  ])
  for (const reg of h.registrations) {
    assert.equal(reg.id, 'prompt-optimizer')
    assert.ok(Number.isInteger(reg.order))
  }
  assert.ok(!h.registrations.some((r) => r.name === 'shell.overlay'), 'no timed star popup registers on the shell overlay')
  assert.ok(h.dict, 'locale dictionary registered')
})

test('dock is hidden while idle and for another session', async () => {
  const h = await createHarness()
  assert.equal(h.Dock(slotProps()), null)
  h.setState({ ...IDLE, open: true, status: 'done', sessionId: 'sess-a', result: 'X', live: 'X' })
  assert.equal(h.Dock(slotProps('sess-other')), null)
  assert.notEqual(h.Dock(slotProps('sess-a')), null)
})

test('loading shows the progress status', async () => {
  const h = await createHarness()
  h.setState({ ...IDLE, open: true, status: 'loading', sessionId: 'sess-a' })
  assert.match(text(h.Dock(slotProps())), new RegExp(h.dict.panelAnalyzing))
})

test('result state offers Use, Copy and Close, and names the style', async () => {
  const h = await createHarness()
  h.setState({
    ...IDLE,
    open: true,
    status: 'done',
    sessionId: 'sess-a',
    result: 'OPT',
    live: 'OPT',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    outputStyle: 'sections',
  })
  const tree = h.Dock(slotProps())
  assert.deepEqual(
    buttons(tree).map(text),
    [h.dict.panelUse, h.dict.panelCopy, h.dict.panelClose],
  )
  const header = text(tree)
  assert.ok(header.includes('deepseek-account / deepseek-flash'), 'model badge missing')
  assert.ok(header.includes(h.dict.styleSectionsShort), 'style missing from the badge')
})

test('applied state makes Undo primary and announces the change', async () => {
  const h = await createHarness()
  h.setState({
    ...IDLE,
    open: true,
    status: 'done',
    sessionId: 'sess-a',
    result: 'OPT',
    live: 'OPT',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    backup: 'my draft',
  })
  const tree = h.Dock(slotProps())
  assert.deepEqual(
    buttons(tree).map(text),
    [h.dict.panelUndo, h.dict.panelCopy, h.dict.panelClose],
  )
  assert.equal(buttons(tree)[0].props.style.background, 'var(--dsw-alias-brand-primary)')
  const live = nodes(tree).filter((node) => node.props?.['aria-live'] === 'polite')
  assert.equal(live.length, 1)
  assert.equal(text(live[0]), h.dict.panelApplied)
})

test('dock adopts the host composer column geometry', async () => {
  const h = await createHarness()
  h.setState({ ...IDLE, open: true, status: 'done', sessionId: 'sess-a', result: 'OPT', live: 'OPT' })
  const tree = h.Dock(slotProps())
  assert.equal(tree.props.style.maxWidth, 'var(--dsh-chat-content-width, 920px)')
  assert.equal(tree.props.style.width, '100%')
  assert.match(String(tree.props.style.margin), /--dsh-composer-stack-gap/)
  const surface = tree.children[0]
  assert.equal(surface.props.style.borderBottom, 'none')
  assert.match(String(surface.props.style.borderRadius), /0 0$/)
})

test('error state renders an alert with the reason', async () => {
  const h = await createHarness()
  h.setState({ ...IDLE, open: true, status: 'error', sessionId: 'sess-a', error: 'boom' })
  const alerts = nodes(h.Dock(slotProps())).filter((node) => node.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(text(alerts[0]), h.dict.panelError.replace('{reason}', 'boom'))
})

test('composer control reflects draft and busy state', async () => {
  const h = await createHarness()
  const empty = h.Button({ ...slotProps(), useInput: (selector) => selector({ draft: '   ' }) })
  assert.equal(buttons(empty)[0].props.disabled, true)
  assert.equal(buttons(h.Button(slotProps()))[0].props.disabled, false)
  h.setState({ ...IDLE, status: 'loading', sessionId: 'sess-a' })
  assert.equal(buttons(h.Button(slotProps()))[0].props.disabled, true)
})

test('style setting renders all three styles and persists the choice', async () => {
  const h = await createHarness()
  const tree = h.Settings()
  const select = selects(tree)[0]
  assert.ok(select, 'settings row has no select')
  assert.deepEqual(
    select.children.map((option) => option.props.value),
    ['plain', 'sections', 'role-task-goal'],
  )
  assert.deepEqual(
    select.children.map(text),
    [h.dict.stylePlain, h.dict.styleSections, h.dict.styleRoleTaskGoal],
  )
  assert.equal(select.props.value, 'plain', 'defaults to the plain style')
  assert.equal(select.props['aria-label'], h.dict.styleRowTitle)
  assert.ok(text(tree).includes(h.dict.styleRowTitle), 'row label missing')

  select.props.onChange({ target: { value: 'role-task-goal' } })
  assert.equal(h.storage.get(STYLE_KEY), 'role-task-goal')
})

test('style setting starts from a stored override', async () => {
  const h = await createHarness([[STYLE_KEY, 'sections']])
  assert.equal(selects(h.Settings())[0].props.value, 'sections')
})

test('an invalid stored value is ignored', async () => {
  const h = await createHarness([[STYLE_KEY, 'nonsense']])
  assert.equal(selects(h.Settings())[0].props.value, 'plain')
})

const flush = () => new Promise((resolve) => setImmediate(resolve))
const streamResponse = (...events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))

test('an interrupted stream cannot replace the draft', async () => {
  const h = await createHarness([], async () => streamResponse({ type: 'delta', text: 'partial' }))
  const props = slotProps()
  let writes = 0
  props.inputActions.setDraft = () => { writes++ }
  h.Button(props).props.onClick()
  await flush()
  const tree = h.Dock(props)
  assert.match(text(tree), /unfinished/)
  const use = buttons(tree).find((b) => text(b) === h.dict.panelUse)
  assert.equal(use.props.disabled, true)
  use.props.onClick()
  assert.equal(writes, 0)
})

test('a cancelled request cannot reset its replacement, and Use/Undo preserves the draft', async () => {
  const pending = []
  const h = await createHarness([], () => new Promise((resolve, reject) => pending.push({ resolve, reject })))
  const props = slotProps()
  let draft = 'original draft'
  props.useInput = (select) => select({ draft })
  props.inputActions.setDraft = (value) => { draft = value }
  h.Button(props).props.onClick()
  h.Button({ ...props, sessionId: 'sess-b' }).props.onClick()
  pending[0].reject(new Error('aborted'))
  await flush()
  const current = { ...props, sessionId: 'sess-b' }
  assert.match(text(h.Dock(current)), new RegExp(h.dict.panelAnalyzing))
  pending[1].resolve(streamResponse({ type: 'done', text: 'rewritten' }))
  await flush()
  buttons(h.Dock(current)).find((b) => text(b) === h.dict.panelUse).props.onClick()
  assert.equal(draft, 'rewritten')
  buttons(h.Dock(current)).find((b) => text(b) === h.dict.panelUndo).props.onClick()
  assert.equal(draft, 'original draft')
})
