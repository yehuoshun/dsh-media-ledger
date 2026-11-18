/**
 * 面板「扫码登录」的纯函数层：认哪些平台、命令怎么拼、内部状态怎么讲成人话。
 *
 * 为什么单独成模块：登录是全插件唯一要起子进程的活（那个例外只开在 `lib/bridge.js`），
 * 但「起哪个脚本、带什么参数、状态怎么翻译」这些判断完全可以离线测——放进纯函数，
 * 冒烟测试不用真跑 python 就能守住「用户输入绝不进命令行」这条线。
 *
 * 只放纯函数：不读 fs、不读 process.env、不 spawn，那三件事全在 `lib/bridge.js`。
 * @module dsh-media-ledger/login
 */

import { COLLECTORS } from './bindings.js';
import { PLATFORMS, normalizePlatform } from './config.js';
import { platformLabel } from './panel.js';

/** 面板不放输入框，账号名固定 main；API 上照样允许别的名字（脚本支持 --account）。 */
export const LOGIN_ACCOUNT_DEFAULT = 'main';

/**
 * Host 侧等脚本退出的上限。
 *
 * 必须**大于**脚本自己等扫码的上限（B站 300s / 抖音 180s / 小红书 300s），
 * 否则用户还没扫完就被 Host 掐掉，面板只会显示「失败」，而真正的原因是面板太急。
 * 330s = 脚本最长 300s + 30s 余量（脚本还要收尾、写凭据、复核一次登录态）。
 */
export const LOGIN_TIMEOUT_MS = 330000;

/** log 只留尾部这么多字符：排错够用，又不会把整个面板状态撑爆。 */
export const LOGIN_LOG_LIMIT = 2000;

/** 账号名的唯一合法形状：字母或数字开头，之后字母数字下划线连字符，最长 32。 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * 脚本自己说过「cookie 值不会打印到终端，只打印字段名与长度」，但凭据是隐私红线：
 * 万一哪天某条日志变更把值带出来，整行丢掉，绝不写进会被面板读到的状态里。
 */
const SECRET_LINE_PATTERN = /(SESSDATA|web_session|sessionid)/i;

/** 契约里的四个阶段。外部传进来的怪值一律当 idle。 */
export const LOGIN_PHASES = ['idle', 'running', 'done', 'failed'];

/** 绝对路径形状的二维码图片（B站 login 会把二维码渲染成 PNG 并打印路径）。 */
const PNG_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\r\n"'<>|?*]*?\.png/gi;

/**
 * 登录目标：四个平台各一条，脚本路径与「有没有采集器」都从 `bindings.js` 的 COLLECTORS 来——
 * 面板空态提示的就是那张表，两处各写一份迟早会说出两个不同的脚本名。
 *
 * `xhs` 用 `scripts/xhs_sync.py`：它有 `login` 子命令且带 `--account`（默认落
 * `config/xhs_<account>.txt`）。`scripts/xhs_login.py` 没有子命令，默认还写到系统临时目录，
 * 与 `config/<平台>_<账号>.txt` 的约定对不上，所以不用它。
 */
export const LOGIN_TARGETS = Object.freeze(Object.fromEntries(PLATFORMS.map((platform) => {
  const collector = COLLECTORS[platform] || null;
  return [platform, Object.freeze({
    platform,
    label: platformLabel(platform),
    script: collector ? collector.script : '',
    hasCollector: Boolean(collector),
    prefix: collector ? collector.prefix : '',
  })];
})));

/**
 * 账号名过滤：只收 `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`，别的一律 null。
 *
 * 不做 trim、不做纠正：这个值最终会变成命令行的 `--account`，宽松一寸就是注入的入口。
 * 不合法就让调用方报 'bad-account'，而不是猜用户想写什么。
 */
export function sanitizeAccount(value) {
  if (typeof value !== 'string') return null;
  return ACCOUNT_PATTERN.test(value) ? value : null;
}

/** 凭据落盘位置（面板提示条与成功文案都照这个说）：`config/<平台>_<账号>.txt`。 */
export function credentialFile(platform, account) {
  const target = LOGIN_TARGETS[platform];
  if (!target || !target.hasCollector || !account) return '';
  return `config/${target.prefix}${account}.txt`;
}

/**
 * 把「平台 + 账号」拼成一条要跑的登录计划。
 *
 * 纯函数是刻意的：命令与参数在这里定死（`login --account <过滤后的账号>`），bridge 只负责起进程。
 * 平台先过 `normalizePlatform`（中文/简称都认），再过白名单；认不出就 'bad-platform'。
 * @returns {{ok: true, plan: {platform: string, account: string, script: string, args: string[]}} | {ok: false, code: string, error: string}}
 */
