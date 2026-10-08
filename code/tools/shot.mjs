// Dream Loop 的"拍一张产品现在的样子"。
//
// 这个脚本存在的唯一理由：dream-loop 的循环是
//   目标图 → 子代理改 → **截图** → 比对 → 再改
// 中间那一步必须是**可重复、可脚本化**的，否则每轮都要手工摆机位，
// 出来的图没法逐轮对比（机位一变，"变亮了"和"镜头挪了"就分不清）。
//
// 所以这里把机位、天气、鬼影距离、闪电强度全部**钉死**，
// 只让光线/材质/模型的变化体现在像素上。
//
// 用法：
//   node tools/shot.mjs                 # 拍全套到 ../../.dream-loop/shots/
//   node tools/shot.mjs --tag before    # 加前缀，方便前后对比
//
// 【为什么不用固定 sleep，而用"等 N 帧"】
// SwiftShader 在 1280×720 下大约 2–3 fps，而且引擎把 dt 夹在 0.05 s。
// `waitForTimeout(2000)` 在真机上够走 120 帧、在离屏只走 4–6 帧 ——
// 同一个脚本在两台机器上拍出的东西不一样。等帧数才是确定的。
//
// 【为什么有些地方要"篡改"运行中的对象】
// 闪电 0.115 s 就衰减完，而离屏只有 2–3 fps —— 走正常路径截图，
// 几乎必然拍到"闪电已经没了"的那一帧。这不是作弊，是**把时间轴钉住**：
// 我们要的是"闪电下的森林长什么样"这张确定的图，不是"我运气好不好"。
// 所有篡改都发生在页面内、只影响这一次摆拍，不改任何源码。

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = new URL('../../.dream-loop/shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
	'.html': 'text/html;charset=utf-8',
	'.js': 'text/javascript;charset=utf-8',
	'.css': 'text/css;charset=utf-8',
	'.png': 'image/png',
	'.glb': 'model/gltf-binary',
};

const tagArg = process.argv.indexOf('--tag');
const TAG = tagArg > 0 && process.argv[tagArg + 1] ? process.argv[tagArg + 1] + '-' : '';

// 截图用 720p。这是宪法里写着的目标分辨率 —— 拍"标准分辨率下的真实观感"，
// 而不是 4K 向下采样出来的假清晰。
const W = 1280;
const H = 720;

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

