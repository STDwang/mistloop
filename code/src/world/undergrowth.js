// 地表植被：蕨草 / 枯草 / 苔垫 / 灌木。
//
// ─────────────────────────────────────────────────────────────
// 【为什么要分四种，而不是"一种草铺满"】
//
// v1 只有一种三片交叉的蕨草，密度 0.42。问题不在数量，在**同质**：
// 整片林地是同一种植物、同一个高度、同一个色相，眼睛扫过去读到的
// 是"一层贴图"，不是"一片地"。人对植被的感知靠的是**边缘的杂乱**——
// 高矮差、疏密差、颜色的冷暖差。
//
// 所以这一版改成"分层播种"：
//   ① 苔垫  ground   —— 贴地、扁、暗。它的作用是**盖住裸地**，
//                        让草和土之间有过渡，而不是草直接插在土上
//   ② 蕨草  fern     —— 主体层，中等高度，垂叶
//   ③ 枯草  drygrass —— 细长、干枯、偏黄。穿插在蕨草里打破同色
//   ④ 灌木  shrub    —— 稀疏、矮、团状。给近景一个"挡住脚"的层次
//
// 四层共用同一个 InstancedMesh 吗？不 —— 它们贴图不同、材质参数不同
// （苔垫几乎不需要 alphaTest 剔除，灌木需要），合在一起会互相妥协。
// 分开是 +3 draw call，换来的是每一层都能单独调。这个交换很划算：
// 4 个 draw call 在总计 40 个里占不到 10%。
//
// 四层都遵守同一条铁律：**让开山路**（见下）。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { ihash2, imod, mulberry32 } from '../core/rng.js';
import { terrainHeight, pathInfluence, groundBlend } from '../core/noise.js';
import { mergeGeoms } from '../core/geometry.js';

// ── 贴图 ───────────────────────────────────────────────────────

// 蕨草：细长下垂的叶片，从底部散开
function fernTexture(size = 256) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const rnd = mulberry32(7717);

	// 先铺一层贴地的枯叶，让草丛"站得住"而不是悬在空中
	for (let i = 0; i < 70; i++) {
		const x = rnd() * size;
		const y = size * (0.82 + rnd() * 0.18);
		const r = size * (0.012 + rnd() * 0.03);
		const v = 30 + Math.floor(rnd() * 34);
		ctx.fillStyle = `rgba(${v + 18},${v + 10},${v},${0.5 + rnd() * 0.4})`;
		ctx.beginPath();
		ctx.ellipse(x, y, r * 1.7, r, rnd() * 3.14, 0, 6.283);
		ctx.fill();
	}

	const blades = 30;
	for (let i = 0; i < blades; i++) {
		const x0 = size * (0.5 + (rnd() - 0.5) * 0.62);
		const h = size * (0.42 + rnd() * 0.52);
		const bend = (rnd() - 0.5) * size * 0.55;
		const w = size * (0.014 + rnd() * 0.026);
		const v = 26 + Math.floor(rnd() * 44);
		const a = 0.65 + rnd() * 0.35;
		ctx.fillStyle = `rgba(${v + 4},${v + 14},${v - 2},${a})`;
		ctx.beginPath();
		ctx.moveTo(x0 - w, size);
		ctx.quadraticCurveTo(x0 - w + bend * 0.5, size - h * 0.55, x0 + bend, size - h);
		ctx.quadraticCurveTo(x0 + w + bend * 0.5, size - h * 0.55, x0 + w, size);
		ctx.closePath();
		ctx.fill();
	}
	return finishTexture(c, 2);
}

// 枯草：比蕨草细得多、直、偏黄。作用是打断蕨草的绿。
function dryGrassTexture(size = 256) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const rnd = mulberry32(4471);
	ctx.clearRect(0, 0, size, size);

	const blades = 46;
	for (let i = 0; i < blades; i++) {
		const x0 = size * (0.5 + (rnd() - 0.5) * 0.86);
		const h = size * (0.5 + rnd() * 0.46);
		// 枯草是"倒伏"的：末端甩得更远
		const bend = (rnd() - 0.5) * size * 0.7;
		const w = size * (0.005 + rnd() * 0.012);
		// 偏黄：R > G > B，这是枯草和活草最省事的区分
		const v = 60 + Math.floor(rnd() * 60);
		const a = 0.5 + rnd() * 0.45;
		ctx.strokeStyle = `rgba(${v + 40},${v + 18},${v - 12},${a})`;
		ctx.lineWidth = w;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(x0, size);
		ctx.quadraticCurveTo(x0 + bend * 0.35, size - h * 0.6, x0 + bend, size - h);
		ctx.stroke();
	}
	return finishTexture(c, 2);
}

