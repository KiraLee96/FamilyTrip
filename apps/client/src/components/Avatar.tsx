/**
 * 用户头像（多端同构，不 fork）
 * ============================================================================
 * 有 avatarUrl → <Image mode="aspectFill">；无 → 👤 图标兜底（与旧版
 * profile-card__avatar 的占位观感一致）。H5 下 Taro <Image> 渲染为
 * <taro-image-core>，内部是真实 <img>，样式类名挂在外层容器上。
 *
 * 降级链与照片墙同源：本会话本地路径（Mock 换头像后即时可见）>
 * 服务端持久 URL（真后端 media 方案 A）> 图标占位。
 */

import { Image, View } from '@tarojs/components';

import { Icon } from './Icon';
import type { User } from '../api/types';

export function Avatar({ user, size = 46 }: { user?: User; size?: number }) {
  const url = user?.avatarUrl;

  return (
    <View
      className="avatar-img"
      style={{ width: size, height: size }}
      // 头像变更属高频偶发交互，不涉及列表虚拟化，无需测试标记
    >
      {url !== undefined && url !== '' ? (
        <Image className="avatar-img__src" src={url} mode="aspectFill" />
      ) : (
        <Icon name="user" size={Math.round(size * 0.52)} />
      )}
    </View>
  );
}

export default Avatar;
