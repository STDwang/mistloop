// 外部贴图资产的统一入口。
//
// ─────────────────────────────────────────────────────────────
// 【为什么这个模块存在】
// 宪法原本是"零外部素材"。2026-10-08 经用户批准修订为：
//   "零下载素材；允许 ImageGen 自产贴图与 Blender 自建模型" ——
// 即素材必须是**我们自己造的**，不许从网上抓。
// 三张贴图（树皮/地面/岩石）由 ImageGen 生成、assets/prep-textures.py
// 裁水印 + 可平铺化 + 压 JPEG，共 913 KB。
//
// 【为什么法线贴图在运行时算，而不是存文件】
// 一张 1024² 的法线 PNG ≈ 1.5 MB，三张就是 4.5 MB —— 比彩色贴图本身还大。
// 而法线的全部信息就是明度的梯度，Sobel 算一次只要几毫秒。
// 用体积换几毫秒的一次性开销，不划算。
//
// 【为什么是异步填充而不是阻塞等待】
// 宪法要求首帧 < 1.5 s 且不许出现进度条。所以材质先以纯色出生，
// 贴图在标题屏背后加载完再"贴上去"（needsUpdate = true）。
// 加载失败则永远保持纯色 —— 游戏照跑，只是没那么好看。
// 这也是为什么这里不返回 Promise：调用方不需要知道"贴图什么时候来"。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';

const cache = new Map();

// Sobel：从明度场推切线空间法线。
// 边界用取模环绕 —— 贴图本身是可平铺的，法线也必须可平铺，
// 否则每块 3.4 m 的地面单元边上会有一圈"凸起的框"。
function normalFromImage(img, strength) {
	const size = 512; // 法线用 512² 足够：高频细节本来就会被 mipmap 抹掉
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	ctx.drawImage(img, 0, 0, size, size);
	const src = ctx.getImageData(0, 0, size, size).data;

	const lum = new Float32Array(size * size);
	for (let i = 0; i < lum.length; i++) {
		const j = i * 4;
		lum[i] = (src[j] * 0.299 + src[j + 1] * 0.587 + src[j + 2] * 0.114) / 255;
	}

	const data = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		const yUp = (y - 1 + size) % size;
		const yDn = (y + 1) % size;
		for (let x = 0; x < size; x++) {
			const xL = (x - 1 + size) % size;
			const xR = (x + 1) % size;
			// 图像坐标的 y 向下，而 UV 的 v 向上 —— 这里直接按 UV 语义取梯度
			const dx = (lum[y * size + xR] - lum[y * size + xL]) * strength;
			const dy = (lum[yDn * size + x] - lum[yUp * size + x]) * strength;
			// n = normalize(-du, -dv, 1)，再编码到 [0,255]
			const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
			const o = (y * size + x) * 4;
			data[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
			data[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
			data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
			data[o + 3] = 255;
		}
	}

	// 上面按 UV 语义取梯度，但行序仍是图像序（第 0 行 = 图像顶部）。
	// albedo 走 TextureLoader 默认 flipY=true，法线必须同样翻转才对得上，
	// 而 DataTexture 不吃 flipY —— 所以在这里手动把行序倒过来。
	const row = size * 4;
	const flipped = new Uint8Array(data.length);
	for (let y = 0; y < size; y++) {
		flipped.set(data.subarray((size - 1 - y) * row, (size - y) * row), y * row);
	}

	const tex = new THREE.DataTexture(flipped, size, size);
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.needsUpdate = true;
	return tex;
}

function configure(tex, rx, ry) {
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(rx, ry);
	tex.anisotropy = 8; // 渲染器会自动夹到硬件上限，不用探测
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

/**
 * 把一组贴图（彩色 + 运行时推导的法线）异步贴到材质上。
 * 同名贴图只加载一次，多个材质共享同一个 THREE.Texture。
 * @param {THREE.MeshStandardMaterial} mat 目标材质
 * @param {string} name public/textures/ 下的文件名（不带扩展名）
 * @param {{repeatX?:number, repeatY?:number, normalScale?:number}} opts
 */
export function applyTextureSet(mat, name, opts = {}) {
	const rx = opts.repeatX ?? 1;
	const ry = opts.repeatY ?? 1;
	const ns = opts.normalScale ?? 1;

	let entry = cache.get(name);
	if (!entry) {
		entry = { map: null, normalMap: null, rx, ry, subs: [], ns: new Map() };
		cache.set(name, entry);
		new THREE.TextureLoader().load(
			`textures/${name}.jpg`,
			(tex) => {
				entry.map = configure(tex, entry.rx, entry.ry);
				entry.normalMap = normalFromImage(tex.image, 2.2);
				entry.normalMap.repeat.set(entry.rx, entry.ry);
				for (const s of entry.subs) {
					s.map = entry.map;
					s.normalMap = entry.normalMap;
					const k = entry.ns.get(s) ?? 1;
					s.normalScale = new THREE.Vector2(k, k);
					s.needsUpdate = true;
				}
			},
			undefined,
			() => console.warn(`[资产] 贴图加载失败：${name}（保持纯色材质）`),
		);
	}

	entry.subs.push(mat);
	entry.ns.set(mat, ns);
	// 已在缓存里（晚到的调用者）就直接挂上，不用等第二次回调
	if (entry.map) mat.map = entry.map;
	if (entry.normalMap) mat.normalMap = entry.normalMap;
	mat.normalScale = new THREE.Vector2(ns, ns);
	mat.needsUpdate = true;
}
