/**
 * 「后端未升级」识别的回归基线（2026-10-27）
 * ============================================================================
 * 为什么值得单独测：`isBackendOutdated` 是**字符串匹配** —— 它认的是
 * `useAsync` 拼出来的错误文案格式 `${message}（code ${code}）`。
 * 一旦有人改了 useAsync 的格式（或者把中文括号换成英文），这个判定会静默失效：
 * 回忆墙又变回"假装空着"，而没有任何测试会红。
 *
 * 这条用例就是那个耦合点的看门人。
 */

import { describe, expect, it } from 'vitest';

import { backendOutdatedHint, isBackendOutdated } from '../constants';

describe('isBackendOutdated —— 4040 识别', () => {
  it('认得 useAsync 拼出的 4040 文案', () => {
    // 与 hooks/useAsync.ts 的 `\`${e.message}（code ${e.code}）\`` 保持同形
    expect(isBackendOutdated('资源不存在（code 4040）')).toBe(true);
  });

  it('不把其它错误码误判为「后端未升级」', () => {
    expect(isBackendOutdated('缺少 Authorization（code 4010）')).toBe(false);
    expect(isBackendOutdated('版本冲突（code 4090）')).toBe(false);
    // 只是消息里出现 4040 但格式不对（没走 useAsync）—— 不认，避免误伤
    expect(isBackendOutdated('4040')).toBe(false);
  });

  it('无错误 / 空值安全', () => {
    expect(isBackendOutdated(undefined)).toBe(false);
    expect(isBackendOutdated('')).toBe(false);
  });
});

describe('backendOutdatedHint —— 文案必须可执行', () => {
  it('包含部署三步，用户不用再去翻文档', () => {
    const s = backendOutdatedHint('缺少 /media/memories 接口');
    expect(s).toContain('prisma migrate deploy');
    expect(s).toContain('pnpm build');
    expect(s).toContain('重启 API');
    expect(s).toContain('缺少 /media/memories 接口');
  });
});
