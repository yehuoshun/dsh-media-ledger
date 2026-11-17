/**
 * 台账的落盘层：两行一个文件的 JSONL，不引数据库。
 *
 * 为什么不是 SQLite：better-sqlite3 要 node-gyp 编译，Electron 的 ABI 一变就挂，
 * 而这里的数据量是「两个号、四平台、一年几百条」，JSONL 直接能用 git 看 diff。
 * @module dsh-media-ledger/store
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isObject } from './util.js';

export const POSTS_FILE = 'posts.jsonl';
export const METRICS_FILE = 'metrics.jsonl';

/** 数据目录：配置优先，其次环境变量，再次「工作区的 data/<项目名>/」，最后退回用户目录。 */
export function resolveDataDir(config) {
  const fromConfig = config && typeof config.dataDir === 'string' ? config.dataDir.trim() : '';
  if (fromConfig) return path.resolve(fromConfig);
  const fromEnv = typeof process.env.DSH_MEDIA_LEDGER_DIR === 'string' ? process.env.DSH_MEDIA_LEDGER_DIR.trim() : '';
  if (fromEnv) return path.resolve(fromEnv);
  const workspace = findWorkspaceRoot(process.cwd());
  if (workspace) return path.join(workspace, 'data', LEDGER_DIR_NAME);
  return path.join(os.homedir(), LEDGER_DIR_NAME);
}

export const LEDGER_DIR_NAME = 'media-ledger';

/**
 * 往上找工作区根：特征是**同一层**既有 `AGENTS.md`，又有 `code/` 或 `work/`。
 * 只认这两个标记，所以插件仓库自己（有 AGENTS.md、没有 code/work）不会被误认成工作区根，
 * 台账不会写回仓库里。找不到就返回空串，让调用方回退用户目录。
 */
export function findWorkspaceRoot(from) {
  let current = path.resolve(from || process.cwd());
  for (;;) {
    const markers = fs.existsSync(path.join(current, 'AGENTS.md'))
      && (fs.existsSync(path.join(current, 'code')) || fs.existsSync(path.join(current, 'work')));
    if (markers) return current;
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

/**
 * 读 JSONL。坏行不吞掉：记下行号返回给调用方，否则一条坏数据会让整份台账静默少一条。
 * 编码按 utf-8 读并剥 BOM —— PowerShell 的 `Set-Content -Encoding utf8` 会带 BOM。
 */
export function readJsonl(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return { records: [], errors: [], file };
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isObject(parsed)) throw new Error('不是 JSON 对象');
      records.push(parsed);
    } catch (error) {
      errors.push({ line: index + 1, message: String(error.message || error) });
    }
  }
  return { records, errors, file };
}

export function appendJsonl(dir, name, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, name), `${JSON.stringify(record)}\n`, 'utf8');
}

/** p0001、p0002……递增；已有 id 里取最大号再加一，不用记录数（删过行会撞号）。 */
export function nextPostId(posts) {
  let max = 0;
  for (const post of posts) {
    const matched = /^p(\d+)$/.exec(String(post.id || ''));
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return `p${String(max + 1).padStart(4, '0')}`;
}

/** 读两份台账并保证唯一性；重复 id 直接报错，因为重复会被复盘算两次。 */
export function loadLedger(dir) {
  const posts = readJsonl(dir, POSTS_FILE);
  const metrics = readJsonl(dir, METRICS_FILE);
  const seen = new Map();
  for (const post of posts.records) {
    const id = String(post.id || '').trim();
    if (!id) throw new Error(`${POSTS_FILE} 里有作品没写 id`);
    if (seen.has(id)) throw new Error(`${POSTS_FILE} 里 id=${id} 重复（同一个 id 会被复盘算两次）`);
    seen.set(id, post);
  }
  return { posts: posts.records, metrics: metrics.records, errors: [...posts.errors, ...metrics.errors].map((item) => ({ ...item })), dir };
}
