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
    const fileName = f.path.split('/').pop() ?? 'photo.jpg';

    // 1) 预签名（服务端生成 fileKey，防目录穿越）
    const presign = await api.presignUpload({
      fileName,
      mimeType: 'image/jpeg',
      byteSize: f.size,
    });

    // 2) 直传对象存储（Mock 模式 uploadUrl 为空 → 跳过）
    if (presign.uploadUrl) {
      const up = await Taro.uploadFile({
        url: presign.uploadUrl,
        filePath: f.path,
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
      byteSize: f.size,
    });

    out.push({ asset, localPath: f.path });
  }

  return out;
}
