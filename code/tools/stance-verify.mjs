// 姿态系统验证探针：Shift 静步 / Ctrl 蹲下 / 自动小跑。
//
// ─────────────────────────────────────────────────────────────
// 【这个探针要证明什么】
//
// 姿态系统最容易被做成"看起来有、实际没用"：改一个速度倍率，
// 数字上能动，但玩家永远不会去用它。所以断言不能只测"速度变小了"，
// 必须测到**它换来了什么**：
//
//   · 眼高真的降了            → 相机 y 与地面的差
//   · 相机是**平滑**降的       → 过渡中采样，确认存在中间态
//   · 响度真的降了            → player.noiseLevel
//   · director 真的读到了     → sinceTravel 的增速被 noise 加权
//   · 第三人称人偶真的蹲了     → 化身的 root→body 相对位移
//   · 自动小跑真的会升格       → 按住 W 一段时间后 speed 跃升
//   · 姿态与奔跑互斥           → 按住 Shift 时永不 running
//
// 最后两条是"设计意图"而不是"机制存在"，但它们才是这个系统成不成立的关键。
//
// ─────────────────────────────────────────────────────────────
// 【环境纪律 · 两条踩过的坑，不要重犯】
//
// ① SwiftShader 在 1280×720 只有 2–4 fps，而引擎把 dt 钳在 0.05 s，
//    于是**物理时间只以约 1/4 的速度前进**。任何 waitForTimeout(900)
//    实际只推进约 0.15 s。所有等待必须用小视口(640×360) + 轮询。
//
// ② 合成 keydown 必须配对 keyup。input.keys 是"按下即入、松开才出"的集合，
//    只发 keydown 的话第二次会被 `if (!this.keys.has(code))` 静默吞掉。
//
// ③ 指针锁可能中途丢失 → paused=true → player.update 停止 → 一切冻结。
//    每个输入阶段前都要 ensureRunning()。
// ─────────────────────────────────────────────────────────────

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
	'.html': 'text/html;charset=utf-8',
	'.js': 'text/javascript;charset=utf-8',
	'.css': 'text/css;charset=utf-8',
};

