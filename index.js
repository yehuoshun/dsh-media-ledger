/**
 * dsh-media-ledger — 四平台作品台账与数据复盘。
 *
 * Host 侧只注册一个 `media` 工具（每多一个工具就要每轮多付一份 token），
 * 台账读写、复盘计算、发布包生成全在 `lib/` 的纯函数里，不依赖宿主 API，
 * 将来要搬到 CLI 或独立页面时原样可用。
 *
 * @module dsh-media-ledger
 */

import { makeBridgeRoutes } from './lib/bridge.js';
import { resolveConfig } from './lib/config.js';
import { registerTools } from './lib/tool.js';

export const name = 'media-ledger';

/** 没有 tools 服务就不该激活（例如只跑了前端的 profile）。 */
export const inject = ['tools'];

/**
 * @param {any} ctx
 * @param {any} rawConfig `cordis.patch.yml` 里这一行的 config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  // 所有注册都挂在 ctx 上：插件卸载时自动回收工具注册。
  ctx.effect(() => {
    const disposers = registerTools(ctx, config);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 卸载期的失败不该阻塞其它插件的回收
        }
      }
    };
  });

  // 左侧栏面板的数据桥（`/api/dsh-media-ledger/*`）：面板是浏览器里的 React 组件，
  // 读不到磁盘、也读不到 Host 的 config，只能经这几条本机路由拿数据和写开关。
  // webServer 在 headless profile 里不存在，所以走 ctx.inject 而不是写进 inject 数组。
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const webServer = sctx.get('webServer');
      const disposers = makeBridgeRoutes(sctx, config).map((route) => webServer.register(route));
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // 同上：回收失败不阻塞
          }
        }
      };
    }, 'media-ledger: panel bridge');
  });
}
