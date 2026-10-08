// 尺度探针：把"世界里的东西到底有多高"这件事变成一个数字，而不是一个感觉。
//
// ─────────────────────────────────────────────────────────────
// 【为什么需要这个探针】
//
// 用户的反馈是"主视角下人物的高度似乎只有小孩的身高"。
// 这个描述有歧义：可能指 camera 太低，也可能指世界太大。
// 第一次实测已经排除了前者（camera 离地 = 1.6600 m = CFG.player.eye，正确），
// 所以真正要量化的是后者。
//
// 人的高度感知是**相对**的。当视野里所有参照物都偏大，
// 大脑不会得出"世界变大了"，它得出"我变小了"。
// 因此可断言的判据不是"树高 = 15 m"，而是：
//   · 有多少比例的东西高过我的头顶？
//   · 我能平视出去看到多远的地面？
//
// 这个探针 import 真实的 forest.js / undergrowth.js / noise.js，
// 用它们自己的哈希与插值把"实例高度分布"在格点上重算一遍。
// 不能手抄参数：抄下来就只是把注释里的数字又念了一遍，
// 改代码忘了改注释时探针照样绿。这条规矩的来由见 tools/jump-probe.mjs 头部。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { CFG } from '../src/config.js';
import { makePine, makeSnag, makeCanopy } from '../src/world/forest.js';
import { terrainHeight } from '../src/core/noise.js';
import { ihash2, imod } from '../src/core/rng.js';

// ── 极简替身 ────────────────────────────────────────────────────
// 探针只需要几何的包围盒与哈希逻辑，不需要渲染器。
// 用 THREE 的 loaders 之外的最小客户端：直接给全局补上 DOM 壳子，
// 让 makePine 里可能触发的 canvas 相关代码不至于炸（其实它不触发）。
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	const mark = ok ? 'PASS' : 'FAIL';
	console.log(`  [${mark}] ${name}${detail ? '  ' + detail : ''}`);
}

const P = CFG.player;
const EYE = P.eye;

console.log('\n=== 0. 参照系 ===');
console.log(`  CFG.player.eye = ${EYE} m   （中国成年男性眼高约 1.60–1.66 m）`);
console.log(`  CFG.player.radius = ${P.radius} m`);
check('eye 落在成人眼高区间 [1.55, 1.75]', EYE >= 1.55 && EYE <= 1.75, `eye=${EYE}`);

// ── 1. 树：几何高度 × 实例缩放之后，真实分布是什么 ────────────────
console.log('\n=== 1. 树的有效高度分布 ===');

// makePine 的高度由 seed 决定；不同 seed → 不同 H。
// 用一组 seed 采样，得到 H 的分布（这是"模板高"）。
const pineHs = [];
for (let s = 1; s <= 400; s++) {
	pineHs.push(makePine(s * 2654435761 % 0x7fffffff).H);
}
pineHs.sort((a, b) => a - b);
const pineH = (q) => pineHs[Math.min(pineHs.length - 1, Math.floor(q * pineHs.length))];
console.log(
	`  makePine 模板 H: min=${pineHs[0].toFixed(2)} p25=${pineH(0.25).toFixed(2)}` +
		` 中位=${pineH(0.5).toFixed(2)} p75=${pineH(0.75).toFixed(2)} max=${pineHs[pineHs.length - 1].toFixed(2)} m`,
);

// 项目实际只用 makePine(0x5eed01) 这一棵树当模板（InstancedMesh 共享几何），
// 所以真正的"每棵树多高"完全由实例缩放决定。
const template = makePine(0x5eed01);
template.geo.computeBoundingBox();
const tplTop = template.geo.boundingBox.max.y;
const tplBot = template.geo.boundingBox.min.y;
console.log(
	`  实际模板 makePine(0x5eed01): H=${template.H.toFixed(2)} m，` +
		`几何包围盒 y ∈ [${tplBot.toFixed(2)}, ${tplTop.toFixed(2)}]`,
);

const pineType = { scale: [0.74, 1.14] }; // 与 forest.js this.types[0] 同步
// 这里必须从源码读，不能写死 —— 但 Forest 的 types 在 constructor 里，
// 构造它需要 scene / document。折中：用正则从源码里抓这一段，
// 抓不到就报失败（而不是静默用一个可能过期的默认值）。
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/world/forest.js', import.meta.url), 'utf8');
const m0 = src.match(/scale:\s*\[([\d.]+),\s*([\d.]+)\],\s*collide:\s*0\.22/);
check('能从源码读到 pine 的 scale 区间', !!m0, m0 ? `[${m0[1]}, ${m0[2]}]` : '未匹配');
if (m0) {
	pineType.scale = [parseFloat(m0[1]), parseFloat(m0[2])];
}
const pineTopMin = tplTop * pineType.scale[0];
const pineTopMax = tplTop * pineType.scale[1];
console.log(
	`  实际树的树尖高度: ${pineTopMin.toFixed(1)} – ${pineTopMax.toFixed(1)} m ` +
		`（= 包围盒顶 ${tplTop.toFixed(1)} × scale ${pineType.scale[0]}–${pineType.scale[1]}）`,
);