// 苔垫：不是"一株植物"，是一片贴地的暗斑。
// 它几乎不用 alphaTest —— 靠概率形状本身就是一个柔软的边缘。
function mossTexture(size = 128) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const rnd = mulberry32(2251);
	ctx.clearRect(0, 0, size, size);

	// 从中心向外堆软斑，形成一个不规则的圆团
	for (let i = 0; i < 60; i++) {
		const ang = rnd() * Math.PI * 2;
		const r = Math.pow(rnd(), 0.6) * size * 0.44;
		const x = size * 0.5 + Math.cos(ang) * r;
		const y = size * 0.5 + Math.sin(ang) * r * 0.8;
		const rad = size * (0.06 + rnd() * 0.14);
		const v = 34 + Math.floor(rnd() * 26);
		const a = 0.24 + rnd() * 0.3;
		const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
		g.addColorStop(0, `rgba(${v + 6},${v + 14},${v},${a})`);
		g.addColorStop(1, `rgba(${v},${v + 8},${v - 4},0)`);
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, rad, 0, 6.284);
		ctx.fill();
	}
	// 苔垫上撒几根细碎的短叶，不然近看是一团糊
	for (let i = 0; i < 90; i++) {
		const ang = rnd() * Math.PI * 2;
		const r = Math.pow(rnd(), 0.5) * size * 0.4;
		const x = size * 0.5 + Math.cos(ang) * r;
		const y = size * 0.5 + Math.sin(ang) * r * 0.8;
		const len = size * (0.03 + rnd() * 0.05);
		const v = 44 + Math.floor(rnd() * 40);
		ctx.strokeStyle = `rgba(${v},${v + 12},${v - 6},${0.4 + rnd() * 0.4})`;
		ctx.lineWidth = size * 0.006;
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x + (rnd() - 0.5) * len, y - len * (0.4 + rnd() * 0.6));
		ctx.stroke();
	}
	return finishTexture(c, 2);
}

// 灌木：一个小叶团。与蕨草的区别是"有体积"——它在中景会挡住脚。
function shrubTexture(size = 256) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const rnd = mulberry32(6101);
	ctx.clearRect(0, 0, size, size);

	// 枝干：从底部往上分叉，给叶团一个"长在什么东西上"的依据
	for (let i = 0; i < 9; i++) {
		const x0 = size * (0.5 + (rnd() - 0.5) * 0.3);
		const h = size * (0.3 + rnd() * 0.36);
		const bend = (rnd() - 0.5) * size * 0.26;
		const v = 40 + Math.floor(rnd() * 22);
		ctx.strokeStyle = `rgba(${v + 10},${v + 4},${v - 6},0.85)`;
		ctx.lineWidth = size * (0.008 + rnd() * 0.009);
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(x0, size);
		ctx.quadraticCurveTo(x0 + bend * 0.4, size - h * 0.6, x0 + bend, size - h);
		ctx.stroke();
	}

	// 叶团：一堆大小不一的小椭圆，聚在上半部
	for (let i = 0; i < 150; i++) {
		const x = size * (0.5 + (rnd() - 0.5) * 0.86);
		const y = size * (0.24 + rnd() * 0.56);
		// 越靠外越稀疏 —— 团状中心的叶子密，边缘稀
		const dc = Math.hypot(x / size - 0.5, (y / size - 0.5) * 0.85);
		if (dc > 0.42 && rnd() < (dc - 0.42) * 3.2) continue;
		const r = size * (0.012 + rnd() * 0.03);
		const v = 28 + Math.floor(rnd() * 38);
		const a = 0.5 + rnd() * 0.45;
		ctx.fillStyle = `rgba(${v + 8},${v + 18},${v - 2},${a})`;
		ctx.beginPath();
		ctx.ellipse(x, y, r, r * (1.1 + rnd() * 0.7), rnd() * 3.14, 0, 6.283);
		ctx.fill();
	}
	return finishTexture(c, 2);
}

