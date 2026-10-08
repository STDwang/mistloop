// 枯林。全部实例化，格点哈希驱动，随玩家刷新。
//
// ─────────────────────────────────────────────────────────────
// 【树冠 · 为什么是"针叶"而不是"阔叶"】
//
// docs/DESIGN.md 原本写着"树全部枯死、无叶"。实际跑起来的问题是：
// 光秃的圆柱在雾里读起来像"电线杆"，不像"树林"。缺少冠层，
// 视野里没有层次、没有起伏，环面世界会显得像一张程序生成的贴图。
//
// 解法不是推翻那条设计，而是把它说清楚：**要的是"死的针叶"，不是"活的阔叶"**。
//   · 枝头挂的是稀疏、下垂、灰褐到墨绿的针叶束 —— 远看是一团结块的剪影
//   · 不是鲜绿、不是饱满树冠 —— 那种确实会让林子显得有生机
//   · 冠层遮住天空的比例更高 → 视野被压成"拱廊"，反而强化了主题
//
// 实现上冠层是第三个 InstancedMesh（+1 draw call），alphaTest 剔除，
// 与树干共用同一套格点哈希，所以环面周期性自动成立。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { ihash2, imod, mulberry32 } from '../core/rng.js';
import { terrainHeight, pathInfluence } from '../core/noise.js';
import { mergeGeoms, bendGeometry } from '../core/geometry.js';
import { applyTextureSet } from '../core/textures.js';

// 导出给离线探针用（tools/forest-probe.mjs 会 import 它们做几何体检）。
// 这不是为测试而测试：树 / 冠层的三角形数与包围盒是这个项目最容易
// 悄悄失控的两个数（一个涨了掉帧，一个错了树会飘起来），
// 而它们只能在浏览器里才能看出来。让它们可被自动化断言，比"目测一下"可靠。
export function makePine(seed) {
	const rnd = mulberry32(seed);
	const parts = [];
	// ─────────────────────────────────────────────────────────────
	// 【为什么 H 从 14+rnd()*8 降到 11+rnd()*6】
	//
	// 用户反馈"主视角下人物的高度似乎只有小孩的身高"。
	// 探针实测 camera 离地 1.6600 m —— 正好是 CFG.player.eye，
	// 数值上是标准成人眼高，没错。
	//
	// 所以问题不在人，在**世界**。原来的组合是：
	//   树干 14–22 m × 实例缩放 0.72–1.3 = 10–28.6 m
	//   冠层半径 (2.6+1.9) × 0.92 ≈ 4.1 m
	// 真实的中国山区松树 15–25 m，可见原始分布的上半段明显偏高；
	// 更关键的是**下界**：14 × 0.72 = 10 m 的树在树林里已经算矮，
	// 意味着玩家周围几乎没有"比自己高一点"的参照物，全是压倒性的大树。
	// 人的高度感知是**相对**的 —— 当所有参照物都偏大 30%，
	// 大脑读出来的结论是"我变小了"，而不是"树变大了"。
	//
	// 降到 11–17 m 再乘缩放 → 约 8–21 m，中位数落在 13 m 左右，
	// 与真实次生林一致，且出现了一批"抬头能看见树尖"的树。
	// 树细一点（rBot 略降）也是同一个目的：让树干与人的比例回到正常。
	// ─────────────────────────────────────────────────────────────
	const H = 11 + rnd() * 6;
	const rTop = 0.070 + rnd() * 0.042;
	const rBot = 0.20 + rnd() * 0.12;

	const trunk = new THREE.CylinderGeometry(rTop, rBot, H, 5, 4, false);
	trunk.translate(0, H / 2, 0);
	const amp = 0.5 + rnd() * 1.1;
	const phi = rnd() * Math.PI * 2;
	bendGeometry(trunk, amp, phi, H);
	parts.push(trunk);

	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const n = 6 + Math.floor(rnd() * 5);
	for (let i = 0; i < n; i++) {
		const t = 0.3 + (i / Math.max(1, n - 1)) * 0.62;
		const y = H * t;
		const len = (2.2 + rnd() * 2.6) * (1 - t * 0.5);
		const rad = 0.012 + 0.055 * (1 - t * 0.6);
		const droop = 0.42 + rnd() * 0.55;
		const g = new THREE.CylinderGeometry(0.012, rad, len, 4, 1, true);
		g.translate(0, len / 2, 0);
		g.rotateX(Math.PI / 2 + droop);
		g.rotateY(rnd() * Math.PI * 2);
		g.translate(amp * t * t * cos, y, amp * t * t * sin);
		parts.push(g);
	}
	return { geo: mergeGeoms(parts), H, amp, phi };
}

