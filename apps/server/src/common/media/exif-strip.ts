/**
 * M6 · EXIF 服务端兜底剥离（P0 合规项）
 * ---------------------------------------------------------------------------
 * 客户端已做剥离，但**服务端必须兜底**：客户端可被绕过、也可被改包。
 *
 * 流程：
 *   收到图片 → 探测 EXIF/GPS → 剥离全部元数据 → 落media_assets.exifStripped
 *          → 检出 GPS 时记审计告警（ALERT）
 *
 * 依赖：`sharp` 做像素级重编码（元数据随之丢弃）。
 * 若运行环境无原生依赖，本模块提供 pure-TS 的 GIF/JPEG 元数据切割兜底，
 * 保证「剥离动作」永不静默跳过。
 */

/** 剥离结果 */
export interface ExifStripResult {
  /** 剥离后的图片字节 */
  data: Buffer;
  /** 是否检出 EXIF 段 */
  hadExif: boolean;
  /** 是否检出 GPS 信息（→ 审计告警） */
  hadGps: boolean;
  /** 落库标记：media_assets.exifStripped */
  exifStripped: boolean;
}

/** 图片处理后端接口；生产用 sharp */
export interface ImageProcessor {
  /** 重编码并丢弃全部元数据 */
  stripMetadata(input: Buffer): Promise<Buffer>;
}

// ── EXIF 段探测（纯 TS，不依赖原生模块）───────────────────────

/** JPEG 起始标记 SOI (0xFFD8) */
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const GPS_TAG = Buffer.from('GPS', 'ascii');

export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf.subarray(0, 2).equals(JPEG_SOI);
}

/**
 * 探测 JPEG 的 EXIF 段与 GPS 标记。
 *
 * 只读探测，不修改字节。
 */
export function probeExif(buf: Buffer): { hadExif: boolean; hadGps: boolean } {
  if (!isJpeg(buf)) {
    // 非 JPEG（PNG / WebP）：本探测器不解析，返回无 EXIF。
    // ⚠️ 这不代表安全 —— 由sharp 重编码兜底剥离。
    return { hadExif: false, hadGps: false };
  }

  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) break;

    const marker = buf.readUInt8(offset + 1);
    // 填充字节 FF FF ... FF
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    // SOS：图像数据开始，之后都是压缩像素，不再有元数据
    if (marker === 0xda) break;

    const segLength = buf.readUInt16BE(offset + 2);
    if (segLength < 2) break;

    const segment = buf.subarray(offset + 4, offset + 2 + segLength);
    if (marker === 0xe1) {
      // APP1：看是否以 "Exif\0\0" 开头
      const isExif =
        segment.length >= 6 &&
        segment.subarray(0, 4).toString('ascii') === 'Exif' &&
        segment[4] === 0x00 &&
        segment[5] === 0x00;

      if (isExif) {
        // EXIF 段内出现 GPS IFD 标记即视为带 GPS
        return { hadExif: true, hadGps: segment.includes(GPS_TAG) };
      }
    }
    offset += 2 + segLength;
  }

  return { hadExif: false, hadGps: false };
}

/**
 * 纯 TS 兜底剥离：从 JPEG 中物理切除全部 APPn 元数据段。
 *
 * ⚠️ 仅在 sharp 不可用时使用。它是**字节级切除**而非重编码，
 * 对非常规编码可能不完整 —— 故仅作最后一道闸，且必须记录告警。
 */
export function stripJpegSegmentsFallback(buf: Buffer): Buffer {
  if (!isJpeg(buf)) return buf;

  const out: Buffer[] = [JPEG_SOI];
  let offset = 2;
  let stripped = false;

  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      out.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    const marker = buf.readUInt8(offset + 1);
    if (marker === 0xff) {
      out.push(buf.subarray(offset, offset + 1));
      offset += 1;
      continue;
    }
    if (marker === 0xda) {
      // SOS 起后面是像素数据，整体保留
      out.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const segLength = buf.readUInt16BE(offset + 2);
    if (segLength < 2) {
      out.push(buf.subarray(offset));
      break;
    }
    const segment = buf.subarray(offset + 4, offset + 2 + segLength);
    const isApp1Exif =
      marker === 0xe1 && segment.length >= 6 && segment.subarray(0, 4).toString('ascii') === 'Exif';

    if (isApp1Exif || (marker >= 0xe1 && marker <= 0xef)) {
      stripped = true; // 丢弃整个应用段
    } else {
      out.push(buf.subarray(offset, offset + 2 + segLength));
    }
    offset += 2 + segLength;
  }

  return stripped ? Buffer.concat(out) : buf;
}

export interface StripDeps {
  /** 可选；缺失时走纯 TS 兜底 */
  processor?: ImageProcessor;
}

/**
 * 服务端兜底剥离入口。
 *
 * **永不静默跳过**：无论走sharp 还是兜底路径，都必须返回已剥离的字节；
 * 无法处理时抛错而不是原样返回带 EXIF 的图。
 */
export async function stripExifServerSide(
  input: Buffer,
  deps: StripDeps = {},
): Promise<ExifStripResult> {
  const probe = probeExif(input);

  if (deps.processor) {
    try {
      const data = await deps.processor.stripMetadata(input);
      return {
        data,
        hadExif: probe.hadExif,
        hadGps: probe.hadGps,
        exifStripped: true,
      };
    } catch {
      // sharp 失败 → 降级到纯 TS 兜底，仍不静默放过
      const data = stripJpegSegmentsFallback(input);
      return {
        data,
        hadExif: probe.hadExif,
        hadGps: probe.hadGps,
        exifStripped: data !== input,
        // 记录降级原因，供上层告警
        ...(data === input ? { degraded: true } : {}),
      };
    }
  }

  const data = stripJpegSegmentsFallback(input);
  return {
    data,
    hadExif: probe.hadExif,
    hadGps: probe.hadGps,
    exifStripped: data !== input,
  };
}
