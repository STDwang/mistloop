// 山路体检探针。
//
// 这条路有三个"错了也不会立刻看出来"的性质，必须自动断言：
//
//   1. 【周期】terrainHeight(x, z) 必须等于 terrainHeight(x + tile, z)。
//      地形网格每帧吸附到 tile 整数倍，靠的就是这一条。破了就地面跳变。
//
//   2. 【闭环】pathCenter(0) 必须等于 pathCenter(1)。
//      路必须真的闭合成环 —— 否则玩家会撞上一个断口。
//
//   3. 【不自交】路不能自己穿自己。
//      那不是"山路"，那是涂鸦；宽度和隆起会互相打架，看起来像一团泥。
//
// 另外检查路的实际效果：凹槽深度、隆起高度是否真的出现在地形上
// （而不是只在公式里存在）。

import { CFG } from '../src/config.js';
import {
	terrainHeight,
	pathCenter,
	pathDistance,
	pathHeightOffset,
	pathInfluence,
	bakePathField,
} from '../src/core/noise.js';

const T = CFG.world.tile;
let fail = 0;
function check(name, ok, detail) {
	console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
	if (!ok) fail++;
}

console.log('══════════ 山路体检 ══════════\n');
console.log(`环面周期 tile = ${T} m，路面半宽 = ${CFG.path.halfWidth} m\n`);

// ── 1. 环路闭合 ──────────────────────────────────────────────
console.log('[闭环]');
const c0 = pathCenter(0);
const c1 = pathCenter(1);
const closeErr = Math.hypot(c0.u - c1.u, c0.v - c1.v);
console.log(`  pathCenter(0) = (${c0.u.toFixed(6)}, ${c0.v.toFixed(6)})`);
console.log(`  pathCenter(1) = (${c1.u.toFixed(6)}, ${c1.v.toFixed(6)})`);
check('环路闭合（t=0 与 t=1 同点）', closeErr < 1e-9, `误差 ${closeErr.toExponential(2)}`);

// ── 2. 环路在 tile 内的范围 ───────────────────────────────────
console.log('\n[环路范围]');
let uMin = 1, uMax = 0, vMin = 1, vMax = 0;
const N = 400;
for (let i = 0; i < N; i++) {
	const c = pathCenter(i / N);
	uMin = Math.min(uMin, c.u); uMax = Math.max(uMax, c.u);
	vMin = Math.min(vMin, c.v); vMax = Math.max(vMax, c.v);
}
console.log(`  u ∈ [${uMin.toFixed(3)}, ${uMax.toFixed(3)}]  →  ${(uMin * T).toFixed(1)} ~ ${(uMax * T).toFixed(1)} m`);
console.log(`  v ∈ [${vMin.toFixed(3)}, ${vMax.toFixed(3)}]  →  ${(vMin * T).toFixed(1)} ~ ${(vMax * T).toFixed(1)} m`);
check('环路完整落在 tile 内（不跨越边界被截断）',
	uMin > 0.05 && uMax < 0.95 && vMin > 0.05 && vMax < 0.95,
	`u [${uMin.toFixed(2)}, ${uMax.toFixed(2)}], v [${vMin.toFixed(2)}, ${vMax.toFixed(2)}]`);

// ── 3. 不自交 ────────────────────────────────────────────────
console.log('\n[不自交]');
// 判据的正确形式：**沿路的弧长**距离足够远的两个点，在空间上也必须离得开。
//
// 用"参数相差 N 个采样点"来筛邻点是错的：采样点在参数上等距，
// 但在空间上不等距 —— 急弯处相邻参数点在空间上挤在一起，
// 这会把"路自己拐弯"误判成"路跟另一段撞上"。
// 所以先建一张弧长表，用弧长来筛。
const pts = [];
for (let i = 0; i < N; i++) pts.push(pathCenter(i / N));

const arc = new Float64Array(N + 1); // arc[i] = 从 t=0 走到第 i 点的弧长
for (let i = 1; i <= N; i++) {
	const a = pts[(i - 1) % N];
	const b = pts[i % N];
	arc[i] = arc[i - 1] + Math.hypot((b.u - a.u) * T, (b.v - a.v) * T);
}
// 弧长必须超过"绕开一个弯所需的最小路程" —— 取 30 m（约 11 倍路宽）。
// 比这更近的两点，如果还靠得比路宽近，那就是真的叠在一起了。
const ARC_GUARD = 30;