function finishTexture(c, aniso) {
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = aniso;
	return tex;
}

// ── 几何 ───────────────────────────────────────────────────────

// 三片交叉四边形。比双片更有体积感，代价只有 4 个三角形。
function crossGeometry(w = 1.15, h = 0.9) {
	const parts = [];
	for (let k = 0; k < 3; k++) {
		const p = new THREE.PlaneGeometry(w, h);
		p.translate(0, h / 2, 0);
		p.rotateY((k * Math.PI) / 3);
		parts.push(p);
	}
	return mergeGeoms(parts);
}

// 单片贴地四边形，略微上翘 —— 苔垫不能是平的，
// 平地上一块水平的半透明片在斜视角下会闪。
function patchGeometry(s = 1.0) {
	const p = new THREE.PlaneGeometry(s, s);
	p.rotateX(-Math.PI / 2 + 0.09);
	return p;
}

// ── 分层的参数表 ───────────────────────────────────────────────
//
// 每一项 = 一层植被。加一层只要往这里加一条。
// 「cell 必须能整除 tile」是这个表最容易被忽略的约束：
// 草格不能整除世界周期的话，环面回绕时草会在错的格子上重新长出来。
//
// ─────────────────────────────────────────────────────────────
// 【尺度纪律 · 改任何 scale 之前先读这段】
//
// 用户反馈"主视角下人物的高度似乎只有小孩的身高"。
// 实测 eye=1.66 m 是对的（就是 CFG.player.eye），问题在**植被太高** ——
// 视野被草本填满、看不见远处地面，大脑读出来的结论是"我比别人矮"。
//
// 参照系：eye = 1.66 m，成人膝盖约 0.5 m、腰 1.0 m、胸 1.3 m。
// 各层最终高度 = 几何高 × scale 上界 × 纵向拉伸，必须落在这条带里：
//   moss      贴地 ≤ 0.15 m  —— 它本来就不是立体的
//   fern      0.9 – 1.2 m    —— 齐腰；**到胸口就变成"我是小孩"的确诊证据**
//   drygrass  0.8 – 1.1 m    —— 枯草过腰但不过胸
//   shrub     1.2 – 1.5 m    —— 到肩膀，能挡视线，但绝不超过头顶
// 上界一旦越过 1.66 m，玩家就是在"灌木丛里游泳"，比例感必然崩。
// 这个错觉一旦成立，再改 eye 也没用 —— 只会变成"一个很高的孩子在灌木丛里"。
// ─────────────────────────────────────────────────────────────
const LAYERS = [
	{
		key: 'moss',
		tex: mossTexture,
		geo: () => patchGeometry(1.0),
		max: 900,
		cell: 2.45, // 196 / 2.45 = 80 ✔ 整除
		density: 0.34,
		radius: 17,
		scale: [0.7, 1.25], // 【别调大】苔垫太大时，俯视是一块块圆纸片
		alphaTest: 0.1, // 苔垫边缘要软，剔得太狠会变成一块块圆片
		castShadow: false,
		color: [0.62, 0.78, 0.68, 0.94], // R 范围（灰暗，不抢戏）
		yOff: 0.02, // 微微抬起，避免和地形 z-fighting
		pathClear: 0.72, // 路上几乎是裸土，苔垫让开
	},
	{
		key: 'fern',
		tex: fernTexture,
		// 蕨类几何高 0.62 m（原 0.9）。**这里降几何高，而不是继续压 scale**：
		// 三片交叉四边形靠 scale 缩到 0.5 以下时，三片会挤在一起，
		// 侧看变成一根细棍 —— 缩放解决不了"模板本身就太大"的问题。
		// 0.62 × 1.3 × 1.25 ≈ 1.01 m：齐腰，不再到胸口。
		geo: () => crossGeometry(1.15, 0.62),
		max: 1400,
		cell: 1.4, // 196 / 1.4 = 140 ✔
		density: 0.42,
		radius: 26,
		// 原 [0.75, 1.7] 的最坏情况 ≈ 0.9 × 1.7 × 1.25 ≈ 1.91 m —— 比人还高，
		// 是"视角像小孩"的主犯。现在 [0.85, 1.3] → 0.66–1.01 m。
		scale: [0.85, 1.3],
		alphaTest: 0.42,
		castShadow: false,
		color: [0.5, 1.25, 0.9, 1.06],
		yOff: -0.05,
		pathClear: 0.55, // 路缘还留一点，路上清空
	},
	{
		key: 'drygrass',
		tex: dryGrassTexture,
		// 枯草几何高 0.72 m（原 1.25）。0.72 × 1.05 × 1.25 ≈ 0.95 m：过腰不过胸。
		geo: () => crossGeometry(1.0, 0.72),
		max: 1200,
		cell: 1.4, // 与 fern 同格，但用不同的哈希 —— 两层错开，不像复制
		density: 0.3,
		radius: 24,
		// 原 [0.8, 1.6] 的最坏情况 1.25 × 1.6 × 1.25 = 2.5 m。现在 [0.8, 1.05]。
		scale: [0.8, 1.05],
		alphaTest: 0.36,
		castShadow: false,
		color: [0.6, 1.3, 1.1, 0.62], // 偏黄：G < R
		yOff: -0.04,
		pathClear: 0.8, // 枯草最容易"长在路上"，剔得狠一点
	},
	{
		key: 'shrub',
		tex: shrubTexture,
		// 灌木几何高 1.1 m（原 1.15，几乎不动 —— 灌木本来就该到腰以上）。
		// 1.1 × 1.05 × 1.25 ≈ 1.44 m：到肩膀，能挡视线。
		geo: () => crossGeometry(1.5, 1.1),
		max: 420,
		cell: 3.5, // 196 / 3.5 = 56 ✔
		density: 0.22,
		radius: 30,
		// 原 [0.65, 1.2] × 纵向拉伸 (0.85+0.4) 最坏到 1.6 m。
		// 现在 [0.7, 1.05] → 最高 1.44 m，绝不超过眼高。
		scale: [0.7, 1.05],
		alphaTest: 0.44,
		castShadow: true, // 灌木够大，投影看得出来
		color: [0.42, 0.95, 0.72, 0.92],
		yOff: -0.08,
		pathClear: 0.95, // 灌木绝不长在路上
	},
];

