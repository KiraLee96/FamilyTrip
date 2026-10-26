/**
 * D-2026-10-26-04 · 媒体上传真机取证（真实 HTTP + 真实 multipart + 真实落盘）
 * ============================================================================
 * 单元测试用的是「直接驱动 handler」，这里补的是**过网络边界**的那一遍：
 * presign（8 段链）→ 真 multipart POST 到 uploadUrl → 回读字节 → confirm → list.url 再回读。
 *
 * 启动：
 *   DATABASE_URL= PORT=3217 MEDIA_PUBLIC_BASE_URL=http://127.0.0.1:3217/media-files \
 *     npx tsx src/main.ts
 * 运行：
 *   BASE=http://127.0.0.1:3217/api MEDIA=http://127.0.0.1:3217/media-files \
 *     node .verify/media-upload-probe.mjs
 */

const BASE = (process.env.BASE ?? 'http://127.0.0.1:3217/api').replace(/\/+$/, '');
const MEDIA = (process.env.MEDIA ?? 'http://127.0.0.1:3217/media-files').replace(/\/+$/, '');

let failed = 0;
function line(ok, name, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` → ${detail}`}`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json?.code, data: json?.data, message: json?.message };
}

/** 一张最小的「合法 JPEG 头 + 随机字节」，用于验证字节完整性（不需要真解码） */
function fakeJpeg(size = 4096) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
  return Buffer.concat([head, body]);
}

const code = `mediaprobe${Date.now()}`;
const login = await api('POST', '/auth/login', { body: { code } });
const token = login.data?.token;
const fam = await api('POST', '/families', { token, body: { name: `${code}家` } });
const familyId = fam.data?.family?.id;
line(login.status === 200 && fam.status === 200, '① 登录 + 建家庭', `familyId=${familyId}`);

// ── presign ──────────────────────────────────────────────────────────
const bytes = fakeJpeg();
const pre = await api('POST', '/media/presign', {
  token,
  body: { familyId, fileName: 'probe.jpg', mimeType: 'image/jpeg', byteSize: String(bytes.length) },
});
const uploadUrl = pre.data?.uploadUrl;
const fileKey = pre.data?.fileKey;
line(
  pre.status === 200 && typeof uploadUrl === 'string' && uploadUrl.startsWith(`${MEDIA}/upload?`),
  '② presign 返回**自家收单端点**（不再是 upload.local 占位）',
  uploadUrl?.replace(/sig=[0-9a-f]+/, 'sig=***'),
);
line(
  typeof fileKey === 'string' && /^f\/\d+\/[\w.-]+\.jpg$/.test(fileKey),
  '③ fileKey 前缀与扩展名正确',
  fileKey,
);

// ── 真上传（multipart/form-data，模拟 Taro.uploadFile）────────────────
const form = new FormData();
form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'probe.jpg');
const up = await fetch(uploadUrl, { method: 'POST', body: form });
const upJson = await up.json().catch(() => ({}));
line(
  up.status === 200 && upJson?.code === 0 && upJson?.data?.byteSize === bytes.length,
  '④ 上传成功（字节数一致）',
  `HTTP ${up.status} byteSize=${upJson?.data?.byteSize}`,
);

// ── 回读 ────────────────────────────────────────────────────────────
const readUrl = `${MEDIA}/${fileKey}`;
const rd = await fetch(readUrl);
const back = Buffer.from(await rd.arrayBuffer());
line(
  rd.status === 200 &&
    rd.headers.get('content-type') === 'image/jpeg' &&
    rd.headers.get('x-content-type-options') === 'nosniff' &&
    back.equals(bytes),
  '⑤ 回读字节完全一致 + Content-Type/nosniff 正确',
  `${readUrl} ${rd.status} ${rd.headers.get('content-type')} ${back.length}B`,
);

// ── 伪造签名必须被拒 ────────────────────────────────────────────────
const forged = await fetch(uploadUrl.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`), {
  method: 'POST',
  body: form,
});
line(forged.status === 403, '⑥ 伪造签名 → 403（上传位不可瞎打）', `HTTP ${forged.status}`);

// ── confirm + list.url ─────────────────────────────────────────────
const conf = await api('POST', '/media/confirm', {
  token,
  body: {
    familyId,
    fileKey,
    mimeType: 'image/jpeg',
    byteSize: String(bytes.length),
    compressed: true,
    exifStripped: true,
    hadGps: false,
    storageClass: 'STANDARD',
  },
});
line(conf.status === 200 && conf.data?.asset?.fileKey === fileKey, '⑦ confirm 登记成功', `assetId=${conf.data?.asset?.id}`);

const list = await api('GET', `/media?familyId=${familyId}`, { token });
const item = (list.data?.items ?? []).find((i) => i.fileKey === fileKey);
line(item?.url === readUrl, '⑧ list.url 与回读基址同源', item?.url);

if (typeof item?.url === 'string') {
  const viaList = await fetch(item.url);
  const viaBytes = Buffer.from(await viaList.arrayBuffer());
  line(
    viaList.status === 200 && viaBytes.equals(bytes),
    '⑨ 用列表里的 url 直接打开 → 字节一致（「传上去就能显示」）',
    `${viaList.status} ${viaBytes.length}B`,
  );
}

// ── 头像分池 ───────────────────────────────────────────────────────
const avatar = await api('POST', '/media/presign', {
  token,
  body: { familyId, purpose: 'AVATAR', fileName: 'me.jpg', mimeType: 'image/jpeg', byteSize: '1024' },
});
line(
  typeof avatar.data?.fileKey === 'string' && avatar.data.fileKey.startsWith('a/'),
  '⑩ purpose=AVATAR → fileKey 走 a/<userId>/（与家庭照片分池）',
  avatar.data?.fileKey,
);

console.log(`\n──────────── 共 ${failed === 0 ? '9+2' : '9+2'} 项，失败 ${failed} ────────────`);
process.exit(failed === 0 ? 0 : 1);