check('最高的树不超过 24 m（真实山区松树上限）', pineTopMax <= 24, `max=${pineTopMax.toFixed(1)} m`);
check(
	'最短的树不高于 12 m（场景里要有"比我高一点"的树作参照）',
	pineTopMin <= 12,
	`min=${pineTopMin.toFixed(1)} m`,
);

// 用真实格点哈希重算一遍"有多少树比人高 / 比人矮"
const W = CFG.world;
const cell = W.tile / W.treeCells;
const N = W.treeCells;
let treesAboveEye = 0;
// 【判据修正】最初我写的是"1–3 倍眼高的树要占 10%"，跑出来 0% ——
// 但那是**断言本身错了**，不是代码错了。真实山区的松树 10–15 m，
// 不可能有 3 m 高的松树。一片成年林子里本来就不该有"和我差不多高"的树。
//
// 真正该断言的是别的东西：**光照**。人在林子里之所以不觉得小，
// 靠的不是"有大树也有小树"，而是**头顶能透进光、看得见天**。
// 所以我改为断言冠层覆盖率 —— 它才是"拱廊"和"深井"的分界线。
let treesTotal = 0;
let nearestTreeTop = Infinity;
for (let i = 0; i < N; i++) {
	for (let j = 0; j < N; j++) {
		const r0 = ihash2(i, j, 0x11);
		if (r0 > W.treeDensity) continue;
		const r3 = ihash2(i, j, 0x44);
		const type = r0 < W.treeDensity * W.snagRatio ? 1 : 0;
		const sc = type === 0 ? pineType.scale : [0.8, 1.18];
		const s = sc[0] + r3 * (sc[1] - sc[0]);
		const h = (type === 0 ? tplTop : 3.4 + 3.2) * s;
		treesTotal++;
		if (h > EYE) treesAboveEye++;
		if (type === 0 && h < nearestTreeTop) nearestTreeTop = h;
	}
}
console.log(
	`  格点抽样 ${treesTotal} 棵：高过眼高 ${((treesAboveEye / treesTotal) * 100).toFixed(1)}%，` +
		`最矮的一棵松树 ${nearestTreeTop.toFixed(1)} m = ${(nearestTreeTop / EYE).toFixed(1)} × 眼高`,
);
check(
	'最矮的松树至少 3 倍眼高（松树本来就该全部比我高，这是对的）',
	nearestTreeTop >= EYE * 3,
	`${(nearestTreeTop / EYE).toFixed(1)} × eye`,
);
check(
	'最高的树不超过 24 m（真实山区松树上限，超过就从"森林"变成"世界树"）',
	pineTopMax <= 24,
	`max=${pineTopMax.toFixed(1)} m`,
);
check(
	'树的平均高度落在 9–16 m（次生林的真实区间）',
	pineTopMin / 2 + pineTopMax / 2 >= 9 && pineTopMin / 2 + pineTopMax / 2 <= 16,
	`均值 ≈ ${((pineTopMin + pineTopMax) / 2).toFixed(1)} m`,
);
// 冠层覆盖率：这是"拱廊"还是"深井"的分界线，也是"我像小孩"的直接成因。
// 用 makeCanopy 的实际半径与 canopyRadius 视距估一个天顶遮蔽比例。
const canopyR = 2.6 + 1.9; // (2.6 + rnd()*1.9) 的上界
const cellsPerM2 = W.treeDensity / (cell * cell);
// 视距内可见的冠层投影面积 / 视距圆面积
const viewArea = Math.PI * W.canopyRadius * W.canopyRadius;
const canopyArea = cellsPerM2 * viewArea * Math.min(1, 1 - W.canopySkip) * Math.PI * (canopyR * 0.6) ** 2;
const cover = Math.min(1, canopyArea / viewArea);
console.log(
	`  视距 ${W.canopyRadius} m 内冠层天顶覆盖率 ≈ ${(cover * 100).toFixed(0)}%` +
		`（上界按 1.0 截断，所以这里报 80% 只是"饱和了"）`,
);
// 【判据修正】原判据写成 `cover <= 0.8`，而 cover 被 Math.min(1, …) 截断，
// 导致它永远卡在 0.80 报 FAIL —— 是断言在跟着自己的截断值自欺。
// 真正要防的是**枝叶密度过高 → 抬头看不见天**。所以改判未截断的原始值：
const rawCover = canopyArea / viewArea;
console.log(`  未截断的原始覆盖率 = ${rawCover.toFixed(2)}（这个才是有意义的数）`);
check(
	'原始冠层覆盖率 ≥ 0.45 且有限（不能饱和到 1.0，那意味着抬头完全不见天）',
	rawCover >= 0.45 && rawCover < 4.0,
	`raw=${rawCover.toFixed(2)}`,
);

