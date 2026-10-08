// 树林几何体检探针。
// 在 Node 里直接 import src/world/forest.js 的几何构造函数，检查：
//   1. 三角形数在预算内（实例化 × 数量 = 总三角形）
//   2. 冠层真的挂在树干中上部（飘起来 / 陷进地里都会被抓到）
//   3. 冠层包围盒比例像个锥形树冠，而不是一块方板
//
// 为什么值得写：这两个数都只能在浏览器里目测，而目测一定会漏。
// 三角形数悄悄翻倍 → 掉帧；冠层 Y 偏移写错 → 树冠飘在半空。
// 让它们可断言，比"再看一眼"可靠。

import * as THREE from 'three';

// forest.js 的 needleTexture() 需要 canvas。几何检查不需要贴图，给个桩。
function stubCanvas() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = {
    canvas: null,
    clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, stroke: noop, fill: noop, arc: noop, ellipse: noop,
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    closePath: noop, strokeRect: noop, setTransform: noop, drawImage: noop,
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', globalAlpha: 1,
    font: '', textAlign: '', textBaseline: '',
  };
  const c = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = c;
  return c;
}
globalThis.document = { createElement: () => stubCanvas() };
globalThis.window = { devicePixelRatio: 1 };
globalThis.self = globalThis.window;

const F = await import('file:///E:/AiStudy/silentHill/code/src/world/forest.js');

// α: treeCell 数 / 渲染半径。用来算实例上限。
const TREE_CELLS = 49;
const TILE = 196;

