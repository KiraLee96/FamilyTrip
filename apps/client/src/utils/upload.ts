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
import { api, type MediaAsset } from '../api';

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
  return { avatarUrl: asset.url !== '' ? asset.url : tempFilePath, localPath: tempFilePath };
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
