/**
 * 面板「采集并导入」的纯函数层：跑哪个脚本、带什么参数、产出落在哪、进度怎么讲成人话。
 *
 * 与 `lib/login.js` 同构：这里**一行 IO 都没有**——不起进程、不读盘、不读 process.env，
 * 真正起进程只在 `lib/bridge.js`（全仓库唯一允许 spawn 的文件，AGENTS.md §5 的窄例外）。
 * 抓取本身仍然由 scripts/ 下的独立 Python 脚本干，插件本体一个请求都不发。
 * @module dsh-media-ledger/fetch
 */

import path from 'node:path';
import { ACCOUNT_DEFAULT, COLLECTOR_TARGETS, sanitizeAccount } from './bindings.js';
import { normalizePlatform } from './config.js';
import { filterLoginLog } from './login.js';
import { lastNonEmptyLine } from './util.js';

/**
 * 一次采集最多留多少条。三个脚本都给同一个值，面板不提供这个选项：
 * 用户要的是「把最近这批作品拉下来灌进台账」，不是「按条数调参」。
 */
export const FETCH_MAX = 50;

/**
 * 一次抓取的上限：30 分钟。
 *
 * B站要逐稿抓三份数据（结算 / 观众画像 / 播放页实时），抖音要翻页再按批取指标，
 * 小红书要走页面「导出数据」下载 xlsx；慢网下都可能跑到十几分钟。给短了用户只会看到
 * 「失败」，真正原因是面板太急——所以宁可让进度条挂着，也不要误杀。
 */
export const FETCH_TIMEOUT_MS = 1800000;

/** 面板日志只留尾部这么多字符（与登录同一个口径）。 */
export const FETCH_LOG_LIMIT = 2000;

/** 四个阶段，少一个前端就得多写一层兜底。 */
export const FETCH_PHASES = ['idle', 'running', 'done', 'failed'];

/**
 * 采集产出的文件名：三个平台同一种形状，由 Host 决定，**不接受请求里带的任何路径**。
 * 账号已经过 `^[A-Za-z0-9_-]{1,32}$`，拼进文件名跑不出 tmp/。
 */
export function fetchOutputName(platform, account) {
  return `panel-fetch-${platform}-${account}.json`;
}

/**
 * 拼出一次采集的完整计划：脚本、逐字 argv、产出文件、凭据文件。
 *
 * argv 是**写死的模板**（子命令在前、值与开关成对），账号只作为「一个参数值」出现，
 * 不做字符串拼接、不传 shell（bridge 里 `shell: false`）。xhs 额外给 `--name`：
 * 它的默认值虽然是 `--account`，但脚本将来改默认值时，台账里的账号名会跟着变，
 * 显式给上就不会。三个平台都显式给 `--max`：xhs 的 `--max` 默认是 0（全部），
 * 不传会把整号作品都拖下来，和这里 50 的口径不一致。
 *
 * @param {object} [options] `{ root }`：工作区根（绝对路径），产出与凭据都相对它算
 * @returns {{ok: true, plan: object} | {ok: false, code: string, error: string}}
 */
export function buildFetchPlan(platform, account, options) {
  const raw = typeof platform === 'string' ? platform.trim() : '';
  const key = normalizePlatform(raw) || raw;
  const target = COLLECTOR_TARGETS[key];
  if (!target) {
    const known = Object.keys(COLLECTOR_TARGETS).filter((item) => COLLECTOR_TARGETS[item].hasCollector).join(' / ');
    return { ok: false, code: 'bad-platform', error: `不认识的平台：${raw || '（空）'}；只支持 ${known}` };
  }
  if (!target.hasCollector) {
    return {
      ok: false,
      code: 'no-collector',
      error: `${target.label}还没有采集脚本，采不了也导不进`,
    };
  }
  // 不传账号按默认 main（与登录一致）；传了空串算填错，不偷偷兜底
  const name = account === undefined || account === null ? ACCOUNT_DEFAULT : sanitizeAccount(account);
  if (!name) {
    return { ok: false, code: 'bad-account', error: '账号名只能用字母、数字、下划线、连字符（1~32 位）' };
  }
  const root = options && typeof options.root === 'string' ? options.root.trim() : '';
  if (!root) {
    // 找不到工作区根就不知道该把 JSON 写哪：宁可报错，也不要落到插件自己的目录里
    return { ok: false, code: 'no-workspace', error: '找不到工作区根，无法确定采集产出目录' };
  }
  const dir = path.resolve(root);
  const outName = fetchOutputName(key, name);
  const outFile = path.join(dir, 'tmp', outName);
  const credentialName = `${target.prefix}${name}.txt`;
  const credentialFile = path.join(dir, 'config', credentialName);
  const args = key === 'xhs'
    ? ['fetch', '--account', name, '--name', name, '--max', String(FETCH_MAX), '--out', outFile]
    : ['fetch', '--account', name, '--max', String(FETCH_MAX), '--out', outFile];
  return {
    ok: true,
    plan: {
      platform: key,
      account: name,
      script: target.script,
      args,
      outName,
      outFile,
      credentialName,
      credentialFile,
    },
  };
}

function toStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 把导入结果收敛成面板契约里的 counts。
 *
 * 拿不到就 null，**不是 0**：0 会被读成「跑过了但一条都没变」，而「没跑成」和「跑了没变化」
 * 在用户那里是两件事（前者要重试，后者是好事）。
 */
export function countsOf(imported) {
  if (!imported || imported.ok !== true) return null;
  const created = Number.isInteger(imported.createdCount) ? imported.createdCount : 0;
  const updated = Number.isInteger(imported.updatedCount) ? imported.updatedCount : 0;
  const skipped = Array.isArray(imported.skipped) ? imported.skipped.length : 0;
  return { created, updated, skipped };
}

function normalizeCounts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    created: Number.isInteger(raw.created) ? raw.created : 0,
    updated: Number.isInteger(raw.updated) ? raw.updated : 0,
    skipped: Number.isInteger(raw.skipped) ? raw.skipped : 0,
  };
}

/**
 * 面板看到的抓取进度。与 `describeLoginState` 同构：只读状态、不碰磁盘、不读时钟以外的东西。
 *
 * 三件事特意在这儿做：
 * 1. 日志先滤掉带凭据值的行（脚本偶尔会把人 cookie 的名字打进错误信息），再截尾部 2000 字符；
 * 2. `running` 但 `startedAt` 早过了超时线 → 按 failed 说（宿主重启、闹钟没跑起来时也不会
 *    永远转圈）；
 * 3. 失败时只说日志最后一行：脚本自己那句人话比「退出码 1」有用得多。
 *
 * @param {object} state bridge 里那份内存状态
 * @param {number} [now] 现算的时钟（测试可以给假时间）
 */
export function describeFetchState(state, now = Date.now()) {
  const raw = state && typeof state === 'object' ? state : {};
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const platform = typeof raw.platform === 'string' ? raw.platform : '';
  const account = typeof raw.account === 'string' ? raw.account : '';
  const startedAt = toStamp(raw.startedAt);
  let finishedAt = toStamp(raw.finishedAt);
  const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
  const counts = normalizeCounts(raw.counts);
  const log = filterLoginLog(raw.log).slice(-FETCH_LOG_LIMIT);
  let phase = FETCH_PHASES.includes(raw.phase) ? raw.phase : 'idle';
  let message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (phase === 'running' && startedAt !== null && nowMs - startedAt > FETCH_TIMEOUT_MS + 5000) {
    phase = 'failed';
    if (finishedAt === null) finishedAt = startedAt + FETCH_TIMEOUT_MS;
    message = message || `抓取超时：脚本 ${Math.round(FETCH_TIMEOUT_MS / 60000)} 分钟没有退出，请重试`;
  }
  if (!message) {
    if (phase === 'idle') message = '还没有发起采集';
    else if (phase === 'running') message = `正在抓取${platform ? `（${platform}）` : ''}：脚本在跑，跑完会自动灌进台账`;
    else if (phase === 'done') {
      message = counts
        ? `已抓取并导入：新建 ${counts.created} 条、更新 ${counts.updated} 条`
        : '采集完成并已导入台账';
    } else {
      const last = lastNonEmptyLine(log);
      if (last) message = last;
      else if (exitCode === null) message = '抓取失败，脚本没有留下任何输出';
      else message = `抓取失败（退出码 ${exitCode}），脚本没有留下任何输出`;
    }
  }
  return { phase, platform, account, startedAt, finishedAt, message, exitCode, log, counts };
}
