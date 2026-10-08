import { defineConfig } from 'vite';

export default defineConfig({
	// 相对基路径：构建产物要能在任意子目录下被静态托管（GitHub Pages 就是
	// https://<user>.github.io/<repo>/ 这种子目录），绝对路径 /assets/… 会 404。
	base: './',
	server: {
		host: '127.0.0.1',
		port: 5199,
		strictPort: false,
		open: false,
	},
	build: {
		target: 'es2022',
		sourcemap: false,
	},
	// 依赖只有一个 three。没有 CDN、没有外部字体、没有任何网络请求。
	optimizeDeps: {
		include: ['three'],
	},
});
