// snd-probe：#26 声效优化的运行时冒烟探针。
//
// audio-probe 是纸面估算，step/storm/hold-probe 各管各的旧链路。
// 这个探针补的是三件**新事**在真实页面里的行为：
//   ① 雨打树叶 —— 离散滴答的调度（密度随天气、天气为 0 时无声、电平护栏）
//   ② 女鬼呼吸 —— 链路存在、增益随接近度出现/消失、速率"越近越慢"
//   ③ 雷空间化 —— 三层过同一个 StereoPanner、默认 pan=0、
//      main.js 端到端接线（az − yaw）、闪电入队带方位
//
// 跑的是 dist 构建 —— 改 src 后必须先 npm run build。
// 用法：node tools/snd-probe.mjs

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
	'.html': 'text/html;charset=utf-8',
	'.js': 'text/javascript;charset=utf-8',
	'.css': 'text/css;charset=utf-8',
	'.png': 'image/png',
	'.glb': 'model/gltf-binary',
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

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) =>
	existsSync(p),
);

let pass = 0;
let fail = 0;
const check = (name, ok, info = '') => {
	if (ok) pass++;
	else fail++;
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${info ? '  ' + info : ''}`);
};

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
			'--no-sandbox',
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 90000 });
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(800);

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

	// 暂停世界更新：director 不得每帧覆盖我们手动设的状态。
	// 渲染循环与 AudioContext 时钟照常走，setTargetAtTime 能正常收敛。
	await page.evaluate(() => window.mist.pause(true));

	console.log('\n══════ ① 雨打树叶：离散滴答调度 ══════════');
	const t1 = await page.evaluate(`
		(() => {
			const a = window.mist.audio;
			if (!a.ready) return { err: 'audio 未就绪' };
			const A = window.mist.CFG.audio;
			const out = { ticks: [], stopped: null };
			const orig = a._burst.bind(a);
			a._burst = (t0, f, q, d, l) => {
				if (f > 2000 && d < 0.06) out.ticks.push({ f, d, l });
				return orig(t0, f, q, d, l);
			};
			// 天气 0.8、张力 0：滴答率 ≈ 2 + 7×0.8^1.2 ≈ 7.35/s → 5 s ≈ 37 次
			a.setWeather(0.8);
			a.setTension(0, 0);
			for (let i = 0; i < 20; i++) a.update(0.25);
			const nWet = out.ticks.length;
			// 天气 0：必须完全无声
			a.setWeather(0);
			const before = out.ticks.length;
			for (let i = 0; i < 20; i++) a.update(0.25);
			out.stopped = out.ticks.length - before;
			out.nWet = nWet;
			a._burst = orig;
			delete a._burst;
			a.setWeather(window.mist.CFG.atmosphere.weatherBase);
			return out;
		})()
	`);
	if (t1.err) {
		check('音频已就绪', false, t1.err);
	} else {
		check('雨大时滴答存在（5 s 游戏时间 ≥ 15 次）', t1.nWet >= 15, `实测 ${t1.nWet} 次`);
		check('滴答频率都在水滴频段（2.3–5.2 kHz）', t1.ticks.every((x) => x.f >= 2290 && x.f <= 5210), '');
		check('滴答时长都是撞击级（18–48 ms）', t1.ticks.every((x) => x.d >= 0.017 && x.d <= 0.049), '');
		check(
			'滴答电平不越护栏（≤ level×1.4，即随机上限）',
			t1.ticks.every((x) => x.l <= 0.028 * 1.4 + 1e-6),
			`max=${Math.max(0, ...t1.ticks.map((x) => x.l)).toFixed(4)}`,
		);
		check('雨停后滴答完全停止（5 s 内 0 次）', t1.stopped === 0, `实测 ${t1.stopped} 次`);
	}

	console.log('\n══════ ② 女鬼呼吸：冷呼吸链 ══════════');
	await page.evaluate('window.mist.audio.setGhost(1)');
	await frames(10);
	const t2a = await page.evaluate(`
		(() => {
			const a = window.mist.audio;
			return {
				hasChain: !!(a.ghostBreathGain && a.ghostBreathVCA && a.ghostBreathLFO),
				gain: a.ghostBreathGain ? a.ghostBreathGain.gain.value : -1,
				rate: a.ghostBreathLFO ? a.ghostBreathLFO.frequency.value : -1,
			};
		})()
	`);
	check('呼吸链三个节点都存在（gain/VCA/LFO）', t2a.hasChain, '');
	check('贴脸时增益浮出（> 0.15，即满增益 0.24 的收敛区）', t2a.gain > 0.15, `gain=${t2a.gain.toFixed(3)}`);
	check('贴脸时呼吸变慢（≈ 0.13 Hz，与玩家呼吸方向相反）', Math.abs(t2a.rate - 0.13) < 0.03, `rate=${t2a.rate.toFixed(3)} Hz`);
	await page.evaluate('window.mist.audio.setGhost(0)');
	await frames(8);
	const t2b = await page.evaluate(`
		(() => {
			const a = window.mist.audio;
			return { gain: a.ghostBreathGain.gain.value, rate: a.ghostBreathLFO.frequency.value };
		})()
	`);
	check('它退场后呼吸归零（gain < 0.05）', t2b.gain < 0.05, `gain=${t2b.gain.toFixed(3)}`);
	check('它退场后呼吸速率回落（≈ 0.21 Hz）', Math.abs(t2b.rate - 0.21) < 0.03, `rate=${t2b.rate.toFixed(3)} Hz`);

	console.log('\n══════ ③ 雷空间化：声像 ══════════');
	const t3 = await page.evaluate(`
		(() => {
			const m = window.mist;
			const a = m.audio;
			const out = {};
			const captured = [];
			const orig = a.ctx.createStereoPanner.bind(a.ctx);
			a.ctx.createStereoPanner = () => {
				const n = orig();
				captured.push(n);
				return n;
			};
			// 近雷 + 明确声像：pan = 0.7 × lerp(0.55, 1, 0.9)
			a.oneShot('thunder', 0.9, 'floor', 0.7);
			out.nearCount = captured.length;
			out.nearPan = captured[captured.length - 1] ? captured[captured.length - 1].pan.value : null;
			// 不带 pan：必须默认 0（storm-probe 的单参数重放路径）
			const c0 = captured.length;
			a.oneShot('thunder', 0.5);
			out.defCount = captured.length - c0;
			out.defPan = captured[captured.length - 1] ? captured[captured.length - 1].pan.value : null;
			// 端到端：main.js 的处理器（az − yaw）
			const c1 = captured.length;
			m.lightning.onThunder(0.5, 2.0);
			out.wireCount = captured.length - c1;
			out.wirePan = captured[captured.length - 1] ? captured[captured.length - 1].pan.value : null;
			out.expectedWirePan = Math.sin(2.0 - m.player.yaw) * (0.55 + (1 - 0.55) * 0.5);
			a.ctx.createStereoPanner = orig;
			return out;
		})()
	`);
	check('一次雷只创建一个声像器（三层同源，不被撕碎）', t3.nearCount === 1, `创建 ${t3.nearCount} 个`);
	check(
		'近雷声像 = pan × lerp(far,1,near)',
		t3.nearPan !== null && Math.abs(t3.nearPan - 0.7 * (0.55 + 0.45 * 0.9)) < 0.03,
		`pan=${t3.nearPan && t3.nearPan.toFixed(3)}`,
	);
	check('不带 pan 的雷默认居中（探针重放路径不炸）', t3.defCount === 1 && Math.abs(t3.defPan) < 1e-6, `pan=${t3.defPan}`);
	check(
		'main.js 端到端：onThunder(near, az) → sin(az − yaw) × 收窄系数',
		t3.wireCount === 1 && t3.wirePan !== null && Math.abs(t3.wirePan - t3.expectedWirePan) < 0.03,
		`pan=${t3.wirePan && t3.wirePan.toFixed(3)} 期望=${t3.expectedWirePan.toFixed(3)}`,
	);

	console.log('\n══════ ④ 闪电入队带方位 + director 喂接近度 ══════════');
	const t4 = await page.evaluate(`
		(() => {
			const m = window.mist;
			const L = m.lightning;
			const out = {};
			// a) 队列项带 az
			L._pulses.length = 0;
			L._thunder.length = 0;
			L._pending.length = 0;
			L._next = 1e9;
			L._strike(0.5);
			const q = L._thunder[L._thunder.length - 1];
			out.queueAz = q ? typeof q.az === 'number' && q.az >= 0 && q.az < Math.PI * 2 : false;
			// b) 到期回调把 az 带给 onThunder
			let fed = null;
			const orig = L.onThunder;
			L.onThunder = (n, a) => {
				fed = { n, a };
			};
			let steps = 0;
			while (steps < 4000 && !fed) {
				L.update(1 / 60, 0);
				steps++;
			}
			L.onThunder = orig;
			out.fedAz = !!fed && typeof fed.a === 'number';
			return out;
		})()
	`);
	check('雷声队列项带方位角 az（0…2π）', t4.queueAz, '');
	check('onThunder 回调把 az 交给音频侧', t4.fedAz, '');

	// c) director 同步推一帧，验证它喂给 setGhost 的就是 接近度 × 不透明度。
	//    （暂停状态下手动调 director.update —— 确定性，不受渲染帧率影响）
	const t4c = await page.evaluate(`
		(() => {
			const m = window.mist;
			const a = m.audio;
			const S = m.stalker;
			const P = m.player;
			const d = m.director;
			// 钉住导演：不触发显形，只让它跑张力/呼吸喂给这一段
			d.cooldown = 1e9;
			d.pending = null;
			const gd = 6;
			const az = P.yaw + 0.6;
			S.show();
			S.place(P.pos.x - Math.sin(az) * gd, P.pos.z - Math.cos(az) * gd);
			S.setDistanceHint(gd);
			S.opacity = 0.9;
			let last = null;
			a.setGhost = (p) => {
				last = p;
			};
			d.update(1 / 60, d.time + 1 / 60);
			delete a.setGhost;
			const expect =
				Math.min(1, Math.max(0, 1 - (gd - m.CFG.audio.ghostBreathNear) / (m.CFG.audio.ghostBreathFar - m.CFG.audio.ghostBreathNear))) *
				S.opacity;
			return { last, expect, active: S.active };
		})()
	`);
	check(
		'director 每帧喂 setGhost = 接近度 × 不透明度（6 m × 0.9）',
		t4c.last !== null && Math.abs(t4c.last - t4c.expect) < 0.05 && t4c.active,
		`喂=${t4c.last !== null ? t4c.last.toFixed(3) : 'null'} 期望=${t4c.expect.toFixed(3)}`,
	);
	// 清场：鬼影退场
	await page.evaluate(() => window.mist.stalker.hide());

	console.log('\n══════ 控制台 ══════');
	check('全程无 JS 报错', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '0 条');

	console.log(`\n========================================================`);
	console.log(`  snd-probe: ${pass} PASS / ${fail} FAIL`);
} finally {
	if (browser) await browser.close();
	server.close();
}
process.exit(fail ? 1 : 0);