const exe = [
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let browser;
const shots = [];
try {
	mkdirSync(OUT, { recursive: true });
	browser = await chromium.launch({
		executablePath: exe,
		headless: true,
		args: [
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--enable-webgl',
			'--no-sandbox',
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	const page = await browser.newPage({ viewport: { width: W, height: H } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 90000 });
	await page.waitForTimeout(1500);

	// 等 n 个**真实渲染帧**（不是 n 次定时器）
	const frames = (n) =>
		page.evaluate(
			(k) =>
				new Promise((res) => {
					let i = 0;
					const tick = () => (++i >= k ? res(i) : requestAnimationFrame(tick));
					requestAnimationFrame(tick);
				}),
			n,
		);

	const shot = async (name, note) => {
		const path = join(OUT, TAG + name + '.png');
		await page.screenshot({ path });
		shots.push({ name: TAG + name, path, note });
		console.log(`  ✓ ${TAG + name}.png  ${note}`);
	};

	// ── 0. 标题屏 ────────────────────────────────────────────────
	// 它不只是"菜单"：宪法要求首帧 < 1.5 s 且不许出现进度条，
	// 所以将来要在标题屏背后预热模型/贴图。这张图是那个改造的基线。
	await shot('00-title', '标题屏（玩家看到的第一眼）');

	// 进林子。HUD 上的字会抢走视线，但它们是产品的一部分 ——
	// 场景/美术迭代关心的是"画面"，所以这里把信息条藏掉，
	// 只留 #gl 里的颗粒/暗角（那才是气氛本身）。
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(1000);
	await page.evaluate(() => {
		window.mist.pause(false);
		for (const id of ['hud-top', 'crosshair', 'help', 'stats', 'objective', 'subtitle', 'bearing']) {
			const el = document.getElementById(id);
			if (el) el.style.display = 'none';
		}
		const r = window.mist.engine.renderer;
		if (r) r.setPixelRatio(1);
	});

	// 场景摆位辅助。全部走真实 API，不手改矩阵。
	await page.evaluate(`
		(() => {
			const m = window.mist;
			const P = m.player, cam = m.engine.camera, S = m.stalker, d = m.director, L = m.lightning;
			const F = m.CFG.flashlight;
			const PROTO_UPDATE = Object.getPrototypeOf(L).update;

			window.__S = {
				// 把玩家和相机摆到确定状态。相机必须手动同步 ——
				// 摆拍时 player.update 未必刚好替我们写过相机。
				place(px, pz, yaw, pitch) {
					P.warpTo(px, pz);
					P.yaw = yaw; P.pitch = pitch;
					cam.position.set(P.pos.x, P.pos.y + P.eyeHeight, P.pos.z);
					cam.rotation.set(pitch, yaw, 0);
					cam.updateMatrixWorld(true);
				},
				// 鬼影摆到"相对当前朝向的某个方位、某个距离"
				ghostAt(dist, azOff) {
					const a = P.yaw + azOff;
					const gx = P.pos.x - Math.sin(a) * dist;
					const gz = P.pos.z - Math.cos(a) * dist;
					S.show();
					S.place(gx, gz);
					S.faceTarget(P.pos.x, P.pos.z);
					S.setDistanceHint(dist);
					return { gx, gz };
				},
				// 从真实光束起点看过去，某身体高度出现在多少仰角上 ——
				// 把这个值设成 pitch，光束就精确穿过那个高度。
				elevOf(offsetY) {
					const a = m.flashlight.aim({});
					const dy = S.pos.y + offsetY - a.oy;
					const dh = Math.hypot(S.pos.x - a.ox, S.pos.z - a.oz);
					return Math.atan2(dy, dh);
				},
				midOffset: m.CFG.entity.height * F.aimAt,
				// 关掉一切自主行为。我们摆的不是"某一帧碰巧的样子"，
				// 是"导演不插手时这个世界本来的样子"。
				quiet() {
					d.cooldown = 1e9;
					d.pending = null;
					// 导演每帧按显形规则重写鬼影的透明度/状态。
					// 摆拍期间必须停掉它 —— 否则我们设的 opacity 下一帧就被覆盖。
					d._tickEntity = () => {};
					L._next = 1e9;
					L._pulses.length = 0;
					L._pending.length = 0;
					L.flash = 0;
					L.light.intensity = 0;
					m.safehouse.light.intensity = 0;
					m.safehouse.ember.visible = false;
				},
				// 手电开关（走真实字段，和 toggle() 写的是同一个）
				torch(on) {
					const f = m.flashlight;
					f.on = on;
					f.light.visible = on;
					f.fill.visible = on;
					f.cone.visible = on;
				},
				// 把闪电钉在峰值。恢复用 release()。
				holdFlash() {
					L._strike && L._strike(0.25); // 抽一次真实的方位角/仰角
					L.update = function () {
						this.flash = 1.0;
						this.light.intensity = this.cfg.lightning.peak;
					};
				},
				releaseFlash() {
					L.update = PROTO_UPDATE.bind(L);
					L.flash = 0;
					L.light.intensity = 0;
				},
				ghost() { return S; },
			};
		})()
	`);

	const T = await page.evaluate('window.mist.CFG.world.tile');
	const MID = T * 0.5 + 6;

	// ── 1/2. 林子 · 平视 ────────────────────────────────────────
	// 机位选在林地中段、朝向让近处有树、远处有雾 —— 这是这个游戏
	// 最主要的"画面"，也是美术迭代的主战场。
	await page.evaluate(`
		(() => {
			const S = window.__S;
			S.quiet();
			S.place(${MID}, ${MID}, 0.9, -0.045);
			S.torch(true);
		})()
	`);
	await frames(12);
	await shot('01-forest', '第一人称 · 手电亮 · 小雨');

	// 关手电的同一机位：便于对比"手电到底贡献了多少"
	await page.evaluate('window.__S.torch(false)');
	await frames(8);
	await shot('02-forest-nolight', '同机位 · 手电关（对比用）');

	// ── 3. 闪电 ─────────────────────────────────────────────────
	await page.evaluate('(() => { window.__S.torch(true); window.__S.holdFlash(); })()');
	await frames(12);
	await shot('03-lightning', '闪电峰值 · 方向光 + 雾 + 天空一起抬');

	// ── 4/5/6. 鬼影 ─────────────────────────────────────────────
	// 9 m 是"看得清轮廓、看不清脸"的距离 —— 恐怖设计铁律第一条。
	await page.evaluate(`
		(() => {
			const S = window.__S, m = window.mist;
			S.releaseFlash();
			S.torch(false);
			S.place(${MID}, ${MID}, 0.9, 0);
			S.ghostAt(9, 0);
			const g = S.ghost();
			g.litTarget = 0; g.lit = 0;
			g.opacity = 0.86;      // 显形完成后的满强度
		})()
	`);
	await frames(12);
	await shot('04-ghost', '女鬼 · 9 m · 无闪电无手电（最深的那一档）');

	// 闪电照亮它 —— 第 1 条规则要求的"只在闪电下被观察到"
	await page.evaluate('window.__S.holdFlash()');
	await frames(12);
	await shot('05-ghost-lightning', '女鬼 · 被闪电照出来的那一瞬');

	// 手电照住它 —— 第 2 条规则（定身）
	await page.evaluate(`
		(() => {
			const S = window.__S, m = window.mist;
			S.releaseFlash();
			S.torch(true);
			const g = S.ghost();
			g.litTarget = 1; g.lit = 1;      // 照住的满状态
			m.player.pitch = S.elevOf(S.midOffset);
			const cam = m.engine.camera;
			cam.rotation.set(m.player.pitch, m.player.yaw, 0);
			cam.position.set(m.player.pos.x, m.player.pos.y + m.player.eyeHeight, m.player.pos.z);
			cam.updateMatrixWorld(true);
		})()
	`);
	await frames(12);
	await shot('06-ghost-torch', '女鬼 · 被手电照住（定身）');

	// ── 7. 第三人称：玩家自己长什么样 ───────────────────────────
	await page.evaluate(`
		(() => {
			const S = window.__S, m = window.mist;
			S.quiet();
			S.torch(true);
			S.ghost().hide();
			S.place(${MID}, ${MID}, 0.9, -0.085);
		})()
	`);
	// 用真实的按键切换视角，而不是直接改内部标志 —— 走产品自己的路径
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', bubbles: true }));
	});
	await frames(20);
	await page.evaluate('window.mist.pause(false)');
	await frames(20);
	await shot('07-third-person', '第三人称 · 玩家模型');

	// ── 8. 山洞 ─────────────────────────────────────────────────
	await page.evaluate(`
		(() => {
			const S = window.__S, m = window.mist;
			const hx = m.safehouse.x, hz = m.safehouse.z;
			// 洞口朝 -Z，所以站在 z 更小的一侧回望洞口
			S.place(hx, hz - 17, Math.PI, -0.02);
			m.safehouse.update(1 / 60, m.player.pos.x, m.player.pos.z);
			m.safehouse.light.intensity = 3.4;
			m.safehouse.ember.visible = true;
		})()
	`);
	await frames(14);
	await shot('08-cave', '山洞安全屋 · 这就是"家"');

	console.log('\n══════ 拍完了 ══════');
	for (const s of shots) console.log(`  ${s.name}`);
	if (errors.length) {
		console.log(`\n  页面错误 ${errors.length} 条：`);
		for (const e of [...new Set(errors)].slice(0, 8)) console.log('    ' + e);
	} else {
		console.log('  无页面错误');
	}
	console.log(`\n  输出目录：${OUT}`);
} finally {
	if (browser) await browser.close();
	server.close();
}
