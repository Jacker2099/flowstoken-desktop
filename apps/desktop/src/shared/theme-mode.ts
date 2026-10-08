export type ThemeMode = "light" | "dark" | "auto";
export const DEFAULT_THEME_MODE: ThemeMode = "light";

/** Preserve explicit choices; missing or invalid preferences use the product default. */
export function normalizeThemeMode(value: unknown): ThemeMode {
	if (value === "light" || value === "dark" || value === "auto") return value;
	if (value === "system") return "auto";
	return DEFAULT_THEME_MODE;
}
