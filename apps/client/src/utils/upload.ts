/**
 * 照片上传工具（多端同构）
 * ============================================================================
 * 流程（两段式，对齐后端 media 域）：
 *   1. Taro.chooseImage   选图/拍照（双端同 API）
 *   2. presignUpload      预签名上传位（服务端生成 fileKey）
 *   3. Taro.uploadFile    直传对象存储（仅真后端；Mock 模式 uploadUrl 为空，跳过）
 *   4. confirmMediaAsset  登记资产（写库 + changeLog）
 *
 * 🔴 EXIF 隐私：客户端无法确认是否已剥离 GPS，confirm 时按未剥离登记
 *    （hadGps && !exifStripped 才触发服务端审计 ALERT，不会谎报安全）。
 *
 * 注意：localPath 是本地临时路径，仅当前会话可渲染，刷新即失效 ——
 * Mock 阶段的已知局限；真后端模式下图片地址由对象存储/CDN 规则拼接。
 */

import Taro from '@tarojs/taro';
import { api, type MediaAsset, type Trip } from '../api';

export interface UploadedPhoto {
  asset: MediaAsset;
  /** 本地临时路径（即时渲染用） */
  localPath: string;
}

/** 头像上传结果：最终可渲染 URL（真后端为对象存储地址，Mock/降级为本地临时路径） */
export interface UploadedAvatar {
  avatarUrl: string;
  /** 本地临时路径（真后端模式下仅本会话有效） */
  localPath: string;
}

/**
 * 单个文件的「预签名 → 直传 → 登记」三段链路。
 * 照片墙与头像上传共用；purpose 区分用途（AVATAR 不走家庭媒体池）。
 */
async function uploadOne(
  file: { path: string; size: number },
  tripId?: string,
  purpose?: 'MEDIA' | 'AVATAR',
): Promise<UploadedPhoto> {
  const fileName = file.path.split('/').pop() ?? 'photo.jpg';

  // 1) 预签名（服务端生成 fileKey，防目录穿越）
  const presign = await api.presignUpload({
    fileName,
    mimeType: 'image/jpeg',
    byteSize: file.size,
    ...(purpose !== undefined ? { purpose } : {}),
  });

  // 2) 直传对象存储（Mock 模式 uploadUrl 为空 → 跳过）
  if (presign.uploadUrl) {
    const up = await Taro.uploadFile({
      url: presign.uploadUrl,
      filePath: file.path,
      name: 'file',
      ...(presign.headers !== undefined ? { header: presign.headers } : {}),
    });
    if (up.statusCode < 200 || up.statusCode >= 300) {
      throw new Error(`上传失败（HTTP ${up.statusCode}）`);
    }
  }

  // 3) 登记资产
  const asset = await api.confirmMediaAsset({
    ...(tripId !== undefined ? { tripId } : {}),
    fileKey: presign.fileKey,
    mimeType: 'image/jpeg',
    byteSize: file.size,
    ...(purpose !== undefined ? { purpose } : {}),
  });

  return { asset, localPath: file.path };
}

/** 读取本地临时文件字节数（chooseAvatar 只给路径不给大小；失败由调用方兜底） */
async function fileByteSize(filePath: string): Promise<number> {
  try {
    // getFileInfo 的 Promise 类型是成功/失败回调结果的联合，按成功分支的 size 收窄
    const info = await Taro.getFileInfo({ filePath });
    return 'size' in info && typeof info.size === 'number' ? info.size : 0;
  } catch {
    return 0;
  }
}

/** 选图并完成上传登记；返回本次成功上传的资产列表 */
export async function pickAndUploadPhotos(tripId?: string): Promise<UploadedPhoto[]> {
  // H5 端 sourceType 含 'camera' 时 Taro 会渲染 <input capture="...">，
  // 桌面浏览器表现为「直接调起相机」而非弹文件选择器（无相机即静默失败）；
  // 小程序端 ['album','camera'] 会弹「拍摄/从相册选择」菜单，是期望语义。
  const isWeb = Taro.getEnv() === Taro.ENV_TYPE.WEB;
  const choosen = await Taro.chooseImage({
    count: 9,
    sizeType: ['compressed'],
    sourceType: isWeb ? ['album'] : ['album', 'camera'],
  });

  const files = choosen.tempFiles ?? [];
  const out: UploadedPhoto[] = [];

  for (const f of files) {
    out.push(await uploadOne(f, tripId));
  }

  return out;
}

