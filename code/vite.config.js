import { defineConfig } from 'vite';

export default defineConfig({
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
