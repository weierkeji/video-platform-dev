import * as THREE from 'three';
import { checkedImage } from '../core/image';
import {
  textureSlots,
  type Asset,
  type Project,
  type TextureBinding,
  type TextureSlot,
} from '../core/model';

const wrapping = {
  repeat: THREE.RepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
  mirror: THREE.MirroredRepeatWrapping,
};
const filters = {
  nearest: THREE.NearestFilter,
  linear: THREE.LinearFilter,
  'nearest-mipmap-nearest': THREE.NearestMipmapNearestFilter,
  'linear-mipmap-nearest': THREE.LinearMipmapNearestFilter,
  'nearest-mipmap-linear': THREE.NearestMipmapLinearFilter,
  'linear-mipmap-linear': THREE.LinearMipmapLinearFilter,
};
export function textureMatrix(b: TextureBinding) {
  // KHR_texture_transform: offset + rotation * scale * uv. UV origin is image upper-left.
  const c = Math.cos(b.rotation),
    s = Math.sin(b.rotation);
  return new THREE.Matrix3().set(
    c * b.scale[0],
    -s * b.scale[1],
    b.offset[0],
    s * b.scale[0],
    c * b.scale[1],
    b.offset[1],
    0,
    0,
    1,
  );
}
export function configureTexture(texture: THREE.Texture, b: TextureBinding, color: boolean) {
  texture.flipY = false;
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.channel = b.texCoord;
  texture.wrapS = wrapping[b.wrapS];
  texture.wrapT = wrapping[b.wrapT];
  texture.magFilter = filters[b.magFilter];
  texture.minFilter = filters[b.minFilter];
  texture.matrixAutoUpdate = false;
  texture.matrix.copy(textureMatrix(b));
  texture.needsUpdate = true;
  return texture;
}
export class TextureBank {
  private controller = new AbortController();
  private images = new Map<string, Promise<ImageBitmap>>();
  private textures = new Map<string, Promise<THREE.Texture>>();
  private bitmaps = new Set<ImageBitmap>();
  private allocated = new Set<THREE.Texture>();
  private pixels = 0;
  private decodedPixels = 0;
  private encodedBytes = 0;
  private disposed = false;
  constructor(
    private project: Project,
    private maxSize = 8192,
  ) {}
  private image(asset: Asset) {
    if (!this.images.has(asset.blobId))
      this.images.set(
        asset.blobId,
        (async () => {
          this.encodedBytes += asset.bytes;
          if (this.encodedBytes > 50 * 1024 * 1024)
            throw new Error('当前场景贴图文件合计超过 50 MB');
          const response = await fetch(`/api/blobs/${asset.blobId}`, {
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
          });
          if (!response.ok) throw new Error(`纹理读取失败：${asset.name}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const info = await checkedImage(bytes, asset);
          if (Math.max(info.width, info.height) > this.maxSize)
            throw new Error(`纹理超过当前 GPU 最大尺寸：${asset.name}`);
          if (this.disposed) throw new Error('纹理加载已取消');
          this.decodedPixels += info.width * info.height;
          if (this.decodedPixels > 67108864)
            throw new Error('当前场景图片超过 6400 万解码像素限制');
          const image = await createImageBitmap(new Blob([bytes], { type: asset.mime }), {
            imageOrientation: 'none',
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          });
          if (this.disposed) {
            image.close();
            throw new Error('纹理加载已取消');
          }
          if (image.width !== info.width || image.height !== info.height) {
            image.close();
            throw new Error(`纹理解码尺寸不匹配：${asset.name}`);
          }
          this.bitmaps.add(image);
          return image;
        })(),
      );
    return this.images.get(asset.blobId)!;
  }
  async load(binding: TextureBinding, slot: TextureSlot) {
    if (this.disposed) throw new Error('纹理加载已取消');
    const asset = this.project.assets.find((a) => a.id === binding.assetId);
    if (!asset || asset.kind !== 'image') throw new Error('纹理图片引用无效');
    const color = slot === 'baseColor' || slot === 'emissive';
    const key = JSON.stringify({ ...binding, assetId: asset.blobId, color });
    if (!this.textures.has(key))
      this.textures.set(
        key,
        (async () => {
          const image = await this.image(asset);
          if (this.disposed) throw new Error('纹理加载已取消');
          this.pixels += image.width * image.height;
          if (this.pixels > 67108864) throw new Error('当前场景纹理超过 6400 万 GPU 纹素限制');
          const texture = configureTexture(new THREE.Texture(image), binding, color);
          this.allocated.add(texture);
          return texture;
        })(),
      );
    return this.textures.get(key)!;
  }
  async apply(material: THREE.MeshStandardMaterial, source: Project['materials'][number]) {
    await Promise.all(
      textureSlots.map(async (slot) => {
        const binding = source.textures?.[slot];
        if (!binding) return;
        const texture = await this.load(binding, slot);
        if (this.disposed) return;
        if (slot === 'baseColor') material.map = texture;
        if (slot === 'metallicRoughness') {
          material.metalnessMap = texture;
          material.roughnessMap = texture;
        }
        if (slot === 'normal') {
          material.normalMap = texture;
          material.normalScale.setScalar(source.normalScale ?? 1);
        }
        if (slot === 'occlusion') {
          material.aoMap = texture;
          material.aoMapIntensity = source.occlusionStrength ?? 1;
        }
        if (slot === 'emissive') material.emissiveMap = texture;
        material.needsUpdate = true;
      }),
    );
  }
  dispose() {
    this.disposed = true;
    this.controller.abort();
    this.allocated.forEach((t) => t.dispose());
    this.allocated.clear();
    this.bitmaps.forEach((b) => b.close());
    this.bitmaps.clear();
    this.images.clear();
    this.textures.clear();
  }
}
