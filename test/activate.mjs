/**
 * 激活检查：用假 ctx 跑 index.js 的 apply，确认工具能注册、能执行、能渲染、能回收。
 * 不用装插件、不用开界面，跑完不留文件（台账写在系统临时目录里，最后删掉）。
 *
 * 用法：
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\activate.mjs"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../index.js';

const dataDir = path.join(os.tmpdir(), `ml-activate-${Date.now()}`);
const registered = [];
const cleaned = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    cleaned.push(dispose);
    return dispose;
  },
  logger: () => {},
  tools: {
    register(spec) {
      registered.push(spec);
      return () => { spec.disposed = true; };
    },
  },
};

apply(ctx, { dataDir });
const tool = registered[0];
if (!tool) {
  console.log('❌ 没有注册任何工具');
  process.exit(1);
}
console.log(`name=${name} inject=${JSON.stringify(inject)} 工具名=${tool.name} 参数键=${Object.keys(tool.parameters.properties).length} 个`);

const add = await tool.execute({ action: 'add_post', platform: '抖音', account: '主号', kind: '图文tag', title: '五盾军团23人穿7号致敬C罗', published_at: '2026-11-14 20:00' });
console.log('add_post →', JSON.stringify(add.added));

const snap = await tool.execute({ action: 'add_metrics', id: 'p0001', captured_at: '2026-11-17 09:00', play: '2.4w', like: '46', comment: '79' });
console.log('add_metrics →', JSON.stringify(snap.added));

const report = await tool.execute({ action: 'report', group_by: 'kind' });
console.log('report →', JSON.stringify(report.groups));

const list = await tool.execute({ action: 'list', platform: '抖音' });
console.log(`list → ${list.total} 条，第一条 ${list.posts[0].id}`);

const pack = await tool.execute({ action: 'pack', platform: 'bilibili', title: '短标题', body: '简介一段', tags: ['足球', 'C罗'], cover_width: 1080, cover_height: 1920 });
const rendered = tool.output.render({}, pack)[0].text;
console.log('pack 渲染 →', rendered.split('\n').filter((line) => line.startsWith('✓') || line.startsWith('⚠')).join(' | '));

const badId = await tool.execute({ action: 'add_metrics', id: 'p9999', play: '100' });
const badAction = await tool.execute({ action: 'nope' });
const badCount = await tool.execute({ action: 'add_metrics', id: 'p0001', play: '很多' });
console.log('错误路径 →', [badId.error, badAction.error, badCount.error].map((text) => text.slice(0, 24)).join(' / '));

const serialized = JSON.stringify(report) + JSON.stringify(pack);
const ok = report.groups.length === 1
  && list.total === 1
  && badId.ok === false && badAction.ok === false && badCount.ok === false
  && !serialized.includes('undefined');

for (const dispose of cleaned) dispose();
const recycled = tool.disposed === true;
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(ok && recycled ? '全过：注册 / 执行 / 渲染 / 错误路径 / 回收' : `失败：ok=${ok} recycled=${recycled}`);
process.exit(ok && recycled ? 0 : 1);