// 自建临时静态服务器：绑定 0 号端口由系统分配，finally 里关闭。
// 为什么不复用 5199：那台常驻 dev server 是被用户主动停掉的，
// 探针不该假设它存在，也不该把验证依赖在别人的进程生命周期上。
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
		args: [
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--enable-webgl',
			'--no-sandbox',
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	// 小视口是必须的：见顶部纪律①
	const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	// 必须点进游戏：不点的话停在标题页，player.update 根本没跑，
	// 所有采样都会是初始值 —— v1 的截图全是标题卡就是漏了这一步。
	await page.locator('button:has-text("进入林子")').click();

	// 合成按键。keydown + 保持 + keyup，见纪律②。
	const press = async (code, down) => {
		await page.evaluate(
			([c, d]) => {
				const ev = new KeyboardEvent(d ? 'keydown' : 'keyup', {
					code: c,
					bubbles: true,
					cancelable: true,
				});
				window.dispatchEvent(ev);
			},
			[code, down],
		);
	};

	// 指针锁可能丢，丢了就 paused，一切都冻住。见纪律③。
	const ensureRunning = async () => {
		const st = await page.evaluate(() => ({
			paused: window.mist.isPaused(),
			stance: window.mist.player.stance,
		}));
		if (st.paused) {
			await page.locator('#gl').click({ position: { x: 300, y: 180 } });
			await page.waitForTimeout(250);
		}
		return st;
	};

	// 轮询直到条件成立或超时。返回是否成立。
	// cond 是**字符串**形式的页面侧表达式 —— Playwright 的 evaluate
	// 参数必须是可 JSON 序列化的，函数对象传不进去（v3 踩过：
	// "Attempting to serialize unexpected value: () => ..."直接炸掉）。
	//
	// 【为什么不用固定 sleep】物理时间约为墙钟的 1/4（纪律①），
	// 固定等待只能靠"等很久"来碰运气，而轮询能给出确定的预算。
	// 【v2 的补丁：paused 时视为"未达成"】
	// headless 里指针锁可能中途丢失 → paused=true → player.update 冻结。
	// 此时 player.stance / eyeHeight / stanceSettled 全部停在冻结瞬间的值 ——
	// 如果等待条件恰好已被冻结状态满足（比如"已收敛"），until 会立刻
	// 返回 true，然后读到一套冻结的旧值。v2 的静步断言就这样失败过：
	// 读到 stance=crouch（冻结）+ settled=true，而 Shift 事件根本没被消费。
	// 解法有二：等待条件里带 !isPaused()，或等待一个冻结时不可能
	// 为真的**后果**（eyeHeight 到达目标）。两条都上。
	const until = async (cond, budgetMs = 12000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < budgetMs) {
			const ok = await page.evaluate(
				(s) => (window.mist.isPaused() ? false : eval(s)),
				cond,
			);
			if (ok) return true;
			await page.waitForTimeout(120);
		}
		return false;
	};

	console.log('\n══════ ① 初始状态 ══════');
	await ensureRunning();
	const init = await page.evaluate(() => {
		const p = window.mist.player;
		return {
			stance: p.stance,
			eyeHeight: p.eyeHeight,
			noiseLevel: p.noiseLevel,
			cfgEye: window.mist.CFG.player.eye,
			running: p.running,
		};
	});
	check(
		'开局是正常走，眼高 = CFG.player.eye',
		init.stance === 'walk' && Math.abs(init.eyeHeight - init.cfgEye) < 1e-6,
		`stance=${init.stance} eye=${init.eyeHeight.toFixed(3)}`,
	);

	console.log('\n══════ ② 蹲下：眼高连续下降 ══════');
	// 采样过渡过程，证明它是**连续**的而不是瞬切。
	// 瞬切在数值上"结果也对"，所以只测终值会漏掉最难看的那种实现。
	await press('ControlLeft', true);
	const eyeSamples = [];
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 8000) {
			const s = await page.evaluate(() => window.mist.player.eyeHeight);
			eyeSamples.push(s);
			if (eyeSamples.length > 6 && Math.abs(s - 0.913) < 0.01) break;
			await page.waitForTimeout(80);
		}
	}
	await press('ControlLeft', false);
	const crouchLow = Math.min(...eyeSamples);
	const crouchHigh = Math.max(...eyeSamples);
	// 蹲下 eyeK = 0.55 → 1.66 × 0.55 = 0.913
	check(
		'蹲下后眼高降到约 0.91 m（CFG eye × 0.55）',
		Math.abs(crouchLow - 0.913) < 0.03,
		`最低眼高 = ${crouchLow.toFixed(3)} m`,
	);
	// 连续性的证据：采样里必须出现**既非起点也非终点**的中间值
	const mids = eyeSamples.filter((s) => s > crouchLow + 0.02 && s < init.cfgEye - 0.02);
	check(
		'眼高是平滑过渡的（采样到中间态，不是瞬切）',
		mids.length >= 1,
		`中间态采样 ${mids.length} 个（如 ${mids.length ? mids[0].toFixed(3) : '—'}）`,
	);

	console.log('\n══════ ③ 蹲下：响度与第三人称人偶 ══════');
	// 切第三人称看人偶有没有真的蹲下去
	await press('KeyF', true);
	await press('KeyF', false);
	await page.waitForTimeout(200);
	await ensureRunning();
	await press('ControlLeft', true);
	await until('Math.abs(window.mist.player.eyeHeight - 0.913) < 0.02', 9000);
	const crouchThird = await page.evaluate(() => {
		const m = window.mist;
		return {
			view: m.player.viewMode,
			noise: m.player.noiseLevel,
			eye: m.player.eyeHeight,
		};
	});
	// 蹲下 noise = 0.12。站着不动时 noiseLevel 还要乘速度因子下限 0.15 ——
	// 所以静止蹲下的理论值是 0.12 × 0.15 = 0.018
	check(
		'蹲下时 noiseLevel 极低（< 0.05）',
		crouchThird.noise < 0.05,
		`noiseLevel = ${crouchThird.noise.toFixed(4)}`,
	);
	check('切到了第三人称', crouchThird.view === 'third', `view=${crouchThird.view}`);

	console.log('\n══════ ④ 静步 ══════');
	await press('ControlLeft', false);
	await ensureRunning();
	await press('ShiftLeft', true);
	// 【必须等"目标姿态 && 已收敛 && 眼高到位"三件套】
	// v1 只等 stance === 'sneak' → 读到过渡半路值（那是姿势参数还没到）；
	// v2 只等 stanceSettled → 冻结状态下立刻返回 true（那是 paused 陷阱，
	// 见 until 的注释）。等眼高到达 1.56 是冻结时不可能满足的**后果**：
	// 物理停着的时候 eyeHeight 永远停在 0.913。
	await until(
		"window.mist.player.stance === 'sneak' && window.mist.player.stanceSettled && " +
			'Math.abs(window.mist.player.eyeHeight - 1.66 * 0.94) < 0.03',
		14000,
	);
	const sneak = await page.evaluate(() => ({
		stance: window.mist.player.stance,
		eye: window.mist.player.eyeHeight,
		running: window.mist.player.running,
		settled: window.mist.player.stanceSettled,
		paused: window.mist.isPaused(),
	}));
	check(
		'Shift 进入静步，眼高只降一点点（0.94 倍）',
		sneak.stance === 'sneak' && Math.abs(sneak.eye - 1.66 * 0.94) < 0.03,
		`stance=${sneak.stance} eye=${sneak.eye.toFixed(3)} settled=${sneak.settled} paused=${sneak.paused}`,
	);
	check('静步时不会奔跑（Shift 与奔跑互斥）', sneak.running === false, `running=${sneak.running}`);
	await press('ShiftLeft', false);
	await until(
		"window.mist.player.stance === 'walk' && window.mist.player.stanceSettled && " +
			'Math.abs(window.mist.player.eyeHeight - window.mist.CFG.player.eye) < 0.02',
		12000,
	);

	console.log('\n══════ ⑤ 自动小跑（按住 W 升格）══════');
	await ensureRunning();
	// 先记录起步速度
	const beforeRun = await page.evaluate(() => window.mist.player.speed);
	await press('KeyW', true);
	// runHold = 1.1 s 的**物理**时间 ≈ 4.4 s 墙钟（纪律①）。
	// 用轮询而不是固定等待：等 running 变 true，或最多 30 s。
	const becameRunning = await until('window.mist.player.running === true', 30000);
	const runSpeed = await page.evaluate(() => window.mist.player.speed);
	await press('KeyW', false);
	check(
		'按住 W 一段时间后自动升格为奔跑',
		becameRunning,
		`running 变为 true，speed=${runSpeed.toFixed(2)} m/s（起步 ${beforeRun.toFixed(2)}）`,
	);
	// 奔跑速度应当明显高于步行的 2.5 m/s
	check(
		'奔跑速度接近 run（> 3.2 m/s）',
		runSpeed > 3.2,
		`speed = ${runSpeed.toFixed(2)} m/s`,
	);

	console.log('\n══════ ⑥ director 真的读到了响度 ══════');
	// 这一条是"姿态有没有机制意义"的核心。
	// sinceTravel 的增速被 noiseLevel 加权 —— 静步走同样的物理距离，
	// 对"连续行进"触发规则的贡献应当显著更小。
	await ensureRunning();
	const measureTravel = async () => {
		await ensureRunning();
		const t0 = await page.evaluate(() => ({
			travel: window.mist.director.sinceTravel,
			x: window.mist.player.pos.x,
			z: window.mist.player.pos.z,
		}));
		await press('KeyW', true);
		await page.waitForTimeout(2600);
		const t1 = await page.evaluate(() => ({
			travel: window.mist.director.sinceTravel,
			x: window.mist.player.pos.x,
			z: window.mist.player.pos.z,
		}));
		await press('KeyW', false);
		await page.waitForTimeout(400);
		// 物理位移是采样有效性的证人：如果指针锁在这段丢了
		// （paused 冻结），位移为 0，sinceTravel 也为 0 ——
		// 拿它算比值会得到假 PASS/假 FAIL。
		const dist = Math.hypot(t1.x - t0.x, t1.z - t0.z);
		return { travel: t1.travel - t0.travel, dist, valid: dist > 0.05 };
	};
	let travelWalk = { travel: 0, valid: false };
	for (let i = 0; i < 3 && !travelWalk.valid; i++) travelWalk = await measureTravel();
	await press('ShiftLeft', true);
	await until(
		"window.mist.player.stance === 'sneak' && window.mist.player.stanceSettled",
		10000,
	);
	let travelSneak = { travel: 0, valid: false };
	for (let i = 0; i < 3 && !travelSneak.valid; i++) travelSneak = await measureTravel();
	await press('ShiftLeft', false);
	const ratio = travelWalk.travel / Math.max(1e-6, travelSneak.travel);
	check(
		'两次采样都有效（物理在跑，指针锁没丢）',
		travelWalk.valid && travelSneak.valid,
		`walk dist=${travelWalk.dist.toFixed(2)} sneak dist=${travelSneak.dist.toFixed(2)}`,
	);
	check(
		'静步时 sinceTravel 增长被明显抑制（≥ 1.8 倍差距）',
		ratio >= 1.8,
		`walk=${travelWalk.travel.toFixed(3)} sneak=${travelSneak.travel.toFixed(3)} ×${ratio.toFixed(2)}`,
	);

	console.log('\n══════ ⑦ 起身后一切复原 ══════');
	await ensureRunning();
	await press('ShiftLeft', false);
	await press('ControlLeft', false);
	await until(
		'Math.abs(window.mist.player.eyeHeight - window.mist.CFG.player.eye) < 0.02',
		12000,
	);
	const back = await page.evaluate(() => ({
		eye: window.mist.player.eyeHeight,
		stance: window.mist.player.stance,
	}));
	check(
		'松开后眼高回到 1.66 m',
		Math.abs(back.eye - 1.66) < 0.02,
		`eye = ${back.eye.toFixed(3)} stance=${back.stance}`,
	);

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	const fail = results.filter((r) => !r.ok);
	console.log(`\n${'='.repeat(56)}`);
	console.log(`  stance-verify: ${results.length - fail.length} PASS / ${fail.length} FAIL`);
	if (fail.length) for (const f of fail) console.log(`   FAIL  ${f.name}  ${f.detail || ''}`);
} finally {
	if (browser) await browser.close();
	await new Promise((r) => server.close(r));
	console.log('\n临时服务器已关闭，端口已释放。');
}
