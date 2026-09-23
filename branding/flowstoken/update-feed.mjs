// FlowsToken open-source builds check for updates on our own server (mirrored from GitHub Releases by the
// server-side release sync) instead of GitHub Releases, which is slow or unreachable for many customers.
// Single source of truth for the update feed; the release config and build validation both import it.
export const FLOWSTOKEN_UPDATE_HOST = "www.flowstoken.com";
export const FLOWSTOKEN_UPDATE_URL = `https://${FLOWSTOKEN_UPDATE_HOST}/downloads/desktop`;

/** True only for the FlowsToken generic feed over https; anything else stays governed by upstream rules. */
export function isFlowsTokenUpdateFeed(updateConfig) {
	if (!updateConfig || updateConfig.provider !== "generic" || typeof updateConfig.url !== "string") return false;
	try {
		const url = new URL(updateConfig.url);
		return url.protocol === "https:" && url.hostname === FLOWSTOKEN_UPDATE_HOST && !url.username && !url.search;
	} catch {
		return false;
	}
}
