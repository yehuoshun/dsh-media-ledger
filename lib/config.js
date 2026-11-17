/**
 * 插件配置的解析与默认值合并。
 *
 * 不导出 schemastery 的 `Config`：那会引入一个依赖，而插件目前只需要三个
 * 可选字段；配置写错时由 resolveConfig 兜底成默认值并在 README 说明。
 * @module dsh-media-ledger/config
 */

import { isObject } from './util.js';

export const PLATFORMS = ['douyin', 'xhs', 'bilibili', 'shipinhao'];

/** 平台别名 → 规范名，用户用中文或简称都能写。 */
const ALIASES = {
  douyin: 'douyin', dy: 'douyin', '抖音': 'douyin',
  xhs: 'xhs', xiaohongshu: 'xhs', redbook: 'xhs', '小红书': 'xhs',
  bilibili: 'bilibili', bili: 'bilibili', 'b站': 'bilibili', 'B站': 'bilibili',
  shipinhao: 'shipinhao', channels: 'shipinhao', wxch: 'shipinhao', '视频号': 'shipinhao',
};

export function normalizePlatform(value) {
  if (typeof value !== 'string') return null;
  return ALIASES[value.trim()] || null;
}

export function resolveConfig(raw) {
  const config = isObject(raw) ? raw : {};
  return {
    dataDir: typeof config.dataDir === 'string' ? config.dataDir.trim() : '',
    // 允许按平台覆盖标题字数与封面规格；不写就用 lib/pack.js 的默认建议值
    titleLimits: isObject(config.titleLimits) ? config.titleLimits : null,
    coverSpecs: isObject(config.coverSpecs) ? config.coverSpecs : null,
  };
}