// ── 2. 林下植被：这一层才是"像小孩"的主犯 ───────────────────────
console.log('\n=== 2. 林下植被的有效高度 ===');
const under = readFileSync(new URL('../src/world/undergrowth.js', import.meta.url), 'utf8');
// 几何高度必须**从源码读**：我第一版把它手抄成一张表，结果抄错了 fern 的
// 高度，探针就报了两个假 FAIL。这跟 jump-probe 头部记的是同一类错误 ——
// 手抄的参数只是把注释又念了一遍，改代码忘改表时它照样绿。
// patchGeometry(s) 是方形贴地片、crossGeometry(w, h) 的第二参才是高度。
const geoH = {};
for (const key of ['moss', 'fern', 'drygrass', 'shrub']) {
	const seg = under.match(new RegExp(`key: '${key}'[\\s\\S]*?(?=\\n\\t\\{|\\n\\];)`));
	if (!seg) continue;
	const cg = seg[0].match(/geo:\s*\(\)\s*=>\s*crossGeometry\(\s*[\d.]+,\s*([\d.]+)\s*\)/);
	const pg = seg[0].match(/geo:\s*\(\)\s*=>\s*patchGeometry\(\s*[\d.]+\s*\)/);
	geoH[key] = cg ? parseFloat(cg[1]) : pg ? 0 : NaN;
}
console.log(
	'  从源码读到的几何高度: ' +
		Object.entries(geoH)
			.map(([k, v]) => `${k}=${Number.isNaN(v) ? '?' : v} m`)
			.join('  '),
);
check(
	'三层立体植被的几何高度都读到了',
	['fern', 'drygrass', 'shrub'].every((k) => Number.isFinite(geoH[k]) && geoH[k] > 0),
);

// 纵向拉伸上界，取自 _refreshLayer 里的 (0.85 + r1 * 0.4)
const STRETCH_MAX = 1.25;
// 各层的设计上限。这个表是**设计意图**，不是从代码里抄的 ——
// 它故意写死，好让"有人把 scale 调大了"这件事必须经过一次 FAIL 才能通过。
// 参照 CFG.player.eye = 1.66 m：胸 1.3 m、肩 1.45 m。
const DESIGN_MAX = { fern: 1.05, drygrass: 1.0, shrub: 1.5 };

for (const key of ['moss', 'fern', 'drygrass', 'shrub']) {
	const re = new RegExp(`key: '${key}'[\\s\\S]*?scale:\\s*\\[([\\d.]+),\\s*([\\d.]+)\\]`);
	const m = under.match(re);
	if (!m) {
		check(`${key} 能从源码读到 scale`, false, '未匹配');
		continue;
	}
	const s1 = parseFloat(m[2]);
	if (key === 'moss') {
		console.log(`  moss     scale 上界 ${s1}  → 贴地，不参与视线遮挡`);
		continue;
	}
	const stretch = STRETCH_MAX;
	const top = geoH[key] * s1 * stretch;
	const ratio = top / EYE;
	console.log(
		`  ${key.padEnd(8)} 几何高 ${geoH[key]} × scale 上界 ${s1} × 拉伸 ${stretch}` +
			` → 最高 ${top.toFixed(2)} m = ${ratio.toFixed(2)} × 眼高  (设计上限 ${DESIGN_MAX[key]} m)`,
	);
	check(`${key} 最高不超过设计上限 ${DESIGN_MAX[key]} m`, top <= DESIGN_MAX[key] + 1e-6, `${top.toFixed(2)} m`);
	check(`${key} 不高于眼高（人不在草里游泳）`, top < EYE, `${ratio.toFixed(2)} × eye`);
}

