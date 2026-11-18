/**
 * 面板上的「绑定状态」：哪个平台存了凭据、什么时候存的、这一路有没有采集脚本。
 *
 * 纯函数，只吃一份目录清单（`{ name, mtimeMs }`），不读盘——真读盘在 `lib/bridge.js`。
 * 单独成模块的理由：凭据文件名（`config/<平台>_<账号>.txt`）是 `scripts/*.py` 与面板
 * **共用的一份约定**。以前它只写在脚本里：用户把凭据存成 `config/bilibili.txt`，
 * 脚本报「凭据文件不存在」，面板却一句提示都没有，只能看到一片空白。
 * @module dsh-media-ledger/bindings
 */

import path from 'node:path';
import { PLATFORMS, normalizePlatform } from './config.js';
import { platformLabel } from './panel.js';

/** 采集脚本、凭据前缀、导入 action；`null` = 这个平台还没有采集脚本（只有台账侧）。 */
export const COLLECTORS = {
  bilibili: { script: 'scripts/bili_sync.py', prefix: 'bilibili_', action: 'import_bili' },
  douyin: { script: 'scripts/douyin_sync.py', prefix: 'douyin_', action: 'import_douyin' },
  xhs: { script: 'scripts/xhs_sync.py', prefix: 'xhs_', action: 'import_xhs' },
  shipinhao: null,
};

/** 凭据文件只认这个扩展名——脚本按它落盘，面板跟着认同一份。 */
export const CREDENTIAL_EXT = '.txt';

/**
 * 账号名的唯一合法形状：`^[A-Za-z0-9_-]{1,32}$`——**与采集脚本逐字一致**
 * （bili_sync.py:99 / douyin_sync.py:118 / xhs_sync.py:119）。
 *
 * 这条正则放在这里而不是 login.js：它同时决定「凭据文件叫什么」（解绑要按它算文件名）
 * 与「命令行能不能带这个值」（登录与采集都要按它挡注入），两处只能有一把尺子。
 * 早先这里多一条「字母或数字开头」，比脚本更严：脚本收得下 `_x`、`-x`，面板却判成坏名字。
 */
export const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 调用方没给账号时的默认值（登录、采集、解绑都用它）。 */
export const ACCOUNT_DEFAULT = 'main';

/**
 * 账号名过滤：只收 `^[A-Za-z0-9_-]{1,32}$`，别的一律 null。
 *
 * 不做 trim、不做纠正：这个值最终会变成命令行参数与凭据文件名，宽松一寸就是注入的入口。
 * 不合法就让调用方报 'bad-account'，而不是猜用户想写什么。
 */
export function sanitizeAccount(value) {
  if (typeof value !== 'string') return null;
  return ACCOUNT_PATTERN.test(value) ? value : null;
}

/**
 * 平台 → 采集脚本 / 凭据前缀 / 有没有采集器。登录与采集各自要用的那份表都从这里派生：
 * 面板空态提示的脚本名、`config/<前缀><账号>.txt` 的文件名，只能是同一条数据。
 */
