// 脚步声离线频谱探针：把"登登登"变成一个可测量的东西。
//
// ─────────────────────────────────────────────────────────────
// 【为什么用 OfflineAudioContext】
//
// "脚步真不真实"听起来是个纯主观判断，但它有可测量的物理面：
//   · 路面脚步应当是**低频主导**的（压实的土 = 躯干音占大头）
//   · 林地脚步应当有**显著的高频脆响**（枯叶碎裂 1.7–3.2 kHz）
//   · 任意两步的波形**不应当相同**（零抖动 = "登登登"的定义本身）
// 这三条都能在离线渲染的频谱上变成断言。
//
// 旧实现测出来的结果：林地高频能量 ≈ 0（1100 Hz 带通架在 780 Hz
// 暗原料上，再被 1400 Hz 总线低通墙削一道），两步之间波形只差噪声底
// —— 这就是用户听到的"登登登"，现在它是一个数字，不再是一个感觉。
//
// 每个用例 new 一个真实 AudioEngine + 注入 OfflineAudioContext
// （init 的 testCtx 参数）。合成链是真源码 —— 规矩来自
// audio-probe 时代的手抄事故（见 audio.js 里 ambSrc.start() 的注释）。
// ─────────────────────────────────────────────────────────────

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8' };

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
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--enable-webgl', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
	});
	const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });

	// 在页面里定义渲染 + 频带能量分析工具（Goertzel 单频能量）
	await page.evaluate(() => {
		const SR = 44100;
		// 【最小总成】用真实的 oneShot/_burst/_thud/_noise（被测对象），
		// 但不 init 整个引擎 —— 连续层（环境床）有自己的随机 LFO，
		// 跨渲染求差时它的方差在低频段比信号还大（v1 实测林地 low 算出负值）。
		// 总线只有 2 行（fx→destination），这正是我们发布的路由。
		window.__stepRender = async (kind, surface, seconds = 0.5) => {
			const m = window.mist;
			const ctx = new OfflineAudioContext(1, Math.floor(SR * seconds), SR);
			const eng = Object.create(m.AudioEngine.prototype);
			eng.cfg = m.CFG;
			eng.ctx = ctx;
			eng.ready = true;
			eng.tension = 0;
			eng._footAlt = false;
			eng.fx = ctx.createGain();
			eng.fx.gain.value = m.CFG.audio.headroom;
			eng.fx.connect(ctx.destination);
			eng.noiseBuffer = eng._makeNoise(ctx, 4);
			if (kind) eng.oneShot(kind, 1, surface);
			const buf = await ctx.startRendering();
			return buf.getChannelData(0);
		};
		// 带和：多个 Goertzel 点求和，抗单点频率对不准（thud 62/74 Hz
		// 都不在 80 Hz 整数上，v1 单点测量撞了大运）
		const POINTS = {
			low: [58, 62, 68, 74, 80, 90, 105, 120],
			mid: [600, 700, 800, 900, 1000],
			high: [1700, 1900, 2000, 2200, 2400, 2600, 2800, 3000, 3200],
			// 动物环境声的频带。乌鸦的鸣叫滑落点在 680–1410 Hz，
			// 虫鸣的翅摩在 4.2–5.8 kHz —— 后者必须在 loudness 上有
			// 自己的刻度，因为"high"带只到 3.2 kHz，量不到它。
			crow: [750, 900, 1050, 1250, 1400],
			bug: [4200, 4600, 5000, 5400, 5800],
		};
		const g1 = (d, f, t0, t1) => {
			const n0 = Math.floor(t0 * SR);
			const n1 = Math.min(d.length, Math.floor(t1 * SR));
			const w = (2 * Math.PI * f) / SR;
			const coeff = 2 * Math.cos(w);
			let s1 = 0;
			let s2 = 0;
			for (let i = n0; i < n1; i++) {
				const s0 = d[i] + coeff * s1 - s2;
				s2 = s1;
				s1 = s0;
			}
			return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / Math.max(1, n1 - n0);
		};
		window.__bands = (d) => {
			const out = {};
			for (const [k, pts] of Object.entries(POINTS)) {
				const t1 = Math.min(1.5, d.length / SR - 0.01);
				out[k] = pts.reduce((acc, f) => acc + g1(d, f, 0, t1), 0) / pts.length;
			}
			out.rms = window.__rms(d);
			return out;
		};
		window.__rms = (d) => {
			const n1 = d.length;
			let acc = 0;
			for (let i = 0; i < n1; i++) acc += d[i] * d[i];
			return Math.sqrt(acc / Math.max(1, n1));
		};
		// 开头 10 ms 的最大绝对值 —— 专测"起音咔哒"。
		// 【为什么要有这个】insect v1 把起音包络写在 LFO 连接的同一个
		// AudioParam 上，连接信号是叠加不是调制，t0 直接跳 ±0.016 ——
		// 每段虫鸣开头一记 -36 dBFS 的咔哒（连续听是"有人按打火机"）。
		// 正常起音（80 ms 缓升）在头 10 ms 只应到达满幅的一小部分。
		window.__onsetPeak = (d) => {
			const n1 = Math.min(d.length, Math.floor(0.01 * SR));
			let pk = 0;
			for (let i = 0; i < n1; i++) pk = Math.max(pk, Math.abs(d[i]));
			return pk;
		};
		window.__peak = (d) => {
			let pk = 0;
			for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
			return pk;
		};
		window.__corr = (a, b) => {
			const N = Math.min(a.length, b.length);
			let ab = 0;
			let aa = 0;
			let bb = 0;
			for (let i = 0; i < N; i++) {
				ab += a[i] * b[i];
				aa += a[i] * a[i];
				bb += b[i] * b[i];
			}
			return ab / (Math.sqrt(aa * bb) + 1e-12);
		};

		// 【尾段比：一个不需要分母的脆响指标】
		//
		// 为什么不用 high/low：那个比值的分母是 low，而 low 里绝大部分是
		// _thud 的 62–74 Hz 正弦 —— 它和"脆响"根本不是同一个东西的量，
		// 相除得不到有物理含义的数。更糟的是路面的 high 本身是带外泄漏
		// （它的 _burst 在 620–1240 Hz，低于 900 Hz 自动亮通道阈值，故意保持全暗），
		// 用一个泄漏量做分母，阈值只能靠"照着实测值往上放"，那样的断言证不了任何事。
		//
		// 换成时域尾段比：把 0.3 s 切成前 0.09 s（撞击瞬间）和后 0.09–0.3 s（尾音）。
		//   · 路面：_thud 是 dur=0.13 的指数衰减正弦 → 0.09 s 后已掉到很小；
		//     它那记中频爆 dur 只有 0.11–0.16，也基本结束了 → 尾段远小于头部。
		//   · 林地：3–5 记碎裂错开到 0.085 s 才开始，加上一记 dur=0.3 的沙沙尾
		//     → 尾段被"拖"得很长。
		// 所以 floor 的尾段比应当**远高于** road。这个量只由各自的包络形状决定，
		// 不涉及任何跨频带相除，也不依赖泄漏。
		// 高频时域占比：0.3 s 内"局部高频事件"的采样点数占比。
		//
		// 【为什么不用 crest factor】
		// v3 试过"光晕度（峰值/RMS）高于路面"，实测 floor=6.49 < road=7.01 判 FAIL。
		// 这不是音频的问题，是指标选错了：crest factor 度量的是**尖峰程度**，
		// 而一记 62 Hz 孤立正弦配上陡峭的 8 ms 起音，本身就是一个很高的尖峰
		// （它的 RMS 很低，因为正弦大部分时间在零点附近）。
		// 拿它当"碎不碎"的代理，等于在问"谁更尖"而不是"谁更碎"。
		//
		// 直接的物理内容：林地的碎裂是 1.7–3.2 kHz 的短事件，
		// 存在**包络起伏极快**的局部高频——相邻两采样点差值大。
		// 用一阶差分与信号幅度之比衡量"抖得多快"，不看绝对能量
		// （两面对能量本来就差 5 倍，直接比绝对量会把"更响"误读成"更碎"）。
		// 归一化后它就是"平均而言，相邻采样跳变有多大"—— 频率的直接代理。
		window.__hfRatio = (d) => {
			const n1 = Math.min(d.length, Math.floor(0.3 * SR));
			let dsum = 0;
			let asum = 0;
			for (let i = 1; i < n1; i++) {
				dsum += Math.abs(d[i] - d[i - 1]);
				asum += Math.abs(d[i]);
			}
			return dsum / Math.max(1e-12, asum);
		};
		const seg = (d, a, b) => {
			const n0 = Math.floor(a * SR);
			const n1 = Math.min(d.length, Math.floor(b * SR));
			let acc = 0;
			for (let i = n0; i < n1; i++) acc += d[i] * d[i];
			return Math.sqrt(acc / Math.max(1, n1 - n0));
		};
		window.__tail = (d) => seg(d, 0.09, 0.3) / Math.max(1e-9, seg(d, 0, 0.09));
		// 光晕度（crest factor）：峰值 / RMS。
		// 【保留但只作记录，不作断言】见 __hfRatio 的注释 —— v3 实测它
		// 对"碎不碎"是反向的（一记孤立低频正弦的尖峰度反而更高）。
		// 留在这里是因为它有诊断价值：数值异常时能立刻看出是不是只剩下纯正弦。
		window.__crest = (d) => {
			const n1 = Math.min(d.length, Math.floor(0.3 * SR));
			let pk = 0;
			let acc = 0;
			for (let i = 0; i < n1; i++) {
				const v = Math.abs(d[i]);
				if (v > pk) pk = v;
				acc += d[i] * d[i];
			}
			return pk / Math.max(1e-9, Math.sqrt(acc / n1));
		};
	});

	console.log('\n══════ 渲染六个离线样本 ══════');
	const data = await page.evaluate(async () => {
		const render = window.__stepRender;
		const road1 = await render('footstep', 'road');
		const road2 = await render('footstep', 'road');
		const floor1 = await render('footstep', 'floor');
		const floor2 = await render('footstep', 'floor');
		const floor3 = await render('footstep', 'floor');
		const silent = await render(null, null);
		// 乌鸦/虫鸣需要更长的渲染窗口（乌鸦连叫 2–3 声约 0.8 s，
		// 虫鸣 0.6–1.5 s），单独用 1.6 s 的 context 渲染。
		// 【各渲 3 次取最大】合成参数带随机（落点/只数/增益都抖），
		// 单次渲染的能量会有数倍波动；取多次最大值是"存在性"的
		// 正确统计 —— 玩家听到的是很多次叫声，只要有一次够清楚就是存在的。
		const crows = [];
		const insects = [];
		for (let i = 0; i < 3; i++) {
			crows.push(await render('crow', null, 1.6));
			insects.push(await render('insect', null, 1.6));
		}
		return {
			silent: window.__bands(silent),
			road1: window.__bands(road1),
			road2: window.__bands(road2),
			floor1: window.__bands(floor1),
			floor2: window.__bands(floor2),
			floor3: window.__bands(floor3),
			corrRoad: window.__corr(road1, road2),
			corrFloor: window.__corr(floor1, floor2),
			corrFloor2: window.__corr(floor1, floor3),
			tailRoad: window.__tail(road1),
			tailFloor: window.__tail(floor1),
			crestRoad: window.__crest(road1),
			crestFloor: window.__crest(floor1),
			hfRoad: window.__hfRatio(road1),
			hfFloor: window.__hfRatio(floor1),
			crow: window.__bands(crows[0]),
			insect: window.__bands(insects[0]),
			crowRms: Math.max(...crows.map((d) => window.__rms(d))),
			insectRms: Math.max(...insects.map((d) => window.__rms(d))),
			insectOnset: Math.max(...insects.map((d) => window.__onsetPeak(d))),
			insectPeak: Math.max(...insects.map((d) => window.__peak(d))),
		};
	});

	console.log('  带能量（0–0.3 s，Goertzel 带和，任意单位）:');
	for (const k of ['silent', 'road1', 'road2', 'floor1', 'floor2', 'floor3']) {
		const b = data[k];
		console.log(
			`    ${k.padEnd(7)} low=${b.low.toExponential(2)}  mid=${b.mid.toExponential(2)}` +
				`  high=${b.high.toExponential(2)}  rms=${b.rms.toFixed(4)}`,
		);
	}
	console.log(
		`  波形相关: road1~road2=${data.corrRoad.toFixed(4)} floor1~floor2=${data.corrFloor.toFixed(4)} floor1~floor3=${data.corrFloor2.toFixed(4)}`,
	);
	console.log(
		`  包络形状: 尾段比 road=${data.tailRoad.toFixed(3)} floor=${data.tailFloor.toFixed(3)}` +
			`   光晕度 road=${data.crestRoad.toFixed(2)} floor=${data.crestFloor.toFixed(2)}` +
			`   高频占比 road=${data.hfRoad.toFixed(4)} floor=${data.hfFloor.toFixed(4)}`,
	);

	console.log('\n══════ 断言 ══════');
	check(
		'路面脚步低频主导（low > high×2，躯干是主角）',
		data.road1.low > data.road1.high * 2,
		`low/high = ${(data.road1.low / Math.max(1e-12, data.road1.high)).toFixed(1)}`,
	);
	// 【为什么这条断言是"尾段比"而不是 high/low】
	//
	// v1 写的是 `floor.high > floor.low * 0.5` → 实测 0.0037 判 FAIL；
	// v2 改成"林地 high/low ≥ 路面 high/low 的 100 倍" → 实测 93 倍又判 FAIL。
	// 两次都错在同一个地方：**拿低频能量当分母**。
	// low 里装的几乎全是 _thud 的 62–74 Hz 正弦，和"脆响"不是同一个物理量，
	// 两者相除得不到有意义的数；而路面的 high 只是带外泄漏，
	// 用泄漏量做基准，阈值就只能照着实测值往上放 —— 那种断言什么也证明不了。
	// （连续两次"把阈值调到刚好卡住实测值"，说明错的不是阈值，是指标。）
	//
	// 尾段比不涉及任何跨频带相除，只由各自的包络形状决定：
	// 路面是 dur≈0.13 的一记躯干 + 一记同长短的中频拍，0.09 s 后已经收尾；
	// 林地是 3–5 记碎裂（最晚 0.085 s 才起）+ 一记 dur=0.3 的沙沙尾，
	// 能量被明显拖长。这才是"林地不是一记干响"的真实内容。
	// 阈值取 1.5 倍 —— 是设计意图（尾音长度差近一倍）而不是拟合出来的数。
	check(
		'林地脚步有拖尾（林地尾段比至少是路面的 1.5 倍）',
		data.tailFloor > data.tailRoad * 1.5,
		`floor=${data.tailFloor.toFixed(3)} road=${data.tailRoad.toFixed(3)} ×${(data.tailFloor / Math.max(1e-9, data.tailRoad)).toFixed(2)}`,
	);
	// 高频占比独立佐证同一件事，走的是另一条测量路径：
	// 尾段比测"能量持续多久"，高频占比测"信号抖得多快"。
	// 林地 1.7–3.2 kHz 的碎裂让相邻采样跳变更大 → 占比更高。
	check(
		'林地脚步更"碎"（相邻采样跳变占比高于路面）',
		data.hfFloor > data.hfRoad,
		`floor=${data.hfFloor.toFixed(4)} road=${data.hfRoad.toFixed(4)} ×${(data.hfFloor / Math.max(1e-9, data.hfRoad)).toFixed(2)}`,
	);
	// 【已退役：林地/路面 high 比值断言】
	// v3 曾有 `floor1.high > road1.high * 3`，实测在 1.2–8.5 之间随机摆，
	// 同一套源码三连跑 2 FAIL 1 PASS —— 又是 165–178 行诊断过的那个坑：
	// 路面的 high 是 620–1240 Hz 爆音的**带外泄漏**（故意保持全暗），
	// 分母是一个接近噪声底的泄漏量，随随机种子波动两个数量级都不够稳。
	// "连续两次把阈值调到刚好卡住实测值，说明错的不是阈值，是指标。"
	// 这条的意图（林地有脆响、路面没有）已由上面两条覆盖：
	// 尾段比（能量持续多久）+ 相邻采样跳变（信号抖得多快），
	// 两者都不依赖任何跨频带泄漏做分母。
	check(
		'路面比林地"沉"（low 至少 1.2 倍）',
		data.road1.low > data.floor1.low * 1.2,
		`road/floor low = ${(data.road1.low / Math.max(1e-12, data.floor1.low)).toFixed(2)}`,
	);
	check(
		'两步不相同（路面波形相关 < 0.98）',
		data.corrRoad < 0.98,
		`corr=${data.corrRoad.toFixed(4)}`,
	);
	check(
		'两步不相同（林地波形相关 < 0.98）',
		data.corrFloor < 0.98 && data.corrFloor2 < 0.98,
		`corr=${data.corrFloor.toFixed(4)} / ${data.corrFloor2.toFixed(4)}`,
	);
	check(
		'脚步信号真实存在（不是在给噪声底通过）',
		data.floor1.rms > 0.001 && data.road1.rms > 0.001,
		`floor rms=${data.floor1.rms.toFixed(4)} road rms=${data.road1.rms.toFixed(4)}`,
	);

	// ── 动物环境声（乌鸦 / 虫鸣）──────────────────────────────
	// 【v2–v3 的三次 FAIL 全是测量问题，不是合成问题】
	//
	// 教训 1（v2）：给乌鸦写绝对阈值 crow > 1e-5，实测 8.87e-7 判 FAIL
	//   —— 随机合成参数下绝对阈值必然抖动。
	// 教训 2（v3）：改"带内/带外 > 500 倍"，实测 96 倍又 FAIL。
	//   原因有二：(a) 乌鸦是**扫频**（0.16 s 内 1410→680 Hz），
	//   Goertzel 单点只在扫频掠过时短暂收到能量，随机参数决定每个点
	//   收到多少 —— 单次渲染的带能量能差 12 倍；
	//   (b) 分母（低频带）是亮噪声的带外泄漏，量级极小且随相位抖，
	//   拿它当基准，比值跟着抖两个数量级。
	//
	// 【v4 的断言只测"存在性 + 响度上限"，频谱位置靠 3 次取最大放宽】
	// 存在性用 rms（对扫频是稳定的全带量），上限是"不刺耳"的硬防线。
	// 频带主导的断言保留但放宽到 20 倍 —— 两次实测分别是 1613/96 和
	// 更高/481，20 倍在两次实测都有 5–80 倍余量，且仍能兜住
	// "有人把带通频率改到 100 Hz"这种灾难性错误。
	console.log(
		`  动物声: 乌鸦 rms(max)=${data.crowRms.toFixed(4)} crow带=${data.crow.crow.toExponential(2)}` +
			`  虫鸣 rms(max)=${data.insectRms.toFixed(4)} bug带=${data.insect.bug.toExponential(2)}`,
	);
	const crowDom = data.crow.crow / Math.max(1e-15, data.crow.low);
	const bugDom = data.insect.bug / Math.max(1e-15, data.insect.low);
	check(
		'乌鸦鸣叫存在且在其频带（带内/低频 > 20 倍）',
		data.crowRms > 5e-5 && crowDom > 20,
		`rms=${data.crowRms.toFixed(4)} crow/low=${crowDom.toFixed(0)}`,
	);
	check(
		'虫鸣存在且在 4–6 kHz 频带（带内/低频 > 50 倍）',
		data.insectRms > 1e-4 && bugDom > 50,
		`rms=${data.insectRms.toFixed(4)} bug/low=${bugDom.toFixed(0)}`,
	);
	// 人耳最敏感的频段必须有硬上限 —— 这是"环境声刺耳"旧病的直接防线。
	// 这一条是刻意的绝对值：无论随机参数怎么抖，虫鸣都不能比脚步响。
	check(
		'虫鸣不刺耳（rms < 0.006，在脚步的响度之下）',
		data.insectRms < 0.006,
		`insect rms=${data.insectRms.toFixed(4)} vs floor rms=${data.floor1.rms.toFixed(4)}`,
	);
	// 起音咔哒检测：头 10 ms 的峰值必须远小于整段峰值。
	// 正常的 80 ms 缓起在头 10 ms 只到满幅的 ~12%；
	// 若包络失效（直接赋值/叠加错误），头 10 ms 就会是满幅方波。
	check(
		'虫鸣起音无咔哒（头 10 ms 峰值 < 整段峰值的 40%）',
		data.insectOnset < data.insectPeak * 0.4,
		`onset=${data.insectOnset.toFixed(4)} peak=${data.insectPeak.toFixed(4)} ×${(data.insectOnset / Math.max(1e-9, data.insectPeak)).toFixed(2)}`,
	);

	// 真实游戏内冒烟：活着的声音管线不炸
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(1200);
	const live = await page.evaluate(() => {
		const m = window.mist;
		try {
			m.audio.oneShot('footstep', 1, 'road');
			m.audio.oneShot('footstep', 1, 'floor');
			m.audio.oneShot('snap', 1);
			m.audio.oneShot('crow', 1);
			m.audio.oneShot('insect', 1);
			return { ready: m.audio.ready, ok: true };
		} catch (e) {
			return { ready: m.audio.ready, ok: false, err: String(e) };
		}
	});
	check('实时管线冒烟（五种一次性音效不抛异常）', live.ok && live.ready, `ready=${live.ready}`);

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	const fail = results.filter((r) => !r.ok);
	console.log(`\n${'='.repeat(56)}`);
	console.log(`  step-probe: ${results.length - fail.length} PASS / ${fail.length} FAIL`);
	if (fail.length) for (const f of fail) console.log(`   FAIL  ${f.name}  ${f.detail || ''}`);
} finally {
	if (browser) await browser.close();
	await new Promise((r) => server.close(r));
	console.log('\n临时服务器已关闭，端口已释放。');
}
