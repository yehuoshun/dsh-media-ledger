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
    // 账号名由用户填（默认 main），凭据落成 config/<平台>_<账号>.txt——这份命名约定与
    // lib/bindings.js、scripts/*.py 共用。校验规则跟着采集脚本走：三个脚本的 argparse
    // 都只收 ^[A-Za-z0-9_-]{1,32}$（bili_sync.py:99 / douyin_sync.py:118 / xhs_sync.py:119），
    // 中文别名在脚本那一侧就不接受，面板也不放行。
    const DEFAULT_LOGIN_ACCOUNT = 'main';
    const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
    const ACCOUNT_INVALID_TEXT = '账号名只能用字母、数字、下划线、连字符（1~32 位）';
    // 左栏里「绑定侧有、台账里 0 条」的账号，行尾标签用这句（样式仍走 NavItem 的 tag）。
    const BOUND_NO_DATA_TAG = '已绑定·无数据';
    const LOGIN_POLL_MS = 2000;
    const LOGIN_RUNNING_TEXT = '已打开浏览器窗口，请在浏览器里扫码…';

    // ---- 解绑 / 采集导入 ----------------------------------------------------------
    // 两条新路由与登录共用同一份账号形状：config/<平台>_<账号>.txt（bindings.js 与 scripts/*.py 同一条约定）。
    // 解绑按它算出要删的那两个文件；采集把它当 --account 交给脚本，跑完再把产出灌进台账。
    const FETCH_PHASES = { idle: true, running: true, done: true, failed: true };
    const FETCH_RUNNING_TEXT = '正在采集：脚本在后台抓数据，跑完会自动灌进台账';
    // 日志尾部上限：Host 已经截过一次，这里再截一次只是兜底，别让一段输出把面板撑爆
    const FETCH_LOG_LIMIT = 2000;
    // Host 的错误码 → 人话。Host 给了中文 error 就用它的，这里只兜「它没说」的那几种
    const FETCH_CODE_TEXT = {
      'no-credential': '这个账号还没有凭据：先扫码登录一次，再采集',
      busy: '已经有一个任务在跑了，等它结束再点一次',
      'no-collector': '这个平台还没有采集脚本，只能手工记账',
      'bad-account': ACCOUNT_INVALID_TEXT,
      'bad-platform': '不认识的平台',
    };
    const UNBIND_NO_FILE_TEXT = '（凭据文件本来就不在）';

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
      // 账号输入：登录按钮旁边那个小框（默认 main，可改成第二个号的别名）
      accountBox: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      accountRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      accountLabel: { fontSize: 12, opacity: 0.62, whiteSpace: 'nowrap' },
      accountInput: {
        font: 'inherit',
        width: 132,
        padding: '3px 8px',
        borderRadius: 7,
        border: '1px solid rgba(128,128,128,0.32)',
        background: 'transparent',
        color: 'inherit',
      },
      accountInputBad: { borderColor: 'rgba(220,80,80,0.65)' },
      accountChips: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      accountChipLabel: { fontSize: 11, opacity: 0.55 },
      accountChip: {
        font: 'inherit',
        fontSize: 11,
        lineHeight: 1.7,
        padding: '0 6px',
        borderRadius: 5,
        border: '1px solid rgba(128,128,128,0.3)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      accountChipActive: { borderColor: 'rgba(70,150,255,0.55)', opacity: 0.95 },
      accountError: { fontSize: 12, color: 'rgba(220,80,80,0.95)' },
      // 解绑 / 采集导入：全是行内控件，不弹窗（window.confirm 会把 React 的状态拍平，也挡不住误触）
      actionBar: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 12,
        fontSize: 12,
      },
      acctList: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
      acctBlock: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      acctRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      acctName: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      btnSm: {
        font: 'inherit',
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 7,
        border: '1px solid rgba(128,128,128,0.32)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      btnDanger: { borderColor: 'rgba(220,80,80,0.55)' },
      fetchBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        border: '1px solid rgba(128,128,128,0.24)',
        borderRadius: 7,
        padding: '5px 8px',
        fontSize: 12,
      },
      confirmBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        border: '1px solid rgba(220,80,80,0.5)',
        borderRadius: 8,
        padding: '9px 11px',
        marginBottom: 12,
        fontSize: 12,
      },
      confirmTitle: { fontWeight: 600 },
      confirmFiles: { opacity: 0.78, wordBreak: 'break-all' },
      okBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: '1px solid rgba(60,170,110,0.55)',
        borderRadius: 8,
        padding: '6px 10px',
        marginBottom: 12,
        fontSize: 12,
      },
      navRow: { display: 'flex', alignItems: 'center', gap: 4 },
      navAction: {
        flex: 'none',
        font: 'inherit',
        fontSize: 10,
        padding: '0 4px',
        borderRadius: 4,
        border: '1px solid rgba(128,128,128,0.3)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.8,
      },
      chipGroup: { display: 'inline-flex', alignItems: 'center', gap: 2 },
      chipOff: {
        font: 'inherit',
        fontSize: 11,
        lineHeight: 1.4,
        padding: '0 3px',
        borderRadius: 4,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.6,
      },
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
    function NavItem({ label, count, tag, tagTone, active, indent, style, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          'aria-current': active ? 'true' : undefined,
          style: { ...S.navItem, ...(indent ? S.navItemIndent : null), ...(active ? S.navItemActive : null), ...(style || null) },
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
    /**
     * 凭据落点：和 `lib/bindings.js` / `scripts/*.py` 共用同一份命名（config/<平台>_<账号>.txt）。
     *
     * 账号跟着**这次登录**走，只有没给（或给空）时才退回默认 main——写死的话，第二个号
     * 登录成功的文案会指着第一个号的文件名说话。
     */
    function credentialName(platform, account) {
      const name = typeof account === 'string' && account ? account : DEFAULT_LOGIN_ACCOUNT;
      return `config/${platform}_${name}.txt`;
    }

    /** 这个平台有没有采集脚本：视频号是 status: 'no-collector'、script 为空，只能手工记账。 */
    function hasCollector(binding) {
      if (!binding) return false;
      if (binding.status === 'no-collector') return false;
      return typeof binding.script === 'string' && binding.script.length > 0;
    }

    /**
     * 身份旁路文件名：bilibili_main.txt → bilibili_main.identity.json。
     *
     * 与 lib/bindings.js 的 identityFileOf 同一条口径——解绑时得把它一起说清楚；
     * 但浏览器 bundle 不能 import Host 模块，只能照着规则再算一遍。
     */
    function identityFileName(credentialFile) {
      const text = typeof credentialFile === 'string' ? credentialFile.trim() : '';
      if (!text.toLowerCase().endsWith('.txt')) return '';
      return text.slice(0, -4) + '.identity.json';
    }

    /**
     * 解绑会删哪几个文件（相对 config/）：凭据那一份恒在；
     * 身份旁路只有 Host 真扫到了（credential.identity 非空）才说——不然就是在吓人。
     */
    function unbindFiles(credential) {
      const file = credential && typeof credential.file === 'string' ? credential.file : '';
      if (!file) return [];
      const files = ['config/' + file];
      const identity = credential && credential.identity ? identityFileName(file) : '';
      if (identity) files.push('config/' + identity);
      return files;
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
        account: typeof source.account === 'string' && source.account ? source.account : DEFAULT_LOGIN_ACCOUNT,
        startedAt: typeof source.startedAt === 'number' ? source.startedAt : null,
        finishedAt: typeof source.finishedAt === 'number' ? source.finishedAt : null,
        message: typeof source.message === 'string' ? source.message : '',
        exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
        log: typeof source.log === 'string' ? source.log : '',
      };
    }

    /** counts 三件套：缺字段按 0 算。Host 只在真跑完时给，null 就是「没有数」（不是 0 条）。 */
    function normalizeCounts(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      return { created: num(raw.created), updated: num(raw.updated), skipped: num(raw.skipped) };
    }

    /**
     * 把 Host 的 fetch 对象收敛成面板认得的形状。
     *
     * 与 normalizeLogin 同一套兜底：契约只保证字段名，idle 时 startedAt / counts 是 null，
     * 失败时 log 可能是空串——逐字段兜住，不让 UI 崩在 undefined 上。
     */
    function normalizeFetch(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const phase = FETCH_PHASES[source.phase] ? source.phase : 'idle';
      return {
        phase,
        platform: typeof source.platform === 'string' ? source.platform : '',
        account: typeof source.account === 'string' ? source.account : '',
        startedAt: typeof source.startedAt === 'number' ? source.startedAt : null,
        finishedAt: typeof source.finishedAt === 'number' ? source.finishedAt : null,
        message: typeof source.message === 'string' ? source.message : '',
        exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
        log: typeof source.log === 'string' ? source.log : '',
        counts: normalizeCounts(source.counts),
      };
    }

    /** 日志最后一行：Host 没给 message 时，至少把脚本最后那句话摆出来。 */
    function lastLogLine(log) {
      const lines = String(log || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return lines.length > 0 ? lines[lines.length - 1] : '';
    }

    /** 采集结果一句话：数字全来自 Host 的 counts，面板不自己数。 */
    function fetchSummary(job) {
      const counts = job && job.counts ? job.counts : null;
      if (!counts) return '已导入 0 条（新增 0 / 更新 0）';
      const total = counts.created + counts.updated;
      const skipped = counts.skipped > 0 ? '，跳过 ' + String(counts.skipped) + ' 条' : '';
      return '已导入 ' + String(total) + ' 条（新增 ' + String(counts.created) + ' / 更新 ' + String(counts.updated) + '）' + skipped;
    }

    /** 采集状态行文案：跑着说在跑，跑完报数，失败给最后一行错误。 */
    function fetchMessage(job) {
      if (!job) return '';
      if (job.phase === 'running') return job.message || FETCH_RUNNING_TEXT;
      if (job.phase === 'done') {
        const summary = fetchSummary(job);
        return job.message && job.message !== summary ? summary + ' · ' + job.message : summary;
      }
      if (job.phase === 'failed') return job.message || lastLogLine(job.log) || '采集失败，展开下面的输出看看';
      return '';
    }

    /** 状态行文案：Host 给了中文就用它的，没给就按 phase 兜一句——文案不许空着。 */
    function loginMessage(login) {
      if (!login) return '';
      if (login.message) return login.message;
      const account = typeof login.account === 'string' ? login.account : '';
      if (login.phase === 'running') return LOGIN_RUNNING_TEXT;
      if (login.phase === 'done') return `已保存凭据：${credentialName(login.platform, account)}`;
      if (login.phase === 'failed') return `账号 ${account || '（未知）'} 登录失败：采集脚本没跑通，展开下面的输出看看`;
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
      const account = typeof login.account === 'string' ? login.account : '';
      return h(
        'div',
        { style: { ...S.loginBar, ...(running ? S.loginBarRunning : failed ? S.loginBarFail : S.loginBarDone) } },
        // 有多个号时，「成功 / 失败」必须说清是哪一个——否则用户不知道谁被写进了 config/
        account ? h('span', { style: { ...S.loginMeta, flex: 'none' } }, `账号 ${account}`) : null,
        h('span', { style: S.loginText }, loginMessage(login)),
        running
          ? h('span', { style: S.loginMeta }, '每 2 秒查一次…')
          : h(
              'button',
              // 重试用**这次任务自己的**账号，不用输入框当前值：框里可能已经被改成别的号了
              { type: 'button', style: S.btn, onClick: () => (onStart ? onStart(login.platform, account) : null) },
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
     * 扫码登录控件：账号输入框 + 校验红字 + 已绑定账号的快捷标签 + 按钮。
     *
     * 账号从「写死 main」改成「默认 main、可改」，是因为两个号的用户要从面板登第二个；
     * 但快捷标签只从 `bindings.platforms[].credentials[]` 来（= config/ 里真有的文件），
     * 新号第一次登录仍然只能手填——面板不去猜用户有几个号。
     *
     * 输入非法时**只**标红、不发请求：Host 侧还有一道 `sanitizeAccount`，这里先挡住是为了
     * 让用户当场看到原因，而不是等一次 HTTP 往返再读一段错误。
     */
    function LoginControl({ platform, login, value, error, bound, unameOf, onChange, onStart, busy, onUnbind }) {
      const running = Boolean(login && login.phase === 'running');
      // 另一条任务（采集）在跑时也别让用户点登录：Host 只会回 busy，不如当场灰掉
      const blocked = Boolean(running || busy);
      const quick = Array.isArray(bound) ? bound.filter((name) => typeof name === 'string' && name) : [];
      const text = typeof value === 'string' ? value : '';
      return h(
        'div',
        { style: S.accountBox },
        h(
          'div',
          { style: S.accountRow },
          h('span', { style: S.accountLabel }, '账号'),
          h('input', {
            type: 'text',
            value: text,
            placeholder: DEFAULT_LOGIN_ACCOUNT,
            'aria-label': '登录账号名',
            'aria-invalid': error ? 'true' : undefined,
            autoComplete: 'off',
            spellCheck: false,
            disabled: blocked,
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              // 回车＝点按钮：一定要把**框里当前的值**传出去，不能只传平台
              if (event.key === 'Enter') onStart(platform, text);
            },
            style: { ...S.accountInput, ...(error ? S.accountInputBad : null) },
          }),
          h(
            'button',
            { type: 'button', style: S.btn, disabled: blocked, onClick: () => onStart(platform, text) },
            running ? '等待扫码…' : '扫码登录',
          ),
        ),
        quick.length > 0
          ? h(
              'div',
              { style: S.accountChips },
              h('span', { style: S.accountChipLabel }, '已绑定：'),
              quick.map((name) => {
                const uname = typeof unameOf === 'function' ? unameOf(name) : '';
                return h(
                  'span',
                  { key: name, style: S.chipGroup },
                  h(
                    'button',
                    {
                      type: 'button',
                      // 鼠标悬停才需要那么细：标签本身还是别名，昵称挂在 title 里
                      title: uname ? '填入 ' + name + '（' + uname + '）' : '填入 ' + name,
                      style: { ...S.accountChip, ...(name === text ? S.accountChipActive : null) },
                      onClick: () => onChange(name),
                    },
                    name,
                  ),
                  // 快捷标签行的解绑入口：点一下进右栏顶部的二次确认，不会直接删文件
                  typeof onUnbind === 'function'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          style: S.chipOff,
                          disabled: Boolean(busy),
                          title: '解绑 ' + name + '（只删凭据，台账不动）',
                          'aria-label': '解绑 ' + name,
                          onClick: () => onUnbind(platform, name),
                        },
                        '×',
                      )
                    : null,
                );
              }),
            )
          : null,
        error ? h('div', { style: S.accountError }, error) : null,
        h('div', { style: S.loginMeta }, `凭据会写入 ${credentialName(platform, text)}`),
      );
    }

    /**
     * 空态：先说清**为什么**空（没绑定？没采集？只是没数据？），再给下一步该敲什么。
     *
     * `binding` 来自 Host 的 `readPanel`——它只读 `config/` 的文件名与时间，不碰凭据内容。
     * `platform` 是当前切片解析出来的平台：登录按钮只在这个平台上出现，
     * 视频号那种没有采集脚本的，按钮换成一句「只能手工记账」。
     * `loginForm` 是上层（PanelPage）那一份账号输入状态：顶部提示条与这里共用同一个值，
     * 否则同一个平台会有两个框、各自填各自的号。
     */
    function EmptyState({ binding, platform, login, onStart, loginForm, actions }) {
      const title = binding ? binding.statusText : '';
      const steps = binding && Array.isArray(binding.steps) ? binding.steps : [];
      const collector = hasCollector(binding);
      const mine = login && platform && login.platform === platform ? login : null;
      // 已绑定账号（有凭据）：空态里直接给「采集并导入 / 解绑」，别让用户为了找按钮再点去别处
      const boundRows = actions && platform && actions.platform === platform && Array.isArray(actions.credentials) ? actions.credentials : [];
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
                { style: { marginTop: 10 } },
                boundRows.length > 0
                  ? h(
                      'div',
                      { style: { marginBottom: 10 } },
                      h('div', { style: S.loginMeta }, '已绑定账号：采集并导入，或者解绑这个号（台账里的作品不会删）'),
                      h(AccountRows, {
                        platform,
                        credentials: boundRows,
                        unameOf: actions.unameOf,
                        busy: actions.busy,
                        job: actions.job,
                        onFetch: actions.onFetch,
                        onUnbind: actions.onUnbind,
                      }),
                    )
                  : null,
                h(LoginControl, {
                  platform,
                  login: mine,
                  value: loginForm ? loginForm.value : DEFAULT_LOGIN_ACCOUNT,
                  error: loginForm ? loginForm.error : '',
                  bound: loginForm && loginForm.bound ? loginForm.bound : [],
                  unameOf: loginForm && loginForm.unameOf ? loginForm.unameOf : null,
                  onChange: loginForm ? loginForm.onChange : () => null,
                  onStart: loginForm ? loginForm.onStart : () => null,
                  busy: actions ? actions.busy : false,
                  onUnbind: actions ? actions.onUnbind : null,
                }),
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
    function LedgerView({ report, posts, slice, binding, platforms, login, onStart, loginForm, actions }) {
      if (report.total === 0) return h(EmptyState, { binding, platform: slice.platform, login, onStart, loginForm, actions });
      if (slice.kind === 'all') return h(GroupedLedger, { posts, platforms });
      return h(SlicedLedger, { posts, slice });
    }

    /** 复盘视图：摘要卡 + 分组小结 + 警告，全部跟随当前筛选。 */
    function ReviewView({ report, binding, platform, login, onStart, loginForm, actions }) {
      return h(
        React.Fragment,
        null,
        report.warnings && report.warnings.length > 0
          ? h('div', { style: S.warn }, report.warnings.map((text, index) => h('div', { key: index }, `· ${text}`)))
          : null,
        h(Summary, { report }),
        h(Groups, { report }),
        report.total === 0 ? h(EmptyState, { binding, platform, login, onStart, loginForm, actions }) : null,
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
     * 绑定侧列出的账号（`bindings.platforms[].credentials[].account`），去重、保序。
     *
     * 左栏的「已绑定·无数据」节点与登录框的快捷标签吃的是同一份——两处都从 `config/`
     * 里的文件名长出来（Host 的 `describePlatform` 已经按存储时间排过序，新的在前）。
     */
    function boundAccountNames(binding) {
      const credentials = binding && Array.isArray(binding.credentials) ? binding.credentials : [];
      const names = [];
      for (const item of credentials) {
        const name = item && typeof item.account === 'string' ? item.account.trim() : '';
        if (name && !names.includes(name)) names.push(name);
      }
      return names;
    }

    /**
     * 账号的真实身份（登录脚本写在 `<凭据>.identity.json` 里的 uname）。
     *
     * 别名（main）是我们自己起的，同名不同号时分不出来；昵称是 B站 给的，能分出来。
     * 没写身份文件的老凭据返回空串，调用方就只显示别名。
     */
    function boundAccountUname(binding, account) {
      const credentials = binding && Array.isArray(binding.credentials) ? binding.credentials : [];
      for (const item of credentials) {
        if (!item || item.account !== account) continue;
        const identity = item.identity && typeof item.identity === 'object' ? item.identity : null;
        return identity && typeof identity.uname === 'string' ? identity.uname.trim() : '';
      }
      return '';
    }

    /**
     * 左导航：视图 + 筛选。
     *
     * 平台列表吃 Host 给的 `platforms`（四个平台恒在），**不是** `facets.platforms`
     * （那只含有数据的平台）——否则台账空的时候左栏一个平台都没有，用户点不进 B站，
     * 也就看不到「为什么这里是空的」。
     */
    function SideNav({ view, slice, facets, platforms, bindings, onView, onSlice, onUnbind, busy }) {
      const listed = Array.isArray(platforms) && platforms.length > 0 ? platforms : (facets && facets.platforms) || [];
      const bindingList = bindings && Array.isArray(bindings.platforms) ? bindings.platforms : [];
      const bindingOf = (key) => bindingList.find((item) => item.key === key) || null;
      const accountsOf = (key) => {
        const found = ((facets && facets.platforms) || []).find((item) => item.key === key);
        return found && Array.isArray(found.accounts) ? found.accounts : [];
      };
      /**
       * 账号节点 = 台账里有作品的（facets）+ 已绑定但台账 0 条的（bindings）。
       *
       * 第二来源是这次补的缺口：小号刚绑上、还没采集，facets 里根本没有它，左栏就点不到，
       * 用户只能干看着。这类节点 count 记 0、行尾标「已绑定·无数据」，点进去的
       * `reports['account:<平台>|<账号>']` 由 Host 侧给一份空报告——前端不自己造报告、不自己算指标。
       */
      const accountsFor = (key) => {
        const listedAccounts = accountsOf(key);
        const known = new Set(listedAccounts.map((item) => item.key));
        const extra = boundAccountNames(bindingOf(key))
          .filter((name) => !known.has(name))
          .map((name) => {
            const uname = boundAccountUname(bindingOf(key), name);
            // 左栏是唯一能一眼看到「main 到底是哪个号」的地方：把昵称挂上去
            return { key: name, label: uname ? `${name}（${uname}）` : name, count: 0, boundOnly: true };
          });
        return listedAccounts.concat(extra);
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
            accountsFor(platform.key).length > 0
              ? accountsFor(platform.key).map((account) => {
                  const accountSlice = 'account:' + platform.key + '|' + account.key;
                  const activeAccount = slice === accountSlice;
                  // 有凭据的账号才给解绑入口；左栏只有 172px，只在选中那一行显示
                  // （右栏顶部那条操作行里每个号都有常显的入口）
                  const bound = boundAccountNames(bindingOf(platform.key)).includes(account.key);
                  return h(
                    'div',
                    { key: platform.key + '|' + account.key, style: S.navRow },
                    h(NavItem, {
                      label: account.label,
                      // 已绑定无数据的节点不报条数（行尾标签已经说了「无数据」，再挂个 0 只是噪音）
                      count: account.boundOnly ? undefined : account.count,
                      indent: true,
                      style: { flex: '1 1 auto', width: 'auto', minWidth: 0 },
                      ...(account.boundOnly ? { tag: BOUND_NO_DATA_TAG, tagTone: 'ready' } : null),
                      active: activeAccount,
                      onClick: () => onSlice(accountSlice),
                    }),
                    bound && activeAccount && typeof onUnbind === 'function'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: S.navAction,
                            disabled: Boolean(busy),
                            title: '解绑 ' + account.key + '（只删凭据，台账不动）',
                            onClick: () => onUnbind(platform.key, account.key),
                          },
                          '解绑',
                        )
                      : null,
                  );
                })
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

    /**
     * 采集状态行：跑着说在跑、跑完报数、失败把脚本输出的尾部折在 <details> 里。
     * 样式沿用登录那条状态行（同一块灰底小字，用户已经认得）。
     */
    function FetchStatus({ job }) {
      if (!job || job.phase === 'idle') return null;
      const running = job.phase === 'running';
      const failed = job.phase === 'failed';
      // Host 已经截到 2000 字符，这里再截一次只是兜底
      const log = typeof job.log === 'string' ? job.log.slice(-FETCH_LOG_LIMIT) : '';
      return h(
        'div',
        { style: { ...S.fetchBar, ...(running ? S.loginBarRunning : failed ? S.loginBarFail : S.loginBarDone) } },
        h('span', { style: S.loginText }, fetchMessage(job)),
        running ? h('span', { style: S.loginMeta }, '每 2 秒查一次…') : null,
        !running && log
          ? h(
              'details',
              { style: S.details },
              h('summary', { style: S.summary }, '采集输出（最后 2000 字符）'),
              h('div', { style: S.log }, log),
            )
          : null,
      );
    }

    /**
     * 已绑定账号的操作行：一行一个号（别名（昵称） + 「采集并导入」 + 「解绑」），
     * 下面挂这个号自己的采集状态。
     *
     * 账号名一律用**凭据别名**（bindings.credentials[].account）——它是 config/ 里那个文件名，
     * 也是脚本 --account 收的值；昵称只放在括号里给人看，绝不往请求里塞。
     */
    function AccountRows({ platform, credentials, unameOf, busy, job, onFetch, onUnbind }) {
      const list = Array.isArray(credentials) ? credentials : [];
      if (!platform) return null;
      const rows = list.filter((item) => item && typeof item.account === 'string' && item.account);
      if (rows.length === 0) return null;
      return h(
        'div',
        { style: S.acctList },
        rows.map((credential) => {
          const name = credential.account;
          const uname = typeof unameOf === 'function' ? unameOf(name) : '';
          const mine = job && job.platform === platform && job.account === name ? job : null;
          const fetching = Boolean(mine && mine.phase === 'running');
          // 防误触：登录或采集任一在跑，两个按钮都不给点
          const disabled = Boolean(busy || fetching);
          return h(
            'div',
            { key: name, style: S.acctBlock },
            h(
              'div',
              { style: S.acctRow },
              h('span', { style: S.acctName }, uname ? name + '（' + uname + '）' : name),
              h(
                'button',
                { type: 'button', style: S.btnSm, disabled, onClick: () => onFetch(platform, name) },
                fetching ? '采集中…' : '采集并导入',
              ),
              h(
                'button',
                { type: 'button', style: S.btnSm, disabled, onClick: () => onUnbind(platform, name) },
                '解绑',
              ),
            ),
            mine ? h(FetchStatus, { job: mine }) : null,
          );
        }),
      );
    }

    function PanelPage() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '', busy: false });
      const [view, setView] = React.useState('ledger');
      const [slice, setSlice] = React.useState('all');
      const parsed = parseSlice(slice);
      // 扫码登录：整页只有一份状态、一个 interval（同一时刻绝不允许两个轮询）
      const [login, setLogin] = React.useState(null);
      // 登录框里那个账号名：默认 main，用户可以改成第二个号；非法时只标红、不发请求
      const [accountDraft, setAccountDraft] = React.useState(DEFAULT_LOGIN_ACCOUNT);
      const [accountError, setAccountError] = React.useState('');
      // 采集导入：与 login 并列的第二份后台任务状态（同一时刻 Host 只会跑一个）
      const [fetchJob, setFetchJob] = React.useState(null);
      // 解绑：行内两段式确认——第一次点击只置这个 state，第二次点击才发 POST
      const [confirmUnbind, setConfirmUnbind] = React.useState(null);
      const [unbindBusy, setUnbindBusy] = React.useState(false);
      const [unbindError, setUnbindError] = React.useState('');
      const [unbindNotice, setUnbindNotice] = React.useState('');
      const pollRef = React.useRef(null);
      const fetchPollRef = React.useRef(null);
      const aliveRef = React.useRef(true);

      /** 停表：唯一的清除点，卸载 / 切切片 / 任务收尾全走这里。 */
      const stopPolling = React.useCallback(() => {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      /** 采集有自己的表：两条任务互不相干，谁在跑停谁，别把对方也掐了。 */
      const stopFetchPolling = React.useCallback(() => {
        if (fetchPollRef.current !== null) {
          clearInterval(fetchPollRef.current);
          fetchPollRef.current = null;
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
       * 每 LOGIN_POLL_MS 查一次 /fetch/state：跑着就续着，进终态就停表。
       *
       * 收尾两件事：done 时重拉一次 /state（新作品进台账、左栏数字跟着变），
       * 并把左栏切片切到这次采集的那个账号——用户点完按钮最想看到的就是那个切片。
       * 失败不切切片（没数据可看，留在原地读日志更合理）。
       */
      const startFetchPolling = React.useCallback(() => {
        stopFetchPolling();
        const timer = setInterval(async () => {
          let body = null;
          let failure = '';
          try {
            const response = await fetch(bridgeUrl('fetch/state'), { headers: { accept: 'application/json' } });
            body = await response.json();
            if (!body || body.ok !== true) failure = (body && body.error) || 'HTTP ' + response.status;
          } catch (error) {
            failure = String((error && error.message) || error);
          }
          if (!aliveRef.current) return;
          if (failure) {
            stopFetchPolling();
            setFetchJob((prev) => normalizeFetch({ ...(prev || {}), phase: 'failed', message: '查不到采集状态：' + failure }));
            return;
          }
          const next = normalizeFetch(body.fetch);
          if (next.phase === 'running') {
            setFetchJob(next);
            return;
          }
          stopFetchPolling();
          if (next.phase === 'idle') {
            // Host 那边没有任务了（插件重启过？）：说清楚，别让按钮永远停在「采集中…」
            setFetchJob(
              (prev) => normalizeFetch({ ...(prev || {}), phase: 'failed', message: '没查到采集任务（插件可能重启过），重新点一次「采集并导入」。' }),
            );
            return;
          }
          setFetchJob(next);
          load();
          if (next.phase === 'done' && next.platform && next.account) setSlice('account:' + next.platform + '|' + next.account);
        }, LOGIN_POLL_MS);
        fetchPollRef.current = timer;
      }, [stopFetchPolling, load]);

      /**
       * 点按钮：先按采集脚本那条账号正则校验，再把文案换成「已打开浏览器窗口」并发 POST；
       * Host 说失败（busy / no-collector / no-python / bad-account …）就直接显示它的中文原因，不留半吊子状态。
       *
       * 账号非法时**只**标红、一个请求都不发：Host 侧还有一道 `sanitizeAccount`，
       * 这里先拦住是为了让用户当场看到原因，而不是等一次往返再读一段错误。
       */
      const startLogin = React.useCallback(
        async (platformKey, account) => {
          if (!platformKey) return;
          // 没给账号（比如 seeding 回来的旧调用）才回落 main；给了空串就按非法处理，别偷偷登成 main
          const name = typeof account === 'string' ? account.trim() : DEFAULT_LOGIN_ACCOUNT;
          if (!ACCOUNT_PATTERN.test(name)) {
            setAccountError(ACCOUNT_INVALID_TEXT);
            return;
          }
          setAccountDraft(name);
          setAccountError('');
          stopPolling();
          setLogin(
            normalizeLogin({ phase: 'running', platform: platformKey, account: name, message: LOGIN_RUNNING_TEXT, startedAt: Date.now() }, platformKey),
          );
          let response = null;
          let body = null;
          try {
            response = await fetch(bridgeUrl('login'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ platform: platformKey, account: name }),
            });
            body = await response.json();
          } catch (error) {
            if (!aliveRef.current) return;
            setLogin(
              normalizeLogin(
                { phase: 'failed', platform: platformKey, account: name, message: `连不上本机桥：${String((error && error.message) || error)}` },
                platformKey,
              ),
            );
            return;
          }
          if (!aliveRef.current) return;
          if (!body || body.ok !== true) {
            setLogin(
              normalizeLogin(
                { phase: 'failed', platform: platformKey, account: name, message: (body && body.error) || `HTTP ${response.status}`, log: '' },
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

      /**
       * 点「采集并导入」：POST /fetch（account 用凭据别名），然后每 2 秒查一次 /fetch/state。
       *
       * 账号一律取 bindings.credentials[].account——昵称只用来显示，绝不能当参数发出去：
       * 昵称里有中文和空格，脚本那份正则第一时间就会拒。
       */
      const startFetch = async (platformKey, account) => {
        if (!platformKey) return;
        const name = typeof account === 'string' ? account.trim() : '';
        if (!name || !ACCOUNT_PATTERN.test(name)) return;
        setUnbindNotice('');
        stopFetchPolling();
        setFetchJob(
          normalizeFetch({ phase: 'running', platform: platformKey, account: name, message: FETCH_RUNNING_TEXT, startedAt: Date.now() }),
        );
        let response = null;
        let body = null;
        try {
          response = await fetch(bridgeUrl('fetch'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: platformKey, account: name }),
          });
          body = await response.json();
        } catch (error) {
          if (!aliveRef.current) return;
          setFetchJob(
            normalizeFetch({
              phase: 'failed',
              platform: platformKey,
              account: name,
              message: '连不上本机桥：' + String((error && error.message) || error),
            }),
          );
          return;
        }
        if (!aliveRef.current) return;
        if (!body || body.ok !== true) {
          const code = body && typeof body.code === 'string' ? body.code : '';
          setFetchJob(
            normalizeFetch({
              phase: 'failed',
              platform: platformKey,
              account: name,
              message: (body && body.error) || FETCH_CODE_TEXT[code] || 'HTTP ' + response.status,
            }),
          );
          return;
        }
        setFetchJob(normalizeFetch(body.fetch));
        startFetchPolling();
      };

      /** 第一下只进二次确认态：一个请求都不发，要删哪几个文件由右栏那一块说清。 */
      const askUnbind = (platformKey, account) => {
        if (!platformKey || !account) return;
        setUnbindNotice('');
        setUnbindError('');
        setConfirmUnbind({ platform: platformKey, account });
      };

      /** 第二下：真的 POST /unbind；成功后重拉 state，左栏标签自己会回到「未绑定」。 */
      const runUnbind = async () => {
        const target = confirmUnbind;
        if (!target || unbindBusy) return;
        setUnbindBusy(true);
        setUnbindError('');
        try {
          const response = await fetch(bridgeUrl('unbind'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: target.platform, account: target.account }),
          });
          const body = await response.json();
          if (!body || body.ok !== true) throw new Error((body && body.error) || 'HTTP ' + response.status);
          const removed = Array.isArray(body.removed) ? body.removed : [];
          setConfirmUnbind(null);
          setUnbindNotice(
            removed.length > 0
              ? '已解绑 ' + target.account + '（删除 ' + removed.map((name) => 'config/' + name).join('、') + '）'
              : '已解绑 ' + target.account + UNBIND_NO_FILE_TEXT,
          );
          // 当前切片正指着这个号：解绑后它会从绑定侧消失，退回平台，免得停在一个空壳切片上
          if (parsed.kind === 'account' && parsed.platform === target.platform && parsed.account === target.account) {
            setSlice('platform:' + target.platform);
          }
          await load();
        } catch (error) {
          if (!aliveRef.current) return;
          setUnbindError(String((error && error.message) || error));
        } finally {
          if (aliveRef.current) setUnbindBusy(false);
        }
      };

      // 卸载：停表，并让还在飞的 setState 自己放弃
      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          stopPolling();
          stopFetchPolling();
        };
      }, [stopPolling, stopFetchPolling]);

      // 切切片（平台 / 账号）：登录提示只属于它自己的那个平台，顺手停表，避免留下第二个轮询
      React.useEffect(() => {
        stopPolling();
        setLogin(null);
      }, [parsed.platform, stopPolling]);

      // 账号输入框跟着切片走：点到某个账号就预填它（换号不用再敲一遍），切走回到 main
      React.useEffect(() => {
        setAccountDraft(parsed.kind === 'account' && parsed.account ? parsed.account : DEFAULT_LOGIN_ACCOUNT);
        setAccountError('');
      }, [slice]);

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

      /**
       * 采集版：刷新页面 / 重进面板时，Host 那边可能还有一条采集在跑（GET /state 顶层的 fetch）。
       * 接回来接着轮询，别让用户以为任务没了又点一次（Host 只会回 busy）。
       * 终态也补一次——刷新后就看不到「已导入 N 条」太亏，那儿只有一行状态，留着不碍事。
       */
      const fetchSeededRef = React.useRef('');
      React.useEffect(() => {
        const remote = state.data && state.data.fetch ? normalizeFetch(state.data.fetch) : null;
        if (!remote || remote.phase === 'idle') return;
        if (remote.phase === 'running') {
          if (fetchJob && fetchJob.phase === 'running') return;
          const mark = 'run|' + remote.platform + '|' + remote.account + '|' + String(remote.startedAt === null ? '' : remote.startedAt);
          if (fetchSeededRef.current === mark) return;
          fetchSeededRef.current = mark;
          setFetchJob(remote);
          startFetchPolling();
          return;
        }
        if (fetchJob) return;
        const mark = remote.phase + '|' + remote.platform + '|' + remote.account + '|' + String(remote.finishedAt === null ? '' : remote.finishedAt);
        if (fetchSeededRef.current === mark) return;
        fetchSeededRef.current = mark;
        setFetchJob(remote);
      }, [state.data, fetchJob, startFetchPolling]);
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
      // 这个平台**已绑定的账号**（来自 config/ 里的文件名）：登录框的快捷标签与左栏「已绑定·无数据」节点共用这份
      const boundAccounts = boundAccountNames(binding);
      // 零凭据才叫「还没绑定」：绑了 main 但没绑小号时，不该再对用户喊「还没绑定」
      const needsBinding = Boolean(parsed.platform && binding && boundAccounts.length === 0);
      const accountValue = typeof accountDraft === 'string' ? accountDraft : DEFAULT_LOGIN_ACCOUNT;
      // 顶部提示条与空态里的登录控件共用同一份输入状态：同一个平台不能有两个各填各号的框
      const loginForm = {
        value: accountValue,
        error: accountError,
        bound: boundAccounts,
        // 别名 → 真实昵称（来自 <凭据>.identity.json）；登录框与左栏都拿这一份
        unameOf: (name) => boundAccountUname(binding, name),
        onChange: (next) => {
          setAccountDraft(next);
          if (accountError) setAccountError('');
        },
        onStart: startLogin,
      };
      // 有凭据的账号（带身份昵称）：采集 / 解绑的操作行只吃这一份，不另扫 facets
      const boundCredentials = binding && Array.isArray(binding.credentials) ? binding.credentials : [];
      // 防误触用全页面口径：login 与 fetch 任一在跑，两个新按钮都灰掉（跨平台也算）
      const remoteLogin = data ? normalizeLogin(data.login, '') : null;
      const remoteFetch = data && data.fetch ? normalizeFetch(data.fetch) : null;
      const tasksRunning = Boolean(
        (login && login.phase === 'running')
          || (fetchJob && fetchJob.phase === 'running')
          || (remoteLogin && remoteLogin.phase === 'running')
          || (remoteFetch && remoteFetch.phase === 'running'),
      );
      // 已绑定账号那一组操作：右栏顶部条与空态共用同一份（同一个号不能两处各起一个任务）
      const actions = {
        platform: parsed.platform,
        credentials: boundCredentials,
        unameOf: loginForm.unameOf,
        busy: tasksRunning,
        job: fetchJob,
        onFetch: startFetch,
        onUnbind: askUnbind,
      };
      // 二次确认要删的文件：先从 bindings 里那条凭据算（有身份旁路的平台会多一份），算不出才按命名规则兜
      const confirmCredential = (() => {
        if (!confirmUnbind) return null;
        const list = data && data.bindings && Array.isArray(data.bindings.platforms) ? data.bindings.platforms : [];
        const found = list.find((item) => item.key === confirmUnbind.platform);
        const credentials = found && Array.isArray(found.credentials) ? found.credentials : [];
        return credentials.find((item) => item && item.account === confirmUnbind.account) || null;
      })();
      const confirmFiles = confirmUnbind
        ? (() => {
            const files = unbindFiles(confirmCredential);
            return files.length > 0 ? files : [credentialName(confirmUnbind.platform, confirmUnbind.account)];
          })()
        : [];

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
                onUnbind: askUnbind,
                busy: tasksRunning,
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
                // 解绑的二次确认：全页面只有这一处，从左栏、快捷标签、操作行点进来都落到这里
                confirmUnbind
                  ? h(
                      'div',
                      { style: S.confirmBox },
                      h('div', { style: S.confirmTitle }, '确认解绑 ' + confirmUnbind.account + '？'),
                      h('div', { style: S.confirmFiles }, '将删除 ' + confirmFiles.join(' 与 ') + '（只在 config/ 目录里）。'),
                      h('div', { style: S.confirmFiles }, '台账里的作品不会删，已经导入的数据一条都不会动。'),
                      h(
                        'div',
                        { style: S.acctRow },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: { ...S.btnSm, ...S.btnDanger },
                            disabled: unbindBusy || tasksRunning,
                            onClick: runUnbind,
                          },
                          unbindBusy ? '解绑中…' : '确认解绑 ' + confirmUnbind.account + '？',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: S.btnSm,
                            disabled: unbindBusy,
                            onClick: () => {
                              setConfirmUnbind(null);
                              setUnbindError('');
                            },
                          },
                          '取消',
                        ),
                        tasksRunning ? h('span', { style: S.loginMeta }, '有任务在跑，等它结束再解绑') : null,
                      ),
                      unbindError ? h('div', { style: S.accountError }, unbindError) : null,
                    )
                  : null,
                unbindNotice ? h('div', { style: S.okBar }, h('span', { style: S.loginText }, unbindNotice)) : null,
                // 已绑定平台的操作条：采集并导入 / 解绑。没凭据的平台上没有它（那边给的是登录控件）
                collector && binding && boundCredentials.length > 0
                  ? h(
                      'div',
                      { style: S.actionBar },
                      h('span', { style: S.loginMeta }, binding.statusText),
                      h(AccountRows, {
                        platform: parsed.platform,
                        credentials: boundCredentials,
                        unameOf: loginForm.unameOf,
                        busy: tasksRunning,
                        job: fetchJob,
                        onFetch: startFetch,
                        onUnbind: askUnbind,
                      }),
                    )
                  : null,
                loginForSlice && loginForSlice.phase !== 'idle'
                  ? h(LoginStatus, { login: loginForSlice, onStart: startLogin })
                  : needsBinding
                    ? h(
                        'div',
                        { style: S.loginBar },
                        h(
                          'span',
                          { style: S.loginText },
                          // 视频号那种没有采集脚本的平台，说「还没有账号的凭据」是在骗人——它压根绑不了
                          collector
                            ? `${binding.label || platformLabel(parsed.platform)}：还没有账号的凭据`
                            : `${binding.label || platformLabel(parsed.platform)}：还没有采集脚本，只能手工记账`,
                        ),
                        collector
                          ? h(LoginControl, {
                              platform: parsed.platform,
                              login: loginForSlice,
                              value: loginForm.value,
                              error: loginForm.error,
                              bound: loginForm.bound,
                              unameOf: loginForm.unameOf,
                              onChange: loginForm.onChange,
                              onStart: loginForm.onStart,
                              busy: tasksRunning,
                              onUnbind: askUnbind,
                            })
                          : h('span', { style: S.loginMeta }, '这个平台只能在台账里手工记账'),
                      )
                    : null,
                // 登失败时把换号入口留在提示条下面：登错了号能立刻改，不用先清掉那条提示
                loginForSlice && loginForSlice.phase === 'failed' && collector
                  ? h(
                      'div',
                      { style: { ...S.loginBar, borderColor: 'rgba(220,80,80,0.45)' } },
                      h(LoginControl, {
                        platform: parsed.platform,
                        login: loginForSlice,
                        value: loginForm.value,
                        error: loginForm.error,
                        bound: loginForm.bound,
                        unameOf: loginForm.unameOf,
                        onChange: loginForm.onChange,
                        onStart: loginForm.onStart,
                        busy: tasksRunning,
                        onUnbind: askUnbind,
                      }),
                    )
                  : null,
                view === 'ledger'
                  ? h(LedgerView, {
                      report,
                      posts,
                      slice: parsed,
                      binding,
                      platforms: data.platforms,
                      login: loginForSlice,
                      onStart: startLogin,
                      loginForm,
                      actions,
                    })
                  : h(ReviewView, {
                      report,
                      binding,
                      platform: parsed.platform,
                      login: loginForSlice,
                      onStart: startLogin,
                      loginForm,
                      actions,
                    }),
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
