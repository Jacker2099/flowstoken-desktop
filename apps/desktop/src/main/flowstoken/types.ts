import type { FlowstokenGroupId } from "./constants.js";

export interface FlowstokenUserSnapshot {
	id: number;
	username: string;
	displayName: string;
	email?: string;
	group?: string;
	quota: number;
	usedQuota: number;
	requestCount: number;
}

export interface FlowstokenUsageRow {
	id: number;
	createdAt: number;
	modelName: string;
	quota: number;
	promptTokens: number;
	completionTokens: number;
	tokenName?: string;
	group?: string;
	content?: string;
}

export interface FlowstokenGroupKeyState {
	groupId: FlowstokenGroupId;
	providerId: string;
	labelZh: string;
	tokenName: string;
	tokenId?: number;
	wired: boolean;
	enabled: boolean;
}

export interface FlowstokenAccountSnapshot {
	loggedIn: boolean;
	user: FlowstokenUserSnapshot | null;
	balanceUsd: string;
	usedUsd: string;
	groups: FlowstokenGroupKeyState[];
	usage: FlowstokenUsageRow[];
	siteUrl: string;
	topupUrl: string;
	consoleUrl: string;
	lastError?: string;
	updatedAt?: number;
}

export interface FlowstokenLoginResult {
	ok: boolean;
	error?: string;
	snapshot?: FlowstokenAccountSnapshot;
}

export interface FlowstokenEnsureKeysResult {
	ok: boolean;
	error?: string;
	snapshot?: FlowstokenAccountSnapshot;
	created: string[];
	reused: string[];
}
