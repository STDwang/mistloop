// 真实浏览器验证：加载页面，抓控制台错误，读运行时统计，截图。
//
// 为什么必须跑真浏览器：几何探针只能验证"算出来的数"，
// 但 shader 编译、InstancedMesh 的实例属性、贴图上传
// 只有真的渲染一次才会暴露。这个项目已经因为
// "探针全过、浏览器白屏" 吃过一次亏。
//
// 用法：node tools/scene-verify.mjs [输出图路径]

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const URL = 'http://127.0.0.1:5199/?debug';
const OUT = process.argv[2] || 'out/verify.png';

// 找系统 Chrome / Edge
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const exe = CANDIDATES.find((p) => p && existsSync(p));
if (!exe) { console.error('找不到 Chrome/Edge'); process.exit(2); }
console.log('浏览器:', exe);

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--enable-webgl',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(`[${m.type()}] ${t}`);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
// 等引擎把首帧渲染出来
await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
await page.waitForTimeout(3000);

const stats = await page.evaluate(() => {
  const m = window.mist;
  const eng = m.engine;
  const r = eng.renderer;
  const info = r.info;
  return {
    fps: +eng.fps?.toFixed(1),
    frameMs: +eng.frameMs?.toFixed(2),
    quality: eng.qualityStep,
    trees: m.forest.types[0].count + m.forest.types[1].count,
    canopy: m.forest.canopy.count,
    plants: m.undergrowth.count,
    undergrowthLayers: m.undergrowth.layers.map((l) => ({ key: l.def.key, count: l.mesh.count, radius: +l.radius.toFixed(0) })),
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    input: { sens: m.input.sensitivity, invertX: m.input.invertX, smoothing: m.input.smoothing },
    settings: m.settings.values,
    hasPath: typeof m.CFG.path === 'object',
    groundSegments: m.CFG.world.groundSegments,
  };
});

console.log('\n══════ 运行时统计 ══════');
console.log(JSON.stringify(stats, null, 2));

console.log('\n══════ 控制台 ══════');
if (errors.length === 0) console.log('  无错误');
else errors.forEach((e) => console.log('  ERROR: ' + e));
// 环面自检的结果
const torusLine = logs.find((l) => l.includes('环面无缝性自检'));
if (torusLine) console.log('\n' + torusLine);

await page.screenshot({ path: OUT });
console.log(`\n截图: ${OUT}`);

await browser.close();
process.exit(errors.length ? 1 : 0);
