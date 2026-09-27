/**
 * OAuth account details for the current Claude Code login, derived from the `oauthAccount` block Claude Code persists in ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json when the config directory is overridden).
 *
 * emailAddress:       full login email organizationName:   display name of the organisation plan:               human-readable plan label (e.g. "Max 20x", "Team Premium")
 */
export interface AccountInfo {
    emailAddress: string | null;
    organizationName: string | null;
    plan: string | null;
}
/** True when the session authenticates with a token/API key instead of OAuth. */
export declare function isProviderSession(env?: NodeJS.ProcessEnv): boolean;
/**
 * Maps the oauthAccount plan fields to a display label. Unmapped organizationType values render raw so an unexpected plan stays visible instead of silently disappearing.
 */
export declare function planLabel(account: {
    organizationType: string | null;
    seatTier: string | null;
    userRateLimitTier: string | null;
    organizationRateLimitTier: string | null;
}): string | null;
/**
 * Derives account info from the parsed contents of claude.json. Pure so it can be tested without touching the filesystem.
 */
export declare function deriveAccountInfo(claudeJson: unknown): AccountInfo;
/**
 * Label for a provider (non-OAuth) session: the explicit provider name when set, else the API host, else nothing (the segment hides).
 */
export declare function resolveProviderLabel(env?: NodeJS.ProcessEnv): string | null;
/**
 * Joins the account fields into one first-line label: "email · organisation · plan". Provider sessions render the provider label alone. Returns null when there is nothing to show.
 */
export declare function formatAccountLabel(account: AccountInfo | null, providerLabel: string | null): string | null;
/**
 * Reads OAuth account info for the current login. Never throws. Provider (token/API key) sessions return null: the oauthAccount block can linger after switching away from OAuth, so it must not be shown for them.
 *
 * claude.json is the user's entire CLI config and grows with project history, so as in auth.ts the derived fields are cached against the file's (mtimeMs, ctimeMs, size, dev, ino) identity, making the steady-state cost a stat plus a ~100-byte read.
 */
export declare function readAccountInfo(): AccountInfo | null;
//# sourceMappingURL=account.d.ts.map