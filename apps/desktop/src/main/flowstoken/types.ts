import type { FlowstokenModelKind, FlowstokenReasoningLevel } from "../../shared/flowstoken-catalog-policy.js";

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
	groupId: string;
	providerId: string;
	labelZh: string;
	tokenName: string;
	tokenId?: number;
	wired: boolean;
	enabled: boolean;
	requiresManualSetup?: boolean;
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

/** Display and supported model capabilities; contains no credentials or executable configuration. */
export interface FlowstokenCatalogModel {
	id: string;
	name: string;
	released: number | null;
	tags: string[];
	vision: boolean;
	image: boolean;
	kind?: FlowstokenModelKind;
	reasoningLevels?: FlowstokenReasoningLevel[];
	defaultReasoningLevel?: FlowstokenReasoningLevel;
	recommended?: boolean;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface FlowstokenCatalogVendor {
	id: string;
	name: string;
	icon: string | null;
	mono: boolean;
	models: FlowstokenCatalogModel[];
}

export interface FlowstokenCatalogGroup {
	/** Immutable NewAPI billing group key, independent from its display title. */
	id: string;
	providerId: string;
	title: string;
	titles?: { zh?: string; en?: string };
	subtitle: string;
	defaultModel?: string;
	highlight?: { title: string; badge: string; description: string };
	vendors: FlowstokenCatalogVendor[];
}

/** Whole server-delivered catalog — the only source for order, names, vendors and badges. */
export interface FlowstokenCatalog {
	schema: 1 | 2;
	/** Opaque schema-2 content revision. Valid earlier revisions can be restored for rollback. */
	revision?: string;
	source?: "network" | "cache" | "fallback";
	fetchedAt?: number;
	generated: number;
	pricingVersion: string;
	newWindowDays: number;
	iconBase: string;
	groups: FlowstokenCatalogGroup[];
}
