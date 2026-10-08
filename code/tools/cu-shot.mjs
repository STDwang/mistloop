// 一次性摆拍：主角化身与女鬼的近景特写，用于验证两段式四肢/围巾/发丝/抽头。
// 机位、光照全部钉死；跑完即弃。
import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = new URL('../../.dream-loop/shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.glb': 'model/gltf-binary' };

const server = createServer((req, res) => {
	const url = (req.url || '/').split('?')[0];
	let file = normalize(join(DIST, url === '/' ? 'index.html' : decodeURIComponent(url)));
	if (!file.startsWith(normalize(DIST))) file = join(DIST, 'index.html');
	try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { file = join(DIST, 'index.html'); }
	res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
	createReadStream(file).pipe(res);
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));

let browser;
try {
	browser = await chromium.launch({
		executablePath: exe, headless: true,
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle', '--enable-webgl', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 90000 });
	await page.waitForTimeout(1500);
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(1000);
	await page.evaluate(() => {
		window.mist.pause(false);
		for (const id of ['hud-top', 'crosshair', 'help', 'stats', 'objective', 'subtitle', 'bearing']) {
			const el = document.getElementById(id);
			if (el) el.style.display = 'none';
		}
		window.mist.engine.renderer.setPixelRatio(1);
	});

	const frames = (n) => page.evaluate((k) => new Promise((res) => { let i = 0; const tick = () => (++i >= k ? res(i) : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), n);

	// 静场 + 全局提亮一档（只为看得清形体；不影响源码）
	await page.evaluate(`
		(() => {
			const m = window.mist;
			m.director.cooldown = 1e9; m.director.pending = null; m.director._tickEntity = () => {};
			m.lightning._next = 1e9; m.lightning._pulses.length = 0; m.lightning.flash = 0;
			m.stalker.hide();
			// 提亮：环境光拉高 + 曝光拉高，专拍形体
			const L = m.engine.scene.children.find((c) => c.isAmbientLight || c.isHemisphereLight);
			if (L) L.intensity = 2.2;
			m.engine.renderer.toneMappingExposure = 2.6;
			m.engine.scene.fog.far = 260;
			if (m.engine.scene.background && m.engine.scene.background.isColor) m.engine.scene.background.setHex(0x3a4148);
			// 相机劫持：直接包一层 renderer.render —— 在游戏 update 写完相机、
			// 真正光栅化之前改机位（rAF 尾部改会被下一帧开头的 update 冲掉）。
			window.__camHijack = { mode: null };
			const R = m.engine.renderer;
			const origRender = R.render.bind(R);
			R.render = function (scene, cam) {
				const H = window.__camHijack, p = m.player;
				if (H.mode === 'follow-side') {
					const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
					cam.position.set(p.pos.x + rx * 2.6, p.pos.y + 1.35, p.pos.z + rz * 2.6);
					cam.lookAt(p.pos.x, p.pos.y + 0.95, p.pos.z);
				} else if (H.mode === 'front') {
					// three.js 朝向惯例：前方是 -sin/-cos（见 shot.mjs ghostAt）
					const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
					cam.position.set(p.pos.x - fx * 2.6, p.pos.y + 1.45, p.pos.z - fz * 2.6);
					cam.lookAt(p.pos.x, p.pos.y + 1.05, p.pos.z);
				}
				cam.updateMatrixWorld(true);
				return origRender(scene, cam);
			};
		})()
	`);

	// ── A. 主角化身 · 第三人称 · 正面 3 m ──
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', bubbles: true }));
	});
	await frames(6);
	await page.evaluate(`
		(() => {
			const m = window.mist, p = m.player;
			p.yaw = 0.9; p.pitch = 0;
			window.__camHijack.mode = 'front';
		})()
	`);
	await frames(12);
	await page.screenshot({ path: join(OUT, 'cu-avatar-front.png') });
	console.log('  ✓ cu-avatar-front.png  化身正面 2.6 m');

	// ── B. 主角化身 · 奔跑中侧写 ──
	await page.keyboard.down('KeyW');
	await frames(50); // 让它升格到跑
	await page.evaluate(`window.__camHijack.mode = 'follow-side';`);
	await frames(6);
	await page.screenshot({ path: join(OUT, 'cu-avatar-run.png') });
	await page.keyboard.up('KeyW');
	console.log('  ✓ cu-avatar-run.png  化身奔跑中·侧面');

	// ── C. 女鬼近景 · 4 m · 提亮 ──
	await page.evaluate(`
		(() => {
			const m = window.mist, S = m.stalker, p = m.player, cam = m.engine.camera;
			window.__camHijack.mode = null;   // 停掉相机劫持，把机位还给这一段
			S.show();
			S.place(p.pos.x - Math.sin(p.yaw) * 4, p.pos.z - Math.cos(p.yaw) * 4);
			S.faceTarget(p.pos.x, p.pos.z);
			S.setDistanceHint(4);
			S.opacity = 0.95; S.lit = 0; S.litTarget = 0;
			const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
			cam.position.set(p.pos.x + fx * 2.4, p.pos.y + 1.55, p.pos.z + fz * 2.4);
			cam.lookAt(p.pos.x - fx * 4, p.pos.y + 1.35, p.pos.z - fz * 4);
			cam.updateMatrixWorld(true);
		})()
	`);
	await frames(10);
	await page.screenshot({ path: join(OUT, 'cu-ghost.png') });
	console.log('  ✓ cu-ghost.png  女鬼近景 4 m');

	if (errors.length) { console.log(`页面错误 ${errors.length} 条：`); for (const e of [...new Set(errors)].slice(0, 6)) console.log('  ' + e); }
	else console.log('无页面错误');
} finally {
	if (browser) await browser.close();
	server.close();
}
