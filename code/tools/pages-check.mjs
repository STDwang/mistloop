// 验证构建产物在「子目录托管」下能正常跑起来 —— 模拟 GitHub Pages 的
// https://<user>.github.io/<repo>/ 场景。绝对路径 /assets/… 在这里会 404，
// 相对路径 ./assets/… 才可以。跑完即弃。
import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PREFIX = '/mistloop';           // 模拟仓库名作为子路径
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };

let notFound = [];
const server = createServer((req, res) => {
	let url = (req.url || '/').split('?')[0];
	if (url === PREFIX) { res.writeHead(301, { Location: PREFIX + '/' }); return res.end(); }
	if (!url.startsWith(PREFIX + '/')) { res.writeHead(404); return res.end('outside prefix'); }
	url = url.slice(PREFIX.length);
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
	page.on('response', (r) => { if (r.status() >= 400) notFound.push(r.status() + ' ' + r.url()); });

	const url = `http://127.0.0.1:${port}${PREFIX}/`;
	console.log(`  访问 ${url}（模拟子目录托管）`);
	await page.goto(url, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 90000 });
	await page.waitForTimeout(2000);

	const title = await page.title();
	const hasButton = await page.locator('button:has-text("进入林子")').count();
	console.log(`  页面标题: ${title}`);
	console.log(`  进入按钮: ${hasButton ? '找到' : '未找到'}`);

	// 真进游戏，确认模型/贴图都加载成功
	await page.locator('button:has-text("进入林子")').click();
	await page.waitForTimeout(2500);
	const state = await page.evaluate(() => {
		const m = window.mist;
		return {
			playing: m.engine && m.engine.running !== false,
			playerY: m.player ? +m.player.pos.y.toFixed(2) : null,
			treeCount: m.forest && m.forest.count !== undefined ? m.forest.count : null,
			glbLoaded: !!(m.avatarRef && m.avatarRef.hasGLB),
		};
	});
	console.log('  运行状态:', JSON.stringify(state));

	await page.screenshot({ path: new URL('../../.dream-loop/shots/gh-pages-check.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
	console.log('  ✓ 截图 gh-pages-check.png');

	console.log('\n══════ 结果 ══════');
	if (notFound.length) { console.log('  ✗ 404 资源：'); for (const u of [...new Set(notFound)].slice(0, 10)) console.log('    ' + u); }
	else console.log('  ✓ 没有任何 404 —— 相对路径在子目录下工作正常');
	if (errors.length) { console.log('  ✗ 页面错误：'); for (const e of [...new Set(errors)].slice(0, 6)) console.log('    ' + e); }
	else console.log('  ✓ 无页面错误');
} finally {
	if (browser) await browser.close();
	server.close();
}
