/**
 * 物品清单（一级 tab）—— 2026-10-27 反馈④第三次
 * ============================================================================
 * 用户口径：「物品清单还是要作为一个 tab」。
 *
 * 为什么不再塞进「我的」里：上一版把它做成了「我的」页内的二级 tab，
 * 结果是「我的」同时承载账号、家庭、清单三件事，且清单还留着一个管理入口 ——
 * 一个东西两个入口，正是用户最初嫌弃「混乱」的原因。既然要 tab，就只留 tab。
 *
 * 页面本身是薄壳：内容全在 `components/ChecklistPanel`（家庭常备 / 我的常备
 * 两半 + 条目按类型分组），这一层只负责「取 familyId + 套页面骨架」。
 * 🔴 不要在这里加清单相关逻辑 —— 否则「我的」页与 tab 页会出现两份实现。
 */

import { useCallback } from 'react';

import { api } from '../api';
import { ChecklistPanel } from '../components/ChecklistPanel';
import { Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { useAsync } from '../hooks/useAsync';

export function ItemsPage() {
  const q = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  const familyId = (q.data ?? [])[0]?.id ?? '';

  // 家庭还没读到就先别渲染清单 —— 否则 ChecklistPanel 会拿空 familyId 发一次
  // 注定失败的请求（共享清单按家庭过滤，空 familyId 什么都拿不到）
  if (q.loading) {
    return (
      <PageLayout title="物品清单" sub="常备物品：家庭一半，我的一半">
        <Loading text="读取家庭…" />
      </PageLayout>
    );
  }

  return (
    <PageLayout title="物品清单" sub="常备物品：家庭一半，我的一半">
      <ChecklistPanel familyId={familyId} />
    </PageLayout>
  );
}

export default ItemsPage;
