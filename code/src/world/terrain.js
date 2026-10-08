// 地形。全部由周期噪声生成，所以它天然可平铺。
//
// 无缝的关键只有一行：网格的对齐点 = round(px / tile) * tile。
// 玩家穿越边界时坐标减去 tile，摄像机位移正好是 -tile，
// 而网格对齐点也正好变化 -tile —— 相对画面一动不动。

import * as THREE from 'three';
import { terrainHeight, groundBlend, pathInfluence, pathDistance } from '../core/noise.js';
import { mulberry32 } from '../core/rng.js';
import { applyTextureSet } from '../core/textures.js';

// 顶点色往白里混时用的目标色
const WHITE = new THREE.Color(0xffffff);

// 一张"大部分接近白"的斑驳贴图，只用来轻微调制明暗。
// 故意做得很淡：脏感靠顶点色，不靠贴图。
export function groundTexture(size = 256) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const img = ctx.createImageData(size, size);
	const rnd = mulberry32(9137);
	// 生成一个 64² 的低频底，再双线性放大 → 廉价但够用的平滑噪声
	const L = 32;
	const low = new Float32Array(L * L);
	for (let i = 0; i < low.length; i++) low[i] = 0.82 + rnd() * 0.18;
	const sample = (fx, fy) => {
		const x = fx * L;
		const y = fy * L;
		const x0 = Math.floor(x) % L;
		const y0 = Math.floor(y) % L;
		const x1 = (x0 + 1) % L;
		const y1 = (y0 + 1) % L;
		const tx = x - Math.floor(x);
		const ty = y - Math.floor(y);
		const sx = tx * tx * (3 - 2 * tx);
		const sy = ty * ty * (3 - 2 * ty);
		const a = low[y0 * L + x0] + (low[y0 * L + x1] - low[y0 * L + x0]) * sx;
		const b = low[y1 * L + x0] + (low[y1 * L + x1] - low[y1 * L + x0]) * sx;
		return a + (b - a) * sy;
	};
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const v = sample(x / size, y / size);
			const g = Math.max(0, Math.min(255, Math.round(v * 255)));
			const i = (y * size + x) * 4;
			img.data[i] = g;
			img.data[i + 1] = g;
			img.data[i + 2] = g;
			img.data[i + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	const tex = new THREE.CanvasTexture(c);
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	// 地形平面是 2 × tile = 392 m。repeat 让贴图平铺单元约 3.4 m ——
	// 比原来的 8.5 m 密，配合更细的网格，近处地面才有"土"的质感
	// 而不是一片模糊。
	tex.repeat.set(115, 115);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 8;
	return tex;
}

