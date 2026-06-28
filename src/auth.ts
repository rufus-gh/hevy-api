import { API_KEY } from "./constants.js";

/** Response from POST /auth/refresh_token */
export interface TokenResponse {
  user_id: string;
  access_token: string;
  refresh_token: string;
  /** ISO timestamp when the access_token expires. */
  expires_at: string;
}

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  userId: string;
  /** epoch ms */
  expiresAt: number;
}

export interface AuthOptions {
  /** Long-lived refresh token captured from the app. */
  refreshToken: string;
  /** Optional pre-existing access token to avoid an initial refresh call. */
  accessToken?: string;
  /** epoch ms expiry for the provided accessToken. */
  expiresAt?: number;
  baseUrl: string;
  fetch: typeof fetch;
  /**
   * Called whenever tokens rotate, so callers can persist the new refresh
   * token (the old one is invalidated on each refresh).
   */
  onTokensRefreshed?: (state: AuthState) => void;
}

/** How long before expiry we proactively refresh. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Manages Hevy's rotating refresh-token auth. The refresh token is
 * single-use: each call to /auth/refresh_token returns a new refresh token
 * that replaces the old one, so we always persist the latest via the callback.
 */
export class HevyAuth {
  private state: AuthState | null = null;
  private inflight: Promise<AuthState> | null = null;

  constructor(private readonly opts: AuthOptions) {
    if (opts.accessToken && opts.expiresAt) {
      this.state = {
        accessToken: opts.accessToken,
        refreshToken: opts.refreshToken,
        userId: "",
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
  get refreshToken(): string {
    return this.state?.refreshToken ?? this.opts.refreshToken;
  }

  async refresh(): Promise<AuthState> {
    // De-dupe concurrent refreshes so we don't burn the single-use token twice.
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<AuthState> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/auth/refresh_token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });

    if (!res.ok) {
      throw new Error(
        `Token refresh failed (${res.status}). The refresh token may be expired or revoked — re-capture it from the app.`,
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
