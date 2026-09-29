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
	groupId: "default" | "smart" | "vip";
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

export interface DesktopFlowstokenApi {
	getSnapshot: () => Promise<FlowstokenAccountSnapshot>;
	loginWithBrowser: () => Promise<FlowstokenLoginResult>;
	loginWithPassword: (username: string, password: string) => Promise<FlowstokenLoginResult>;
	logout: () => Promise<FlowstokenAccountSnapshot>;
	ensureKeys: (groupIds?: Array<"default" | "smart" | "vip">) => Promise<FlowstokenEnsureKeysResult>;
	refresh: () => Promise<FlowstokenAccountSnapshot>;
	openExternal: (url: string) => Promise<void>;
	onAccountChanged: (listener: (snapshot: FlowstokenAccountSnapshot) => void) => () => void;
	getCatalog: () => Promise<FlowstokenCatalog>;
}

/** Mirror of main/flowstoken/types.ts — the server-delivered desktop model catalog (schema 1). */
export interface FlowstokenCatalogModel {
	id: string;
	name: string;
	released: number | null;
	tags: string[];
	vision: boolean;
	image: boolean;
}

export interface FlowstokenCatalogVendor {
	id: string;
	name: string;
	icon: string | null;
	mono: boolean;
	models: FlowstokenCatalogModel[];
}

export interface FlowstokenCatalogGroup {
	id: "smart" | "default" | "vip";
	providerId: string;
	title: string;
	subtitle: string;
	defaultModel?: string;
	highlight?: { title: string; badge: string; description: string };
	vendors: FlowstokenCatalogVendor[];
}

export interface FlowstokenCatalog {
	schema: 1;
	generated: number;
	pricingVersion: string;
	newWindowDays: number;
	iconBase: string;
	groups: FlowstokenCatalogGroup[];
}
