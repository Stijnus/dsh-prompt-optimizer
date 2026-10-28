/**
 * Browser half of the Prompt Optimizer plugin.
 *
 * Adds two composer entries:
 * - `conversation.input.right` — a ✨ control that rewrites the current draft.
 * - `conversation.input.dock`  — a non-modal panel streaming the rewrite, with
 *   Use / Undo / Copy / Close.
 *
 * The rewrite itself is the Host half's job: this module only sends the draft to
 * `POST /prompt-optimizer/optimize` and renders the SSE answer. Nothing is sent
 * to the agent, and replacing the draft is always an explicit click.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-rewrite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useSyncExternalStore } = React

    const NS = 'prompt-optimizer'
    const ENDPOINT = '/prompt-optimizer/optimize'
    const DEFAULTS_ENDPOINT = '/prompt-optimizer/defaults'
    const MAX_DRAFT_CHARS = 6000

    /** Rewrite shapes accepted by the Host; mirrors its Config enum. */
    const STYLES = ['plain', 'sections', 'role-task-goal']
    /** Browser-scoped override of the profile's `outputStyle` default. */
    /** Quiet, user-initiated suite star link. */
    const STAR_SUITE_URL = 'https://github.com/Stijnus?tab=repositories&q=dsh'

    const STYLE_KEY = 'dsh-prompt-optimizer.outputStyle'
    const STYLE_SHORT_KEYS = {
      plain: 'stylePlainShort',
      sections: 'styleSectionsShort',
      'role-task-goal': 'styleRoleTaskGoalShort',
    }

    const DICTIONARIES = {
      en: {
        label: 'Prompt optimizer',
        actionOptimize: 'Optimize prompt',
        actionOptimizing: 'Optimizing…',
        panelTitle: 'Optimized prompt',
        panelRegion: 'Optimized prompt preview',
        panelAnalyzing: 'Rewriting your prompt…',
        panelUse: 'Use',
        panelUndo: 'Undo',
        panelCopy: 'Copy',
        panelCopied: 'Copied',
        panelClose: 'Close',
        panelEmpty: 'No result yet.',
        panelApplied: 'Draft replaced. Undo restores the original text.',
        panelError: 'Optimization failed: {reason}',
        starSuite: 'Star the suite',
        starSuiteTitle: 'Star the Stijnus DSH plugin suite on GitHub',
        styleRowTitle: 'Prompt style',
        styleRowDescription:
          'Shape the rewritten prompt is written in. Plain keeps one continuous prompt; Sections uses Role / Task / Context / Format headings; Role-Task-Goal uses three labeled lines.',
        stylePlain: 'Plain prompt',
        styleSections: 'Sections (Role / Task / Context / Format)',
        styleRoleTaskGoal: 'Role / Task / Goal',
        stylePlainShort: 'plain',
        styleSectionsShort: 'sections',
        styleRoleTaskGoalShort: 'role-task-goal',
      },
      zh: {
        label: '提示词优化',
        actionOptimize: '优化提示词',
        actionOptimizing: '优化中…',
        panelTitle: '优化后的提示词',
        panelRegion: '优化后的提示词预览',
        panelAnalyzing: '正在改写你的提示词…',
        panelUse: '使用',
        panelUndo: '撤销',
        panelCopy: '复制',
        panelCopied: '已复制',
        panelClose: '关闭',
        panelEmpty: '还没有结果。',
        panelApplied: '已替换草稿，点击撤销可恢复原文。',
        panelError: '优化失败：{reason}',
        starSuite: '为插件套件点星',
        starSuiteTitle: '在 GitHub 上为 Stijnus 的 DSH 插件套件点星',
        styleRowTitle: '提示词形态',
        styleRowDescription:
          '控制改写后提示词的排版。纯文本：一整段连续提示词；分段：使用「角色 / 任务 / 背景 / 格式」小节标题；角色·任务·目标：三行标签式。',
        stylePlain: '纯文本',
        styleSections: '分段（角色 / 任务 / 背景 / 格式）',
        styleRoleTaskGoal: '角色 / 任务 / 目标',
        stylePlainShort: '纯文本',
        styleSectionsShort: '分段',
        styleRoleTaskGoalShort: '角色·任务·目标',
      },
    }

    // ---- style preference ------------------------------------------------------

    /** Read the browser override, or '' when unset/invalid. */
    function readStoredStyle() {
      try {
        const value = window.localStorage?.getItem(STYLE_KEY)
        return STYLES.includes(value) ? value : ''
      } catch {
        return ''
      }
    }

    /** Persist the browser override; storage failures leave the profile default. */
    function storeStyle(value) {
      try {
        window.localStorage?.setItem(STYLE_KEY, value)
      } catch {
        // A private/blocked storage context still optimizes with the default.
      }
    }

    // ---- shared rewrite state -------------------------------------------------

    let snapshot = {
      open: false,
      status: 'idle', // idle | loading | done | error
      live: '',
      result: '',
      error: '',
      sessionId: null,
      provider: '',
      model: '',
      outputStyle: '',
      backup: null,
    }
    const listeners = new Set()
    let inflight = null

    function setState(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
    }

    function close() {
      if (inflight !== null) {
        inflight.abort()
        inflight = null
      }
      setState({ open: false, status: 'idle', live: '', error: '', backup: null })
    }

    /** Read one SSE response, calling `onEvent` for each decoded event. */
    async function consumeStream(response, signal, onEvent) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const line = frame.split('\n').find((part) => part.startsWith('data:'))
          if (line === undefined) continue
          try {
            onEvent(JSON.parse(line.slice(5).trim()))
          } catch {
            // A malformed frame is skipped; the next one may still be valid.
          }
        }
        if (signal.aborted) break
      }
    }

    /** Ask the Host to rewrite `draft` and stream the answer into the store. */
    async function optimize(sessionId, draft) {
      if (inflight !== null) inflight.abort()
      const local = new AbortController()
      inflight = local
      setState({
        open: true,
        status: 'loading',
        live: '',
        result: '',
        error: '',
        sessionId,
        provider: '',
        model: '',
        outputStyle: '',
        backup: null,
      })
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            draft: draft.slice(0, MAX_DRAFT_CHARS),
            // Omitted when unset so the Host applies its profile Config default.
            outputStyle: readStoredStyle() || undefined,
          }),
          signal: local.signal,
        })
        if (local.signal.aborted || inflight !== local) return
        if (!response.ok || response.body === null) {
          setState({ status: 'error', error: `HTTP ${response.status}` })
          return
        }
        let text = ''
        let settled = false
        await consumeStream(response, local.signal, (event) => {
          if (local.signal.aborted || inflight !== local || settled) return
          if (event === null || typeof event !== 'object') return
          if (event.type === 'meta') {
            setState({
              provider: String(event.provider ?? ''),
              model: String(event.model ?? ''),
              outputStyle: STYLES.includes(event.outputStyle) ? event.outputStyle : '',
            })
          } else if (event.type === 'delta') {
            text += typeof event.text === 'string' ? event.text : ''
            setState({ live: text })
          } else if (event.type === 'done') {
            settled = true
            text = typeof event.text === 'string' && event.text !== '' ? event.text : text
            setState({ status: 'done', result: text, live: text })
          } else if (event.type === 'error') {
            settled = true
            setState({ status: 'error', error: String(event.reason ?? 'failed') })
          }
        })
        if (!settled && !local.signal.aborted && getSnapshot().status === 'loading') {
          if (text.trim() === '') setState({ status: 'error', error: 'empty-output' })
          else setState({ status: 'error', error: 'unfinished' })
        }
      } catch (error) {
        if (local.signal.aborted || inflight !== local) return
        setState({ status: 'error', error: shortMessage(error) })
      } finally {
        if (inflight === local) inflight = null
      }
    }

    function shortMessage(error) {
      const message = error instanceof Error ? error.message : String(error)
      return message.length > 120 ? `${message.slice(0, 120)}…` : message
    }

    // ---- controls -------------------------------------------------------------

    const SPARKLE = h(
      'svg',
      { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false' },
      h('path', {
        d: 'M8 1.5l1.35 3.4 3.4 1.35-3.4 1.35L8 11l-1.35-3.4L3.25 6.25l3.4-1.35L8 1.5z',
        fill: 'currentColor',
      }),
      h('path', {
        d: 'M12.6 10.4l.65 1.65 1.65.65-1.65.65-.65 1.65-.65-1.65-1.65-.65 1.65-.65.65-1.65z',
        fill: 'currentColor',
        opacity: 0.75,
      }),
    )

    function buttonStyle(busy) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: busy ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1,
        cursor: busy ? 'progress' : 'pointer',
        whiteSpace: 'nowrap',
      }
    }

    function createOptimizeButton(t) {
      return function OptimizeButton(props) {
        const state = useSyncExternalStore(subscribe, getSnapshot)
        const draft = props.useInput((value) => (value === undefined ? '' : value.draft || ''))
        const busy = state.status === 'loading' && state.sessionId === props.sessionId
        const disabled = busy || draft.trim() === ''
        const label = busy ? t('actionOptimizing') : t('actionOptimize')
        return h(
          'button',
          {
            type: 'button',
            className: 'dsh-prompt-rewrite-trigger',
            'aria-label': label,
            title: label,
            'aria-busy': busy ? 'true' : undefined,
            disabled,
            style: { ...buttonStyle(busy), opacity: disabled ? 0.5 : 1 },
            onClick: () => {
              if (disabled) return
              void optimize(props.sessionId, draft)
            },
          },
          busy
            ? h('span', {
                'aria-hidden': true,
                style: {
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: '2px solid var(--dsw-alias-border-l2)',
                  borderTopColor: 'var(--dsw-alias-brand-primary)',
                  display: 'inline-block',
                },
              })
            : SPARKLE,
          h('span', null, label),
        )
      }
    }

    // The dock slot renders its entries with no width wrapper, so the entry
    // itself must adopt the host's composer-column geometry: full-bleed is what
    // a dock entry becomes without it. `--dsh-chat-content-width` is inherited
    // from the conversation body and already resolves to the transcript /
    // composer column (clamp 680-920px, user-draggable), which is exactly the
    // width the host's own dock panels use.
    const dockStyle = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 'var(--dsh-chat-content-width, 920px)',
      margin: '0 auto calc(0px - var(--dsh-composer-stack-gap, 6px) - 3px)',
      flex: 'none',
    }

    // Dock panels merge into the composer card below: top-only radius, no
    // bottom border, and no outer gap.
    const panelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '10px 14px 12px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderBottom: 'none',
      borderRadius: 'var(--dsw-radius-lg, 12px) var(--dsw-radius-lg, 12px) 0 0',
      background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1))',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      overflow: 'hidden',
    }

    const headerStyle = { display: 'flex', alignItems: 'center', gap: 8 }
    const titleStyle = { fontWeight: 600, fontSize: 13 }
    const badgeStyle = {
      marginLeft: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11,
      color: 'var(--dsw-alias-label-secondary)',
    }
    const bodyStyle = {
      margin: 0,
      paddingRight: 2,
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: 1.55,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: '40vh',
      overflowY: 'auto',
    }
    const appliedStyle = {
      color: 'var(--dsw-alias-state-success-primary)',
      fontSize: 12,
    }
    const hintStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }

    function actionStyle(primary) {
      return {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        border: `1px solid ${primary ? 'transparent' : 'var(--dsw-alias-border-l1)'}`,
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
      }
    }

    const settingRowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 24,
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    }
    const settingLabelStyle = { minWidth: 0 }
    const settingTitleStyle = { fontSize: 14, lineHeight: '20px' }
    const settingHintStyle = {
      marginTop: 4,
      maxWidth: 520,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const settingSelectStyle = {
      flex: 'none',
      font: 'inherit',
      fontSize: 13,
      padding: '6px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      minWidth: 240,
    }

    /**
     * General settings row: pick the rewrite shape. The value is a browser
     * override; until it is changed the row shows the Host's Config default,
     * fetched from the package's own defaults endpoint.
     */
    function createStyleSetting(t) {
      return function StyleSetting() {
        const [style, setStyle] = useState(() => readStoredStyle() || 'plain')

        useEffect(() => {
          if (readStoredStyle() !== '') return undefined
          let cancelled = false
          fetch(DEFAULTS_ENDPOINT)
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              if (cancelled || data === null) return
              if (STYLES.includes(data.outputStyle) && readStoredStyle() === '') setStyle(data.outputStyle)
            })
            .catch(() => {})
          return () => {
            cancelled = true
          }
        }, [])

        const onChange = (event) => {
          const value = event.target.value
          if (!STYLES.includes(value)) return
          storeStyle(value)
          setStyle(value)
        }

        return h(
          'div',
          { style: settingRowStyle },
          h(
            'div',
            { style: settingLabelStyle },
            h('div', { style: settingTitleStyle }, t('styleRowTitle')),
            h('div', { style: settingHintStyle }, t('styleRowDescription')),
          ),
          h(
            'select',
            {
              style: settingSelectStyle,
              value: style,
              'aria-label': t('styleRowTitle'),
              onChange,
            },
            h('option', { value: 'plain' }, t('stylePlain')),
            h('option', { value: 'sections' }, t('styleSections')),
            h('option', { value: 'role-task-goal' }, t('styleRoleTaskGoal')),
          ),
        )
      }
    }

    function createResultDock(t) {
      return function OptimizerResultDock(props) {
        const state = useSyncExternalStore(subscribe, getSnapshot)
        const draft = props.useInput((value) => (value === undefined ? '' : value.draft || ''))
        const [copied, setCopied] = useState(false)
        const owns = state.open && state.sessionId === props.sessionId
        const actions = props.inputActions

        useEffect(() => {
          if (!copied) return undefined
          const timer = setTimeout(() => setCopied(false), 1500)
          return () => clearTimeout(timer)
        }, [copied])

        useEffect(() => {
          if (!owns) return undefined
          const onKey = (event) => {
            if (event.key !== 'Escape') return
            if (state.status === 'loading') return
            close()
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        }, [owns, state.status])

        // The dock belongs to the session it was opened in.
        if (!owns) return null

        const text = state.result || state.live
        const reasoning = state.status === 'loading' && text === ''
        const modelLabel = [state.provider, state.model].filter(Boolean).join(' / ')
        const styleLabel =
          state.outputStyle !== '' ? t(STYLE_SHORT_KEYS[state.outputStyle] ?? 'stylePlainShort') : ''
        const badgeText = [modelLabel, styleLabel].filter(Boolean).join(' · ')

        const writeDraft = (next) => {
          if (actions === undefined || actions === null) return false
          if (typeof actions.setDraft === 'function') {
            actions.setDraft(next)
            return true
          }
          if (typeof actions.insertText === 'function') {
            const capture = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
            actions.insertText(next, capture)
            return true
          }
          return false
        }

        const onUse = () => {
          if (state.status !== 'done' || text.trim() === '' || state.backup !== null) return
          if (!writeDraft(text.trim())) return
          setState({ backup: draft })
        }

        const onUndo = () => {
          if (state.backup === null) return
          writeDraft(state.backup)
          setState({ backup: null })
        }

        const onCopy = async () => {
          if (text.trim() === '') return
          try {
            await navigator.clipboard.writeText(text.trim())
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }

        const applied = state.backup !== null
        const canApply = text.trim() !== '' && state.status === 'done' && !applied

        return h(
          'div',
          { style: dockStyle },
          h(
            'div',
            { style: panelStyle, role: 'region', 'aria-label': t('panelRegion') },
            h(
              'div',
              { style: headerStyle },
              SPARKLE,
              h('span', { style: titleStyle }, t('panelTitle')),
              badgeText !== '' ? h('span', { style: badgeStyle }, badgeText) : null,
            ),
            reasoning ? h('div', { style: hintStyle, role: 'status' }, t('panelAnalyzing')) : null,
            state.status === 'error'
              ? h(
                  'div',
                  { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }, role: 'alert' },
                  t('panelError').replace('{reason}', state.error),
                )
              : null,
            text !== '' ? h('pre', { style: bodyStyle }, text) : null,
            state.status !== 'error' && text === '' && !reasoning
              ? h('div', { style: hintStyle }, t('panelEmpty'))
              : null,
            // After applying, the primary action becomes Undo; the note is a live
            // region so a screen reader announces the draft change.
            applied ? h('div', { style: appliedStyle, role: 'status', 'aria-live': 'polite' }, t('panelApplied')) : null,
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              applied
                ? h('button', { type: 'button', style: actionStyle(true), onClick: onUndo }, t('panelUndo'))
                : h(
                    'button',
                    {
                      type: 'button',
                      style: canApply ? actionStyle(true) : { ...actionStyle(true), opacity: 0.55, cursor: 'default' },
                      disabled: !canApply,
                      onClick: onUse,
                    },
                    t('panelUse'),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  style: actionStyle(false),
                  disabled: text.trim() === '',
                  onClick: onCopy,
                },
                copied ? t('panelCopied') : t('panelCopy'),
              ),
              h(
                'a',
                {
                  href: STAR_SUITE_URL,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: t('starSuiteTitle'),
                  style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-link)', textDecoration: 'none', whiteSpace: 'nowrap' },
                },
                '\u2605 ' + t('starSuite'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...actionStyle(false), marginLeft: 'auto' },
                  onClick: close,
                },
                t('panelClose'),
              ),
            ),
          ),
        )
      }
    }


    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES))

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'prompt-optimizer',
              order: 25,
              label: () => t('label'),
            },
            createOptimizeButton(t),
          ),
        )

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'prompt-optimizer',
              order: 25,
              label: () => t('panelTitle'),
            },
            createResultDock(t),
          ),
        )

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            { name: 'settings.general.item', id: 'prompt-optimizer', order: 55 },
            createStyleSetting(t),
          ),
        )
      },
    }
  },
})