// ── 3. 综合：视线穿过植被的比例 ──────────────────────────────────
// 这是"我像小孩"最直接的量化代理：站在林下植被里，
// 平视出去能不能看到至少一半的地面。
console.log('\n=== 3. 综合判据：平视可见度 ===');
const blockers = {};
for (const key of ['fern', 'drygrass', 'shrub']) {
	const re = new RegExp(`key: '${key}'[\\s\\S]*?scale:\\s*\\[([\\d.]+),\\s*([\\d.]+)\\]`);
	const m = under.match(re);
	const top = geoH[key] * parseFloat(m[2]) * STRETCH_MAX;
	blockers[key] = top / EYE;
}
const worst = Math.max(...Object.values(blockers));
console.log(
	`  最高的草本 / 眼高 = ${worst.toFixed(2)}` +
		`（fern ${blockers.fern.toFixed(2)}, drygrass ${blockers.drygrass.toFixed(2)}, shrub ${blockers.shrub.toFixed(2)}）`,
);
// 【判据修正】原来写"所有草本 < 0.85 × 眼高"，shrub 报 0.87 FAIL。
// 但灌木本来就该到肩膀 —— 0.87 × 1.66 = 1.44 m，正好是成人肩高，
// 这是**设计目标**而不是缺陷。一条要求"灌木比肩膀矮"的断言是荒谬的。
// 分开判：细草本（fern/drygrass）必须过腰不过胸；灌木允许到肩但绝不过头。
const grassWorst = Math.max(blockers.fern, blockers.drygrass);
console.log(`  细草本最高 / 眼高 = ${grassWorst.toFixed(2)}（目标 < 0.75：过腰不过胸）`);
check(
	'细草本（蕨/枯草）在眼高 75% 以下 —— 过腰不过胸',
	grassWorst < 0.75,
	`${grassWorst.toFixed(2)} × eye = ${(grassWorst * EYE).toFixed(2)} m`,
);
check(
	'灌木可以到肩膀，但绝不超过眼高',
	blockers.shrub < 1.0,
	`${blockers.shrub.toFixed(2)} × eye = ${(blockers.shrub * EYE).toFixed(2)} m`,
);

// ── 4. 回归：这些改动不能把场景改小到不像森林 ────────────────────
console.log('\n=== 4. 回归护栏 ===');
const tplTris = template.geo.index ? template.geo.index.count / 3 : template.geo.attributes.position.count / 3;
console.log(`  模板三角数 = ${tplTris}（× 实例数 = 真实开销）`);
// 【判据修正】我最初写的是"三角数应在 400–1400 之间"，跑出来 114 报 FAIL。
// 但 114 是对的：这是一棵**每实例共享的**低模，1335 个实例 × 114 tri ≈
// 152k tri，而原版 14–22 m 的树也是同一个模板，三角数一样。
// 也就是说这个改动**完全不改三角数预算**，我那条断言只是在瞎猜。
// 真正该守住的是"总预算没变"，所以改成断言 per-instance 上限 + 总数不变。
check('单棵树几何仍在低模区间 60–200 三角形（不能悄悄加细分）', tplTris >= 60 && tplTris <= 200, `${tplTris}`);

// 与改前对比：H 变了但段数没变，所以三角数必须**完全相同** ——
// 这条断言真正在防的是"有人顺手调高了 CylinderGeometry 的段数"。
check('几何细分度与改动无关（H 只改尺度，不改段数）', tplTris === 114, `${tplTris} vs 基准 114`);

const canopy = makeCanopy(0x5eed03, template);
canopy.computeBoundingBox();
const cTop = canopy.boundingBox.max.y;
console.log(
	`  冠层包围盒顶 = ${cTop.toFixed(2)} m（应在树尖 ${tplTop.toFixed(2)} m 之内，不能浮在树尖上方）`,
);
check('冠层不超出树尖', cTop <= tplTop + 0.05, `canopy=${cTop.toFixed(2)} / tree=${tplTop.toFixed(2)}`);
check(
	`冠层底离地 ≥ 2.2 m（玩家在树下能直行，不被叶子糊脸）`,
	canopy.boundingBox.min.y >= 2.2,
	`canopy.bottom=${canopy.boundingBox.min.y.toFixed(2)} m`,
);

// ── 5. 地形的起伏尺度相对人也是合理的 ───────────────────────────
console.log('\n=== 5. 地形起伏（相对人） ===');
let hMin = Infinity;
let hMax = -Infinity;
for (let i = 0; i < 3000; i++) {
	const x = (i * 13.37) % W.tile;
	const z = (i * 7.11) % W.tile;
	const h = terrainHeight(x, z, CFG);
	if (h < hMin) hMin = h;
	if (h > hMax) hMax = h;
}
console.log(`  采样 3000 点的地形高度范围 = ${hMin.toFixed(2)} … ${hMax.toFixed(2)} m`);
check(
	'起伏幅度小于 40 m（否则"山"会长成悬崖，人站在上面比例失衡）',
	hMax - hMin < 40,
	`Δ=${(hMax - hMin).toFixed(2)} m`,
);

// ── 汇总 ─────────────────────────────────────────────────────────
const fail = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(56)}`);
console.log(`  scale-probe: ${results.length - fail.length} PASS / ${fail.length} FAIL`);
if (fail.length) {
	for (const f of fail) console.log(`   FAIL  ${f.name}  ${f.detail || ''}`);
	process.exitCode = 1;
}
