/**
 * 与宿主无关的小工具：服务解析、无损 JSON、数字解析、错误文本。
 * @module dsh-media-ledger/util
 */

/** 按属性或 `ctx.get` 取服务，宿主实现两种都可能出现。 */
export function serviceOf(ctx, name) {
  if (!ctx) return undefined;
  try {
    const direct = ctx[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // 抛异常的 getter 等同于没有这个服务
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorText(error) {
  if (!error) return 'unknown error';
  return String(error.message || error);
}

/**
 * 宿主要求工具结果是「无损 JSON」：`undefined` 字段会让整个结果被拒，
 * 所以在边界上统一清一遍，而不是逐个工具手动防。
 */
export function toLossless(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (type !== 'object') return null;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toLossless(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = toLossless(item, seen);
  }
  return out;
}

/**
 * 平台后台的显示值：`2.4w`、`1.2万`、`3,456`、`12k` 都要能进台账，
 * 否则用户每报一次数都得自己换算。解析不了返回 null（存 null 不填 0，
 * 0 和「没显示」在复盘里是两件事）。
 */
export function parseCount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const text = String(value).trim().replace(/[,，\s]/g, '');
  const matched = /^(\d+(?:\.\d+)?)(w|万|k|千)?$/i.exec(text);
  if (!matched) return null;
  const unit = (matched[2] || '').toLowerCase();
  const scale = unit === 'w' || unit === '万' ? 10000 : unit === 'k' || unit === '千' ? 1000 : 1;
  return Math.round(Number(matched[1]) * scale);
}
