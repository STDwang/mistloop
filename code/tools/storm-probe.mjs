// 雷雨探针：验证"小雨 + 闪电 + 雷声 + 取消全屏闪"这一组改动。
//
// ─────────────────────────────────────────────────────────────
// 【这个探针要回答的问题】
// 需求原文：「天气改为小雨淅淅沥沥，画面阴郁一些，有雷声闪电，闪电带来的
//            光效，对森林的光效影响要自然，取消鬼影消失时的全屏突然闪一下，
//            改为在有闪电照耀时能被观察到，然后慢慢淡化」
//
// 拆成可测量的断言：
//   ① 雨是**常驻**的（小雨淅淅沥沥 ≠ 偶尔阵雨），且画面确实更暗、雨丝确实短
//   ② 闪电是一盏**真的灯**：方向光强度真的起来了，而且雾/环境光/天空
//      三样**同时**被抬起
//   ③ 雷声**延迟**与距离严格对应（距离 / 343）
//   ④⑤ 鬼影消失时**没有任何全屏闪**（DOM 上直接取证），且是**慢慢淡化**
//
// 【为什么④要在 DOM 上取证而不是读代码】
// "全屏闪一下"的实现细节可以有很多种（overlay 透明度、CSS 动画类、
// filter 反色……），只改其中一种不算修好。直接看 #gl 有没有被加上
// glitch 类、#flash 的 opacity 有没有离开 0 —— 这才是玩家的眼睛看到的东西。
//
// ─────────────────────────────────────────────────────────────
// 【为什么这个探针要自己推物理，而不是等 rAF】
//
// 这是本文件里最容易写错的一处。headless SwiftShader 在 640×360 下只有
// 2–3 fps，而引擎把 dt 钳在 0.05 s —— 于是**物理时间只以墙钟的约 1/8 前进**。
// 实测：`lightning._strike(1.0)` 的期望距离是 6200 m，延迟 = 6200/343 ≈ 18 s
// 物理时间 —— 按墙钟要等两分半。任何"等 N 秒再断言"的写法在 headless 里
// 都只是在测"探针的耐心"，不是在测游戏。
//
// 所以凡是涉及时间推进的断言（闪电脉冲、雷声延迟、鬼影淡化），
// 一律 `pause(true)` 把 rAF 里的 director 停掉，然后**手动定步**
// `director.update(1/60, t)` / `lightning.update(1/60, t)`。
// 这样测到的是纯粹的逻辑，与帧率、与机器快慢完全无关。
//
// 唯一必须留在 rAF 上的是"闪电 → 雾/天光/环境光"这一段：那几行写在
// main.js 的帧循环里（它们本来就是渲染侧的事）。所以②分成两半：
//   ②a 用定步推进测"一记闪电确实产生了一个真实的 flash 峰值"
//   ②b 把 flash 钉在 1、让 rAF 跑几帧，测"flash 真的传导到了那四样东西"
// 分开测还有一个好处：哪一半坏了，报错会直接指出是哪一半。
// ─────────────────────────────────────────────────────────────

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
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
const port = await new Promise((r) =>
	server.listen(0, '127.0.0.1', () => r(server.address().port)),
);

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

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}  ${detail}`);
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
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	await page.locator('button:has-text("进入林子")').click();
	await page.evaluate('window.mist.pause(false)');
	await page.waitForFunction('window.mist.audio.ready === true', null, { timeout: 30000 });
	// 等 director 真的跑了几帧 —— weather 是在 director.update 里算出来的，
	// 刚加载完它还停在构造函数里的初值 0.08。
	await page.waitForFunction('window.mist.director.time > 0.25', null, { timeout: 30000 });

	// ══════════ ① 连阴雨与阴郁 ══════════
	console.log('\n══════ ① 小雨淅淅沥沥（常驻）与阴郁 ══════');

	const w = await page.evaluate(`({
		weather: window.mist.director.weather,
		rainVisible: window.mist.atmosphere.rain.visible,
		rainOpacity: window.mist.atmosphere.rain.material.opacity,
		rainCount: window.mist.atmosphere.rain.geometry.attributes.position.count / 2,
		exposure: window.mist.engine.renderer.toneMappingExposure,
		fogTarget: window.mist.director.fogDensity,
		fogNow: window.mist.engine.scene.fog.density,
		fogColor: '#' + window.mist.engine.scene.fog.color.getHexString(),
		hemi: window.mist.CFG.atmosphere.hemiIntensity,
		overcast: window.mist.CFG.atmosphere.overcast,
		skyBottomHex: '#' + window.mist.CFG.atmosphere.skyBottom.toString(16).padStart(6, '0'),
		rainLen: (() => {
			const p = window.mist.atmosphere.rain.geometry.attributes.position.array;
			let sum = 0, n = 0;
			for (let i = 0; i < Math.min(p.length, 600); i += 6) { sum += Math.abs(p[i + 4] - p[i + 1]); n++; }
			return sum / n;
		})(),
	})`);

	console.log(
		`  天气=${w.weather.toFixed(3)} 雨滴=${w.rainCount} 雨可见=${w.rainVisible} ` +
			`雨不透明度=${w.rainOpacity.toFixed(3)} 平均丝长=${w.rainLen.toFixed(3)} m`,
	);
	console.log(
		`  曝光=${w.exposure} 环境光=${w.hemi} 天光=${w.overcast} ` +
			`雾目标=${w.fogTarget.toFixed(4)} 雾当前=${w.fogNow.toFixed(4)} 雾色=${w.fogColor}`,
	);

	check(
		'雨是常驻的（天气基线 >= 0.25，不是偶尔阵雨）',
		w.weather >= 0.25,
		`weather=${w.weather.toFixed(3)}`,
	);
	check('雨一直可见（没有"天气够大才下雨"的开关）', w.rainVisible === true, `visible=${w.rainVisible}`);
	check(
		'雨滴密度够（>=1200，稀疏的雨丝会读成屏幕划痕）',
		w.rainCount >= 1200,
		`${w.rainCount} 滴`,
	);
	check('画面更阴郁（曝光 < 1.0）', w.exposure < 1.0, `exposure=${w.exposure}`);
	check(
		'天光被压暗、环境光不再是"大晴天"的量级（hemi <= 1.25）',
		w.hemi <= 1.25,
		`hemi=${w.hemi} overcast=${w.overcast}`,
	);
	check(
		'雾更浓（设计目标密度 > 0.0195，约 40 m 能见度而非 49 m）',
		w.fogTarget > 0.0195,
		`目标=${w.fogTarget.toFixed(4)} → 约 ${(0.832 / w.fogTarget).toFixed(0)} m`,
	);
	check(
		'雨丝短（小雨是"点点"，不是长划线）',
		w.rainLen < 0.45,
		`平均丝长 ${w.rainLen.toFixed(3)} m`,
	);
	// 地平线附近必须正好是雾色，否则天与地之间会出现一条可见的接缝。
	// 这条不是"好看"，是"不穿帮"。
	check(
		'天空底色与雾色一致（否则地平线会出现一条接缝）',
		w.skyBottomHex.toLowerCase() === w.fogColor.toLowerCase(),
		`sky=${w.skyBottomHex} fog=${w.fogColor}`,
	);

	// ── 从这里开始全部定步推进，把 rAF 里的 director 停掉 ──────────
	await page.evaluate('window.mist.pause(true)');

	// ══════════ ②a 一记闪电真的产生了 flash ══════════
	console.log('\n══════ ②a 闪电是真的方向光，不是全屏白闪 ══════════');

	const strike = await page.evaluate(`
		(() => {
			const m = window.mist;
			const L = m.lightning;
			// 清干净，保证测到的是这一次闪电
			L._pulses.length = 0;
			L._thunder.length = 0;
			L._pending.length = 0;
			L._next = 1e9;              // 关掉自动闪电
			L.flash = 0;
			L.light.intensity = 0;

			// 钉住随机数：distK=1 时距离 = distMin + range*(1-k)，
			// k→1 就落在最近端（最亮）。同时复击数会取到最大 4 记 ——
			// 脉冲间隔被拉到最长，**单帧峰值反而最低**，这是个保守的测法。
			const rand = Math.random;
			Math.random = () => 0.99999;
			const info = L._strike(1.0);
			Math.random = rand;

			let peakFlash = 0, peakInt = 0;
			for (let i = 0; i < 240; i++) {
				L.update(1 / 60, 0);
				peakFlash = Math.max(peakFlash, L.flash);
				peakInt = Math.max(peakInt, L.light.intensity);
			}
			return {
				dist: info.distance,
				delay: info.delay,
				peakFlash,
				peakInt,
				peak: m.CFG.lightning.peak,
				// 灯的归属：它必须**一直挂在场景里**，而不是每次闪电新建
				inScene: L.light.parent === m.engine.scene,
				isDir: L.light.isDirectionalLight === true,
				castShadow: L.light.castShadow,
				flashAfter: L.flash,
			};
		})()
	`);

	console.log(
		`  距离 ${strike.dist.toFixed(0)} m → 延迟 ${strike.delay.toFixed(2)}s；` +
			`峰值 flash=${strike.peakFlash.toFixed(3)} 方向光=${strike.peakInt.toFixed(2)}`,
	);

	check(
		'闪电挂着一盏真正的方向光（不是 DOM 叠加层）',
		strike.inScene && strike.isDir,
		`inScene=${strike.inScene} isDirectionalLight=${strike.isDir}`,
	);
	check(
		'方向光关掉了阴影贴图（否则每帧一次额外渲染，只为一记 20 秒一次的闪）',
		strike.castShadow === false,
		`castShadow=${strike.castShadow}`,
	);
	check(
		'一记闪电把场景照到过曝量级（方向光峰值 > 1.0）',
		strike.peakInt > 1.0,
		`峰值 ${strike.peakInt.toFixed(2)}（= flash × ${strike.peak}）`,
	);
	check(
		'闪电确实是"闪"（flash 峰值 > 0.5）',
		strike.peakFlash > 0.5,
		`flash=${strike.peakFlash.toFixed(3)}`,
	);
	check(
		'闪电是短暂的（4 秒后回落到接近 0）',
		strike.flashAfter < 0.05,
		`flash=${strike.flashAfter.toFixed(4)}`,
	);

	// ══════════ ②b flash 真的传导到了那四样东西 ══════════
	//
	// 这四样写在 main.js 的帧循环里，所以必须在 rAF 上测。
	// 手法是把闪电时钟冻住、flash 钉在 1，让 rAF 用满值跑几帧。
	// 直接读 scene 上的对象，不读代码 —— 又是"看玩家的眼睛看到什么"。
	const vis = await page.evaluate(`
		(() => {
			const m = window.mist;
			const scene = m.engine.scene;
			const sky = scene.children.find(
				(c) => c.isMesh && c.material && c.material.isMeshBasicMaterial && c.material.fog === false,
			);
			const read = () => {
				const h = scene.children.find((c) => c.isHemisphereLight);
				const f = scene.fog.color;
				return {
					hemi: h.intensity,
					fogLum: f.r + f.g + f.b,
					skyLum: sky ? sky.material.color.r + sky.material.color.g + sky.material.color.b : -1,
				};
			};
			window.__oldUpdate = m.lightning.update;
			window.__oldFlash = m.lightning.flash;
			window.__oldInt = m.lightning.light.intensity;
			// 冻表
			m.lightning.update = () => {};
			m.lightning.flash = 0;
			m.lightning.light.intensity = 0;
			window.__readVis = read;
			return { baseHemi: m.CFG.atmosphere.hemiIntensity, hemiBoost: m.CFG.lightning.hemiBoost };
		})()
	`);
	await page.waitForTimeout(1400); // 让 rAF 用 flash=0 跑几帧
	const base = await page.evaluate('window.__readVis()');
	await page.evaluate(`
		window.mist.lightning.flash = 1;
		window.mist.lightning.light.intensity = window.mist.CFG.lightning.peak;
	`);
	await page.waitForTimeout(1400);
	const boost = await page.evaluate('window.__readVis()');
	await page.evaluate(`
		window.mist.lightning.update = window.__oldUpdate;
		window.mist.lightning.flash = window.__oldFlash;
		window.mist.lightning.light.intensity = window.__oldInt;
	`);

	console.log(
		`  基线：环境光=${base.hemi.toFixed(3)} 雾亮度=${base.fogLum.toFixed(3)} 天空=${base.skyLum.toFixed(3)}`,
	);
	console.log(
		`  闪时：环境光=${boost.hemi.toFixed(3)} 雾亮度=${boost.fogLum.toFixed(3)} 天空=${boost.skyLum.toFixed(3)}`,
	);

	check(
		'闪电抬起了环境光（不是只亮一个物体）',
		boost.hemi > base.hemi * 1.2,
		`${base.hemi.toFixed(3)} → ${boost.hemi.toFixed(3)}（${(boost.hemi / base.hemi).toFixed(2)}×）`,
	);
	check(
		'闪电点亮了雾（否则远处的树像贴纸浮在没变的雾上）',
		boost.fogLum > base.fogLum * 1.1,
		`${(boost.fogLum / base.fogLum).toFixed(2)}×`,
	);
	check(
		'闪电点亮了天空（地面亮了、天没亮 = 闪电像发生在另一个世界）',
		boost.skyLum > base.skyLum * 1.1,
		`${(boost.skyLum / base.skyLum).toFixed(2)}×`,
	);

	// ══════════ ③ 雷声的延迟 ══════════
	console.log('\n══════ ③ 雷声：延迟 = 距离 / 声速 ══════════');

	const thunder = await page.evaluate(`
		(() => {
			const m = window.mist;
			const L = m.lightning;
			L._pulses.length = 0;
			L._thunder.length = 0;
			L._pending.length = 0;
			L._next = 1e9;
			L.flash = 0;

			const log = [];
			const origOnThunder = L.onThunder;
			L.onThunder = (near) => {
				log.push({ kind: 'thunder', t: L.t, near });
				// 同时走真实的音频管线，验证雷声合成不抛异常
				try { m.audio.oneShot('thunder', near); log.push({ kind: 'audio', ok: true }); }
				catch (e) { log.push({ kind: 'audio', ok: false, err: String(e) }); }
				if (origOnThunder) origOnThunder(near);
			};

			const rand = Math.random;
			Math.random = () => 0.99999;      // 落在最近端，延迟最短
			const info = L._strike(1.0);
			Math.random = rand;
			log.push({ kind: 'strike', t: L.t, dist: info.distance, delay: info.delay });

			// 定步推进，一直推到雷声出现（延迟是物理时间，不是墙钟）
			let steps = 0;
			while (steps < 4000 && !log.some((e) => e.kind === 'thunder')) {
				L.update(1 / 60, 0);
				steps++;
			}
			L.onThunder = origOnThunder;
			return { log, steps, soundSpeed: m.CFG.lightning.soundSpeed };
		})()
	`);

	const st = thunder.log.find((e) => e.kind === 'strike');
	const th = thunder.log.find((e) => e.kind === 'thunder');
	const audioRes = thunder.log.filter((e) => e.kind === 'audio');

	check('闪电记录到了距离', !!st && st.dist > 0, st ? `${st.dist.toFixed(0)} m` : '无');
	check(
		'雷声确实响了（在 4000 步物理时间内）',
		!!th,
		th ? `near=${th.near.toFixed(2)}（${thunder.steps} 步后）` : `推了 ${thunder.steps} 步也没响`,
	);

	if (st && th) {
		const actual = th.t - st.t;
		const want = st.dist / thunder.soundSpeed;
		const err = Math.abs(actual - want);
		console.log(
			`  距离 ${st.dist.toFixed(0)} m → 预期延迟 ${want.toFixed(3)}s，实测 ${actual.toFixed(3)}s`,
		);
		check(
			'雷声延迟与"距离 / 声速"一致（±0.05 s）',
			err < 0.05,
			`误差 ${err.toFixed(4)}s`,
		);
		check(
			'延迟是"看得见之后才听得见"（> 0.3 s，近雷也不例外）',
			actual > 0.3,
			`${actual.toFixed(3)}s`,
		);
	}
	check(
		'雷声在真实音频管线上不抛异常',
		audioRes.length > 0 && audioRes.every((a) => a.ok),
		audioRes.length ? `${audioRes.length} 次调用` : '没跑到',
	);

	// ══════════ ④⑤ 取消全屏闪 + 慢慢淡化 ══════════
	console.log('\n══════ ④⑤ 鬼影消失：没有全屏闪，只有慢慢淡化 ══════');

	const fadeRes = await page.evaluate(`
		(() => {
			const m = window.mist;
			const d = m.director;
			const gl = document.getElementById('gl');
			const fl = document.getElementById('flash');

			let elapsed = 0;
			const step = (n) => {
				for (let i = 0; i < n; i++) {
					elapsed += 1 / 60;
					d.update(1 / 60, elapsed);
				}
			};

			// 先让它完整淡入。否则 vanishFrom ≈ 0，整段淡化都贴着 0 走，
			// 测出来的"单调下降"是假的 —— 0 到 0 当然单调。
			d._spawn('R5', false);
			step(45);                        // 0.75 s，fadeIn 已经到 1
			const opStart = d.stalker.opacity;

			// 从这一刻起盯住 DOM。"全屏闪"不管怎么实现，最后都要落到
			// #gl 的 classList 或者 #flash 的 opacity 上。
			let glitchSeen = gl.classList.contains('glitch');
			let flashPeak = parseFloat(fl.style.opacity || '0');

			// 强制"被注视驱逐" → 走 _vanish 路径
			d.stareTime = 99;
			const t0 = d.time;
			const samples = [];
			let escapedDuring = false;
			for (let i = 0; i < 400; i++) {
				step(1);
				if (gl.classList.contains('glitch')) glitchSeen = true;
				flashPeak = Math.max(flashPeak, parseFloat(fl.style.opacity || '0'));
				if (d.escaped) escapedDuring = true;
				if (d.state === 'VANISH') samples.push({ t: d.time - t0, op: d.stalker.opacity });
				else break;
			}
			const opacities = samples.map((s) => s.op);
			return {
				opStart,
				glitchSeen,
				flashPeak,
				glClassNow: gl.className,
				escapedDuring,
				n: samples.length,
				dur: samples.length ? samples[samples.length - 1].t : 0,
				opFirst: opacities.length ? opacities[0] : null,
				opLast: opacities.length ? opacities[opacities.length - 1] : null,
				opMax: opacities.length ? Math.max(...opacities) : null,
				monotone: opacities.every((v, i) => i === 0 || v <= opacities[i - 1] + 1e-9),
				fadeSeconds: m.CFG.entity.fadeSeconds,
				state: d.state,
			};
		})()
	`);

	console.log(
		`  消失前 opacity=${fadeRes.opStart.toFixed(3)}；淡化采到 ${fadeRes.n} 个中间态，` +
			`${fadeRes.opFirst !== null ? fadeRes.opFirst.toFixed(3) : '?'} → ` +
			`${fadeRes.opLast !== null ? fadeRes.opLast.toFixed(3) : '?'}，` +
			`历时 ${fadeRes.dur.toFixed(2)}s（物理时间）`,
	);

	check(
		'消失时**没有任何全屏闪**（#gl 全程没被加上 glitch 类）',
		fadeRes.glitchSeen === false,
		`glitchSeen=${fadeRes.glitchSeen} class="${fadeRes.glClassNow}"`,
	);
	check(
		'#flash 叠加层全程没亮（opacity 始终为 0）',
		fadeRes.flashPeak === 0,
		`峰值 opacity=${fadeRes.flashPeak}`,
	);
	check(
		'消失是"慢慢淡化"而不是"啪一下没了"（>=60 个中间态，约 1 s 以上）',
		fadeRes.n >= 60,
		`${fadeRes.n} 个中间态`,
	);
	check(
		`淡化时长接近 CFG.entity.fadeSeconds（${fadeRes.fadeSeconds} s，±0.3）`,
		Math.abs(fadeRes.dur - fadeRes.fadeSeconds) < 0.3,
		`${fadeRes.dur.toFixed(3)}s`,
	);
	check(
		'淡化是单调下降的（不是先亮后灭）',
		fadeRes.monotone,
		`${fadeRes.opFirst !== null ? fadeRes.opFirst.toFixed(3) : '?'} → ` +
			`${fadeRes.opLast !== null ? fadeRes.opLast.toFixed(3) : '?'}`,
	);
	check(
		'这个过程中没有误触发"到家"结局（否则整个场景会被冻住）',
		fadeRes.escapedDuring === false && fadeRes.state === 'DORMANT',
		`escaped=${fadeRes.escapedDuring} state=${fadeRes.state}`,
	);

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	check('全程无 JS 报错', errors.length === 0, errors.length ? errors[0] : '0 条');

	console.log(`\n  storm-probe: ${pass} PASS / ${fail} FAIL`);
} finally {
	await browser.close();
	server.close();
}

process.exit(fail === 0 ? 0 : 1);
