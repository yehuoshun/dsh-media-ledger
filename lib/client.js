/**
 * dsh-media-ledger 的左侧栏面板（浏览器侧）。
 *
 * 形态是 DSH 的 browser module loader 要求的样子：`window.__ModuleLoader__.load({ id, factory })`，
 * `id` 必须等于包名（`dsh-media-ledger`），React 只能从 `require('react')` 拿——
 * 文档明令禁止 require 任何 `@deepseek-ai/dsh-client-*` 包（宿主随时改，改了就白屏）。
 *
 * 数据从 `lib/bridge.js` 开的本机路由取，开关也写回那里；面板本身不碰文件、不碰 config。
 * 布局是「左导航 + 右内容」：左栏切换视图（台账 / 复盘）与筛选（平台 → 账号），右栏跟着变。
 * 左栏四个平台**恒在**，行尾带绑定状态（已绑定 / 未绑定 / 未接入）——没绑的平台点进去会给出
 * 「下一步敲什么」；绑定状态由 Host 扫 `config/` 的文件名与时间得出，面板看不到凭据内容。
 * 视图与筛选都是本地 state，不改 URL、不新增路由；**所有指标都由 Host 算好**（`reports[切片]`），
 * 这里只挑列、拼标签。
 * 样式全用内联 + `currentColor` / 半透明灰，浅色深色都由宿主主题带着走。
 */