export function buildLoginPlan(platform, account) {
  const raw = typeof platform === 'string' ? platform.trim() : '';
  const key = normalizePlatform(raw) || raw;
  const target = LOGIN_TARGETS[key];
  if (!target) {
    const known = PLATFORMS.filter((item) => LOGIN_TARGETS[item].hasCollector).join(' / ');
    return { ok: false, code: 'bad-platform', error: `不认识的平台：${raw || '（空）'}；只支持 ${known}` };
  }
  if (!target.hasCollector) {
    return {
      ok: false,
      code: 'no-collector',
      error: `${target.label}还没有采集脚本，面板这边起不了登录；暂时只能手工记账`,
    };
  }
  // 不传账号就用默认 main；传了空串算「填错了」，不偷偷兜底成 main
  const name = account === undefined || account === null ? LOGIN_ACCOUNT_DEFAULT : sanitizeAccount(account);
  if (!name) {
    return {
      ok: false,
      code: 'bad-account',
      error: '账号名只能用字母、数字、下划线、连字符（1~32 位，字母或数字开头）',
    };
  }
  return {
    ok: true,
    plan: { platform: key, account: name, script: target.script, args: ['login', '--account', name] },
  };
}

/** 丢掉带凭据值的行——只丢整行，不动别的输出（排错要看得见脚本说了什么）。 */
export function filterLoginLog(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return '';
  return value.split(/\r?\n/).filter((line) => !SECRET_LINE_PATTERN.test(line)).join('\n');
}

/**
 * 从日志里抓最后一个 `.png` 绝对路径（B站登录会把二维码渲染成图片并打印它的位置）。
 * 抓不到返回 null——这一版面板不渲染图片，只把路径放进状态里方便排错。
 */
export function extractQrPath(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return null;
  const found = value.match(PNG_PATH_PATTERN);
  if (!found || found.length === 0) return null;
  const last = String(found[found.length - 1]).trim();
  return last || null;
}

function toStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lastLogLine(log) {
  const lines = String(log || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function messageFor(phase, { platform, account, exitCode, log, custom }) {
  if (phase === 'idle') return '还没有发起登录';
  if (phase === 'running') return '已打开浏览器窗口，请在浏览器里扫码';
  if (phase === 'done') {
    const file = credentialFile(platform, account);
    return file ? `已保存凭据：${file}` : '登录完成';
  }
  // failed：Host 自己判定的原因（超时等）优先，其次脚本报错的最后一行
  if (custom) return custom;
  const tail = lastLogLine(log);
  if (tail) return tail;
  return exitCode === null ? '登录失败，脚本没有留下任何输出' : `登录失败（退出码 ${exitCode}），脚本没有留下任何输出`;
}

/**
 * 把内部状态翻成面板契约里的 `login` 形状。
 *
 * `now` 可注入（测试与宿主时钟不同步时也能稳定）：它只用来兜一件事——bridge 的定时器
 * 万一没跑到（进程被挂起、宿主卡住），这里按 `startedAt` 也能把「早就该结束的 running」判成超时失败。
 * @returns {{phase: string, platform: string, account: string, startedAt: number|null, finishedAt: number|null, message: string, exitCode: number|null, log: string, qrPath: string|null}}
 */
export function describeLoginState(state, now = Date.now()) {
  const raw = state && typeof state === 'object' ? state : {};
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const platform = typeof raw.platform === 'string' ? raw.platform : '';
  const account = typeof raw.account === 'string' ? raw.account : '';
  const startedAt = toStamp(raw.startedAt);
  let finishedAt = toStamp(raw.finishedAt);
  const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
  // 先滤凭据行再截尾巴：截断发生在过滤之后，2000 字符里不会有半行 secret
  const log = filterLoginLog(raw.log).slice(-LOGIN_LOG_LIMIT);
  const qrPath = typeof raw.qrPath === 'string' && raw.qrPath ? raw.qrPath : extractQrPath(log);
  let phase = LOGIN_PHASES.includes(raw.phase) ? raw.phase : 'idle';
  let custom = typeof raw.message === 'string' ? raw.message.trim() : '';

  if (phase === 'running' && startedAt !== null && nowMs - startedAt > LOGIN_TIMEOUT_MS + 5000) {
    phase = 'failed';
    finishedAt = finishedAt === null ? startedAt + LOGIN_TIMEOUT_MS : finishedAt;
    custom = custom || `登录超时：脚本 ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒没有退出，请重试`;
  }

  return {
    phase,
    platform,
    account,
    startedAt,
    finishedAt,
    message: messageFor(phase, { platform, account, exitCode, log, custom }),
    exitCode,
    log,
    qrPath,
  };
}
