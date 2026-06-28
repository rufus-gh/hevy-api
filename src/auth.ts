import { API_KEY } from "./constants.js";

/** Response from POST /auth/refresh_token (and /login_with_saved_account). */
export interface TokenResponse {
  user_id: string;
  access_token: string;
  refresh_token: string;
  /** ISO timestamp when the access_token expires. */
  expires_at: string;
}

/**
 * Long-lived "saved account" credentials (the value the iOS keychain holds).
 * Unlike the refresh token, the secret does NOT rotate — it can be reused
 * indefinitely to mint fresh tokens, so it keeps you logged in without ever
 * depending on the app refreshing.
 */
export interface SavedAccountCredentials {
  userId: string;
  secret: string;
}

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  userId: string;
  /** epoch ms */
  expiresAt: number;
}

export interface AuthOptions {
  /** Rotating refresh token captured from the app. */
  refreshToken?: string;
  /**
   * Stable saved-account credentials. When provided, tokens are minted via
   * POST /login_with_saved_account and the user stays logged in indefinitely.
   * Takes precedence over `refreshToken`.
   */
  savedAccount?: SavedAccountCredentials;
  /** Optional pre-existing access token to avoid an initial mint call. */
  accessToken?: string;
  /** epoch ms expiry for the provided accessToken. */
  expiresAt?: number;
  baseUrl: string;
  fetch: typeof fetch;
  /** Called whenever tokens are minted, so callers can persist the latest. */
  onTokensRefreshed?: (state: AuthState) => void;
}

/** How long before expiry we proactively refresh. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Manages Hevy auth. Two modes:
 *  - saved account (preferred): re-logs in with a stable, non-rotating secret,
 *    so it never gets stuck on an expired/rotated token.
 *  - refresh token: exchanges the rotating, single-use refresh token.
 */
export class HevyAuth {
  private state: AuthState | null = null;
  private inflight: Promise<AuthState> | null = null;

  constructor(private readonly opts: AuthOptions) {
    if (opts.accessToken && opts.expiresAt) {
      this.state = {
        accessToken: opts.accessToken,
        refreshToken: opts.refreshToken ?? "",
        userId: opts.savedAccount?.userId ?? "",
        expiresAt: opts.expiresAt,
      };
    }
  }

  /** Returns a valid access token, refreshing if missing or near expiry. */
  async getAccessToken(): Promise<string> {
    if (this.state && this.state.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return this.state.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /** The current refresh token (rotates on every refresh). */
  get refreshToken(): string | undefined {
    return this.state?.refreshToken || this.opts.refreshToken;
  }

  /** Whether this auth never goes stale (saved-account mode). */
  get isPersistent(): boolean {
    return !!this.opts.savedAccount;
  }

  async refresh(): Promise<AuthState> {
    // De-dupe concurrent refreshes so we don't burn a single-use token twice.
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<AuthState> {
    const res = this.opts.savedAccount
      ? await this.opts.fetch(`${this.opts.baseUrl}/login_with_saved_account`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": API_KEY },
          body: JSON.stringify({
            userId: this.opts.savedAccount.userId,
            secret: this.opts.savedAccount.secret,
          }),
        })
      : await this.opts.fetch(`${this.opts.baseUrl}/auth/refresh_token`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": API_KEY },
          body: JSON.stringify({ refresh_token: this.refreshToken }),
        });

    if (!res.ok) {
      throw new Error(
        this.opts.savedAccount
          ? `Saved-account login failed (${res.status}). The secret may be invalid or revoked — re-capture it from the app.`
          : `Token refresh failed (${res.status}). The refresh token may be expired or revoked — re-capture it from the app.`,
      );
    }

    const data = (await res.json()) as TokenResponse;
    const state: AuthState = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user_id,
      expiresAt: Date.parse(data.expires_at),
    };
    this.state = state;
    this.opts.onTokensRefreshed?.(state);
    return state;
  }
}