window.__ModuleLoader__.load({
  id: 'dsh-media-ledger',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-media-ledger';
    const BRIDGE = 'api/dsh-media-ledger';

    // 与 lib/panel.js 的标签保持一致（客户端 bundle 不能 import Host 模块，只能各留一份）
    const PLATFORM_LABELS = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', shipinhao: '视频号' };
    const NO_PLATFORM_LABEL = '未归平台';
    const NO_ACCOUNT_LABEL = '未标账号';

    // ---- 扫码登录的常量 ----------------------------------------------------------
    // 账号固定 main：面板不放输入框（Host 契约 A），凭据落成 config/<平台>_main.txt。
    const LOGIN_ACCOUNT = 'main';
    const LOGIN_POLL_MS = 2000;
    const LOGIN_RUNNING_TEXT = '已打开浏览器窗口，请在浏览器里扫码…';

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
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        padding: '16px 20px 18px',
        fontSize: 13,
        lineHeight: 1.5,
      },
      head: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12, flex: 'none' },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      muted: { opacity: 0.62 },
      spacer: { flex: 1 },
      body: { flex: 1, minHeight: 0, display: 'flex', gap: 18 },
      nav: {
        flex: 'none',
        width: 172,
        minWidth: 132,
        overflowY: 'auto',
        paddingRight: 10,
        borderRight: '1px solid rgba(128,128,128,0.18)',
      },
      navGroup: { fontSize: 11, letterSpacing: '0.04em', opacity: 0.55, margin: '12px 0 4px' },
      navItem: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        font: 'inherit',
        padding: '5px 8px',
        marginBottom: 2,
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
      },
      navItemIndent: { paddingLeft: 18 },
      navItemActive: { background: 'rgba(128,128,128,0.16)', fontWeight: 600 },
      navBar: { position: 'absolute', left: 2, top: 6, bottom: 6, width: 2, borderRadius: 1, background: 'currentColor', opacity: 0.72 },
      navLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      navCount: { fontSize: 11, opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
      navTag: {
        flex: 'none',
        fontSize: 10,
        lineHeight: 1.6,
        padding: '0 4px',
        borderRadius: 4,
        border: '1px solid rgba(128,128,128,0.3)',
        opacity: 0.66,
        whiteSpace: 'nowrap',
      },
      navTagReady: { opacity: 0.95, borderColor: 'rgba(70,150,255,0.55)' },
      main: { flex: 1, minWidth: 0, overflowY: 'auto' },
      crumb: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
      crumbTitle: { fontSize: 15, fontWeight: 600 },
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
      section: { marginBottom: 16 },
      sectionBtn: {
        font: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '6px 8px',
        marginBottom: 6,
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.24)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
      },
      warn: {
        border: '1px solid rgba(200,150,0,0.45)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 12,
        fontSize: 12,
      },
      empty: { opacity: 0.62, padding: '18px 0' },
      emptyBox: {
        border: '1px dashed rgba(128,128,128,0.32)',
        borderRadius: 10,
        padding: '14px 16px',
        maxWidth: 640,
      },
      emptyTitle: { fontWeight: 600, marginBottom: 6 },
      steps: { margin: '4px 0 0', paddingLeft: 20 },
      stepItem: { marginBottom: 4 },
      hint: { marginTop: 10, fontSize: 12, opacity: 0.62 },
      loginRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 },
      loginBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: 8,
        padding: '7px 10px',
        marginBottom: 12,
        fontSize: 12,
      },
      loginBarRunning: { borderColor: 'rgba(70,150,255,0.5)' },
      loginBarDone: { borderColor: 'rgba(60,170,110,0.55)' },
      loginBarFail: { borderColor: 'rgba(220,80,80,0.5)' },
      loginText: { flex: 1, minWidth: 0 },
      loginMeta: { fontSize: 12, opacity: 0.62 },
      details: { width: '100%', marginTop: 2 },
      summary: { cursor: 'pointer', fontSize: 12, opacity: 0.75 },
      log: {
        marginTop: 6,
        padding: '6px 8px',
        borderRadius: 6,
        background: 'rgba(128,128,128,0.12)',
        fontSize: 11,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 180,
        overflow: 'auto',
      },
      group: { marginBottom: 18 },
      groupHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        paddingBottom: 4,
        marginBottom: 4,
        borderBottom: '1px solid rgba(128,128,128,0.2)',
      },
      groupLabel: { fontSize: 13, fontWeight: 600 },
      groupCount: { fontSize: 12, opacity: 0.62, fontVariantNumeric: 'tabular-nums' },
      foot: { marginTop: 16, fontSize: 12, opacity: 0.62 },
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

    function platformLabel(key) {
      if (!key) return NO_PLATFORM_LABEL;
      return PLATFORM_LABELS[key] || key;
    }

    /** 切片 id 的解析，和 `lib/panel.js` 的 `parseSlice` 同形。 */
    function parseSlice(id) {
      const text = typeof id === 'string' ? id : '';
      if (text.startsWith('platform:')) return { kind: 'platform', platform: text.slice('platform:'.length), account: '' };
      if (text.startsWith('account:')) {
        const rest = text.slice('account:'.length);
        const cut = rest.indexOf('|');
        if (cut >= 0) return { kind: 'account', platform: rest.slice(0, cut), account: rest.slice(cut + 1) };
      }
      return { kind: 'all', platform: '', account: '' };
    }

    function matchSlice(post, slice) {
      if (slice.kind === 'all') return true;
      const platform = String(post.platform || '').trim();
      if (platform !== slice.platform) return false;
      if (slice.kind === 'platform') return true;
      return String(post.account || '').trim() === slice.account;
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

    /**
     * 左栏的一项：选中时左侧一条竖条 + 底色，条数靠右。
     *
     * `tag` 是行尾的小字状态（已绑定 / 未绑定 / 未接入）：条数说明「有多少条」，
     * 标签说明「这条路通不通」——没绑的平台条数恒为 0，光看数字分不清是「没数据」还是「没接上」。
     */
    function NavItem({ label, count, tag, tagTone, active, indent, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          'aria-current': active ? 'true' : undefined,
          style: { ...S.navItem, ...(indent ? S.navItemIndent : null), ...(active ? S.navItemActive : null) },
        },
        active ? h('span', { style: S.navBar, 'aria-hidden': 'true' }) : null,
        h('span', { style: S.navLabel }, label),
        tag ? h('span', { style: { ...S.navTag, ...(tagTone === 'ready' ? S.navTagReady : null) } }, tag) : null,
        typeof count === 'number' ? h('span', { style: S.navCount }, String(count)) : null,
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

    const GROUP_BY_LABELS = { platform: '平台', account: '账号', kind: '类型' };

    function Groups({ report }) {
      if (!report.groups || report.groups.length === 0) return null;
      return h(
        'div',
        { style: S.section },
        h('div', { style: { ...S.cardLabel, marginBottom: 4 } }, `按${GROUP_BY_LABELS[report.groupBy] || '类型'}分组`),
        h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h('tr', null, ['分组', '条数', '播放中位数', '点赞中位数', '互动率', '评论赞比'].map((t) => h('th', { key: t, style: S.th }, t))),
          ),
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

    /** 作品表：列跟着筛选走——已经按平台筛了就不必再显示平台列。 */
    function PostTable({ posts, showPlatform, showAccount }) {
      const columns = [{ key: 'date', label: '日期', nowrap: true, render: (post) => post.date || '—' }];
      if (showPlatform) {
        columns.push({ key: 'platform', label: '平台', nowrap: true, render: (post) => platformLabel(post.platform) });
      }
      if (showAccount) {
        columns.push({
          key: 'account',
          label: '账号',
          nowrap: true,
          render: (post) => post.account || h('span', { style: S.muted }, NO_ACCOUNT_LABEL),
        });
      }
      columns.push(
        { key: 'kind', label: '类型', nowrap: true, render: (post) => post.kind },
        { key: 'title', label: '标题', render: (post) => post.title || h('span', { style: S.muted }, '（无标题）') },
        { key: 'play', label: '播放', render: (post) => (post.hasData ? fmtCount(post.play) : h('span', { style: S.muted }, '未报数')) },
        { key: 'like', label: '赞', render: (post) => fmtCount(post.like) },
        { key: 'comment', label: '评', render: (post) => fmtCount(post.comment) },
        { key: 'share', label: '转', render: (post) => fmtCount(post.share) },
        { key: 'collect', label: '藏', render: (post) => fmtCount(post.collect) },
        { key: 'tPlusHours', label: 'T+', nowrap: true, render: (post) => fmtAge(post.tPlusHours) },
      );
      return h(
        'table',
        { style: S.table },
        h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column.key, style: S.th }, column.label)))),
        h(
          'tbody',
          null,
          posts.map((post) =>
            h(
              'tr',
              { key: post.id },
              columns.map((column) =>
                h('td', { key: column.key, style: column.nowrap ? { ...S.td, whiteSpace: 'nowrap' } : S.td }, column.render(post)),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * 空态：先说清**为什么**空（没绑定？没采集？只是没数据？），再给下一步该敲什么。
     *
     * `binding` 来自 Host 的 `readPanel`——它只读 `config/` 的文件名与时间，不碰凭据内容。
     */
    /** 凭据落点：和 `lib/bindings.js` / `scripts/*.py` 共用同一份命名（config/<平台>_<账号>.txt）。 */
    function credentialName(platform) {
      return `config/${platform}_${LOGIN_ACCOUNT}.txt`;
    }

    /** 这个平台有没有采集脚本：视频号是 status: 'no-collector'、script 为空，只能手工记账。 */
    function hasCollector(binding) {
      if (!binding) return false;
      if (binding.status === 'no-collector') return false;
      return typeof binding.script === 'string' && binding.script.length > 0;
    }

    const LOGIN_PHASES = { idle: true, running: true, done: true, failed: true };

    /**
     * 把 Host 的 login 对象收敛成面板认得的形状。
     *
     * 契约只保证字段名，不保证一定给全（idle 时 startedAt 是 null、failed 时 log 可能是空串），
     * 所以这里逐字段兜底：缺了就给默认值，别让 UI 崩在 undefined 上。
     */
    function normalizeLogin(raw, platform) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const phase = LOGIN_PHASES[source.phase] ? source.phase : 'idle';
      return {
        phase,
        platform: typeof source.platform === 'string' && source.platform ? source.platform : String(platform || ''),
        account: typeof source.account === 'string' && source.account ? source.account : LOGIN_ACCOUNT,
        startedAt: typeof source.startedAt === 'number' ? source.startedAt : null,
        finishedAt: typeof source.finishedAt === 'number' ? source.finishedAt : null,
        message: typeof source.message === 'string' ? source.message : '',
        exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
        log: typeof source.log === 'string' ? source.log : '',
      };
    }

    /** 状态行文案：Host 给了中文就用它的，没给就按 phase 兜一句——文案不许空着。 */
    function loginMessage(login) {
      if (!login) return '';
      if (login.message) return login.message;
      if (login.phase === 'running') return LOGIN_RUNNING_TEXT;
      if (login.phase === 'done') return `已保存凭据：${credentialName(login.platform)}`;
      if (login.phase === 'failed') return '登录失败：采集脚本没跑通，展开下面的输出看看';
      return '';
    }

    /**
     * 登录提示：一条状态行 +（失败时）折叠起来的脚本输出尾部。
     *
     * 顶部提示条与空态共用这一份——两个入口长得一样，状态机只在上层（PanelPage）有一份。
     */
    function LoginStatus({ login, onStart }) {
      if (!login || login.phase === 'idle') return null;
      const running = login.phase === 'running';
      const failed = login.phase === 'failed';
      return h(
        'div',
        { style: { ...S.loginBar, ...(running ? S.loginBarRunning : failed ? S.loginBarFail : S.loginBarDone) } },
        h('span', { style: S.loginText }, loginMessage(login)),
        running
          ? h('span', { style: S.loginMeta }, '每 2 秒查一次…')
          : h(
              'button',
              { type: 'button', style: S.btn, onClick: () => (onStart ? onStart(login.platform) : null) },
              failed ? '重试' : '再登录一次',
            ),
        failed
          ? h(
              'details',
              { style: S.details },
              h('summary', { style: S.summary }, '脚本输出（最后 2000 字符）'),
              h('div', { style: S.log }, login.log || '（脚本没有输出）'),
            )
          : null,
      );
    }

    /**
     * 空态：先说清**为什么**空（没绑定？没采集？只是没数据？），再给下一步该敲什么。
     *
     * `binding` 来自 Host 的 `readPanel`——它只读 `config/` 的文件名与时间，不碰凭据内容。
     * `platform` 是当前切片解析出来的平台：登录按钮只在这个平台上出现，
     * 视频号那种没有采集脚本的，按钮换成一句「只能手工记账」。
     */
    function EmptyState({ binding, platform, login, onStart }) {
      const title = binding ? binding.statusText : '';
      const steps = binding && Array.isArray(binding.steps) ? binding.steps : [];
      const collector = hasCollector(binding);
      const mine = login && platform && login.platform === platform ? login : null;
      return h(
        'div',
        { style: S.emptyBox },
        h('div', { style: S.emptyTitle }, title || '这个筛选下还没有作品。'),
        steps.length > 0
          ? h('ol', { style: S.steps }, steps.map((step, index) => h('li', { key: index, style: S.stepItem }, step)))
          : null,
        platform
          ? collector
            ? h(
                'div',
                { style: S.loginRow },
                h(
                  'button',
                  { type: 'button', style: S.btn, onClick: () => onStart(platform), disabled: Boolean(mine && mine.phase === 'running') },
                  mine && mine.phase === 'running' ? '等待扫码…' : '扫码登录',
                ),
                h('span', { style: S.loginMeta }, `账号固定 ${LOGIN_ACCOUNT}，凭据会写入 ${credentialName(platform)}`),
              )
            : h('div', { style: { ...S.loginMeta, marginTop: 10 } }, `${platformLabel(platform)}还没有采集脚本，只能手工记账`)
          : null,
        mine && mine.phase !== 'idle' ? h('div', { style: { marginTop: 10 } }, h(LoginStatus, { login: mine, onStart })) : null,
        h(
          'div',
          { style: S.hint },
          '手工记一条也可以：让 agent 用 media 工具调 add_post（数据都在本地，不上传）。',
        ),
      );
    }

    /** 报过数的一堆 + 未报数的一堆（未报数单独折叠，不混排）。平铺与分段共用这一段。 */
    function PostSection({ posts, showPlatform, showAccount, emptyText }) {
      const [showNoData, setShowNoData] = React.useState(false);
      const withData = posts.filter((post) => post.hasData === true);
      const withoutData = posts.filter((post) => post.hasData !== true);
      return h(
        React.Fragment,
        null,
        withData.length > 0
          ? h(PostTable, { posts: withData, showPlatform, showAccount })
          : h('div', { style: S.empty }, emptyText),
        withoutData.length > 0
          ? h(
              'div',
              { style: { marginTop: 16 } },
              h(
                'button',
                { type: 'button', style: S.sectionBtn, onClick: () => setShowNoData(!showNoData), 'aria-expanded': showNoData ? 'true' : 'false' },
                h('span', { 'aria-hidden': 'true' }, showNoData ? '▾' : '▸'),
                h('span', null, `未报数 ${withoutData.length} 条`),
              ),
              showNoData ? h(PostTable, { posts: withoutData, showPlatform, showAccount }) : null,
            )
          : null,
      );
    }

    const NO_DATA_HINT = '这些作品都还没报数——先用 media add_metrics 补一次数据，复盘才有意义。';

    /** 切片是某平台 / 某账号：保持原来的平铺表，不加段头。 */
    function SlicedLedger({ posts, slice }) {
      const showPlatform = slice.kind === 'all';
      const showAccount = slice.kind !== 'account';
      return h(PostSection, { posts, showPlatform, showAccount, emptyText: NO_DATA_HINT });
    }

    /**
     * 「全部」切片：按 Host 给的 `platforms` 顺序一段一个平台，段头写「平台名 · N 条」。
     *
     * 两件事别做错：
     *   1. N 只是**当前 posts 里该平台的行数**，不是指标——互动率 / 中位数 / T+ 全来自 Host 的
     *      `buildReport`，这里一个都不算；
     *   2. 0 条的段整段跳过（不渲染空表头）；老记录里没有平台的落到「未归平台」一段，
     *      不能因为分段就把它们从表里丢掉（左栏那个「未归平台」节点点的就是这批）。
     */
    function GroupedLedger({ posts, platforms }) {
      const list = Array.isArray(platforms) ? platforms : [];
      const groups = list.map((platform) => ({ key: platform.key, label: platform.label, rows: [] }));
      const byKey = new Map(groups.map((group) => [group.key, group]));
      const unassigned = [];
      for (const post of posts) {
        const key = String(post.platform || '').trim();
        const group = byKey.get(key);
        if (group) group.rows.push(post);
        else unassigned.push(post);
      }
      if (unassigned.length > 0) groups.push({ key: '', label: NO_PLATFORM_LABEL, rows: unassigned });
      const visible = groups.filter((group) => group.rows.length > 0);
      if (visible.length === 0) return h('div', { style: S.empty }, '这个筛选下还没有作品。');
      return h(
        React.Fragment,
        null,
        visible.map((group) =>
          h(
            'div',
            { key: group.key || '__unassigned', style: S.group },
            h(
              'div',
              { style: S.groupHead },
              h('span', { style: S.groupLabel }, group.label),
              h('span', { style: S.groupCount }, `· ${group.rows.length} 条`),
            ),
            h(PostSection, {
              posts: group.rows,
              // 已经分段了，段内不再显示平台列；账号列照旧
              showPlatform: false,
              showAccount: true,
              emptyText: `${group.label}的作品都还没报数——先用 media add_metrics 补一次数据，复盘才有意义。`,
            }),
          ),
        ),
      );
    }

    /**
     * 台账视图：「全部」按平台分段，某平台 / 某账号切片保持平铺。
     * 分组只做展示分流，不改任何口径。
     */
    function LedgerView({ report, posts, slice, binding, platforms, login, onStart }) {
      if (report.total === 0) return h(EmptyState, { binding, platform: slice.platform, login, onStart });
      if (slice.kind === 'all') return h(GroupedLedger, { posts, platforms });
      return h(SlicedLedger, { posts, slice });
    }

    /** 复盘视图：摘要卡 + 分组小结 + 警告，全部跟随当前筛选。 */
    function ReviewView({ report, binding, platform, login, onStart }) {
      return h(
        React.Fragment,
        null,
        report.warnings && report.warnings.length > 0
          ? h('div', { style: S.warn }, report.warnings.map((text, index) => h('div', { key: index }, `· ${text}`)))
          : null,
        h(Summary, { report }),
        h(Groups, { report }),
        report.total === 0 ? h(EmptyState, { binding, platform, login, onStart }) : null,
      );
    }

    function sliceTitle(slice, facets) {
      if (slice.kind === 'all') return '全部';
      const platform = facets && facets.platforms ? facets.platforms.find((item) => item.key === slice.platform) : null;
      const platformText = platform ? platform.label : platformLabel(slice.platform);
      if (slice.kind === 'account') return `${platformText} · ${slice.account || NO_ACCOUNT_LABEL}`;
      return platformText;
    }

    /** 绑定状态 → 行尾标签；认不出的状态就不显示，别自己编一个。 */
    function bindingTag(binding) {
      if (!binding) return {};
      if (binding.status === 'ready') return { tag: '已绑定', tagTone: 'ready' };
      if (binding.status === 'unbound') return { tag: '未绑定' };
      if (binding.status === 'no-collector') return { tag: '未接入' };
      return {};
    }

    /**
     * 左导航：视图 + 筛选。
     *
     * 平台列表吃 Host 给的 `platforms`（四个平台恒在），**不是** `facets.platforms`
     * （那只含有数据的平台）——否则台账空的时候左栏一个平台都没有，用户点不进 B站，
     * 也就看不到「为什么这里是空的」。
     */
    function SideNav({ view, slice, facets, platforms, bindings, onView, onSlice }) {
      const listed = Array.isArray(platforms) && platforms.length > 0 ? platforms : (facets && facets.platforms) || [];
      const bindingList = bindings && Array.isArray(bindings.platforms) ? bindings.platforms : [];
      const bindingOf = (key) => bindingList.find((item) => item.key === key) || null;
      const accountsOf = (key) => {
        const found = ((facets && facets.platforms) || []).find((item) => item.key === key);
        return found && Array.isArray(found.accounts) ? found.accounts : [];
      };
      const unassigned = (facets && facets.unassigned) || 0;
      const total = (facets && facets.total) || 0;
      return h(
        'nav',
        { style: S.nav, 'aria-label': '台账导航' },
        h('div', { style: { ...S.navGroup, marginTop: 0 } }, '视图'),
        h(NavItem, { label: '台账', active: view === 'ledger', onClick: () => onView('ledger') }),
        h(NavItem, { label: '复盘', active: view === 'review', onClick: () => onView('review') }),
        h('div', { style: S.navGroup }, '筛选'),
        h(NavItem, { label: '全部', count: total, active: slice === 'all', onClick: () => onSlice('all') }),
        listed.map((platform) =>
          h(
            React.Fragment,
            { key: platform.key },
            h(NavItem, {
              label: platform.label,
              count: platform.count,
              ...bindingTag(bindingOf(platform.key)),
              active: slice === `platform:${platform.key}`,
              onClick: () => onSlice(`platform:${platform.key}`),
            }),
            accountsOf(platform.key).length > 0
              ? accountsOf(platform.key).map((account) =>
                  h(NavItem, {
                    key: `${platform.key}|${account.key}`,
                    label: account.label,
                    count: account.count,
                    indent: true,
                    active: slice === `account:${platform.key}|${account.key}`,
                    onClick: () => onSlice(`account:${platform.key}|${account.key}`),
                  }),
                )
              : null,
          ),
        ),
        unassigned > 0
          ? h(NavItem, {
              label: NO_PLATFORM_LABEL,
              count: unassigned,
              active: slice === 'platform:',
              onClick: () => onSlice('platform:'),
            })
          : null,
      );
    }

    function PanelPage() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '', busy: false });
      const [view, setView] = React.useState('ledger');
      const [slice, setSlice] = React.useState('all');
      const parsed = parseSlice(slice);
      // 扫码登录：整页只有一份状态、一个 interval（同一时刻绝不允许两个轮询）
      const [login, setLogin] = React.useState(null);
      const pollRef = React.useRef(null);
      const aliveRef = React.useRef(true);

      /** 停表：唯一的清除点，卸载 / 切切片 / 任务收尾全走这里。 */
      const stopPolling = React.useCallback(() => {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      const load = React.useCallback(async () => {
        setState((prev) => ({ ...prev, phase: prev.data ? 'ready' : 'loading', error: '' }));
        try {
          const response = await fetch(bridgeUrl('state'), { headers: { accept: 'application/json' } });
          const body = await response.json();
          if (!body || body.ok !== true) throw new Error((body && body.error) || `HTTP ${response.status}`);
          setState({ phase: 'ready', data: body, error: '', busy: false });
          setSidebarVisibility(body.sidebar !== false);
        } catch (error) {
          setState((prev) => ({ ...prev, phase: 'error', data: null, error: String((error && error.message) || error), busy: false }));
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

      /**
       * 每 `LOGIN_POLL_MS` 查一次 Host 的 `/login/state`；跑到 done/failed 就停表。
       * done 顺手重拉一次台账，让左栏标签跟着变「已绑定」。
       */
      const startPolling = React.useCallback(
        (platformKey) => {
          stopPolling();
          const timer = setInterval(async () => {
            let body = null;
            let failure = '';
            try {
              const response = await fetch(bridgeUrl('login/state'), { headers: { accept: 'application/json' } });
              body = await response.json();
              if (!body || body.ok !== true) failure = (body && body.error) || `HTTP ${response.status}`;
            } catch (error) {
              failure = String((error && error.message) || error);
            }
            if (!aliveRef.current) return;
            if (failure) {
              stopPolling();
              setLogin((prev) => normalizeLogin({ ...(prev || {}), phase: 'failed', message: `查不到登录状态：${failure}` }, platformKey));
              return;
            }
            const next = normalizeLogin(body.login, platformKey);
            if (next.phase === 'running') {
              setLogin(next);
              return;
            }
            stopPolling();
            if (next.phase === 'done') {
              setLogin(next);
              load();
              return;
            }
            if (next.phase === 'failed') {
              setLogin(next);
              return;
            }
            // idle：Host 那边没有任务了（插件重启过？），给一句人话，别停在「等待扫码」
            setLogin({ ...next, phase: 'failed', message: '没查到登录任务（插件可能重启过），重新点一次「扫码登录」。' });
          }, LOGIN_POLL_MS);
          pollRef.current = timer;
        },
        [stopPolling, load],
      );

      /**
       * 点按钮：先把文案换成「已打开浏览器窗口」，再发 POST；
       * Host 说失败（busy / no-collector / no-python …）就直接显示它的中文原因，不留半吊子状态。
       */
      const startLogin = React.useCallback(
        async (platformKey) => {
          if (!platformKey) return;
          stopPolling();
          setLogin(normalizeLogin({ phase: 'running', platform: platformKey, message: LOGIN_RUNNING_TEXT, startedAt: Date.now() }, platformKey));
          let response = null;
          let body = null;
          try {
            response = await fetch(bridgeUrl('login'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ platform: platformKey, account: LOGIN_ACCOUNT }),
            });
            body = await response.json();
          } catch (error) {
            if (!aliveRef.current) return;
            setLogin(normalizeLogin({ phase: 'failed', platform: platformKey, message: `连不上本机桥：${String((error && error.message) || error)}` }, platformKey));
            return;
          }
          if (!aliveRef.current) return;
          if (!body || body.ok !== true) {
            setLogin(
              normalizeLogin(
                { phase: 'failed', platform: platformKey, message: (body && body.error) || `HTTP ${response.status}`, log: '' },
                platformKey,
              ),
            );
            return;
          }
          // 以 Host 回的 login 为准（它带着真实 startedAt 与那句「请在浏览器里扫码」）
          setLogin(normalizeLogin(body.login, platformKey));
          startPolling(platformKey);
        },
        [startPolling, stopPolling],
      );

      // 卸载：停表，并让还在飞的 setState 自己放弃
      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          stopPolling();
        };
      }, [stopPolling]);

      // 切切片（平台 / 账号）：登录提示只属于它自己的那个平台，顺手停表，避免留下第二个轮询
      React.useEffect(() => {
        stopPolling();
        setLogin(null);
      }, [parsed.platform, stopPolling]);

      /**
       * 刷新页面 / 重进面板时，Host 那边可能还有任务在跑：GET /state 顶层的 login 就是干这个的。
       * 接回来接着轮询，别让用户以为任务没了又点一次（那样 Host 只会回 code: 'busy'）。
       * 只接 running，且同一轮任务（platform + startedAt）只接一次——否则每次 setLogin 引起的重渲染都会再起一个轮询。
       */
      const seededRef = React.useRef('');
      React.useEffect(() => {
        const remote = state.data && state.data.login ? normalizeLogin(state.data.login, parsed.platform) : null;
        if (!remote || remote.phase !== 'running') return;
        if (login && login.phase === 'running') return;
        const mark = remote.platform + '|' + String(remote.startedAt === null ? '' : remote.startedAt);
        if (seededRef.current === mark) return;
        seededRef.current = mark;
        setLogin(remote);
        startPolling(remote.platform);
      }, [state.data, login, parsed.platform, startPolling]);

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
      const reports = data && data.reports ? data.reports : null;
      const report = (reports && reports[slice]) || (data && data.report) || null;
      const posts = data && Array.isArray(data.posts) ? data.posts.filter((post) => matchSlice(post, parsed)) : [];
      // 当前切片对应的平台绑定状态；「全部」不分平台，没有单一绑定可言
      const bindingList = data && data.bindings && Array.isArray(data.bindings.platforms) ? data.bindings.platforms : [];
      const binding = parsed.kind === 'all' ? null : bindingList.find((item) => item.key === parsed.platform) || null;
      // 登录提示只跟着「自己的平台」走：切到别的切片就不再展示上一条
      const loginForSlice = login && parsed.platform && login.platform === parsed.platform ? login : null;
      const collector = hasCollector(binding);
      const needsBinding = Boolean(parsed.platform && binding && binding.status !== 'ready');

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, '自媒体台账'),
          h('span', { style: S.spacer }),
          h(Toggle, { checked: sidebarOn, disabled: state.busy, label: '在左侧栏显示', onChange: toggle }),
          h('button', { type: 'button', style: S.btn, onClick: load, disabled: state.phase === 'loading' }, '刷新'),
        ),
        state.error ? h('div', { style: { ...S.warn, borderColor: 'rgba(220,80,80,0.5)' } }, state.error) : null,
        data
          ? h(
              'div',
              { style: S.body },
              h(SideNav, {
                view,
                slice,
                facets: data.facets,
                platforms: data.platforms,
                bindings: data.bindings,
                onView: setView,
                onSlice: (next) => setSlice(next),
              }),
              h(
                'div',
                { style: S.main },
                h(
                  'div',
                  { style: S.crumb },
                  h('span', { style: S.crumbTitle }, sliceTitle(parsed, data.facets)),
                  h('span', { style: { ...S.muted, fontSize: 12 } }, `${report ? report.total : 0} 条 · ${view === 'ledger' ? '台账' : '复盘'}`),
                ),
                loginForSlice && loginForSlice.phase !== 'idle'
                  ? h(LoginStatus, { login: loginForSlice, onStart: startLogin })
                  : needsBinding
                    ? h(
                        'div',
                        { style: S.loginBar },
                        h('span', { style: S.loginText }, `${binding.label || platformLabel(parsed.platform)} 还没绑定`),
                        collector
                          ? h('button', { type: 'button', style: S.btn, onClick: () => startLogin(parsed.platform) }, '扫码登录')
                          : h('span', { style: S.loginMeta }, '还没有采集脚本，只能手工记账'),
                        collector
                          ? h('span', { style: S.loginMeta }, `账号固定 ${LOGIN_ACCOUNT} · 凭据会写入 ${credentialName(parsed.platform)}`)
                          : null,
                      )
                    : null,
                view === 'ledger'
                  ? h(LedgerView, { report, posts, slice: parsed, binding, platforms: data.platforms, login: loginForSlice, onStart: startLogin })
                  : h(ReviewView, { report, binding, platform: parsed.platform, login: loginForSlice, onStart: startLogin }),
                data.truncated
                  ? h('div', { style: { ...S.muted, fontSize: 12, marginTop: 10 } }, `还有 ${Math.max(0, data.postsTotal - data.posts.length)} 条没列出来，用 media list 看全量。`)
                  : null,
                h(
                  'div',
                  { style: S.foot },
                  `台账目录：${data.dataDir}`,
                  data.bindings && data.bindings.configDir ? ` · 凭据目录：${data.bindings.configDir}` : '',
                  data.errors && data.errors.length > 0 ? ` · 坏行 ${data.errors.length} 条（见 media list 的输出）` : '',
                  sidebarOn ? '' : ' · 左侧栏入口已隐藏，用命令面板里的「自媒体台账」可以重新显示',
                ),
              ),
            )
          : state.phase === 'loading'
            ? h('div', { style: S.muted }, '读取台账…')
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
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage));
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
