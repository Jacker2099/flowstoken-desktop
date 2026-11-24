import { powerMonitor } from "electron";

/** 系统空闲秒数（无键鼠输入）。独立成模块：执行器测试替换本模块即可，不必加载 electron。 */
export function getSystemIdleSeconds(): number {
	return powerMonitor.getSystemIdleTime();
}
