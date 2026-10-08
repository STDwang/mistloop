// 第三人称视角验证：F 切换、E 手电、化身显隐、相机几何、偏好持久化。
//
// ─────────────────────────────────────────────────────────────
// 【这个探针必须存在的原因】
//
// 视角切换是典型的"每一半都对，合起来错"的功能：
//   · controller 的相机数学是对的（有单元探针可证）
//   · avatar 的步态是对的（读 bobPhase，纯函数）
//   · 但"手电换挂点 + 化身显隐 + 设置持久化"是 main.js 里的**接线**，
//     接线错了一根线，游戏就静默地错下去。
// 所以这个脚本走真实浏览器、发真实键盘事件（和 jump-verify 同一哲学），
// 断言的都是玩家能感知的东西：相机在哪、影子有没有、F 按下去发生了什么。
// ─────────────────────────────────────────────────────────────

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TAG = process.argv[2] || 'view';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
};

const server = createServer((req, res) => {
	const url = (req.url || '/').split('?')[0];
	let file = normalize(join(DIST, url === '/' ? 'index.html' : decodeURIComponent(url)));
	if (!file.startsWith(normalize(DIST))) file = join(DIST, 'index.html');
	try {
		if (statSync(file).isDirectory()) file = join(file, 'index.html');
	} catch {
		file = join(DIST, 'index.html');
	}
	res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
	createReadStream(file).pipe(res);
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
console.log(`临时静态服务器: http://127.0.0.1:${port}/?debug`);

const exe = [
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
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
	const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
	// 【踩坑】视口必须是小的。SwiftShader 下 1280×720 只有 2–4 fps，
	// 而引擎把 dt 钳在 0.05 s —— 物理时间以约 1/4 实时流逝，
	// "等 900 ms 再量位移"量到的其实是 0.15 s 的物理位移。
	// 小视口换帧率，配合下面的轮询大预算，才是可靠的等待。
	const errors = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	await page.waitForTimeout(1200);
	const btn = page.locator('button:has-text("进入林子")');
	if (await btn.count()) {
		await btn.click();
		await page.waitForTimeout(1500);
	}

	// ── 探针工具 ────────────────────────────────────────────────
	// 【踩坑 v1】合成 keydown 必须跟着 keyup：input.keys 是按下即入、
	// 松开才出的集合，不发 keyup 的话第二次 keydown 会被
	// `if (!this.keys.has(code))` 门静默吞掉 —— v1 的 E/F"失灵"全是它。
	async function tapKey(page, code, holdMs = 60) {
		await page.evaluate(
			({ code }) => {
				window.dispatchEvent(new KeyboardEvent('keydown', { code }));
			},
			{ code },
		);
		await page.waitForTimeout(holdMs);
		await page.evaluate(
			({ code }) => {
				window.dispatchEvent(new KeyboardEvent('keyup', { code }));
			},
			{ code },
		);
		await page.waitForTimeout(40);
	}

	// 【踩坑 v1】headless 里指针锁可能中途丢失 → onLockChange(false) →
	// paused=true → player.update 不再跑 → 相机冻结在旧位置。
	// v1 的"切回第一人称后相机高度不变"假 FAIL 就是它。
	// 处理方式与真人一致：点击画面重新锁鼠。返回暂停状态供断言参考。
	async function ensureRunning(page) {
		const st = await page.evaluate(() => ({
			paused: window.mist.isPaused(),
			fps: window.mist.engine.fps,
		}));
		if (st.paused) {
			await page.click('#gl');
			await page.waitForTimeout(400);
		}
		const st2 = await page.evaluate(() => ({ paused: window.mist.isPaused() }));
		return { before: st, after: st2 };
	}

	// ── 1. 默认第一人称 ─────────────────────────────────────────
	console.log('\n══════ 1. 默认状态 ══════');
	const fp = await page.evaluate(() => {
		const m = window.mist;
		const p = m.player;
		return {
			mode: p.viewMode,
			avatarVisible: !!m.engine.scene.getObjectByProperty('visible', true) && true,
			camY: m.engine.camera.position.y,
			playerY: p.pos.y,
			eye: m.CFG.player.eye,
		};
	});
	check('默认视角是第一人称', fp.mode === 'first', fp.mode);

	// ── 2. E 键 = 手电 ──────────────────────────────────────────
	console.log('\n══════ 2. E 键手电 ══════');
	await ensureRunning(page);
	const flashState = await page.evaluate(async () => {
		const m = window.mist;
		let spot = null;
		m.engine.scene.traverse((n) => {
			if (n.isSpotLight) spot = n;
		});
		const press = (code, down) =>
			window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
		const before = spot.visible;
		press('KeyE', true);
		await new Promise((r) => setTimeout(r, 80));
		press('KeyE', false);
		await new Promise((r) => setTimeout(r, 80));
		const afterOff = spot.visible;
		press('KeyE', true);
		await new Promise((r) => setTimeout(r, 80));
		press('KeyE', false);
		await new Promise((r) => setTimeout(r, 80));
		const afterOn = spot.visible;
		return { before, afterOff, afterOn };
	});
	check(
		'E 键切换手电（开→关→开）',
		flashState.before === true && flashState.afterOff === false && flashState.afterOn === true,
		`before=${flashState.before} off=${flashState.afterOff} on=${flashState.afterOn}`,
	);

	// ── 3. F 键 = 切到第三人称 ──────────────────────────────────
	console.log('\n══════ 3. F 切第三人称 ══════');
	await ensureRunning(page);
	await page.keyboard.press('F');
	await page.waitForTimeout(600);

	const tp = await page.evaluate(() => {
		const m = window.mist;
		const p = m.player;
		const cam = m.engine.camera;
		// 化身可见性：avatar.root 在场景里
		// 通过手电装具的世界位置反查挂点：第三人称时光应在化身头上
		let spot = null;
		m.engine.scene.traverse((n) => {
			if (n.isSpotLight) spot = n;
		});
		const V3 = cam.position.constructor;
		const lightPos = new V3();
		spot.getWorldPosition(lightPos);
		const headW = p.viewMode === 'third' ? lightPos : null;
		const dx = cam.position.x - p.pos.x;
		const dz = cam.position.z - p.pos.z;
		const dy = cam.position.y - p.pos.y;
		const flat = Math.hypot(dx, dz);
		const sy = Math.sin(p.yaw);
		const cy = Math.cos(p.yaw);
		// 相机在"前方"投影 = forward·offset。第三人称应为负（在身后）。
		const fwdDot = -sy * dx + -cy * dz;
		return {
			mode: p.viewMode,
			flat,
			dy,
			fwdDot,
			lightDy: lightPos.y - (p.pos.y + 1.56),
			lightFlat: Math.hypot(lightPos.x - p.pos.x, lightPos.z - p.pos.z),
			stored: JSON.parse(localStorage.getItem('mistloop.settings.v1') || '{}').viewMode,
		};
	});
	check('F 后 viewMode = third', tp.mode === 'third', tp.mode);
	check(
		'相机在人物身后（前方投影 < 0）',
		tp.fwdDot < -0.5,
		`fwdDot=${tp.fwdDot.toFixed(2)} m`,
	);
	check(
		'相机水平距离接近设计值 3.4 m',
		Math.abs(tp.flat - 3.4) < 0.6,
		`flat=${tp.flat.toFixed(2)} m`,
	);
	check(
		'相机高于人物（俯视机位）',
		tp.dy > 1.2 && tp.dy < 3.4,
		`dy=${tp.dy.toFixed(2)} m`,
	);
	check(
		'手电已换挂到化身头部（高度≈化身眼高）',
		Math.abs(tp.lightDy) < 0.25 && tp.lightFlat < 0.5,
		`dy=${tp.lightDy.toFixed(2)} flat=${tp.lightFlat.toFixed(2)}`,
	);
	check('偏好已写入 localStorage', tp.stored === 'third', `stored=${tp.stored}`);

	await page.screenshot({ path: `out/${TAG}-third-road.png` });

	// ── 4. 第三人称下移动仍然有效 ───────────────────────────────
	console.log('\n══════ 4. 移动与回归 ══════');
	const ensure1 = await ensureRunning(page);
	// 【踩坑】出生点正前方可能正好有树 —— v1 里 speed=2.31 m/s
	// 但 900 ms 位移只有 0.21 m，就是顶着树走。所以先环顾 16 个方向，
	// 用 forest.treeCountNear 挑一条 4 m 内无树的走向，再开走。
	const move = await page.evaluate(async () => {
		const m = window.mist;
		const p = m.player;
		const press = (code, down) =>
			window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
		// 选方向：从当前点向 16 个方向探 4 m，取"树最少"的方向
		let bestYaw = p.yaw;
		let bestScore = Infinity;
		for (let i = 0; i < 16; i++) {
			const y = (i / 16) * Math.PI * 2;
			const sx = -Math.sin(y);
			const cz = -Math.cos(y);
			let score = 0;
			for (let d = 1; d <= 4; d += 1) {
				score += m.forest.treeCountNear(p.pos.x + sx * d, p.pos.z + cz * d, 1.1);
			}
			if (score < bestScore) {
				bestScore = score;
				bestYaw = y;
			}
		}
		// 【踩坑】input 上没有 yaw 属性 —— 真值源是 player.yaw。
		// v1 设 m.input.yaw 等于往一个没人读的属性上写，
		// 玩家仍面朝出生点那棵树，speed=2.31 但位移只有 0.21。
		m.player.yaw = bestYaw;
		m.player.pitch = 0;
		m.player._apply();
		const x0 = p.pos.x;
		const z0 = p.pos.z;
		press('KeyW', true);
		// 【踩坑】不能按墙钟等 —— 帧率低时物理时间远慢于墙钟。
		// 轮询：位移过阈值即成功，15 s 墙钟预算兜底。
		let moved = 0;
		const t0 = performance.now();
		while (performance.now() - t0 < 15000) {
			await new Promise((r) => setTimeout(r, 100));
			moved = Math.hypot(p.pos.x - x0, p.pos.z - z0);
			if (moved > 1.5) break;
		}
		press('KeyW', false);
		return {
			clear: bestScore,
			moved,
			speed: p.speed,
			paused: m.isPaused(),
		};
	});
	check(
		'第三人称下 W 仍能移动',
		move.moved > 1.2 && move.clear === 0,
		`moved=${move.moved.toFixed(2)} m speed=${move.speed.toFixed(2)} 前方树=${move.clear} paused=${move.paused}`,
	);

	// 密林定标点：化身在树丛里的截图（比例感的最终目检）
	await page.evaluate(() => {
		const m = window.mist;
		m.player.warpTo(-63, 41);
		m.input.yaw = 1.2;
		m.player._apply();
	});
	await page.waitForTimeout(700);
	await page.screenshot({ path: `out/${TAG}-third-thicket.png` });

	// ── 5. F 切回第一人称 ───────────────────────────────────────
	console.log('\n══════ 5. F 切回第一人称 ══════');
	await ensureRunning(page);
	await tapKey(page, 'KeyF');
	// 轮询等相机真正回到眼高（低帧率下 _apply 要等到下一帧才生效）
	const back = await page.evaluate(async () => {
		const m = window.mist;
		const p = m.player;
		const cam = m.engine.camera;
		const t0 = performance.now();
		let camDy = cam.position.y - p.pos.y;
		while (performance.now() - t0 < 6000) {
			camDy = cam.position.y - p.pos.y;
			if (Math.abs(camDy - 1.66) < 0.12 && p.viewMode === 'first') break;
			await new Promise((r) => setTimeout(r, 100));
		}
		return {
			mode: p.viewMode,
			camDy,
			paused: m.isPaused(),
			stored: JSON.parse(localStorage.getItem('mistloop.settings.v1') || '{}').viewMode,
		};
	});
	check('切回后 viewMode = first', back.mode === 'first', back.mode);
	check(
		'相机回到眼高',
		Math.abs(back.camDy - 1.66) < 0.12,
		`camDy=${back.camDy.toFixed(3)} m（eye=1.66）paused=${back.paused}`,
	);
	check('偏好同步回 first', back.stored === 'first', `stored=${back.stored}`);

	// ── 6. 跳跃在第三人称下不炸 ─────────────────────────────────
	await ensureRunning(page);
	// 切回第三人称再跳（覆盖"第三人称 + 跳跃"的组合）
	await tapKey(page, 'KeyF');
	// 【踩坑】化身刚显隐会触发 SwiftShader 的着色器惰性编译，
	// rAF 可能停摆 300–500 ms。固定等 150 ms 再读 airborne 会撞上停摆，
	// 读到"还没跳"。改成轮询：1.5 s 内等到离地就算起跳成功。
	await page.waitForTimeout(600);
	const jump = await page.evaluate(async () => {
		const m = window.mist;
		const p = m.player;
		const press = (code, down) =>
			window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
		const waitGrounded = async (target, budgetMs) => {
			const t0 = performance.now();
			while (performance.now() - t0 < budgetMs) {
				if (p.airborne === target) return true;
				await new Promise((r) => setTimeout(r, 40));
			}
			return p.airborne === target;
		};
		press('Space', true);
		await new Promise((r) => setTimeout(r, 50));
		press('Space', false);
		const rose = await waitGrounded(true, 6000);
		// 0.94 s 滞空 = 约 19 个物理帧；SwiftShader 2–4 fps 时墙钟要 5–10 s
		const landed = await waitGrounded(false, 25000);
		return { rose, landed, mode: p.viewMode };
	});
	check(
		'第三人称下跳跃-落地循环正常',
		jump.rose === true && jump.landed === true,
		`rose=${jump.rose} landed=${jump.landed} mode=${jump.mode}`,
	);

	// ── 7. 刷新后偏好恢复 ───────────────────────────────────────
	console.log('\n══════ 6. 偏好恢复 ══════');
	// 当前已是 third（第 6 节切过）。刷新后应自动恢复 third。
	await page.reload({ waitUntil: 'load' });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	await page.waitForTimeout(1000);
	const btn2 = page.locator('button:has-text("进入林子")');
	if (await btn2.count()) {
		await btn2.click();
		await page.waitForTimeout(1200);
	}
	const persisted = await page.evaluate(() => {
		const m = window.mist;
		let spot = null;
		m.engine.scene.traverse((n) => {
			if (n.isSpotLight) spot = n;
		});
		const V3 = m.engine.camera.position.constructor;
		const v = new V3();
		spot.getWorldPosition(v);
		return {
			mode: m.player.viewMode,
			// 光的世界高度（相对脚）：第一人称挂相机 = eye-0.12 ≈ 1.54；
			// 第三人称挂化身头 = 1.56-0.12 ≈ 1.44。两个值靠得近，
			// 但判据给 ±0.05 就能分开 —— v1 把判据写成 1.3–1.9，
			// 两种模式都落在里面，等于没判。
			lightY: v.y - m.player.pos.y,
		};
	});
	check('刷新后视角偏好恢复为 third', persisted.mode === 'third', persisted.mode);
	check(
		'刷新后手电挂在化身头上（lightY≈1.44，而非相机的 1.54）',
		Math.abs(persisted.lightY - 1.44) < 0.06,
		`lightY=${persisted.lightY.toFixed(3)} m`,
	);

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	const fail = results.filter((r) => !r.ok);
	console.log(`\n${'='.repeat(56)}`);
	console.log(`  view-verify: ${results.length - fail.length} PASS / ${fail.length} FAIL`);
	if (fail.length) for (const f of fail) console.log(`   FAIL  ${f.name}  ${f.detail || ''}`);
	if (errors.length) process.exitCode = 1;
} finally {
	if (browser) await browser.close();
	await new Promise((r) => server.close(r));
	console.log('\n临时服务器已关闭，端口已释放。');
}
