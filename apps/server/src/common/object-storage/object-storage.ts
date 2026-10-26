/**
 * 对象存储端口（media 域唯一的外部存储依赖）
 * ============================================================================
 * 为什么要有这一层：
 *   仓库此前**没有任何对象存储实现** —— `MediaServiceOptions.signUpload` /
 *   `putObject` / `fetchObject` 三个注入口齐全，但 `main.ts` 一个都没传，
 *   于是 `presign` 恒回占位地址 `https://upload.local/<fileKey>`，
 *   客户端 uploadFile 打过去 DNS 必失败 → 头像 / 行程照片 / 回忆墙**全部传不上去**。
 *   （D-2026-10-26-04）
 *
 *   `ObjectStorage` 就是那三个注入口的**统一形状**：换实现（本地磁盘 / COS / OSS / S3）
 *   只换 driver，media 域与客户端零改动。
 *
 * 🔴 只定义「存字节 / 取字节 / 签一个上传位」三件事，不做业务判断：
 *    鉴权、写入门（归档只读 / 成员判定）仍在 media 域，别下沉到这里。
 */

/** 预签名上传位的返回形状（与 `MediaServiceOptions.signUpload` 逐字一致） */
export interface SignedUpload {
  uploadUrl: string;
  headers?: Record<string, string>;
  expiresIn: number;
}

export interface ObjectStorage {
  /** 驱动标识，仅用于启动日志与排障（`local-disk` / `cos` / `s3` …） */
  readonly kind: string;

  /**
   * 签一个上传位。
   *
   * ⚠️ 小程序端 `Taro.uploadFile` **只能发 multipart/form-data POST**，不能发 PUT 裸流，
   *    所以本地磁盘驱动签的是「自家收单端点」的地址（服务端收流后再落盘），
   *    而不是「客户端直接 PUT 到桶」的那种 URL。云驱动若走桶的 POST Object 表单，
   *    需要额外返回 `formData` 字段（届时扩 `SignedUpload`，属纯加法）。
   */
  signUpload(args: { fileKey: string; mimeType: string; byteSize: bigint }): Promise<SignedUpload>;

  /** 写入对象（服务端持有字节：收单端点落盘、EXIF 剥离回写都用它） */
  putObject(fileKey: string, data: Buffer, mimeType: string): Promise<void>;

  /** 读取对象（EXIF 服务端剥离、收单端点回读） */
  fetchObject(fileKey: string): Promise<Buffer>;
}