// 种子：每层用自己的，避免两层共用同一套随机数导致"成对出现"
const SEEDS = {
	moss: [0x1f3a, 0x77c1, 0x2b9d, 0x8e14],
	fern: [0x51c7, 0x9a02, 0x3d71, 0x6b45],
	drygrass: [0x2e83, 0xc410, 0x7906, 0x1ad2],
	shrub: [0x6f2b, 0x3c96, 0xb517, 0x4280],
};

export class Undergrowth {
	constructor(cfg, scene) {
		this.cfg = cfg;
		this.group = new THREE.Group();
		scene.add(this.group);

		this.layers = [];
		this._dummy = new THREE.Object3D();
		this._color = new THREE.Color();
		this._lastX = Infinity;
		this._lastZ = Infinity;

		for (const def of LAYERS) {
			// cell 必须整除 tile —— 这是环面周期的硬约束，宁可报错也不要静默出错
			const K = Math.round(cfg.world.tile / def.cell);
			if (Math.abs(K * def.cell - cfg.world.tile) > 1e-6) {
				throw new Error(
					`[undergrowth] 层 "${def.key}" 的 cell=${def.cell} 不能整除 tile=${cfg.world.tile}`,
				);
			}

			const mat = new THREE.MeshStandardMaterial({
				map: def.tex(),
				alphaTest: def.alphaTest,
				side: THREE.DoubleSide,
				roughness: 1.0,
				metalness: 0.0,
				color: 0xffffff,
			});
			const mesh = new THREE.InstancedMesh(def.geo(), mat, def.max);
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			mesh.frustumCulled = false;
			mesh.castShadow = def.castShadow;
			mesh.receiveShadow = true;
			mesh.count = 0;
			this.group.add(mesh);

			this.layers.push({
				def,
				mesh,
				K,
				radius: def.radius,
				baseRadius: def.radius,
				seed: SEEDS[def.key],
			});
		}

		// 兼容旧调用点（main.js / director.js 读的是 undergrowth.mesh.count）
		this.mesh = this.layers[1].mesh; // fern 层作为代表
		this.radius = this.layers[1].radius;
	}

	refresh(px, pz, force = false) {
		if (!force && Math.abs(px - this._lastX) < 1.2 && Math.abs(pz - this._lastZ) < 1.2) return;
		this._lastX = px;
		this._lastZ = pz;

		for (const L of this.layers) this._refreshLayer(L, px, pz);
	}