let minNonAdj = Infinity;
let minPair = null;
for (let i = 0; i < N; i++) {
	for (let j = i + 1; j < N; j++) {
		// 两点之间的弧长（两条路，取短的那条 —— 环路是闭合的）
		const along = arc[j] - arc[i];
		const arcSep = Math.min(along, arc[N] - along);
		if (arcSep < ARC_GUARD) continue;
		const d = Math.hypot(pts[i].u - pts[j].u, pts[i].v - pts[j].v) * T;
		if (d < minNonAdj) { minNonAdj = d; minPair = [i, j, arcSep]; }
	}
}
const laneClear = CFG.path.halfWidth * 2 + CFG.path.bermWidth * 2; // 两条完整路槽的宽度
console.log(`  沿路走 ${ARC_GUARD} m 以上才允许靠近`);
console.log(`  最接近的两段：t=${(minPair[0] / N).toFixed(3)} 与 t=${(minPair[1] / N).toFixed(3)}（沿路相距 ${minPair[2].toFixed(1)} m）`);
console.log(`  空间距离 = ${minNonAdj.toFixed(2)} m`);
console.log(`  两条路槽总宽 = ${laneClear.toFixed(2)} m（半宽 ${CFG.path.halfWidth} + 隆起 ${CFG.path.bermWidth}，各两倍）`);
check('环路不自交（两段之间有足够间隔）', minNonAdj > laneClear * 1.5,
	`${minNonAdj.toFixed(1)} m > ${(laneClear * 1.5).toFixed(1)} m`);

// ── 4. 地形周期性 ────────────────────────────────────────────
console.log('\n[地形周期性]');
let maxPeriodErr = 0;
let worstPt = null;
const probes = [
	[0.5, 60], [30, 90], [12.7, 155.3], [98, 98], [170, 20], [45.5, 130.25],
];
for (const [x, z] of probes) {
	// 跨 tile 边界必须完全一致（这是环面无缝的全部依据）
	const variants = [
		terrainHeight(x + T, z, CFG),
		terrainHeight(x, z + T, CFG),
		terrainHeight(x - T, z - T, CFG),
	];
	for (const h of variants) {
		const e = Math.abs(h - terrainHeight(x, z, CFG));
		if (e > maxPeriodErr) { maxPeriodErr = e; worstPt = [x, z]; }
	}
}
console.log(`  最大周期误差 = ${maxPeriodErr.toExponential(3)} m（在 (${worstPt})）`);
check('地形高度以 tile 为周期', maxPeriodErr < 1e-9, `误差 ${maxPeriodErr.toExponential(2)} m`);

// ── 5. 路的实际效果 ──────────────────────────────────────────
console.log('\n[路面效果]');
// 在中线上取一点：应当有下陷；垂直于路往外走到 8 m：应当回到 0
const ct = 0.31;
const cw = pathCenter(ct);
const cx = cw.u * T, cz = cw.v * T;
// 数值求法向
const dt = 0.001;
const ca = pathCenter(ct - dt), cb2 = pathCenter(ct + dt);
let tx = (cb2.u - ca.u) * T, tz = (cb2.v - ca.v) * T;
const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
const nx = -tz, nz = tx;

console.log('  沿路面法向采样（距中线 → 高度修正 / 影响强度 / 到中线距离）:');
for (const off of [0, 0.5, 1.0, 1.35, 1.8, 2.2, 2.7, 3.5, 5.0, 8.0]) {
	const px = cx + nx * off, pz = cz + nz * off;
	const off_h = pathHeightOffset(px, pz, CFG);
	const inf = pathInfluence(px, pz, CFG);
	const d = pathDistance(px, pz, CFG);
	console.log(
		`    ${off.toFixed(2).padStart(5)} m → 高度 ${off_h >= 0 ? '+' : ''}${off_h.toFixed(4)} m  ` +
		`影响 ${inf.toFixed(3)}  实测距离 ${d.toFixed(2)} m`,
	);
}
const atCenter = pathHeightOffset(cx, cz, CFG);
check('路中心是下陷的', atCenter < -CFG.path.sink * 0.9,
	`中心高度修正 = ${atCenter.toFixed(4)} m（期望 ≈ ${(-CFG.path.sink).toFixed(3)}）`);

// 隆起：在 half + bermWidth/2 处最高
const bermOff = CFG.path.halfWidth + CFG.path.bermWidth * 0.5;
const bermH = pathHeightOffset(cx + nx * bermOff, cz + nz * bermOff, CFG);
check('两侧有泥土隆起', bermH > CFG.path.berm * 0.7,
	`隆起 ${bermH.toFixed(4)} m（期望 ≈ ${CFG.path.berm.toFixed(3)}）`);

const farH = pathHeightOffset(cx + nx * 8, cz + nz * 8, CFG);
check('远离路面后修正归零', Math.abs(farH) < 1e-9, `8 m 外 = ${farH.toExponential(2)}`);

// 距离场一致性：在中线上量到的距离应接近 0
const dCenter = pathDistance(cx, cz, CFG);
check('中线上的距离场接近 0', dCenter < 0.35, `实测 ${dCenter.toFixed(3)} m`);