// 矮树桩 / 断桩：增强地面的"被破坏过"的感觉
export function makeSnag(seed) {
	const rnd = mulberry32(seed);
	const parts = [];
	// 断桩同样降一档：它原来 4.5–9 m，比两层楼还高，
	// 和"被雷劈断的矮桩"这个设定不符，也加重了"我是小孩"的错觉。
	const H = 3.4 + rnd() * 3.2;
	const trunk = new THREE.CylinderGeometry(0.15 + rnd() * 0.1, 0.34 + rnd() * 0.16, H, 6, 3, false);
	trunk.translate(0, H / 2, 0);
	const amp = 0.25 + rnd() * 0.5;
	const phi = rnd() * Math.PI * 2;
	bendGeometry(trunk, amp, phi, H);
	parts.push(trunk);

	const n = 2 + Math.floor(rnd() * 3);
	for (let i = 0; i < n; i++) {
		const t = 0.45 + rnd() * 0.5;
		const len = 0.6 + rnd() * 1.1;
		const g = new THREE.CylinderGeometry(0.03, 0.07, len, 4, 1, true);
		g.translate(0, len / 2, 0);
		// 断枝朝斜上方，像被风折断
		g.rotateX(-Math.PI / 2 + 0.5 + rnd() * 0.5);
		g.rotateY(rnd() * Math.PI * 2);
		g.translate(amp * t * t * Math.cos(phi), H * t, amp * t * t * Math.sin(phi));
		parts.push(g);
	}
	return { geo: mergeGeoms(parts), H, amp, phi };
}

// ── 针叶贴图 ───────────────────────────────────────────────────
// 画一束从中心往外散开的针叶。关键在"稀疏"：
// 如果画成一团圆斑，alphaTest 之后会像一块塑料板；
// 画成细线，远处才会自然淡出成一团模糊的暗色 —— 那正是雾里树冠的样子。
export function needleTexture(size = 256) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const rnd = mulberry32(31337);
	ctx.clearRect(0, 0, size, size);

	const cx = size * 0.5;
	const cy = size * 0.56;

	// 背面罩一层极淡的雾状绿，让针叶束在远处能连成一片（而不是一颗颗孤立的星）
	const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.46);
	haze.addColorStop(0, 'rgba(46,54,40,0.30)');
	haze.addColorStop(0.55, 'rgba(40,48,36,0.14)');
	haze.addColorStop(1, 'rgba(34,42,32,0)');
	ctx.fillStyle = haze;
	ctx.fillRect(0, 0, size, size);

	// 针叶：从中心向外放射，越长越细，末端略下垂
	const needles = 190;
	for (let i = 0; i < needles; i++) {
		const ang = -Math.PI * 0.5 + (rnd() - 0.5) * Math.PI * 1.65;
		const len = size * (0.14 + rnd() * 0.3);
		const droop = 0.18 + rnd() * 0.42;
		const x0 = cx + (rnd() - 0.5) * size * 0.16;
		const y0 = cy + (rnd() - 0.5) * size * 0.16;
		const x1 = x0 + Math.cos(ang) * len;
		// 末端向下垂：针叶不是直线
		const y1 = y0 + Math.sin(ang) * len + len * droop * 0.55;
		const mx = (x0 + x1) * 0.5 + Math.cos(ang + 1.57) * len * 0.1;
		const my = (y0 + y1) * 0.5 + len * droop * 0.2;

		const v = 30 + Math.floor(rnd() * 46);
		const a = 0.45 + rnd() * 0.5;
		ctx.strokeStyle = `rgba(${v + 6},${v + 16},${v - 4},${a})`;
		ctx.lineWidth = size * (0.0022 + rnd() * 0.0044);
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(x0, y0);
		ctx.quadraticCurveTo(mx, my, x1, y1);
		ctx.stroke();
	}

	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 2;
	return tex;
}

