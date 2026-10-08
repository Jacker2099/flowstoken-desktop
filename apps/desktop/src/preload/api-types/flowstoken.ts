import type { FlowstokenModelKind, FlowstokenReasoningLevel } from "../../shared/flowstoken-catalog-policy.js";
import type { ModelsConfigData } from "./models.js";

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

export interface DesktopFlowstokenApi {
	getSnapshot: () => Promise<FlowstokenAccountSnapshot>;
	loginWithBrowser: () => Promise<FlowstokenLoginResult>;
	cancelLogin: () => Promise<void>;
	loginWithPassword: (username: string, password: string) => Promise<FlowstokenLoginResult>;
	logout: () => Promise<FlowstokenAccountSnapshot>;
	ensureKeys: (groupIds?: string[]) => Promise<FlowstokenEnsureKeysResult>;
	refresh: () => Promise<FlowstokenAccountSnapshot>;
	openExternal: (url: string) => Promise<void>;
	onAccountChanged: (listener: (snapshot: FlowstokenAccountSnapshot) => void) => () => void;
	getCatalog: (options?: { force?: boolean }) => Promise<FlowstokenCatalog>;
	getCatalogSnapshot: (options?: { force?: boolean }) => Promise<FlowstokenCatalogSnapshot>;
}

export interface FlowstokenCatalogSnapshot {
	catalog: FlowstokenCatalog;
	config: ModelsConfigData;
}

/** Mirror of main/flowstoken/types.ts — validated server model catalog (schema 1 or 2). */
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
