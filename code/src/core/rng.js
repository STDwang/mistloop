// 确定性哈希。
// 为什么需要它：世界是"按坐标算出来"的，不是存下来的。
// 只要哈希是确定性的，同一个 (x, z) 就永远得到同一棵树——这是环面可复现的前提。

// 二维整数哈希 → [0, 1)
export function ihash2(x, y, seed = 0) {
	let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

// 三维整数哈希 → [0, 1)
export function ihash3(x, y, z, seed = 0) {
	let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
	h = Math.imul(h ^ (h >>> 13), 1274126177) ^ Math.imul(seed | 0, 1013904223);
	h = Math.imul(h ^ (h >>> 16), 2246822519);
	return (h >>> 0) / 4294967296;
}

// 数学取模（JS 的 % 对负数返回负值，这里修正）
export function imod(a, n) {
	return ((a % n) + n) % n;
}

// 局部随机数发生器。用于"一次性"的随机（抖动、色偏），不参与世界可复现性。
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