// ── 树冠几何 ───────────────────────────────────────────────────
// 悬挂在树干上层的若干"针叶扇"。每一片是双面四边形，
// 随机朝向 + 随机倾斜，这样从任何角度看都有东西挡着，也不会出现薄片感。
export function makeCanopy(seed, tree) {
	const rnd = mulberry32(seed);
	const parts = [];
	const H = tree.H;
	const amp = tree.amp;
	const cos = Math.cos(tree.phi);
	const sin = Math.sin(tree.phi);

	// 冠层集中在中上部：下面留空，玩家在树间穿行时头顶才有"拱廊"感。
	// 层数 5、最上一层到 0.95H —— 不到 1.0，因为叶片四边形自身有厚度，
	// 挂在 0.95H 它的上缘就到树尖了。挂到 1.0H 会有一撮叶子浮在树尖上方，
	// 侧影就散了（松树的尖顶是它最好认的特征）。
	const layers = 5;
	for (let L = 0; L < layers; L++) {
		const t = 0.5 + (L / (layers - 1)) * 0.45;
		const y = H * t;
		const bend = amp * t * t;
		// 越往上冠幅越小（松树的锥形）。指数 1.35 > 1 是让收口更快，
		// 上部几层急剧收窄 —— 线性收窄会得到一个圆筒，不是锥。
		const taper = Math.pow(1.0 - (t - 0.5) / 0.5, 1.35) * 0.92 + 0.08;
		const radius = (2.6 + rnd() * 1.9) * taper;
		const fanCount = 3 + Math.floor(rnd() * 3);

		for (let f = 0; f < fanCount; f++) {
			const a = rnd() * Math.PI * 2;
			const r = radius * (0.35 + rnd() * 0.65);
			const size = (1.9 + rnd() * 1.6) * taper;
			const p = new THREE.PlaneGeometry(size, size * (0.72 + rnd() * 0.4));

			// 先随机倾斜（让叶片不是全部竖直），再朝向水平方位，最后平移到枝头。
			// 垂直抖动也按 taper 收 —— 否则树顶那几片会往上飘出去。
			p.rotateX(-Math.PI * 0.5 + (rnd() - 0.5) * 1.5);
			p.rotateZ((rnd() - 0.5) * 1.2);
			p.rotateY(a);
			p.translate(
				bend * 0.85 + Math.cos(a) * r,
				y + (rnd() - 0.5) * size * 0.7 * taper,
				bend * 0.85 + Math.sin(a) * r,
			);
			parts.push(p);
		}
	}
	return mergeGeoms(parts);
}

