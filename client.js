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
  id: '@stijnus/dsh-prompt-optimizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useSyncExternalStore } = React

    const NS = 'prompt-optimizer'
    const ENDPOINT = '/prompt-optimizer/optimize'
    const MAX_DRAFT_CHARS = 6000

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
      },
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
        backup: null,
      })
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, draft: draft.slice(0, MAX_DRAFT_CHARS) }),
          signal: local.signal,
        })
        if (!response.ok || response.body === null) {
          setState({ status: 'error', error: `HTTP ${response.status}` })
          return
        }
        let text = ''
        let settled = false
        await consumeStream(response, local.signal, (event) => {
          if (event === null || typeof event !== 'object') return
          if (event.type === 'meta') {
            setState({ provider: String(event.provider ?? ''), model: String(event.model ?? '') })
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
          else setState({ status: 'done', result: text, live: text })
        }
      } catch (error) {
        if (local.signal.aborted) setState({ status: 'idle', live: '' })
        else setState({ status: 'error', error: shortMessage(error) })
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
            className: 'dsh-prompt-optimizer-trigger',
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
        const showModel = state.provider !== '' || state.model !== ''

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
          if (text.trim() === '' || state.backup !== null) return
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
        const canApply = text.trim() !== '' && state.status !== 'loading' && !applied

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
              showModel
                ? h('span', { style: badgeStyle }, [state.provider, state.model].filter(Boolean).join(' / '))
                : null,
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
      },
    }
  },
})