// 距离场的周期性：跨 tile 必须一致
let maxDistErr = 0;
for (const [x, z] of probes) {
	const a = pathDistance(x, z, CFG);
	const b = pathDistance(x + T, z, CFG);
	const c = pathDistance(x, z - T, CFG);
	maxDistErr = Math.max(maxDistErr, Math.abs(a - b), Math.abs(a - c));
}
check('距离场以 tile 为周期', maxDistErr < 1e-9, `误差 ${maxDistErr.toExponential(2)} m`);

// ── 6. 路径长度 ──────────────────────────────────────────────
console.log('\n[路径长度]');
let len = 0;
let prev = pathCenter(0);
for (let i = 1; i <= N; i++) {
	const c = pathCenter(i / N);
	len += Math.hypot((c.u - prev.u) * T, (c.v - prev.v) * T);
	prev = c;
}
console.log(`  环路总长 ≈ ${len.toFixed(1)} m`);
console.log(`  步行一圈（2.5 m/s）≈ ${(len / 2.5).toFixed(0)} s，奔跑（4.85 m/s）≈ ${(len / 4.85).toFixed(0)} s`);
// 与设计节奏对照：一圈应该在 1–3 分钟之间，太短察觉太快，太长节奏拖
check('绕一圈的时间在 1–4 分钟（符合恐惧节拍）',
	len / 4.85 > 55 && len / 2.5 < 260,
	`走 ${(len / 2.5).toFixed(0)}s / 跑 ${(len / 4.85).toFixed(0)}s`);

// ── 7. 距离场烘焙 ────────────────────────────────────────────
// 游戏运行时用的不是上面那个精确实现，而是烘焙后的双线性采样场。
// 场必须满足：误差远小于路的特征尺寸（半宽 1.35 m），且自身保持周期性。
console.log('\n[距离场烘焙]');
const bakeMs = bakePathField(CFG);
console.log(`  烘焙耗时 ${bakeMs.toFixed(0)} ms（游戏启动时一次性成本）`);
// 烘焙之后 pathDistance 走采样路径 —— 与精确值对比
let maxErr = 0;
let errAt = null;
for (let k = 0; k < 600; k++) {
	const x = Math.random() * T;
	const z = Math.random() * T;
	// 精确参考：绕过烘焙，直接用未导出的原始实现 —— 这里用
	// "重新烘焙到临时 cfg"的技巧不可行，改为对比 influence 的连续性。
	// 实际做法：用 pathInfluence（已走采样场）与 pathHeightOffset 的
	// 精确公式对比太绕 —— 直接对比采样场在中线上的值最有效：
	const t = k / 600;
	const c = pathCenter(t);
	const cx = c.u * T, cz = c.v * T;
	const d = pathDistance(cx, cz, CFG); // 采样场
	if (d > maxErr) { maxErr = d; errAt = t; }
}
console.log(`  中线上采样场的最大读数 = ${maxErr.toFixed(3)} m（t=${errAt?.toFixed(3)}）`);
// 中线上的读数应该接近 0。1 m/格的双线性会让中心读数略高于 0，
// 但超过 0.55 m（路半宽的 40%）就意味着场错了。
check('采样场在中线上接近 0', maxErr < 0.55, `最大 ${maxErr.toFixed(3)} m`);

// 采样场的周期性
let maxPeriod = 0;
for (const [x, z] of probes) {
	maxPeriod = Math.max(maxPeriod,
		Math.abs(pathDistance(x, z, CFG) - pathDistance(x + T, z, CFG)));
}
check('采样场以 tile 为周期', maxPeriod < 1e-9, `误差 ${maxPeriod.toExponential(2)} m`);

// 烘焙前后 influence 的形状一致性：半宽处 inf 应该还是 1，半宽+羽化外应为 0
const cTest = pathCenter(0.4);
const cxT = cTest.u * T, czT = cTest.v * T;
// 数值法向
const caT = pathCenter(0.399), cbT = pathCenter(0.401);
let txT = (cbT.u - caT.u) * T, tzT = (cbT.v - caT.v) * T;
const tlT = Math.hypot(txT, tzT); txT /= tlT; tzT /= tlT;
const nxT = -tzT, nzT = txT;
const infInner = pathInfluence(cxT + nxT * (CFG.path.halfWidth - 0.2), czT + nzT * (CFG.path.halfWidth - 0.2), CFG);
const infOuter = pathInfluence(cxT + nxT * (CFG.path.halfWidth + CFG.path.feather + 1), czT + nzT * (CFG.path.halfWidth + CFG.path.feather + 1), CFG);
check('采样场：路内 influence 仍为 1', infInner > 0.97, `实测 ${infInner.toFixed(3)}`);
check('采样场：路外 influence 仍为 0', infOuter < 0.03, `实测 ${infOuter.toFixed(3)}`);

console.log(`\n══════════ ${fail === 0 ? '全部通过' : fail + ' 项失败'} ══════════`);
process.exit(fail === 0 ? 0 : 1);