export const COLLECTOR_TARGETS = Object.freeze(Object.fromEntries(PLATFORMS.map((platform) => {
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
 * `bilibili_main.txt` → `{ platform: 'bilibili', account: 'main' }`。
 * 认不出（平台名不在表里、账号为空、扩展名不对）就返回 null，不猜。
 */
export function parseCredentialName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text.toLowerCase().endsWith(CREDENTIAL_EXT)) return null;
  const stem = text.slice(0, -CREDENTIAL_EXT.length);
  for (const [platform, collector] of Object.entries(COLLECTORS)) {
    if (!collector || !stem.startsWith(collector.prefix)) continue;
    const account = stem.slice(collector.prefix.length);
    if (!account) return null;
    return { platform, account };
  }
  return null;
}

/**
 * 身份旁路文件名：`bilibili_main.txt` → `bilibili_main.identity.json`。
 *
 * 采集脚本登录成功后写这一份（只含 uname/mid/saved_at，**不含 cookie**），面板靠它把
 * 「已绑定 main」说成「已绑定 main（昵称）」。命名跟着凭据文件走，
 * 所以一条凭据最多对一条身份；没写身份的老凭据照常工作，只是说不出昵称。
 */
export function identityFileOf(credentialFile) {
  const text = typeof credentialFile === 'string' ? credentialFile.trim() : '';
  if (!text.toLowerCase().endsWith(CREDENTIAL_EXT)) return '';
  return `${text.slice(0, -CREDENTIAL_EXT.length)}.identity.json`;
}

/**
 * 解绑计划：把「平台 + 账号」算成 `config/` 里**那两个确切的文件**（凭据 + 身份旁路）。
 *
 * 为什么是纯函数：解绑要删文件，而删文件最怕的是「算出来的名字跑到 config 之外」。名字只从
 * `COLLECTORS` 的前缀与 `identityFileOf` 来（不认入参里的任何路径），账号先过同一条正则；
 * 给了 `configDir` 还会把绝对路径再校一次 `dirname`，不在 config 目录里就整单拒绝。
 * 这条检查放在纯函数里，冒烟测试不用碰磁盘就能守住「绝不删 data/、绝不出 config」。
 *
 * @param {string} [configDir] 工作区里的 `config/` 目录（绝对路径；不给就只回文件名）
 * @returns {{ok: true, plan: {platform: string, account: string, dir: string, files: {name: string, file: string}[]}} | {ok: false, code: string, error: string}}
 */
export function buildUnbindPlan(platform, account, configDir) {
  const raw = typeof platform === 'string' ? platform.trim() : '';
  const key = normalizePlatform(raw) || raw;
  const target = COLLECTOR_TARGETS[key];
  if (!target) {
    const known = PLATFORMS.filter((item) => COLLECTOR_TARGETS[item].hasCollector).join(' / ');
    return { ok: false, code: 'bad-platform', error: `不认识的平台：${raw || '（空）'}；只支持 ${known}` };
  }
  if (!target.hasCollector) {
    return {
      ok: false,
      code: 'no-collector',
      error: `${target.label}还没有采集脚本，没有可解绑的凭据`,
    };
  }
  // 解绑必须明确说清删哪个账号：登录可以「省了按 main」，删凭据不行——删错了要用户重新扫码
  if (account === undefined || account === null) {
    return {
      ok: false,
      code: 'bad-account',
      error: '解绑要写清账号名，例如 {"platform":"bilibili","account":"main"}',
    };
  }
  const name = sanitizeAccount(account);
  if (!name) {
    return { ok: false, code: 'bad-account', error: '账号名只能用字母、数字、下划线、连字符（1~32 位）' };
  }
  const credential = `${target.prefix}${name}${CREDENTIAL_EXT}`;
  const identity = identityFileOf(credential);
  const names = identity ? [credential, identity] : [credential];
  const fromDir = typeof configDir === 'string' ? configDir.trim() : '';
  const dir = fromDir ? path.resolve(fromDir) : '';
  const files = names.map((item) => ({ name: item, file: dir ? path.join(dir, item) : item }));
  for (const item of files) {
    // 第二道锁：只删 config 目录的直接子文件（账号正则已挡住 ../ 与 /，这里再按 resolve 后的结果校一次）
    if (dir && path.dirname(item.file) !== dir) {
      return { ok: false, code: 'bad-account', error: `拒绝：${item.name} 算出来不在 config 目录里` };
    }
  }
  return { ok: true, plan: { platform: key, account: name, dir, files } };
}

/** 身份记录收敛成 `{ uname, mid }`：缺字段就当没有，别往 UI 里塞 undefined。 */
function normalizeIdentity(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const uname = typeof source.uname === 'string' ? source.uname.trim() : '';
  const mid = typeof source.mid === 'number' || (typeof source.mid === 'string' && source.mid.trim())
    ? String(source.mid).trim()
    : '';
  if (!uname && !mid) return null;
  return { uname, mid };
}

/** 存的时间说得像人话：今天 / 昨天 / N 天前 / 具体日期。`now` 只为测试可注入。 */
export function formatSavedAt(time, now = Date.now()) {
  const stamp = typeof time === 'number' ? time : Date.parse(String(time || ''));
  if (!Number.isFinite(stamp)) return '';
  const day = 24 * 60 * 60 * 1000;
  const diff = Math.floor((now - stamp) / day);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 30) return `${diff} 天前`;
  return new Date(stamp).toISOString().slice(0, 10);
}

/** 每个平台「下一步该敲什么」。面板的空态直接照抄这几行，文案只在这一处改。 */
export function bindingSteps(platform) {
  const collector = COLLECTORS[platform] || null;
  if (!collector) {
    return [
      `${platformLabel(platform)}还没有采集脚本（目前只有台账侧）`,
      '暂时只能手工记账：让 agent 用 media 调 add_post / add_metrics',
    ];
  }
  return [
    // 账号名不是只能 main：脚本收 `<平台>_<账号>.txt`，同一个平台可以绑第二个号
    // 0.5.7 起面板自己就能登录与采集：先说按钮，命令行只当「要历史/要更多」的补充，别把人赶回 shell
    `点下面的「扫码登录」，用手机扫码（账号名可改，默认 ${ACCOUNT_DEFAULT}）；凭据落到 config/${collector.prefix}<账号名>${CREDENTIAL_EXT}`,
    '登录成功后点这个账号行的「采集并导入」：最多拉 50 条，跑完自动灌进台账',
    `还要历史或更多条：python ${collector.script} fetch --account <账号名> --max 100，再让 agent 用 media 调 ${collector.action}`,
  ];
}

function describePlatform(platform, entries, identities) {
  const collector = COLLECTORS[platform] || null;
  const found = [];
  if (collector) {
    for (const entry of entries) {
      const parsed = parseCredentialName(entry && entry.name);
      if (!parsed || parsed.platform !== platform) continue;
      const time = Number(entry.mtimeMs);
      const identity = normalizeIdentity(identities && identities.get ? identities.get(identityFileOf(entry.name)) : null);
      found.push({
        account: parsed.account,
        file: entry.name,
        savedAt: formatSavedAt(time),
        time: Number.isFinite(time) ? time : 0,
        identity,
      });
    }
  }
  // 新的排前面：状态文案里的「什么时候存」指最近那一次
  found.sort((a, b) => b.time - a.time || String(a.account).localeCompare(String(b.account)));
  const credentials = found.map(({ account, file, savedAt, identity }) => ({ account, file, savedAt, identity }));
  const status = !collector ? 'no-collector' : credentials.length > 0 ? 'ready' : 'unbound';
  const label = platformLabel(platform);
  // 有身份就说「别名（真实昵称）」：两个号都叫 main 时，只有这一处能让人看出是哪个号
  const accounts = credentials
    .map((item) => (item.identity && item.identity.uname ? `${item.account}（${item.identity.uname}）` : item.account))
    .join('、');
  const statusText = status === 'no-collector'
    ? `${label}：还没有采集脚本，只能手工记账`
    : status === 'ready'
      ? `${label}：已绑定 ${accounts}（${credentials[0].savedAt}存）`
      : `${label}：还没绑定，${'config/'}${collector.prefix}<账号>.txt 不存在`;
  return {
    key: platform,
    label,
    status,
    statusText,
    script: collector ? collector.script : '',
    action: collector ? collector.action : '',
    credentials,
    steps: bindingSteps(platform),
  };
}

/**
 * 面板要的绑定状态：四个平台恒在四条，顺序跟 `PLATFORMS` 一致。
 *
 * 第二个参数是身份旁路文件（登录脚本写的 `<凭据>.identity.json`，只有 uname/mid），
 * 以「文件名 → 身份」的形式传进来；传不传都不影响绑定判定，只影响文案里说不说得出昵称。
 */
export function describeBindings(entries, identities) {
  const list = Array.isArray(entries) ? entries : [];
  const map = new Map();
  for (const item of Array.isArray(identities) ? identities : []) {
    const name = item && typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    map.set(name, item);
  }
  return { platforms: PLATFORMS.map((platform) => describePlatform(platform, list, map)) };
}