export function createTerrain(cfg) {
	const tile = cfg.world.tile;
	const size = tile * 2; // 400 m：保证玩家周围至少 100 m 地面被覆盖
	const seg = cfg.world.groundSegments;

	const geo = new THREE.PlaneGeometry(size, size, seg, seg);
	geo.rotateX(-Math.PI / 2);

	const pos = geo.attributes.position;
	const count = pos.count;
	const colors = new Float32Array(count * 3);

const mud = new THREE.Color(cfg.palette.mud);
const moss = new THREE.Color(cfg.palette.moss);
const rot = new THREE.Color(cfg.palette.rot);
const trail = new THREE.Color(cfg.palette.trail);
const tmp = new THREE.Color();
const tmp2 = new THREE.Color();

for (let i = 0; i < count; i++) {
	// 注意：这里用局部坐标采样。因为世界是周期函数，局部坐标与
	// 世界坐标（差一个 tile 的整数倍）得到的高度完全一致，所以无需换算。
	const x = pos.getX(i);
	const z = pos.getZ(i);
	pos.setY(i, terrainHeight(x, z, cfg));

	const w = groundBlend(x, z, cfg); // 湿度
	const wobble = groundBlend(x * 3.7 + 51, z * 3.7 - 17, cfg);
	tmp.copy(mud).lerp(moss, THREE.MathUtils.clamp((w - 0.32) * 1.9, 0, 1));
	// 低洼积水处压暗偏向腐殖质
	tmp2.copy(rot);
	tmp.lerp(tmp2, THREE.MathUtils.clamp((0.42 - w) * 2.4 + (wobble - 0.5) * 0.5, 0, 0.85));

	// ── 山路 ──────────────────────────────────────────────
	// 路面的颜色逻辑和别处不同：它不能被湿度主导。
	// 踩实的土是**裸露的矿质土**——腐殖层被磨掉了，所以偏灰、偏亮、
	// 且完全不受苔藓影响。这是"路"和"泥地"在颜色上唯一可靠的区别。
	//
	// 分层：
	//   inf = 1          路面正中：实土 + 一点被踩碎的叶屑的暖调
	//   0 < inf < 1      路缘：实土与腐殖质的混合带（落叶堆积处）
	//   inf = 0          普通林地
	const inf = pathInfluence(x, z, cfg);
	if (inf > 0.001) {
		tmp2.copy(trail);
		// 路面上撒一点斑驳：完全均匀的路面看起来像一条丝带，很假
		const patch = groundBlend(x * 11.3 + 7, z * 11.3 + 19, cfg);
		tmp2.multiplyScalar(0.86 + patch * 0.3);
		tmp.lerp(tmp2, inf * 0.94);
	}

	// 色板里的值是"材质本色"，还需要过光照，所以整体提亮一档
	tmp.multiplyScalar(cfg.atmosphere.groundGain);

	// ── 真彩贴图下顶点色必须退居"调色"位 ─────────────────────
	// 原来这里只有顶点色承担全部颜色，贴图（接近白的程序噪声）只负责
	// 轻微斑驳 —— 相乘之后还是顶点色的颜色。
	// 换成 ImageGen 的真彩地面贴图后，贴图自带泥/苔/落叶的颜色细节，
	// 再乘一遍顶点色就是双重上色，整片地面会暗成一团。
	// 所以把顶点色往白里混，只保留"泥地 / 苔藓 / 山路"的大块区分。
	const keep = cfg.textures?.enabled ? cfg.textures.groundVertexTint : 1;
	if (keep < 1) {
		tmp.lerp(WHITE, 1 - keep);
	}

	colors[i * 3] = Math.min(1, tmp.r);
	colors[i * 3 + 1] = Math.min(1, tmp.g);
	colors[i * 3 + 2] = Math.min(1, tmp.b);
}

	geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	geo.computeVertexNormals();

	const mat = new THREE.MeshStandardMaterial({
		vertexColors: true,
		roughness: 1.0,
		metalness: 0.0,
	});
	// 真彩地面贴图（泥/苔/落叶），加载完成后异步贴上；失败则保持纯顶点色。
	// 法线贴图在运行时从明度推导（见 core/textures.js），地面法线要弱一点 ——
	// 太强会把整片林地变成"卵石滩"。
	if (cfg.textures?.enabled) {
		applyTextureSet(mat, 'ground', {
			repeatX: cfg.textures.groundRepeat,
			repeatY: cfg.textures.groundRepeat,
			normalScale: 0.55,
		});
	} else {
		mat.map = groundTexture();
	}
	mat.color = new THREE.Color(0xffffff);

	const mesh = new THREE.Mesh(geo, mat);
	mesh.receiveShadow = true;
	mesh.matrixAutoUpdate = false;
	return mesh;
}

// 每帧把地形网格吸附到 tile 的整数倍位置。
export function snapTerrain(mesh, px, pz, cfg) {
	const T = cfg.world.tile;
	mesh.position.x = Math.round(px / T) * T;
	mesh.position.z = Math.round(pz / T) * T;
	mesh.position.y = 0;
	mesh.updateMatrix();
}
