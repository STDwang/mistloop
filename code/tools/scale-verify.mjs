// 自托管尺度验证：起一个临时静态服务器 → 跑浏览器验证 → 立刻关掉。
//
// ─────────────────────────────────────────────────────────────
// 【为什么不用常驻 dev server】
//
// 之前所有浏览器验证都依赖 http://127.0.0.1:5199/ 这个常驻 vite dev server。
// 它的代价是显而易见的：验证跑完以后端口还开着、进程还挂着，
// 用户会问"这是什么，能关吗"，而一旦它挂了（进程被回收 / 用户手工关掉），
// 所有验证脚本就集体失效，报一个和被测代码毫无关系的 ECONNREFUSED。
//
// 所以改成：脚本自己在 127.0.0.1 上开一个随机端口，服务 dist/，
// 验证完在 finally 里 close()。这样验证的成败只取决于代码本身。
//
// 用 dist/（构建产物）而不是 src/：这样连"改动能不能编译"也一起验了。
// 代价是不能热更新，但这个脚本本来就是一次性的快照验证，不需要 HMR。
// ─────────────────────────────────────────────────────────────

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TAG = process.argv[2] || 'scale-after';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

// ── 临时静态服务器 ──────────────────────────────────────────────
const server = createServer((req, res) => {
	const url = (req.url || '/').split('?')[0];
	let file = normalize(join(DIST, url === '/' ? 'index.html' : decodeURIComponent(url)));
	// 目录穿越防护：任何逃出 DIST 的请求都当成 index.html
	if (!file.startsWith(normalize(DIST))) file = join(DIST, 'index.html');
	try {
		if (statSync(file).isDirectory()) file = join(file, 'index.html');
	} catch {
		file = join(DIST, 'index.html'); // SPA 回退
	}
	res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
	createReadStream(file).pipe(res);
});

const port = await new Promise((resolve, reject) => {
	// 端口 0 = 让内核分配一个空闲端口。用固定端口会和别的进程撞。
	server.listen(0, '127.0.0.1', () => resolve(server.address().port));
	server.on('error', reject);
});
const URLBASE = `http://127.0.0.1:${port}/?debug`;
console.log(`临时静态服务器: ${URLBASE}  (dist 已构建)`);

const CANDIDATES = [
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
	process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const exe = CANDIDATES.find((p) => p && existsSync(p));
if (!exe) {
	console.error('找不到 Chrome/Edge');
	server.close();
	process.exit(2);
}

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
}