export class Forest {
	constructor(cfg, scene) {
		this.cfg = cfg;
		this.group = new THREE.Group();
		scene.add(this.group);

		const bark = new THREE.Color(cfg.palette.bark);

		this.types = [
			{
				mesh: null,
				max: 1400,
				count: 0,
				// 【尺度】原 [0.72, 1.3] 的均值约 1.01，但上尾很重，
				// 配合 11–17 m 的树干会产生 22 m 的巨木。
				// 收成 [0.74, 1.14]、均值约 0.94 —— 整体略低于 1.0，
				// 让"平均那棵树"比原来矮约 20%。见 makePine 的注释。
				scale: [0.74, 1.14],
				collide: 0.22,
				share: 0.84,
			},
			{
				mesh: null,
				max: 480,
				count: 0,
				scale: [0.8, 1.18],
				collide: 0.34,
				share: 0.16,
			},
		];
		const pines = makePine(0x5eed01);
		const snags = makeSnag(0x5eed02);
		const geos = [pines.geo, snags.geo];

		for (let i = 0; i < this.types.length; i++) {
			const t = this.types[i];
			const mat = new THREE.MeshStandardMaterial({
				color: bark,
				roughness: 0.96,
				metalness: 0.0,
				flatShading: true,
			});
			// 真树皮贴图。flatShading 必须去掉 —— 它会在顶点级强制重算
			// 法线，把贴图法线的细节整个盖掉（两者抢同一个法线插值）。
			// 轮廓的"枯"感已经由几何的弯曲承担，不再需要它。
			if (cfg.textures?.enabled) {
				mat.flatShading = false;
				applyTextureSet(mat, 'bark', {
					repeatX: cfg.textures.barkRepeatX,
					repeatY: cfg.textures.barkRepeatY,
					normalScale: 1.1,
				});
			}
			const mesh = new THREE.InstancedMesh(geos[i], mat, t.max);
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			// 剔除由我们自己按半径做，交给 three 反而会整块丢弃
			mesh.frustumCulled = false;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.count = 0;
			t.mesh = mesh;
			this.group.add(mesh);
		}

		// ── 冠层：独立的一个 InstancedMesh ────────────────────────
		// 容量给得比 pine 少：冠层只在视距内后半段才需要（近了反而看不全），
		// 但它跟 pine 是同一批格点，所以数量上是 1:1 —— 上限按 pine 的实测峰值取。
		this.canopy = new THREE.InstancedMesh(
			makeCanopy(0x5eed03, pines),
			new THREE.MeshStandardMaterial({
				map: needleTexture(),
				alphaTest: cfg.world.canopyAlphaTest,
				side: THREE.DoubleSide,
				roughness: 1.0,
				metalness: 0.0,
				color: 0xffffff,
				// 针叶不投影：每个实例都是一堆薄片，阴影贴图会出现严重的锯齿闪烁，
				// 而雾天里树冠的投影本来就看不太出来。这是"省一笔"而不是"妥协"。
				flatShading: false,
			}),
			1400,
		);
		this.canopy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.canopy.frustumCulled = false;
		this.canopy.castShadow = false;
		this.canopy.receiveShadow = false;
		this.canopy.count = 0;
		this.group.add(this.canopy);

		this._dummy = new THREE.Object3D();
		this._color = new THREE.Color();
		this.near = []; // 玩家 16 m 内的树干碰撞体
		this._lastX = Infinity;
		this._lastZ = Infinity;
		this.viewRadius = cfg.world.viewRadius;
	}

