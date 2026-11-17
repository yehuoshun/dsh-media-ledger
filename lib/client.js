/**
 * dsh-media-ledger 的左侧栏面板（浏览器侧）。
 *
 * 形态是 DSH 的 browser module loader 要求的样子：`window.__ModuleLoader__.load({ id, factory })`，
 * `id` 必须等于包名（`dsh-media-ledger`），React 只能从 `require('react')` 拿——
 * 文档明令禁止 require 任何 `@deepseek-ai/dsh-client-*` 包（宿主随时改，改了就白屏）。
 *
 * 数据从 `lib/bridge.js` 开的本机路由取，开关也写回那里；面板本身不碰文件、不碰 config。
 * 样式全用内联 + `currentColor` / 半透明灰，浅色深色都由宿主主题带着走。
 */
window.__ModuleLoader__.load({
  id: 'dsh-media-ledger',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-media-ledger';
    const BRIDGE = 'api/dsh-media-ledger';

    const bridgeUrl = (endpoint) => {
      try {
        return new URL(`${BRIDGE}/${endpoint}`, document.baseURI).toString();
      } catch {
        return `/${BRIDGE}/${endpoint}`;
      }
    };

    const S = {
      page: {
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '18px 24px 28px',
        fontSize: 13,
        lineHeight: 1.5,
      },
      head: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      muted: { opacity: 0.62 },
      spacer: { flex: 1 },
      cardRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 },
      card: {
        border: '1px solid rgba(128,128,128,0.24)',
        borderRadius: 10,
        padding: '9px 12px',
        minWidth: 108,
      },
      cardLabel: { fontSize: 12, opacity: 0.62, marginBottom: 2 },
      cardValue: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        fontSize: 12,
        opacity: 0.62,
        padding: '6px 8px',
        borderBottom: '1px solid rgba(128,128,128,0.24)',
        whiteSpace: 'nowrap',
      },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,0.12)', verticalAlign: 'top' },
      btn: {
        font: 'inherit',
        padding: '4px 10px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.32)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      warn: {
        border: '1px solid rgba(200,150,0,0.45)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 12,
        fontSize: 12,
      },
      sw: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
      track: (on) => ({
        width: 34,
        height: 18,
        borderRadius: 9,
        position: 'relative',
        flex: 'none',
        background: on ? 'rgba(70,150,255,0.85)' : 'rgba(128,128,128,0.42)',
        transition: 'background 120ms ease',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: 2,
        left: on ? 18 : 2,
        width: 14,
        height: 14,
        borderRadius: 7,
        background: '#fff',
        transition: 'left 120ms ease',
      }),
    };

    function fmtCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (Math.abs(value) >= 10000) return `${Math.round(value / 1000) / 10}w`;
      return String(Math.round(value * 10) / 10);
    }

    function fmtPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return `${value}%`;
    }

    function fmtAge(hours) {
      if (typeof hours !== 'number' || !Number.isFinite(hours)) return '—';
      return hours >= 24 ? `${Math.round((hours / 24) * 10) / 10}d` : `${hours}h`;
    }

    /** 左侧栏图标：宿主给 size/active，颜色用 currentColor 才会跟着选中态变。 */
    function PanelIcon({ size = 18, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: active ? 1 : 0.78 },
        },
        h('path', { d: 'M4 19V9M10 19V5M16 19v-6M22 19H2', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      );
    }

    /** 开关：自己写的，role=switch + aria-checked 是宿主控件的既有行为。 */
    function Toggle({ checked, disabled, label, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled: Boolean(disabled),
          onClick: () => onChange(!checked),
          style: { ...S.sw, background: 'transparent', border: 'none', padding: 0, color: 'inherit' },
        },
        h('span', { style: S.track(checked), 'aria-hidden': 'true' }, h('span', { style: S.knob(checked) })),
        h('span', null, label),
      );
    }

    function Summary({ report }) {
      const age = report.ageRangeHours;
      const ageText = age ? `${fmtAge(age[0])}~${fmtAge(age[1])}` : '—';
      const cards = [
        ['作品', String(report.total)],
        ['有数据', String(report.withData)],
        ['互动率', fmtPercent(report.interactionRate)],
        ['龄期', ageText],
      ];
      return h(
        'div',
        { style: S.cardRow },
        cards.map(([label, value]) =>
          h('div', { key: label, style: S.card }, h('div', { style: S.cardLabel }, label), h('div', { style: S.cardValue }, value)),
        ),
      );
    }

    function Groups({ report }) {
      if (!report.groups || report.groups.length === 0) return null;
      return h(
        'div',
        { style: { marginBottom: 16 } },
        h('div', { style: { ...S.cardLabel, marginBottom: 4 } }, `按${report.groupBy === 'platform' ? '平台' : report.groupBy === 'account' ? '账号' : '类型'}分组`),
        h(
          'table',
          { style: S.table },
          h('thead', null, h('tr', null, ['分组', '条数', '播放中位数', '点赞中位数', '互动率', '评论赞比'].map((t) => h('th', { key: t, style: S.th }, t)))),
          h(
            'tbody',
            null,
            report.groups.map((group) =>
              h(
                'tr',
                { key: group.key },
                h('td', { style: S.td }, group.key),
                h('td', { style: S.td }, String(group.count)),
                h('td', { style: S.td }, fmtCount(group.playMedian)),
                h('td', { style: S.td }, fmtCount(group.likeMedian)),
                h('td', { style: S.td }, fmtPercent(group.interactionRate)),
                h('td', { style: S.td }, typeof group.commentLikeRatio === 'number' ? String(group.commentLikeRatio) : '—'),
              ),
            ),
          ),
        ),
      );
    }

    function Posts({ posts }) {
      if (posts.length === 0) {
        return h('div', { style: S.muted }, '台账还是空的。在对话里让 agent 用 media 工具 add_post 记一条作品，这里就会出现。');
      }
      const head = ['日期', '平台', '类型', '标题', '播放', '赞', '评', '转', '藏', 'T+'];
      return h(
        'table',
        { style: S.table },
        h('thead', null, h('tr', null, head.map((t) => h('th', { key: t, style: S.th }, t)))),
        h(
          'tbody',
          null,
          posts.map((post) =>
            h(
              'tr',
              { key: post.id },
              h('td', { style: { ...S.td, whiteSpace: 'nowrap' } }, post.date || '—'),
              h('td', { style: { ...S.td, whiteSpace: 'nowrap' } }, post.platform || '—'),
              h('td', { style: { ...S.td, whiteSpace: 'nowrap' } }, post.kind),
              h('td', { style: S.td }, post.title || h('span', { style: S.muted }, '（无标题）')),
              h('td', { style: S.td }, post.hasData ? fmtCount(post.play) : h('span', { style: S.muted }, '未报数')),
              h('td', { style: S.td }, fmtCount(post.like)),
              h('td', { style: S.td }, fmtCount(post.comment)),
              h('td', { style: S.td }, fmtCount(post.share)),
              h('td', { style: S.td }, fmtCount(post.collect)),
              h('td', { style: S.td }, fmtAge(post.tPlusHours)),
            ),
          ),
        ),
      );
    }

    function PanelPage() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '', busy: false });

      const load = React.useCallback(async () => {
        setState((prev) => ({ ...prev, phase: prev.data ? 'ready' : 'loading', error: '' }));
        try {
          const response = await fetch(bridgeUrl('state'), { headers: { accept: 'application/json' } });
          const body = await response.json();
          if (!body || body.ok !== true) throw new Error((body && body.error) || `HTTP ${response.status}`);
          setState({ phase: 'ready', data: body, error: '', busy: false });
          setSidebarVisibility(body.sidebar !== false);
        } catch (error) {
          setState({ phase: 'error', data: null, error: String((error && error.message) || error), busy: false });
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const response = await fetch(bridgeUrl('state'), { headers: { accept: 'application/json' } });
            const body = await response.json();
            if (!alive) return;
            if (!body || body.ok !== true) throw new Error((body && body.error) || `HTTP ${response.status}`);
            setState({ phase: 'ready', data: body, error: '', busy: false });
            setSidebarVisibility(body.sidebar !== false);
          } catch (error) {
            if (alive) setState({ phase: 'error', data: null, error: String((error && error.message) || error), busy: false });
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      const toggle = async (next) => {
        setState((prev) => ({ ...prev, busy: true }));
        try {
          const response = await fetch(bridgeUrl('sidebar'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value: next }),
          });
          const body = await response.json();
          if (!body || body.ok !== true) throw new Error((body && body.error) || `HTTP ${response.status}`);
          setSidebarVisibility(next);
          setState((prev) => ({ ...prev, busy: false, error: '', data: prev.data ? { ...prev.data, sidebar: next } : prev.data }));
        } catch (error) {
          setState((prev) => ({ ...prev, busy: false, error: `开关没保存：${String((error && error.message) || error)}` }));
        }
      };

      const data = state.data;
      const sidebarOn = data ? data.sidebar !== false : true;

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, '自媒体台账'),
          h('span', { style: { ...S.muted, fontSize: 12 } }, data ? `${data.posts.length} 条 · ${data.report.groupBy === 'kind' ? '按类型' : '按平台'}复盘` : ''),
          h('span', { style: S.spacer }),
          h(Toggle, { checked: sidebarOn, disabled: state.busy, label: '在左侧栏显示', onChange: toggle }),
          h('button', { type: 'button', style: S.btn, onClick: load, disabled: state.phase === 'loading' }, '刷新'),
        ),
        state.error ? h('div', { style: { ...S.warn, borderColor: 'rgba(220,80,80,0.5)' } }, state.error) : null,
        state.phase === 'loading' ? h('div', { style: S.muted }, '读取台账…') : null,
        data
          ? h(
              React.Fragment,
              null,
              data.report.warnings && data.report.warnings.length > 0
                ? h('div', { style: S.warn }, data.report.warnings.map((text, index) => h('div', { key: index }, `· ${text}`)))
                : null,
              h(Summary, { report: data.report }),
              h(Groups, { report: data.report }),
              h(Posts, { posts: data.posts }),
              h(
                'div',
                { style: { ...S.muted, fontSize: 12, marginTop: 14 } },
                `台账目录：${data.dataDir}`,
                data.errors && data.errors.length > 0 ? ` · 坏行 ${data.errors.length} 条（见 media list 的输出）` : '',
                sidebarOn ? '' : ' · 左侧栏入口已隐藏，用命令面板里的「自媒体台账」可以重新显示',
              ),
            )
          : null,
      );
    }

    // ---- 侧栏入口的注册 / 注销 --------------------------------------------------
    // 客户端 apply 拿不到 Host 的 config，所以先无脑注册，再由 bridge 的 state 把真相纠回来；
    // 关掉开关时用 register 返回的幂等 disposer 把图标摘掉（刷新页面后仍按配置决定）。
    let pluginCtx = null;
    let wantSidebar = true;
    let sidebarDisposers = [];

    function registerSidebar() {
      if (!pluginCtx || sidebarDisposers.length > 0) return;
      pluginCtx.slots.inject('sidebar.panellist', () => {
        if (!wantSidebar) return undefined;
        const dispose = pluginCtx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '自媒体台账' },
          PanelIcon,
        );
        sidebarDisposers.push(dispose);
        return () => {
          sidebarDisposers = sidebarDisposers.filter((item) => item !== dispose);
          dispose();
        };
      });
    }

    function setSidebarVisibility(visible) {
      wantSidebar = visible !== false;
      if (wantSidebar) {
        registerSidebar();
        return;
      }
      const pending = sidebarDisposers;
      sidebarDisposers = [];
      for (const dispose of pending) {
        try {
          dispose();
        } catch {
          // 图标已经没了就不算失败
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx;
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage),
        );
        registerSidebar();

        // 命令面板里的开关：侧栏图标被隐藏后，这是唯一能把它叫回来的入口。
        ctx.inject(['commandUi'], (sctx) => {
          const command = sctx.get('commandUi');
          sctx.effect(() => {
            return command.register({
              name: 'media-ledger-sidebar',
              description: () => '自媒体台账：在左侧栏显示或隐藏',
              available: () => true,
              ui: {
                kind: 'popupSelect',
                options: async () => [
                  { id: 'show', label: '在左侧栏显示「自媒体台账」' },
                  { id: 'hide', label: '从左侧栏隐藏「自媒体台账」' },
                ],
                onSelect: async (option) => {
                  const next = option.id === 'show';
                  try {
                    const response = await fetch(bridgeUrl('sidebar'), {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ value: next }),
                    });
                    const body = await response.json();
                    if (body && body.ok === true) setSidebarVisibility(next);
                  } catch {
                    // 命令面板没有地方显示错误，失败就保持原状
                  }
                },
              },
            });
          }, 'media-ledger: sidebar command');
        });
      },
    };
  },
});