let browser;
try {
	browser = await chromium.launch({
		executablePath: exe,
		headless: true,
		args: [
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--enable-webgl',
			'--ignore-gpu-blocklist',
			'--disable-gpu-sandbox',
			'--no-sandbox',
		],
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

	const errors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

	await page.goto(URLBASE, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	await page.waitForTimeout(1500);
	// 点掉标题屏，否则所有截图都是标题画面
	const btn = page.locator('button:has-text("进入林子")');
	if (await btn.count()) {
		await btn.click();
		// 等 intro 的淡出结束、控制权交给游戏
		await page.waitForTimeout(1800);
	}
	await page.waitForTimeout(1500);

	// ── 运行时尺度实测 ──────────────────────────────────────────
	const probe = await page.evaluate(() => {
		const m = window.mist;
		const CFG = m.CFG;
		const EYE = CFG.player.eye;

		const layers = m.undergrowth.layers.map((L) => {
			L.mesh.geometry.computeBoundingBox();
			const bb = L.mesh.geometry.boundingBox;
			const geoH = bb.max.y - bb.min.y;
			const sc = L.def.scale;
			return {
				key: L.def.key,
				geoH,
				scaleMax: sc[1],
				// 纵向拉伸上界：代码里是 (0.85 + r1 * 0.4)，r1 ∈ [0,1]
				topMax: geoH * sc[1] * (L.def.key === 'moss' ? 1 : 1.25),
				count: L.mesh.count,
			};
		});

		// 树：直接读渲染器实际持有的实例矩阵。
		// getMatrixAt 需要一个真的 THREE.Matrix4（内部会调 fromArray）。
		// 【踩坑】我第一版从 mesh.instanceMatrix 上取构造器 —— 但那是
		// BufferAttribute，不是 Matrix4，拿到的"类"没有 fromArray，
		// 于是报 t.fromArray is not a function。正确来源是任一 Object3D 的
		// matrix / matrixWorld：那才是 Matrix4 实例。这里用相机自己的。
		// 另一个更省事的办法是直接读 instanceMatrix.array 的 stride 偏移，
		// 但那依赖 three 内部布局，用 matrix 更稳。
		const tr = m.forest.types[0];
		tr.mesh.geometry.computeBoundingBox();
		const geoTop = tr.mesh.geometry.boundingBox.max.y;
		const Matrix4 = m.engine.camera.matrix.constructor;
		const tmpMat = new Matrix4();
		let treeHMin = Infinity;
		let treeHMax = -Infinity;
		let treeHSum = 0;
		let treeHN = 0;
		for (let i = 0; i < tr.count; i++) {
			tr.mesh.getMatrixAt(i, tmpMat);
			const h = geoTop * tmpMat.elements[5];
			if (h < treeHMin) treeHMin = h;
			if (h > treeHMax) treeHMax = h;
			treeHSum += h;
			treeHN++;
		}

		return {
			eye: EYE,
			layers,
			trees: { n: treeHN, min: treeHMin, max: treeHMax, avg: treeHSum / Math.max(1, treeHN) },
			canopyCount: m.forest.canopy.count,
			treesTotal: m.forest.types[0].count + m.forest.types[1].count,
			plants: m.undergrowth.count,
			drawCalls: m.engine.renderer.info.render.calls,
			triangles: m.engine.renderer.info.render.triangles,
		};
	});

	console.log('\n══════ 运行时尺度实测 ══════');
	console.log(`  眼高 eye = ${probe.eye} m（中国成年男性眼高 1.60–1.66 m）`);
	console.log(
		`  树（渲染器实际矩阵）: ${probe.trees.n} 棵，高度 ` +
			`${probe.trees.min.toFixed(1)} – ${probe.trees.max.toFixed(1)} m，均值 ${probe.trees.avg.toFixed(1)} m`,
	);
	console.log(
		`  冠层 ${probe.canopyCount} / 树干 ${probe.treesTotal} / 林下植被 ${probe.plants}；` +
			`draw calls ${probe.drawCalls}，三角形 ${(probe.triangles / 1000).toFixed(0)}k`,
	);
	console.log('  林下植被：');
	for (const L of probe.layers) {
		console.log(
			`    ${L.key.padEnd(9)} geoH=${L.geoH.toFixed(2)} scaleMax=${L.scaleMax}` +
				` → 最高 ${L.topMax.toFixed(2)} m = ${(L.topMax / probe.eye).toFixed(2)} × 眼高  (实例 ${L.count})`,
		);
	}

	console.log('\n══════ 断言 ══════');
	check('树最高不超过 18 m', probe.trees.max <= 18, `max=${probe.trees.max.toFixed(1)} m（改前约 28.6 m）`);
	check('树均高在 9–14 m', probe.trees.avg >= 9 && probe.trees.avg <= 14, `avg=${probe.trees.avg.toFixed(1)} m`);
	check(
		'树均高是眼高的 6–9 倍（还是森林，不是苗圃）',
		probe.trees.avg / probe.eye >= 6 && probe.trees.avg / probe.eye <= 9,
		`${(probe.trees.avg / probe.eye).toFixed(1)} × eye`,
	);
	const grass = probe.layers.filter((L) => ['fern', 'drygrass'].includes(L.key));
	for (const L of grass) {
		check(
			`${L.key} 在眼高 75% 以下（过腰不过胸）`,
			L.topMax / probe.eye < 0.75,
			`${L.topMax.toFixed(2)} m = ${(L.topMax / probe.eye).toFixed(2)} × eye`,
		);
	}
	const shrub = probe.layers.find((L) => L.key === 'shrub');
	if (shrub) {
		check('灌木可到肩膀但绝不超过眼高', shrub.topMax < probe.eye, `${shrub.topMax.toFixed(2)} m`);
	}

	// ── 定标截图 ────────────────────────────────────────────────
	const SHOTS = [
		{ name: 'road', x: 24.0, z: -38.0, yaw: 0.6 },
		{ name: 'road-far', x: 52.0, z: 12.0, yaw: 2.1 },
		{ name: 'thicket', x: -63.0, z: 41.0, yaw: 4.0 },
		{ name: 'thicket-look', x: -63.0, z: 41.0, yaw: 1.3, pitch: -0.42 },
	];
	console.log('\n══════ 定标截图 ══════');
	for (const s of SHOTS) {
		await page.evaluate(
			({ x, z, yaw, pitch }) => {
				const m = window.mist;
				m.player.warpTo(x, z);
				// 【踩坑】真值源是 player.yaw / player.pitch ——
				// input 上没有 yaw 属性，设它等于没人读。
				m.player.yaw = yaw;
				m.player.pitch = pitch;
				m.player._apply();
			},
			{ x: s.x, z: s.z, yaw: s.yaw, pitch: s.pitch ?? 0 },
		);
		await page.waitForTimeout(700);
		const out = `out/${TAG}-${s.name}.png`;
		await page.screenshot({ path: out });
		console.log(`  ${out}  @(${s.x}, ${s.z}) yaw=${s.yaw} pitch=${s.pitch ?? 0}`);
	}

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	const fail = results.filter((r) => !r.ok);
	console.log(`\n${'='.repeat(56)}`);
	console.log(`  scale-verify: ${results.length - fail.length} PASS / ${fail.length} FAIL`);
	if (fail.length) for (const f of fail) console.log(`   FAIL  ${f.name}  ${f.detail || ''}`);
	if (errors.length) console.log(`   另有 ${errors.length} 条控制台错误`);
} finally {
	// 无论成败都必须关掉端口 —— 这就是改掉常驻 dev server 的意义所在
	if (browser) await browser.close();
	await new Promise((r) => server.close(r));
	console.log('\n临时服务器已关闭，端口已释放。');
}
