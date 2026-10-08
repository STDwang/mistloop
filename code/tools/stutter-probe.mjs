// 顿挫探针：把"走着走着忽然闪我一下 / 卡一下"变成数字。
//
// 【为什么需要这个探针】
// 这类问题几乎不可能靠读代码定位：它只在真人游玩时出现，
// 而且所有常规指标都显示健康 —— 60 帧里 59 帧 4 ms、1 帧 400 ms，
// 平均只有 10.6 ms，帧率计数器上看是"60fps 很流畅"。
// 唯一能抓住它的是**孤立长帧**本身，以及它发生那一瞬间的现场快照。
//
// 所以这个探针做两件事：
//   ① 用 rAF 真实帧间隔（不是 engine.fps 的滑动平均）统计 p99 / worst
//   ② 每一笔长帧都连带着记录：走了多远、张力、身影状态、音频负载、画质档
//
// 【headless 的已知局限，必须在结论里说明】
// SwiftShader 软渲染下 p99 天然很差（每帧 100–300 ms），
// 所以**本探针在 headless 下无法判断"是否卡顿"**——
// 它只能验证"顿挫日志机制本身能工作"，以及检查有无随行走步进的
// 单调增长（内存/节点泄漏）。真正的判据要拿真机上的日志。

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
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });

	// 必须点"进入林子"。不点的话停在标题页，player.update 根本不跑，
	// 所有采样都是初始值 —— 而且 AudioContext 也不会创建（需要用户手势）。
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(800);

	// headless 里指针锁可能拿不到；拿不到就直接解除暂停，
	// 否则 player.update 完全不走，测到的是静止画面。
	const locked = await page.evaluate('document.pointerLockElement !== null');
	await page.evaluate('window.mist.pause(false)');
	await page.evaluate('window.mist.audio.init ? window.mist.audio.init() : 0');
	if (!locked) console.log('  [note] 指针锁未获得，已手动解除暂停（headless 常见）');

	// 等音频真正就绪，否则 strain/nodeCount 全是 -1，诊断字段失去意义。
	await page.waitForFunction('window.mist.audio.ready === true', null, { timeout: 30000 });

	// ── 行走 + 持续转头 ──────────────────────────────────────
	// 两个动作都要做：直行测"走了多远引起的"，转头测"视野变化引起的"
	// （LOD 换批是后者的典型成因）。只做其中一个会漏掉一半嫌疑。
	await page.evaluate('window.mist.frameReset()');
	const t0 = await page.evaluate(
		'({dist: window.mist.director.distance, t: performance.now()})',
	);

	await page.evaluate(`
		window.__probeKeys = new Set();
		window.__probeYaw = window.mist.player.yaw;
		window.__probeRAF = true;
		(function spin(){
			if (!window.__probeRAF) return;
			requestAnimationFrame(spin);
			// 模拟"边走边四处张望"：8 秒一个来回
			window.__probeYaw += 0.011;
			window.mist.player.yaw = Math.sin(window.__probeYaw) * 1.2;
		})();
	`);
	await page.evaluate(`
		const press = (code, down) => {
			const type = down ? 'keydown' : 'keyup';
			window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
			const c = document.getElementById('gl');
			c.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
		};
		window.__probePress = press;
		press('KeyW', true);
	`);

	// 采样：每 1 秒抓一次现场。headless 物理时间是墙钟的约 1/4，
	// 所以预算给足 —— 这里的目的是"步进时有没有单调增长"，不是跑到多远。
	const samples = [];
	for (let i = 0; i < 14; i++) {
		await page.waitForTimeout(1000);
		samples.push(
			await page.evaluate(`({
				dist: window.mist.director.distance,
				nodes: window.mist.audio.nodeCount(),
				strain: window.mist.audio.strain(),
				p99: window.mist.frameTimes().p99,
				worst: window.mist.frameTimes().worst,
				spikes: window.mist.frameTimes().n,
			})`),
		);
	}
	await page.evaluate(`window.__probeRAF = false; window.__probePress('KeyW', false);`);

	const final = await page.evaluate('window.mist.frameTimes()');
	const t1 = await page.evaluate(
		'({dist: window.mist.director.distance, t: performance.now()})',
	);
	const travelled = t1.dist - t0.dist;
	const wall = (t1.t - t0.t) / 1000;

	console.log(`\n  观察窗口 ${wall.toFixed(1)}s，行走 ${travelled.toFixed(1)} m`);
	console.log(`  帧耗时 p99 = ${final.p99.toFixed(1)} ms，最差 = ${final.worst.toFixed(1)} ms`);
	console.log('  采样步进（1s 一次）：');
	for (const s of samples) {
		console.log(
			`    dist=${s.dist.toFixed(1).padStart(6)}m  nodes=${String(s.nodes).padStart(3)}  ` +
				`strain=${String(s.strain).padStart(5)}  p99=${s.p99.toFixed(0).padStart(4)}ms`,
		);
	}

	// ── 断言 ─────────────────────────────────────────────────
	// 注意：这些断言刻意**不**判断"有没有卡顿"（headless 下无意义）。
	// 它们只保证诊断机制是活的，以及没有随行走而累积的泄漏。

	// 1. 帧间隔确实被观测到了。
	// 【阈值为什么是 25 而不是 100】SwiftShader 软渲染下 640×360 只有
	// 约 2–3 fps（实测 36–54 帧 / 14 秒）。原本写 >100 是拿真机的帧数
	// 当成了 headless 的帧数 —— 又一个"阈值卡住实测值"的假 FAIL。
	// 这条断言要证的是"统计链路通不通"，不是帧率高低。
	check('帧间隔统计在工作（采样数 > 25）', final.n > 25, `n=${final.n}`);

	// 2. 物理确实在推进 —— 这是所有后续结论的证人
	check('观察窗口内玩家确实在移动', travelled > 1, `行走 ${travelled.toFixed(2)} m`);

	// 3. 音频诊断读数可用（不是 -1 的哨兵值）
	const lastStrain = samples[samples.length - 1].strain;
	check(
		'音频 strain 读数可用（不是 -1 哨兵）',
		typeof lastStrain === 'number' && lastStrain >= 0,
		`strain=${lastStrain}`,
	);

	// 4. 音频节点数不发散 —— 一次性音效必须能被回收
	const nodes = samples.map((s) => s.nodes);
	const maxNodes = Math.max(...nodes);
	check(
		'音频节点数不发散（一次性音效在被回收）',
		maxNodes < 120,
		`峰值 ${maxNodes} 个（若持续增长则是 onended 没接上，会泄漏）`,
	);

	// 5. 没有随行走距离单调增长的节点数（泄漏的典型特征）
	const firstHalf = nodes.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
	const lastHalf = nodes.slice(7).reduce((a, b) => a + b, 0) / 7;
	check(
		'节点数不随行走单调增长（无泄漏趋势）',
		lastHalf < firstHalf + 20,
		`前段均值 ${firstHalf.toFixed(1)} → 后段均值 ${lastHalf.toFixed(1)}`,
	);

	// 6. 顿挫日志机制可用：p99 与最差帧都被量化了
	check(
		'最差帧被记录（诊断链路完整）',
		final.worst > 0,
		`worst=${final.worst.toFixed(1)}ms（headless 软渲染下天然很差，此处不断言其数值）`,
	);

	// 7. 无 JS 报错
	check('全程无 JS 报错', errors.length === 0, errors.length ? errors[0] : '0 条');

	console.log(`\n  stutter-probe: ${pass} PASS / ${fail} FAIL`);
	console.log(
		'  【重要】headless 用 SwiftShader 软渲染，p99 天然在 100ms 量级，\n' +
			'  本探针不判断"是否卡顿"。真机判据请开 ?ft 后正常游玩，\n' +
			'  控制台出现 [顿挫] 行时把它贴回来 —— 那行里有现场快照。',
	);
} finally {
	await browser.close();
	server.close();
}

process.exit(fail === 0 ? 0 : 1);
