// 姿态视觉校验：蹲下/静步在第三人称下看起来对不对。
//
// 数值探针（stance-verify）能证明 eyeHeight 变了，但证不了"那个人偶
// 看起来是不是蹲着"—— 一个只把 root.position.y 往下挪的实现也能
// 让所有数值通过，而画面上是"人偶陷进地里"。这里就是拍这个。
//
// 同时用一条几何断言兜住最典型的错误：蹲下时人偶的**头部高度**
// 必须真的下降，但**脚**必须仍然站在地面上（不能沉下去）。

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = new URL('../out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
	'.html': 'text/html;charset=utf-8',
	'.js': 'text/javascript;charset=utf-8',
	'.css': 'text/css;charset=utf-8',
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
	const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(600);

	const press = async (code, down) => {
		await page.evaluate(
			([c, d]) => {
				window.dispatchEvent(
					new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true, cancelable: true }),
				);
			},
			[code, down],
		);
	};
	// 【踩坑】不能只等 stanceSettled —— 它是个**当前值**，不是"目标已达成"。
	// v1 在按下 Ctrl 之后立刻轮询 stanceSettled，读到的是 walk 状态下
	// 残留的 k=1，于是 until() 当场返回 true，接着读到的 eyeHeight 是
	// 过渡刚开始的 1.421 m。引擎本身完全正确（诊断脚本实测 1.2 s 收敛到 0.913），
	// 错的是探针问了一个"现在好了吗"而不是"去到那里了吗"。
	// 正确的等待条件是**目标姿态 + 已收敛**，两个都要。
	const settleTo = async (stance, budgetMs = 12000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < budgetMs) {
			const ok = await page.evaluate(
				(s) => window.mist.player.stance === s && window.mist.player.stanceSettled,
				stance,
			);
			if (ok) return true;
			await page.waitForTimeout(120);
		}
		return false;
	};
	const ensureRunning = async () => {
		if (await page.evaluate(() => window.mist.isPaused())) {
			await page.locator('#gl').click({ position: { x: 300, y: 180 } });
			await page.waitForTimeout(250);
		}
	};

	// 切第三人称：这一支的问题只在这里可见
	await press('KeyF', true);
	await press('KeyF', false);
	await page.waitForTimeout(300);
	await ensureRunning();

	// 把玩家放到一个视野干净的位置，且朝向让光从侧前方来 ——
	// 逆光下剪影只看得见轮廓，看不清"膝盖有没有弯"。
	await page.evaluate(() => {
		const m = window.mist;
		m.player.warpTo(m.CFG.world.tile * 0.5 + 6, m.CFG.world.tile * 0.5 + 6);
		m.player.yaw = 0.9;
		m.player.pitch = -0.08;
	});
	await page.waitForTimeout(400);

	const measure = async () =>
		page.evaluate(() => {
			const m = window.mist;
			const a = m.avatarRef;
			// 【必须量躯干网格，不能量 body 组】
			// body 是个位于原点的 Group，只承载 _duck 位移；
			// 而躯干 Mesh 在 body 里还有自己的 local y=1.22。
			// v1 量的是 body.getWorldPosition()，拿到的其实是 root 的高度
			// （0.119 m，等于 player.pos.y），于是"下沉量"算成了 -0.070 ——
			// 一个纯粹的测量对象错误，和动画本身无关。
			//
			// 【v2 的第二个错误】不能靠 children[0] 去猜躯干是谁。
			// v2 那样写之后量出来蹲下反而"升高"了 0.328 m ——
			// 因为机身还有其他子节点，且躯干自己带 rotation.x 前倾，
			// 而 body 又被施加了前倾旋转，索引猜错就会量到别的部件。
			// 正确做法：按类型和几何特征**找**躯干 —— 它是圆柱体里
			// 半径最大、位置最高的那个（肩是 0.2、躯干是 0.19，用 y 区分）。
			// 更稳的是直接读 body 自身的世界位置再补上躯干的 local y，
			// 因为 body 的位移就是 _duck，这是我们要测的量本身。
			const v = m.THREE_V3();
			a.body.getWorldPosition(v);
			// 【第三版：分开量两个东西，别混】
			//   · bodyGroupY  = body 组的**原点**在世界里的高度。
			//     它不是身体的高度！body 的原点钉在脚踝处，躯干/头/腿
			//     各自带自己的 local y（躯干 +1.22、腿从 +0.94 往下）。
			//     所以 bodyGroupY 下沉到地面以下**是正确的** —— 那不是穿模。
			//   · headWorldY  = 头网格的世界高度，这才是"人偶看起来多高"。
			//     蹲下必须让它下降，且必须仍然高于地面。
			// v2 把 body 组的高度当成了身体高度，于是量出"下沉到 -0.276 m"
			// 还以为人偶入地了。断言用错量，和实现无关。
			// GLB 换装后头网格叫 P_Head；基元 fallback 才是 SphereGeometry
			const head = a.body.children.find(
				(c) => c.name === 'P_Head' || c.geometry?.type === 'SphereGeometry',
			);
			// 【量包围盒顶，不量网格原点】GLB 换装后头网格的几何被烘焙到
			// 角色空间、position=(0,0,0)，getWorldPosition 读到的是脚底。
			// "头顶"的诚实定义 = 头几何体世界包围盒的 max.y —— 对基元球
			// 和 GLB 头一视同仁，下蹲/前倾矩阵也天然计入。
			head.updateWorldMatrix(true, false);
			const hb = m.THREE_BOX3().setFromObject(head);
			return {
				bodyGroupY: v.y,
				headWorldY: hb.max.y,
				rootY: a.root.position.y,
				duck: a._duck,
				leanX: a.body.rotation.x,
				stance: m.player.stance,
				eye: m.player.eyeHeight,
				ground: m.player.pos.y,
				names: a.body.children.map((c) => `${c.type}:${c.geometry?.type || ''}`),
			};
		});

	await ensureRunning();
	const stand = await measure();
	await page.screenshot({ path: join(OUT, 'stance-stand.png') });

	// 蹲下
	await press('ControlLeft', true);
	await settleTo('crouch');
	await page.waitForTimeout(500);
	await ensureRunning();
	const crouched = await measure();
	await page.screenshot({ path: join(OUT, 'stance-crouch.png') });

	console.log('\n══════ 人偶几何 ══════');
	if (stand && crouched) {
		const drop = stand.headWorldY - crouched.headWorldY;
		console.log(`  站姿头顶世界高 = ${stand.headWorldY.toFixed(3)} m  (duck=${stand.duck.toFixed(3)})`);
		console.log(`  蹲姿头顶世界高 = ${crouched.headWorldY.toFixed(3)} m  (duck=${crouched.duck.toFixed(3)})`);
		console.log(
			`  头顶下沉 = ${drop.toFixed(3)} m   眼高 ${stand.eye.toFixed(3)} → ${crouched.eye.toFixed(3)}`,
		);

		check(
			'蹲下时人偶真的变矮（头顶下沉 0.3–0.75 m）',
			drop > 0.3 && drop < 0.75,
			`头顶下沉 ${drop.toFixed(3)} m（负数=反而升高，即 v1 的符号 bug）`,
		);
		// 最典型的错误实现：把整个 root 往下挪 → 脚穿进地里。
		// root 应当**不动**（它始终钉在脚的位置），下沉发生在 body 上。
		check(
			'人偶根部不动（脚仍站在地面上，没有沉进地里）',
			Math.abs(crouched.rootY - stand.rootY) < 0.02,
			`root ${stand.rootY.toFixed(3)} → ${crouched.rootY.toFixed(3)}`,
		);
		// 头顶下沉量必须**大于**眼高下降量的一半、但小于它：
		// 眼高降 0.75 m、头顶降约 0.4 m，差额由前倾补 ——
		// 如果头顶降得比眼高还多，说明人偶被压扁了。
		const eyeDrop = stand.eye - crouched.eye;
		check(
			'头顶下沉量小于眼高下降量（差额由前倾/屈膝补足）',
			drop < eyeDrop,
			`头顶降 ${drop.toFixed(3)} < 眼高降 ${eyeDrop.toFixed(3)} m`,
		);
		// 前倾必须真的发生：这是"压低"最可读的剪影变化。
		// 只下沉不前倾 = 人偶在乘电梯，不是在蹲。
		check(
			'蹲下时躯干前倾（0.25–0.5 rad）',
			crouched.leanX > 0.25 && crouched.leanX < 0.5,
			`leanX = ${crouched.leanX.toFixed(3)} rad（站姿 ${stand.leanX.toFixed(3)}）`,
		);
		// 头顶必须在合理的人体高度区间内：蹲下约 1.3 m、站立约 1.85 m。
		// 这一条兜住"人偶整体缩放到 0"之类的灾难性错误。
		check(
			'站立头顶 ≈1.8 m，蹲下头顶 ≈1.3 m（人体比例合理）',
			stand.headWorldY > 1.6 && stand.headWorldY < 2.0 && crouched.headWorldY > 1.1 && crouched.headWorldY < 1.5,
			`站 ${stand.headWorldY.toFixed(2)} m / 蹲 ${crouched.headWorldY.toFixed(2)} m`,
		);
	} else {
		check('取到化身对象', false, 'avatarRef 为空');
	}

	await press('ControlLeft', false);
	await settleTo('walk');

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	const fail = results.filter((r) => !r.ok);
	console.log(`\n${'='.repeat(56)}`);
	console.log(`  stance-visual: ${results.length - fail.length} PASS / ${fail.length} FAIL`);
	if (fail.length) for (const f of fail) console.log(`   FAIL  ${f.name}  ${f.detail || ''}`);
	console.log(`  截图: out/stance-stand.png  out/stance-crouch.png`);
} finally {
	if (browser) await browser.close();
	await new Promise((r) => server.close(r));
	console.log('\n临时服务器已关闭，端口已释放。');
}
