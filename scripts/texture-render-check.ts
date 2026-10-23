import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import type { Project } from '../src/core/model';

/** Uses the running editor's renderer modules; --renderer requires the development server. */
export async function textureRenderCheck(
  browser: Browser,
  origin: string,
  project: Project,
  sceneId: string,
  panelId: string,
  cameraId: string,
) {
  const page = await browser.newPage();
  // tsx/esbuild may retain nested function names in callbacks serialized by Playwright.
  await page.addInitScript('globalThis.__name = (fn) => fn');
  await page.route('**/texture-render-check', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Renderer integration</title>',
    }),
  );
  await page.goto(origin + '/texture-render-check');
  const input = { project, sceneId, panelId, cameraId };
  let requests = 0;
  await page.route('**/api/blobs/*', async (route) => {
    requests++;
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 350));
    await route.fulfill({ response });
  });
  const success = await page.evaluate(async ({ project, sceneId, panelId, cameraId }) => {
    const path = '/src/render/scene.ts',
      { SceneRenderer } = await import(path);
    const renderer = new SceneRenderer(),
      started = performance.now();
    renderer.setProject(project, sceneId);
    const loadingBefore = renderer.loading;
    let earlyError = '';
    try {
      renderer.render(renderer.objects.get(cameraId), 480, 270);
    } catch (e) {
      earlyError = String(e);
    }
    await renderer.ready();
    const elapsed = performance.now() - started;
    renderer.evaluate(0);
    renderer.render(renderer.objects.get(cameraId), 480, 270);
    const material = renderer.objects.get(panelId).material;
    const maps = ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'aoMap', 'emissiveMap'].map(
      (key) => ({
        key,
        channel: material[key].channel,
        colorSpace: material[key].colorSpace,
        width: material[key].image.width,
      }),
    );
    const images: ImageBitmap[] = maps.map(({ key }) => material[key].image),
      gpuBefore = renderer.renderer.info.memory.textures;
    renderer.clear();
    const closed = images.every((image) => image.width === 0),
      gpuAfter = renderer.renderer.info.memory.textures;
    renderer.dispose();
    return { loadingBefore, earlyError, elapsed, maps, closed, gpuBefore, gpuAfter };
  }, input);
  assert.equal(requests, 2);
  assert.ok(success.loadingBefore);
  assert.match(success.earlyError, /就绪/);
  assert.ok(success.elapsed >= 350);
  assert.ok(success.closed);
  assert.ok(success.gpuBefore > 0);
  assert.equal(success.gpuAfter, 0);
  assert.deepEqual(
    success.maps.map((m) => m.colorSpace),
    ['srgb', '', '', '', '', 'srgb'],
  );
  assert.equal(success.maps.find((m) => m.key === 'aoMap')!.channel, 1);
  await page.unroute('**/api/blobs/*');
  await page.route('**/api/blobs/*', (route) =>
    route.fulfill({ status: 404, body: 'missing texture' }),
  );
  const failed = await page.evaluate(async ({ project }) => {
    const path = '/src/render/timeline.ts',
      { TimelineRenderer } = await import(path);
    const renderer = new TimelineRenderer(document.createElement('canvas'), project);
    try {
      await renderer.render(0);
      return '';
    } catch (e) {
      return String(e);
    } finally {
      renderer.dispose();
    }
  }, input);
  assert.match(failed, /纹理读取失败/);
  await page.unroute('**/api/blobs/*');
  await page.route('**/api/blobs/*', async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 250));
    await route.fulfill({ response });
  });
  const cancelled = await page.evaluate(async ({ project, sceneId, cameraId }) => {
    const path = '/src/render/scene.ts',
      { SceneRenderer } = await import(path);
    const renderer = new SceneRenderer();
    renderer.setProject(project, sceneId);
    const previous = renderer.ready().then(
      () => 'resolved',
      (e: unknown) => String(e),
    );
    const next = structuredClone(project);
    next.materials.forEach((m) => {
      delete m.textures;
    });
    renderer.setProject(next, sceneId);
    await renderer.ready();
    const oldResult = await previous;
    renderer.evaluate(0);
    renderer.render(renderer.objects.get(cameraId), 480, 270);
    const result = {
      oldResult,
      loading: renderer.loading,
      error: renderer.textureError,
      newestProject: renderer.project === next,
    };
    renderer.dispose();
    return result;
  }, input);
  assert.notEqual(cancelled.oldResult, 'resolved');
  assert.equal(cancelled.error, '');
  assert.equal(cancelled.loading, false);
  assert.ok(cancelled.newestProject);
  await page.unroute('**/api/blobs/*');
  // Compare a sampled color/ORM texel against the equivalent material factors in the same actual GPU pipeline.
  const lateDecode = await page.evaluate(async ({ project, sceneId }) => {
    const path = '/src/render/scene.ts',
      { SceneRenderer } = await import(path);
    const originalDecode = window.createImageBitmap.bind(window),
      decoded: ImageBitmap[] = [];
    let signalStarted!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = await originalDecode(...args);
      decoded.push(bitmap);
      signalStarted();
      await gate;
      return bitmap;
    }) as typeof createImageBitmap;
    const renderer = new SceneRenderer();
    try {
      renderer.setProject(project, sceneId);
      const previous = renderer.ready().catch((e: unknown) => String(e));
      await started;
      renderer.clear();
      release();
      await previous;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { decoded: decoded.length, closed: decoded.every((image) => image.width === 0) };
    } finally {
      release();
      window.createImageBitmap = originalDecode;
      renderer.dispose();
    }
  }, input);
  assert.ok(lateDecode.decoded > 0);
  assert.ok(lateDecode.closed);
  const semantics = await page.evaluate(async ({ project, sceneId, panelId, cameraId }) => {
    const path = '/src/render/scene.ts',
      { SceneRenderer } = await import(path);
    const renderer = new SceneRenderer(),
      panel = project.entities.find((e) => e.id === panelId)!;
    const material = project.materials.find((m) => m.id === panel.materialId)!;
    const source = structuredClone(project),
      g = source.geometries.find((g) => g.id === panel.geometryId)!;
    g.uv = g.positions.map(() => [0.25, 0.25]);
    g.uv1 = g.positions.map(() => [0.25, 0.25]);
    const read = async (p: Project) => {
      renderer.setProject(p, sceneId);
      await renderer.ready();
      renderer.evaluate(0);
      renderer.render(renderer.objects.get(cameraId), 480, 270);
      const gl = renderer.renderer.getContext(),
        bytes = new Uint8Array(4);
      gl.readPixels(215, 159, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return Array.from(bytes).slice(0, 3);
    };
    const srgb = (n: number) =>
      n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4;
    const color = structuredClone(source),
      cm = color.materials.find((m) => m.id === material.id)!;
    cm.emissive = [0, 0, 0];
    cm.textures = { baseColor: material.textures!.baseColor };
    cm.alphaMode = 'OPAQUE';
    const mapped = await read(color),
      constant = structuredClone(color),
      cc = constant.materials.find((m) => m.id === material.id)!;
    delete cc.textures;
    cc.linearColor = [230, 40, 30].map(srgb) as [number, number, number];
    const constantColor = await read(constant);
    const orm = structuredClone(source),
      om = orm.materials.find((m) => m.id === material.id)!;
    om.emissive = [0, 0, 0];
    om.alphaMode = 'OPAQUE';
    om.textures = {
      metallicRoughness: {
        ...material.textures!.metallicRoughness!,
        magFilter: 'nearest',
        minFilter: 'nearest',
      },
    };
    const ormMapped = await read(orm),
      ormConstant = structuredClone(orm),
      oc = ormConstant.materials.find((m) => m.id === material.id)!;
    delete oc.textures;
    oc.metalness *= 200 / 255;
    oc.roughness *= 106 / 255;
    const constantORM = await read(ormConstant);
    // Rotate by +90 degrees around the UV origin with anisotropic scale, then offset back into the image.
    const rotated = structuredClone(color),
      rm = rotated.materials.find((m) => m.id === material.id)!;
    rm.textures!.baseColor = {
      ...rm.textures!.baseColor!,
      scale: [2, 0.5],
      rotation: Math.PI / 2,
      offset: [0.25, 0.25],
    };
    // Input (.25,.25) -> (.125,.75), sampling the green quadrant.
    const rotatedColor = await read(rotated),
      green = structuredClone(constant),
      gm = green.materials.find((m) => m.id === material.id)!;
    gm.linearColor = [30, 200, 70].map(srgb) as [number, number, number];
    const constantGreen = await read(green);
    const opaque = structuredClone(color),
      og = opaque.geometries.find((g) => g.id === panel.geometryId)!;
    og.uv = og.positions.map(() => [0.75, 0.75]);
    const opaqueAlpha = await read(opaque),
      yellow = structuredClone(constant),
      ym = yellow.materials.find((m) => m.id === material.id)!;
    ym.linearColor = [240, 200, 40].map(srgb) as [number, number, number];
    const constantYellow = await read(yellow);
    renderer.dispose();
    return {
      mapped,
      constantColor,
      ormMapped,
      constantORM,
      rotatedColor,
      constantGreen,
      opaqueAlpha,
      constantYellow,
    };
  }, input);
  const near = (a: number[], b: number[]) =>
    assert.ok(
      a.every((n, i) => Math.abs(n - b[i]) <= 1),
      JSON.stringify({ a, b }),
    );
  near(semantics.mapped, semantics.constantColor);
  near(semantics.ormMapped, semantics.constantORM);
  near(semantics.rotatedColor, semantics.constantGreen);
  near(semantics.opaqueAlpha, semantics.constantYellow);
  const formats = await page.evaluate(async ({ project }) => {
    const path = '/src/core/image.ts',
      { imageInfo } = await import(path),
      response = await fetch(
        '/api/blobs/' + project.assets.find((a) => a.mime === 'image/png')!.blobId,
      );
    const bitmap = await createImageBitmap(await response.blob()),
      canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const result = [];
    for (const mime of ['image/jpeg', 'image/webp']) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), mime),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer()),
        info = imageInfo(bytes),
        decoded = await createImageBitmap(blob, {
          imageOrientation: 'none',
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
      result.push({ ...info, decodedWidth: decoded.width, decodedHeight: decoded.height });
      decoded.close();
    }
    return result;
  }, input);
  assert.deepEqual(
    formats.map((f) => f.mime),
    ['image/jpeg', 'image/webp'],
  );
  formats.forEach((f) => {
    assert.equal(f.width, f.decodedWidth);
    assert.equal(f.height, f.decodedHeight);
  });
  await page.close();
  return {
    checkedAt: new Date().toISOString(),
    browser: browser.version(),
    projectId: project.id,
    requests,
    success,
    failed,
    cancelled,
    lateDecode,
    semantics,
    formats,
  };
}