	// 玩家移动超过约 1.6 m 才重建实例，避免每帧写上千个矩阵
	refresh(px, pz, force = false) {
		if (!force && Math.abs(px - this._lastX) < 1.6 && Math.abs(pz - this._lastZ) < 1.6) return;
		this._lastX = px;
		this._lastZ = pz;

		const W = this.cfg.world;
		const K = W.treeCells;
		const cell = W.tile / K;
		const R = this.viewRadius;
		const R2 = R * R;
		const canopyMax = this.canopy.instanceMatrix.count;
		// 冠层比树干早一点淡出：视距尽头它是几个像素的暗块，
		// 留着只会增加 overdraw，而 alphaTest 的开销跟屏幕覆盖面积成正比。
		const canopyR2 = Math.min(R, W.canopyRadius) ** 2;

		const i0 = Math.floor((px - R) / cell);
		const i1 = Math.ceil((px + R) / cell);
		const j0 = Math.floor((pz - R) / cell);
		const j1 = Math.ceil((pz + R) / cell);

		for (const t of this.types) t.count = 0;
		this.near.length = 0;
		let cn = 0;

		for (let j = j0; j <= j1; j++) {
			// 关键：格点索引先对 K 取模再哈希 → 走到第 K 格就是第 0 格，
			// 世界因此天然以 K*cell = tile 为周期。
			const hj = imod(j, K);
			for (let i = i0; i <= i1; i++) {
				const hi = imod(i, K);

				const r0 = ihash2(hi, hj, 0x51ed);
				if (r0 > W.treeDensity) continue;
				const r1 = ihash2(hi, hj, 0x9e37);
				const r2 = ihash2(hi, hj, 0x85eb);
				const r3 = ihash2(hi, hj, 0xc2b2);

				// 格内抖动：这是"看起来不像网格"的全部秘密
				const wx = i * cell + r1 * cell;
				const wz = j * cell + r2 * cell;
				const dx = wx - px;
				const dz = wz - pz;
				const d2 = dx * dx + dz * dz;
				if (d2 > R2) continue;

				// ── 让开山路 ──────────────────────────────────
				// 路上长树是一眼假的东西：玩家会立刻意识到"路"只是
				// 一张画在地上、跟世界没有关系的贴图。
				//
				// 判据不能用"距离 < 阈值"这种硬切 —— 那会在路边形成
				// 一条整齐的、几何感的空白带。用的是"沿路的概率衰减"：
				// 路面正中完全不生成，越靠近路缘保存的概率越高。
				//
				// 【踩坑】v1 在这里套了一层"r4 < 0.3 才做判定"的概率门，
				// 想省 pathDistance 的开销 —— 但它把剔除概率也乘成了 30%，
				// 路中心还有七成的树活着，路上全是树。距离场烘焙之后
				// 查询是 O(1)，这层门只有害处，删掉。
				{
					const inf = pathInfluence(wx, wz, this.cfg);
					// r4 是独立哈希，与"有没有树"的判定无关，正好当剔除骰子
					const r4 = ihash2(hi, hj, 0x3f19);
					if (r4 < inf * this.cfg.path.treeClear) continue;
				}

				const type = r0 < W.treeDensity * W.snagRatio ? 1 : 0;
				const t = this.types[type];
				if (t.count >= t.max) continue;

				const scaleBase = t.scale[0] + r3 * (t.scale[1] - t.scale[0]);
				const d = this._dummy;
				d.position.set(wx, terrainHeight(wx, wz, this.cfg) - 0.3, wz);
				d.rotation.set(0, r3 * Math.PI * 2, (r1 - 0.5) * 0.1);
				d.scale.set(scaleBase * (0.92 + r2 * 0.16), scaleBase, scaleBase * (0.92 + r1 * 0.16));
				d.updateMatrix();
				t.mesh.setMatrixAt(t.count, d.matrix);

				// 逐棵色偏：让林子不是一块死板的颜色
				const v = 0.62 + r2 * 0.55;
				this._color.setRGB(v * (0.96 + r1 * 0.09), v * (0.95 + r3 * 0.1), v * (0.9 + r2 * 0.12));
				t.mesh.setColorAt(t.count, this._color);
				t.count++;

				// ── 冠层：同一棵树，同一套变换，只是另一个 mesh ────────
				// 树桩型不长冠层（它就是断掉的桩）。
				// 另外用 r1 抽掉一部分：不是每棵枯松都还剩针叶，
				// 一片"有的光、有的有叶"的林子比整齐划一可信得多。
				if (
					type === 0 &&
					cn < canopyMax &&
					d2 < canopyR2 &&
					r1 > W.canopySkip
				) {
					this.canopy.setMatrixAt(cn, d.matrix);
					// 冠层颜色：比树干暗、偏冷，且与树干色偏不同步 ——
					// 否则整棵树会像一个整体色块，露馅
					const cv = 0.5 + r2 * 0.5;
					this._color.setRGB(
						cv * (0.82 + r3 * 0.14),
						cv * (0.9 + r1 * 0.12),
						cv * (0.78 + r2 * 0.12),
					);
					this.canopy.setColorAt(cn, this._color);
					cn++;
				}

				if (d2 < 256) {
					this.near.push({ x: wx, z: wz, r: t.collide * scaleBase });
				}
			}
		}

		for (const t of this.types) {
			t.mesh.count = t.count;
			t.mesh.instanceMatrix.needsUpdate = true;
			if (t.mesh.instanceColor) t.mesh.instanceColor.needsUpdate = true;
		}
		this.canopy.count = cn;
		this.canopy.instanceMatrix.needsUpdate = true;
		if (this.canopy.instanceColor) this.canopy.instanceColor.needsUpdate = true;
	}

