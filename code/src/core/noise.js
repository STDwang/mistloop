// 周期噪声与地形函数。
//
// 关键设计：所有噪声都以"归一化坐标的 1.0"为周期，也就是以 world.tile 米为周期。
// 做法：格点索引在使用前对格点频率取模。这样噪声天然可平铺，
// 世界才可能是真正的环面——不是"用雾盖住接缝"，而是根本不存在接缝。

import { ihash2, imod } from './rng.js';

function smoothstep(t) {
	return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
	return a + (b - a) * t;
}

// 周期值噪声。u、v 为归一化世界坐标（x / tile），freq 为格点频率（必须是整数）。
export function pnoise(u, v, freq, seed) {
	const x = u * freq;
	const y = v * freq;
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const fx = smoothstep(x - xi);
	const fy = smoothstep(y - yi);
	const x0 = imod(xi, freq);
	const y0 = imod(yi, freq);
	const x1 = (x0 + 1) % freq;
	const y1 = (y0 + 1) % freq;
	const n00 = ihash2(x0, y0, seed);
	const n10 = ihash2(x1, y0, seed);
	const n01 = ihash2(x0, y1, seed);
	const n11 = ihash2(x1, y1, seed);
	return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fy);
}

// 分形叠加。八度频率取 baseFreq * 2^o（始终是整数），所以整体仍以 1.0 为周期。
export function pfbm(u, v, baseFreq, octaves, seed) {
	let amp = 0.5;
	let freq = baseFreq;
	let sum = 0;
	let norm = 0;
	for (let o = 0; o < octaves; o++) {
		sum += amp * pnoise(u, v, freq, seed + o * 1013);
		norm += amp;
		amp *= 0.5;
		freq *= 2;
	}
	return sum / norm;
}

// 地形高度（米）。四层：大起伏的丘陵、中层起伏、脚下起伏、细碎凸起。
// 中层振幅故意给得比"看起来自然"更大：太平的地面在雾里没有纵深，
// 玩家会立刻意识到自己在走平地，"打圈"的感觉就散了。
//
// 第五层是山路：一条被踩陷的凹槽 + 两侧的泥土隆起。
// 它加在最后，所以路的形状不受其他层干扰 —— 凹槽永远是真的凹槽。
export function terrainHeight(x, z, cfg) {
	const u = x / cfg.world.tile;
	const v = z / cfg.world.tile;
	let h = (pfbm(u, v, 3, 4, 1337) - 0.5) * 11.0;
	h += (pfbm(u, v, 9, 3, 7331) - 0.5) * 3.4;
	h += (pfbm(u, v, 29, 2, 991) - 0.5) * 1.1;
	// 细碎层：路面会被压实，所以这一层在路面范围内被压小
	h += (pfbm(u, v, 73, 2, 441) - 0.5) * 0.32 * pathRoughnessScale(x, z, cfg);
	h += pathHeightOffset(x, z, cfg);
	return h;
}

// 地面湿度：用于顶点色在"泥"和"苔"之间混合。湿度高处偏苔，低洼处偏泥。
export function groundBlend(x, z, cfg) {
	const u = x / cfg.world.tile;
	const v = z / cfg.world.tile;
	return pfbm(u, v, 7, 3, 4242);
}

// 地面坡度（近似）：用有限差分求梯度模长，配合湿度决定色偏。
export function terrainSlope(x, z, cfg, e = 1.5) {
	const hL = terrainHeight(x - e, z, cfg);
	const hR = terrainHeight(x + e, z, cfg);
	const hD = terrainHeight(x, z - e, cfg);
	const hU = terrainHeight(x, z + e, cfg);
	const gx = (hR - hL) / (2 * e);
	const gz = (hU - hD) / (2 * e);
	return Math.sqrt(gx * gx + gz * gz);
}

// ═══════════════════════════════════════════════════════════════
// 山路
// ═══════════════════════════════════════════════════════════════
//
// 为什么必须有这条路：一片纯噪声的丘陵在雾里读起来是"随机地形"，
// 不是"山里的小径"。人走进一片完全没有人类痕迹的林地时，脑子会
// 判定这是"地图"；而一旦脚下有一条踩出来的路，他会自动开始
// 沿着它走 —— 这正是我们要的：**这条路是陷阱，因为它是个闭环。**
//
// 【关键约束 · 环路必须在环面上是闭合且周期的】
//
// 这不是"画一条线"，因为：
//   1. 地形高度必须以 tile 为周期，否则环面回绕时地面会跳变。
//   2. 路必须以 1.0（归一化坐标）为周期，否则走出 tile 后路就断了。
//
// 做法：路的中线用"圆 + 谐波扰动"，而且只用整数频率的谐波。
//   u(t) = 0.5 + ru·cos(2πt) + Σ aₖ·cos(2πkt + φₖ)
//   v(t) = 0.5 + rv·sin(2πt) + Σ aₖ·sin(2πkt + φₖ)
// t ∈ [0,1) 走一圈，u、v 自动回到起点 —— 且因为谐波频率是整数，
// 把 u 平移 1.0（走出一个 tile）得到完全相同的形状。
//
// 所以这是一条**真正的闭合环路**，而不是"看起来能接上"的线。
// 玩家沿着它走，会精确地回到起点 —— 这就是"打圈"的物理基础。