/**
 * 上传头像图（已持有本地临时路径时使用）。
 * ============================================================================
 * 两条入口：
 *   · 小程序「微信头像」：Button openType="chooseAvatar" 回调的 detail.avatarUrl
 *     （微信官方头像选择器，含历史头像；返回临时文件，需走本链路上传固化）
 *   · H5「从相册选择」：chooseImage 的 tempFilePath
 * 返回 URL 取「服务端 asset.url > 本地临时路径」——与照片墙同一条降级链，
 * Mock 模式（无对象存储）下用本地路径让头像即时可见。
 */
export async function uploadAvatarImage(
  tempFilePath: string,
  byteSize?: number,
): Promise<UploadedAvatar> {
  const size = byteSize ?? (await fileByteSize(tempFilePath));
  if (size <= 0) throw new Error('无法读取图片大小，请重试或换一张图');
  const { asset } = await uploadOne({ path: tempFilePath, size }, undefined, 'AVATAR');
  // 🔴 老写法 `asset.url !== ''` 会把 undefined 放行（`undefined !== ''` 为真），
  //    于是 avatarUrl 被传成 undefined，PATCH 时字段消失、库里永远 NULL。
  //    这里按「非空字符串」判定，拿不到持久 URL 就退本地临时路径（本会话可见）。
  const settled = typeof asset.url === 'string' && asset.url !== '' ? asset.url : tempFilePath;
  return { avatarUrl: settled, localPath: tempFilePath };
}

/** H5 端「从相册选择」头像：选图后走上传链路（小程序端头像入口是 chooseAvatar 按钮） */
export async function pickAndUploadAvatar(): Promise<UploadedAvatar> {
  const choosen = await Taro.chooseImage({
    count: 1,
    sizeType: ['compressed'],
    sourceType: ['album'],
  });
  const file = (choosen.tempFiles ?? [])[0];
  if (file === undefined) throw new Error('未选择图片');
  return uploadAvatarImage(file.path, file.size);
}

/**
 * 让用户选「这批照片归到哪次旅行」。
 * ============================================================================
 * 为什么需要这一步：从回忆墙 / 首页直接上传时若不带 tripId，照片只会落进
 * 「按月份归档」的组里，**永远不属于任何行程** —— 用户在行程详情的「照片」tab
 * 里怎么翻都翻不到，体感就是"照片传丢了"。
 *
 * 返回语义（调用方必须区分对待）：
 *   · `string`    → 绑定到该行程
 *   · `undefined` → 明确选「不绑定」，或压根没有行程可绑
 *   · `null`      → 用户取消了选择，**本次上传应中止**
 */
export async function chooseTripForPhotos(): Promise<string | undefined | null> {
  let trips: Trip[] = [];
  try {
    trips = await api.listTrips();
  } catch {
    // 行程拉不到不该挡住传照片 —— 退化成「不绑定」
    return undefined;
  }
  if (trips.length === 0) return undefined;

  // 优先未结束的行程（进行中 / 计划中），没有则退回最近几场
  const open = trips.filter((t) => t.status !== 'FINISHED' && t.status !== 'CANCELLED');
  const pool = (open.length > 0 ? open : trips).slice(0, 3);

  try {
    const res = await Taro.showActionSheet({
      itemList: [...pool.map((t) => `归到「${t.title}」`), '不绑定行程'],
    });
    if (res.tapIndex === pool.length) return undefined;
    return pool[res.tapIndex]?.id;
  } catch {
    return null; // showActionSheet 取消会 reject
  }
}