	// 把位置推出所有树干。用"沿法线插值"而不是硬推，避免贴着树走时抖动。
	resolve(x, z, radius) {
		let nx = x;
		let nz = z;
		for (let i = 0; i < this.near.length; i++) {
			const t = this.near[i];
			const dx = nx - t.x;
			const dz = nz - t.z;
			const rr = t.r + radius;
			const d2 = dx * dx + dz * dz;
			if (d2 >= rr * rr || d2 < 1e-9) continue;
			const d = Math.sqrt(d2);
			const push = (rr - d) / d;
			nx += dx * push;
			nz += dz * push;
		}
		return { x: nx, z: nz };
	}

	// 环面无缝性自检：返回玩家周围 radius 米内所有树的"相对位置签名"。
	// 在 (0.5, 60) 与 (196.5, 60) 两个点调用，结果必须完全一致。
	sampleAround(px, pz, radius = 6) {
		const W = this.cfg.world;
		const K = W.treeCells;
		const cell = W.tile / K;
		const i0 = Math.floor((px - radius) / cell);
		const i1 = Math.ceil((px + radius) / cell);
		const j0 = Math.floor((pz - radius) / cell);
		const j1 = Math.ceil((pz + radius) / cell);
		const out = [];
		for (let j = j0; j <= j1; j++) {
			const hj = imod(j, K);
			for (let i = i0; i <= i1; i++) {
				const hi = imod(i, K);
				const r0 = ihash2(hi, hj, 0x51ed);
				if (r0 > W.treeDensity) continue;
				const r1 = ihash2(hi, hj, 0x9e37);
				const r2 = ihash2(hi, hj, 0x85eb);
				if (r0 > W.treeDensity) continue;
				out.push([
					+(i * cell + r1 * cell - px).toFixed(4),
					+(j * cell + r2 * cell - pz).toFixed(4),
					+r0.toFixed(6),
				]);
			}
		}
		out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		return out;
	}

	// ── 供导演用的空间查询 ──────────────────────────────────────

	// 某点周围 radius 米内有多少棵树。0 = 空地。
	treeCountNear(x, z, radius = 3) {
		const W = this.cfg.world;
		const K = W.treeCells;
		const cell = W.tile / K;
		const r2 = radius * radius;
		const ci = Math.floor(x / cell);
		const cj = Math.floor(z / cell);
		let n = 0;
		for (let dj = -2; dj <= 2; dj++) {
			for (let di = -2; di <= 2; di++) {
				const i = ci + di;
				const j = cj + dj;
				const hi = imod(i, K);
				const hj = imod(j, K);
				const r0 = ihash2(hi, hj, 0x51ed);
				if (r0 > W.treeDensity) continue;
				const wx = i * cell + ihash2(hi, hj, 0x9e37) * cell;
				const wz = j * cell + ihash2(hi, hj, 0x85eb) * cell;
				const dx = wx - x;
				const dz = wz - z;
				if (dx * dx + dz * dz < r2) n++;
			}
		}
		return n;
	}

	// 从 (x0,z0) 朝 (x1,z1) 看，前 maxDist 米里有多大比例被树干挡住。
	// 返回 0（完全通畅）~ 1（全挡）。
	corridorOcclusion(x0, z0, x1, z1, maxDist = 26) {
		const dx = x1 - x0;
		const dz = z1 - z0;
		const len = Math.hypot(dx, dz);
		if (len < 1e-3) return 1;
		const reach = Math.min(len, maxDist);
		const samples = 16;
		let blocked = 0;
		for (let s = 1; s <= samples; s++) {
			const t = (reach * s) / samples / len;
			const px = x0 + dx * t;
			const pz = z0 + dz * t;
			if (this.treeCountNear(px, pz, 1.35) > 0) blocked++;
		}
		return blocked / samples;
	}

	// 画质降级：优先砍"雾里看不见的树"，而不是降视觉质量
	reduceRadius(factor) {
		this.viewRadius = Math.max(34, this.viewRadius * factor);
		// 冠层是 overdraw 大户（alphaTest 的代价与屏幕覆盖面积成正比），
		// 降级时它要跟着收得更狠
		this.cfg.world.canopyRadius = Math.max(26, this.cfg.world.canopyRadius * factor * 0.9);
		this._lastX = Infinity;
	}
}