// 环路的谐波表。改这里 = 改路的形状。
//
// 【幅度纪律】这些数是被两条硬约束逼出来的，改之前先看 tools/path-probe.mjs：
//
//   ① 不自交 —— 最初用 a = 0.075/0.048/0.026/0.014 时，
//      两段路在空间上只差 0.1 m，画面上是一坨互相叠加的泥槽。
//   ② 不能有"发夹弯" —— 高次谐波（k=4、k=5）会制造急转弯，
//      弯道两侧的路缘在空间上贴得很近（实测 1.2 m < 路宽 2.7 m）。
//      那不是"蜿蜒"，那是路跟自己挤在一起，隆起带会互相吃掉。
//
// 所以：只留低次谐波（k=2、3），幅度小。
// 想要更蜿蜒，必须同时放大基圆半径 —— 单加谐波只会把它拧成麻花。
const PATH_HARMONICS = [
	{ k: 2, a: 0.026, p: 0.0 },
	{ k: 3, a: 0.014, p: 1.9 },
];

// 基圆半径。它同时决定"环路总长"和"能不能容下谐波"。
// 总长 ≈ 2π·R_avg。R=0.235 时约 290 m，走一圈约 116 s —— 落在节拍区间内。
const PATH_RU = 0.235;
const PATH_RV = 0.208;

// 环路中线的归一化坐标。
// 只用整数频率谐波 → t:0→1 必回原点，且 u 平移 1.0 形状不变。
export function pathCenter(t) {
	let u = 0.5 + PATH_RU * Math.cos(2 * Math.PI * t);
	let v = 0.5 + PATH_RV * Math.sin(2 * Math.PI * t);
	for (const h of PATH_HARMONICS) {
		u += h.a * Math.cos(2 * Math.PI * h.k * t + h.p);
		v += h.a * Math.sin(2 * Math.PI * h.k * t + h.p * 0.7);
	}
	return { u, v };
}

// 世界坐标下的路中线。
export function pathCenterWorld(t, cfg) {
	const T = cfg.world.tile;
	const { u, v } = pathCenter(t);
	return { x: u * T, z: v * T };
}

// ═══════════════════════════════════════════════════════════════
// 距离场烘焙
// ═══════════════════════════════════════════════════════════════
//
// pathDistance 每次调用要做 ~440 次 pathCenter（粗扫 + 三分细化）。
// 地形生成一个顶点要调它两次（凹槽 + 压实），11.6 万顶点 =
// 1 亿次三角函数 —— 首帧要卡好几秒。而树、草、灌木的每一次刷新
// 也都要查它。这个函数是整个世界生成的热点，不能每次都硬算。
//
// 解法：路是**静态的**。启动时把距离烘焙到一张网格上，之后所有查询
// 都是双线性采样 —— O(1)。烘焙一次的成本（几万次 pathDistance）
// 换掉后续无限次的调用，稳赚。
//
// 精度：192² 网格 ≈ 1.02 m/格。路面剖面最窄的特征是 bermWidth
// （0.85 m），看起来勉强。但地形网格本身是 1.15 m/格 ——
// 场比网格更细，瓶颈在网格不在场。双线性插值让边缘平滑。

const PATH_FIELD_N = 192;
let pathField = null; // Float32Array(PATH_FIELD_N²)，单位：米
let pathFieldCfg = null;

// 精确实现的粗扫段数。384 段 × 环长 ≈ 0.73 m/段，保证"最近段"
// 的搜索不会落到隔壁段上（v1 用 24 段吃过这个亏）。
const PATH_SEG = 384;

export function bakePathField(cfg) {
	const T = cfg.world.tile;
	const N = PATH_FIELD_N;
	const field = new Float32Array(N * N);
	const step = T / N;
	const t0 = performance.now();
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			// 网格中心采样，避免半格偏移。
			// 必须调 Raw：重烘时 pathField 已存在，调 pathDistance 会
			// 采到旧场 —— 烘出来的还是旧路。
			field[j * N + i] = pathDistanceRaw(i * step + step * 0.5, j * step + step * 0.5, cfg);
		}
	}
	pathField = field;
	pathFieldCfg = cfg;
	return performance.now() - t0;
}

