import type { Asset } from './model';

/** Header inspection bounds image allocation; full decoding is still required before rendering. */
export function imageInfo(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, count: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + count));
  let mime: Asset['mime'],
    width = 0,
    height = 0;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n') {
    mime = 'image/png';
    if (v.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') throw new Error('PNG 头部无效');
    width = v.getUint32(16);
    height = v.getUint32(20);
    let offset = 8,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = v.getUint32(offset),
        kind = ascii(offset + 4, 4);
      if (offset + length + 12 > bytes.length) throw new Error('PNG 数据不完整');
      if (kind === 'acTL') throw new Error('纹理暂不支持 APNG 动画');
      offset += length + 12;
      if (kind === 'IEND') {
        ended = true;
        break;
      }
    }
    if (!ended) throw new Error('PNG 缺少结束块');
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('JPEG 标记无效');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = v.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 数据不完整');
      if ([192, 193, 194].includes(marker)) {
        if (length < 8) throw new Error('JPEG 帧头无效');
        height = v.getUint16(offset + 3);
        width = v.getUint16(offset + 5);
      }
      offset += length;
    }
  } else if (bytes.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    mime = 'image/webp';
    if (v.getUint32(4, true) + 8 > bytes.length) throw new Error('WebP 数据不完整');
    const kind = ascii(12, 4);
    if (kind === 'VP8X') {
      if (bytes.length < 30) throw new Error('WebP 扩展头无效');
      if (bytes[20] & 2) throw new Error('纹理暂不支持 WebP 动画');
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (kind === 'VP8 ' && bytes.length >= 30 && ascii(23, 3) === '\x9d\x01\x2a') {
      width = v.getUint16(26, true) & 16383;
      height = v.getUint16(28, true) & 16383;
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      const bits = v.getUint32(21, true);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  } else throw new Error('纹理仅支持静态 PNG、JPEG、WebP 原始图片');
  if (!width || !height || Math.max(width, height) > 8192 || width * height > 16777216)
    throw new Error('纹理尺寸无效或超过 8192 边长 / 1600 万像素限制');
  return { mime, width, height };
}
export async function sha256(bytes: Uint8Array) {
  const data = Uint8Array.from(bytes);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export async function checkedImage(bytes: Uint8Array, asset: Asset) {
  const info = imageInfo(bytes);
  if (
    info.mime !== asset.mime ||
    bytes.length !== asset.bytes ||
    (await sha256(bytes)) !== asset.blobId
  )
    throw new Error(`图片内容或哈希不匹配：${asset.name}`);
  return info;
}