	_refreshLayer(L, px, pz) {
		const def = L.def;
		const cell = def.cell;
		const K = L.K;
		const R = L.radius;
		const R2 = R * R;
		const max = L.mesh.instanceMatrix.count;
		const [s0, s1] = def.scale;
		const [c0, c1, c2, c3] = def.color;
		const [sA, sB, sC, sD] = L.seed;
		const densityMul = this.cfg.world.vegetationDensity;

		const i0 = Math.floor((px - R) / cell);
		const i1 = Math.ceil((px + R) / cell);
		const j0 = Math.floor((pz - R) / cell);
		const j1 = Math.ceil((pz + R) / cell);

		let n = 0;
		for (let j = j0; j <= j1; j++) {
			const hj = imod(j, K);
			for (let i = i0; i <= i1; i++) {
				if (n >= max) break;
				const hi = imod(i, K);

				const r0 = ihash2(hi, hj, sA);
				if (r0 > def.density * densityMul) continue;
				const r1 = ihash2(hi, hj, sB);
				const r2 = ihash2(hi, hj, sC);
				const r3 = ihash2(hi, hj, sD);

				const wx = i * cell + r1 * cell;
				const wz = j * cell + r2 * cell;
				const dx = wx - px;
				const dz = wz - pz;
				if (dx * dx + dz * dz > R2) continue;

				// ── 让开山路 ──────────────────────────────────
				// 草长在路上是最刺眼的破绽之一。
				// 【踩坑】v1 用 r3 < 0.25 做了道"性能门"，但门把剔除概率
				// 也乘成了 25% —— 路中心 86% 的草还活着。距离场烘焙之后
				// 查询 O(1)，直接用 r3 当剔除骰子，概率精确。
				{
					const inf = pathInfluence(wx, wz, this.cfg);
					if (r3 < inf * def.pathClear) continue;
				}

				// 湿度调制：蕨草喜湿、苔垫喜湿、枯草喜干。
				// 这一个标量让四层植被在地面上"分片"，而不是均匀铺开 ——
				// 均匀铺开正是"贴图感"的来源。
				const wet = groundBlend(wx, wz, this.cfg);
				if (def.key === 'drygrass') {
					if (wet > 0.58 && r1 > (1 - (wet - 0.58) * 2.2)) continue;
				} else if (def.key === 'moss') {
					if (wet < 0.36 && r2 > 0.45) continue;
				}

				const s = s0 + r3 * (s1 - s0);
				const d = this._dummy;
				d.position.set(
					wx,
					terrainHeight(wx, wz, this.cfg) + def.yOff,
					wz,
				);
				d.rotation.set(0, r2 * Math.PI * 2, 0);
				// 苔垫是贴地的，不能纵向拉伸（会离地）
				d.scale.set(
					s,
					def.key === 'moss' ? s : s * (0.85 + r1 * 0.4),
					s,
				);
				d.updateMatrix();
				L.mesh.setMatrixAt(n, d.matrix);

				// 逐实例色偏
				const v = c0 + r0 * c1;
				this._color.setRGB(
					Math.min(1, v * c3),
					Math.min(1, v * c2),
					Math.min(1, v * (c2 - 0.14)),
				);
				L.mesh.setColorAt(n, this._color);
				n++;
			}
		}
		L.mesh.count = n;
		L.mesh.instanceMatrix.needsUpdate = true;
		if (L.mesh.instanceColor) L.mesh.instanceColor.needsUpdate = true;
	}

	// 降画质：按"层的重要性"从外往里砍。
	// 顺序：灌木 → 枯草 → 苔垫 → 蕨草。蕨草撑住最后的画面密度，最后动它。
	reduceRadius(factor) {
		const order = ['shrub', 'drygrass', 'moss', 'fern'];
		for (const key of order) {
			const L = this.layers.find((l) => l.def.key === key);
			if (!L) continue;
			const next = Math.max(10, L.radius * factor);
			if (next < L.baseRadius * 0.6 || L.radius > 10) {
				L.radius = next;
				break;
			}
		}
		this.radius = this.layers[1].radius;
		this._lastX = Infinity;
	}

	// 给导演用：当前总共多少株被实例化
	get count() {
		let n = 0;
		for (const L of this.layers) n += L.mesh.count;
		return n;
	}
}