// 双线性采样烘焙场。世界坐标 → 网格坐标 → 四点插值。
// 环面处理：wrap 网格索引（场本身以 tile 为周期）。
function samplePathField(x, z, cfg) {
	const T = cfg.world.tile;
	const N = PATH_FIELD_N;
	const step = T / N;
	// 世界坐标 → 格坐标（相对格子中心）
	let gx = x / step - 0.5;
	let gy = z / step - 0.5;
	const i0 = Math.floor(gx);
	const j0 = Math.floor(gy);
	const fx = gx - i0;
	const fy = gy - j0;
	const i1 = i0 + 1;
	const j1 = j0 + 1;
	const w0 = imod(i0, N);
	const w1 = imod(i1, N);
	const v0 = imod(j0, N);
	const v1 = imod(j1, N);
	const d00 = pathField[v0 * N + w0];
	const d10 = pathField[v0 * N + w1];
	const d01 = pathField[v1 * N + w0];
	const d11 = pathField[v1 * N + w1];
	return (d00 * (1 - fx) + d10 * fx) * (1 - fy) + (d01 * (1 - fx) + d11 * fx) * fy;
}

// 到路中线的距离（米）。烘焙完成后走快速路径；否则回退到直接计算。
// 【不要】在烘焙完成前调用 pathInfluence / pathHeightOffset ——
// main.js 里 bakePathField 必须先于 createTerrain。
export function pathDistance(x, z, cfg) {
	if (pathField && pathFieldCfg === cfg) return samplePathField(x, z, cfg);
	return pathDistanceRaw(x, z, cfg);
}

// 精确但慢的原始实现（烘焙时与回退时使用）。
function pathDistanceRaw(x, z, cfg) {
	const T = cfg.world.tile;
	// 世界坐标 → 归一化坐标（环面上，取到中线最近的一个周期）
	let u = x / T;
	let v = z / T;
	u -= Math.floor(u);
	v -= Math.floor(v);

	// 第一轮：粗扫
	let best = Infinity;
	let bestI = 0;
	for (let i = 0; i < PATH_SEG; i++) {
		const c = pathCenter(i / PATH_SEG);
		let du = u - c.u;
		let dv = v - c.v;
		// 用最小周期位移，保证跨 tile 边界时距离不跳
		du -= Math.round(du);
		dv -= Math.round(dv);
		const d2 = du * du + dv * dv;
		if (d2 < best) {
			best = d2;
			bestI = i;
		}
	}

	// 第二轮：在最优段 ±1 段内三分细化。
	// 段长 0.91 m，邻域覆盖 2.7 m，远超路的半宽 1.35 m —— 足够。
	const step = 1 / PATH_SEG;
	let lo = (bestI - 1) * step;
	let hi = (bestI + 1) * step;
	const at = (t) => {
		const c = pathCenter(t);
		let du = u - c.u;
		let dv = v - c.v;
		du -= Math.round(du);
		dv -= Math.round(dv);
		return du * du + dv * dv;
	};
	// 函数在邻域内是单峰的，三分搜索收敛
	for (let it = 0; it < 28; it++) {
		const m1 = lo + (hi - lo) / 3;
		const m2 = hi - (hi - lo) / 3;
		if (at(m1) < at(m2)) hi = m2;
		else lo = m1;
	}
	const refined = at((lo + hi) * 0.5);
	const d2 = Math.min(best, refined);

	return Math.sqrt(d2) * T;
}

// 路的归一化影响强度：1 = 正中心，0 = 完全离开路面。
// 用 smoothstep 而不是线性衰减，边缘才不会有"台阶"。
export function pathInfluence(x, z, cfg) {
	const d = pathDistance(x, z, cfg);
	const half = cfg.path.halfWidth;
	const feather = cfg.path.feather;
	if (d <= half) return 1;
	if (d >= half + feather) return 0;
	const t = 1 - (d - half) / feather;
	return t * t * (3 - 2 * t);
}

// 路面对地形高度的修正量（米）。
//
// 关键：路不是"铺在地面上"，而是"被踩陷下去的"。
// 一条真实的山径是一个浅浅的凹槽，两侧才有新鲜的泥土隆起 ——
// 那圈隆起（berm）是"有人经常走这里"的视觉证据。
// 所以这里返回的是负值（下陷）+ 边缘正值（隆起）。
export function pathHeightOffset(x, z, cfg) {
	const d = pathDistance(x, z, cfg);
	const half = cfg.path.halfWidth;

	// 中心下陷：cos 剖面，最深处 sinkDepth
	if (d < half) {
		const k = d / half;
		const dish = (1 - k * k) * cfg.path.sink;
		return -dish;
	}

	// 两侧隆起：在 half ~ half + bermWidth 之间鼓起
	const bw = cfg.path.bermWidth;
	if (d < half + bw) {
		const k = (d - half) / bw;
		// 半正弦：中间最高，两端归零 —— 与下陷和外部都能接上
		return Math.sin(k * Math.PI) * cfg.path.berm;
	}
	return 0;
}

// 路面粗糙度：踩实的地比松软腐殖层更平。
// 用在高度函数的细节层上做乘法，让路看起来"被压实了"。
export function pathRoughnessScale(x, z, cfg) {
	const inf = pathInfluence(x, z, cfg);
	return 1 - inf * cfg.path.smooth;
}