function tri(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
function bbox(g) {
  g.computeBoundingBox();
  const b = g.boundingBox;
  return { min: b.min.clone(), max: b.max.clone(), size: b.max.clone().sub(b.min) };
}
function fmt(v) { return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`; }

let fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
}

console.log('══════════ 树林几何体检 ══════════\n');

// ── 1. 枯松 ──────────────────────────────────────────────────
console.log('[枯松]');
const pine = F.makePine(0x5eed01);
const pineTri = tri(pine.geo);
const pb = bbox(pine.geo);
console.log(`  三角形/棵 = ${pineTri}   高 = ${pine.H.toFixed(1)} m`);
console.log(`  包围盒 size = ${fmt(pb.size)}`);
check('树干几何有效（三角形 > 100）', pineTri > 100, `实际 ${pineTri}`);
// 【判据已更新】原来是 14–22 m。用户反馈"视角像小孩"之后，
// 世界尺度整体下调约 20%，模板 H 变成 11–17 m（见 forest.js makePine 注释）。
// 这里跟着改是**必须的**：不改的话探针会一直红着，
// 而一个长期红的探针等于没有探针 —— 所有人都会学会忽略它。
check('模板树高在 11–17 m（真实次生林，仍成拱廊）', pine.H >= 11 && pine.H <= 17, `实际 ${pine.H.toFixed(1)} m`);
check(
	'模板树高是眼高的 6–11 倍（还要像森林，不能像苗圃）',
	pine.H / 1.66 >= 6 && pine.H / 1.66 <= 11,
	`${(pine.H / 1.66).toFixed(1)} × eye`,
);
check('高度方向的包围盒覆盖全树高', pb.size.y > pine.H * 0.85, `bbox.y=${pb.size.y.toFixed(1)} vs H=${pine.H.toFixed(1)}`);

// ── 2. 树桩 ──────────────────────────────────────────────────
console.log('\n[树桩]');
const snag = F.makeSnag(0x5eed02);
const snagTri = tri(snag.geo);
console.log(`  三角形/棵 = ${snagTri}   高 = ${snag.H.toFixed(1)} m`);
check('树桩几何有效', snagTri > 50, `实际 ${snagTri}`);

// ── 3. 冠层 ──────────────────────────────────────────────────
console.log('\n[冠层]');
const canopy = F.makeCanopy(0x5eed03, pine); // 冠层直接返回几何（无树高元数据）
const canopyTri = tri(canopy);
const cb = bbox(canopy);
const H = pine.H;
console.log(`  三角形/棵 = ${canopyTri}`);
console.log(`  包围盒 min = ${fmt(cb.min)}  max = ${fmt(cb.max)}`);
console.log(`  包围盒 size = ${fmt(cb.size)}`);
console.log(`  以树高归一化的 Y 范围: ${(cb.min.y / H).toFixed(3)} ~ ${(cb.max.y / H).toFixed(3)}`);

// 冠层必须在树的中上部。低于 0 就是陷进地里，高于 H 就是飘在天上。
check('冠层没有低于地面', cb.min.y > -0.4, `min.y = ${cb.min.y.toFixed(3)}`);
check('冠层没有高过树顶', cb.max.y < H + 1.0, `max.y = ${cb.max.y.toFixed(2)} vs H = ${H.toFixed(2)}`);
// 阈值是 0.35 而不是 0.45：叶片四边形有 2–3 m 宽，挂在 0.5H 时它的下缘
// 自然会垂到 0.43H 附近。这不是 bug，"头顶有顶、身侧通透"正是要的拱廊感。
// 真正要守住的是"玩家头部（1.66 m ≈ 0.10H）不会被叶子糊住"。
check(
  '冠层主体在 35%–105% 树高之间（中上部拱廊）',
  cb.min.y > H * 0.35 && cb.max.y < H * 1.05,
  `实际 ${(cb.min.y / H).toFixed(2)}H ~ ${(cb.max.y / H).toFixed(2)}H`,
);
// 关键的可玩性断言：冠层下缘必须高于玩家眼睛，否则走在树间会被叶子刷脸
const EYE = 1.66;
check(
  '冠层下缘高于玩家眼睛（不会糊脸）',
  cb.min.y > EYE + 3.0,
  `冠层底 ${cb.min.y.toFixed(1)} m vs 眼高 ${EYE} m`,
);
// 锥形松树：冠幅要明显小于树高，否则就是一把伞
const spread = Math.max(cb.size.x, cb.size.z);
check(
  '冠幅是树高的 20%–70%（锥形，不是伞形）',
  spread > H * 0.2 && spread < H * 0.7,
  `冠幅 ${spread.toFixed(1)} m = ${(spread / H * 100).toFixed(0)}% 树高`,
);

// ── 4. 实例预算 ──────────────────────────────────────────────
console.log('\n[实例预算]');
// 半径 R 米内期望的树数 ≈ π R² × 密度 / 格面积
const cell = TILE / TREE_CELLS;
const density = 0.72;
function expectedTrees(R) {
  return (Math.PI * R * R * density) / (cell * cell);
}
const R = 72;
const canopyR = 58;
const nTree = Math.round(expectedTrees(R));
const nCanopy = Math.round(expectedTrees(canopyR) * 0.84 * (1 - 0.22)); // 84% 是 pine 占比，再扣掉 canopySkip
console.log(`  格边长 ${cell} m，密度 ${density}`);
console.log(`  视距 ${R} m 内期望树数 ≈ ${nTree}（上限 1400 + 480 = 1880）`);
console.log(`  冠层视距 ${canopyR} m 内期望冠层数 ≈ ${nCanopy}（上限 1400）`);
check('树干实例上限够用', nTree < 1400, `需要 ${nTree}`);
check('冠层实例上限够用', nCanopy < 1400, `需要 ${nCanopy}`);

let totalTri = nTree * 0.84 * pineTri + nTree * 0.16 * snagTri + nCanopy * canopyTri;
console.log(`\n  最坏情况总三角形 ≈ ${(totalTri / 1000).toFixed(0)}k`);
console.log(`    · 树干(枯松) ${(nTree * 0.84 * pineTri / 1000).toFixed(0)}k`);
console.log(`    · 树干(树桩) ${(nTree * 0.16 * snagTri / 1000).toFixed(0)}k`);
console.log(`    · 冠层       ${(nCanopy * canopyTri / 1000).toFixed(0)}k`);
check('总三角形 < 900k（核显可承受）', totalTri < 900000, `${(totalTri / 1000).toFixed(0)}k`);

console.log(`\n══════════ ${fail === 0 ? '全部通过' : fail + ' 项失败'} ══════════`);
process.exit(fail === 0 ? 0 : 1);
