/**
 * 发布包：把稿件整理成能直接粘进创作中心的一段文本，顺便做封面与字数的机械检查。
 *
 * 这里只做「检查」，不做上传——上传要碰各平台的私有接口和登录态，
 * 两三个号的量级不值得（详见 README 的「不做什么」）。
 * @module dsh-media-ledger/pack
 */

import { normalizePlatform } from './config.js';

/** 各平台封面建议尺寸；这些是能让平台不裁切的常见规格，可在配置里覆盖。 */
export const DEFAULT_COVER = {
  douyin: { width: 1080, height: 1920, ratio: '9:16' },
  xhs: { width: 1080, height: 1440, ratio: '3:4' },
  bilibili: { width: 1920, height: 1080, ratio: '16:9' },
  shipinhao: { width: 1080, height: 1920, ratio: '9:16' },
};

/** 标题字数上限；小红书 20 字是硬限制，其余是「超了会被折叠」的建议值。 */
export const DEFAULT_TITLE_LIMIT = { douyin: 30, xhs: 20, bilibili: 80, shipinhao: 16 };

export const MAX_TAGS = 5;

function pickSpec(config, platform, defaults) {
  const own = config && config.coverSpecs && config.coverSpecs[platform];
  if (own && typeof own.width === 'number' && typeof own.height === 'number') {
    return { width: own.width, height: own.height, ratio: own.ratio || defaults.ratio };
  }
  return defaults;
}

function pickLimit(config, platform) {
  const own = config && config.titleLimits && typeof config.titleLimits[platform] === 'number'
    ? config.titleLimits[platform]
    : null;
  return own === null ? DEFAULT_TITLE_LIMIT[platform] : own;
}

/** 标签统一成 `#xxx`，去掉重复与空串，超出 5 个截断。 */
export function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/^#+/, '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${name}`);
  }
  return out.slice(0, MAX_TAGS);
}

/**
 * @param {object} input
 * @param {string} input.platform
 * @param {string} input.title
 * @param {string} [input.body]
 * @param {string[]} [input.tags]
 * @param {{width:number,height:number}} [input.cover]
 * @param {object} [config]
 */
export function buildPack(input, config = {}) {
  const platform = normalizePlatform(input.platform);
  if (!platform) throw new Error('platform 只认 douyin / xhs / bilibili / shipinhao（或中文平台名）');

  const title = String(input.title || '').trim();
  if (!title) throw new Error('标题不能为空');
  const body = String(input.body || '').trim();
  const tags = normalizeTags(input.tags);
  const spec = pickSpec(config, platform, DEFAULT_COVER[platform]);
  const limit = pickLimit(config, platform);

  const checks = [];
  checks.push({
    ok: title.length <= limit,
    label: '标题字数',
    detail: `${title.length}/${limit} 字${title.length > limit ? `，超了会被平台折叠或截断` : ''}`,
  });
  checks.push({ ok: tags.length > 0, label: '话题标签', detail: `${tags.length} 个（上限 ${MAX_TAGS}）` });
  if (tags.length === MAX_TAGS) checks.push({ ok: true, label: '标签上限', detail: '已到 5 个，多余的不再加' });

  const cover = input.cover;
  if (cover && typeof cover.width === 'number' && typeof cover.height === 'number') {
    const target = spec.width / spec.height;
    const actual = cover.width / cover.height;
    const drift = Math.abs(actual - target) / target;
    checks.push({
      ok: drift <= 0.02,
      label: '封面比例',
      detail: `给定 ${cover.width}×${cover.height}（${actual.toFixed(3)}），目标 ${spec.width}×${spec.height}（${spec.ratio} ${target.toFixed(3)}）`,
    });
  } else {
    checks.push({ ok: true, label: '封面尺寸', detail: `建议 ${spec.width}×${spec.height}（${spec.ratio}）` });
  }

  const titleLine = `【${platformLabel(platform)} 发布包】`;
  const parts = [
    titleLine,
    `标题（${title.length}/${limit} 字）`,
    title,
    '',
    '简介',
    body || '（正文没填）',
    '',
    `话题（${tags.length}/${MAX_TAGS}）`,
    tags.length > 0 ? tags.join(' ') : '（没填话题）',
    '',
    `封面：${spec.width}×${spec.height}（${spec.ratio}）`,
  ];

  return { platform, text: parts.join('\n'), checks, tags, coverHint: spec, titleLimit: limit };
}

export function platformLabel(platform) {
  return { douyin: '抖音', xhs: '小红书', bilibili: 'B站', shipinhao: '视频号' }[platform] || platform;
}
