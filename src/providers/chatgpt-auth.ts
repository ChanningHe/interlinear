// "Sign in with ChatGPT" for open-source apps (developers.openai.com/siwc): OAuth 2.0 authorization
// code + PKCE as a public client, no secret, no impersonation. The extension registers itself
// dynamically the first time and reuses the client id OpenAI issues. Tokens are kept apart from
// settings (never exported, never synced) and only the background uses them for requests.

export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const APP_NAME = "interlinear";
/** OpenAI requires a 127.0.0.1 loopback callback; nothing listens there, the tab URL is read instead. */
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

export interface ChatgptCredential {
  /** Issued at first registration (oaiapp_…) and reused for every later sign-in and refresh. */
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly email: string;
  readonly sub: string;
}

/** Per-attempt secrets, kept in memory only for the duration of one sign-in. */
export interface PendingSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly clientId: string;
}

/** The user disconnected the extension in ChatGPT, or the refresh token expired. */
export class SignedOutError extends Error {
  constructor() {
    super("Signed out of ChatGPT; sign in again in settings");
    this.name = "SignedOutError";
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** S256 code challenge for a PKCE verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Fresh secrets for one attempt; reauthorization reuses the client id from the first registration. */
export function newPendingSignIn(existingClientId?: string): PendingSignIn {
  return { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), clientId: existingClientId ?? DYNAMIC_CLIENT };
}

export async function authorizeUrl(pending: PendingSignIn, hostId: string, loginHint?: string): Promise<string> {
  const isNew = pending.clientId === DYNAMIC_CLIENT;
  const params = new URLSearchParams({
    client_id: pending.clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    resource: RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: await codeChallenge(pending.verifier),
    ext_agent_host_id: hostId,
    ...(isNew && { agent_name_hint: APP_NAME }),
    ...(loginHint && { login_hint: loginHint }),
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * The callback URL from a tab URL. Nothing listens on 127.0.0.1, so a browser may show its error
 * page instead (Firefox: about:neterror?u=<the URL>); both forms are recognised.
 */
export function callbackFrom(url: string): string | undefined {
  if (url.startsWith(REDIRECT_URI)) return url;
  if (!url.startsWith("about:neterror")) return undefined;
  const inner = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("u") ?? "";
  return inner.startsWith(REDIRECT_URI) ? inner : undefined;
}

/** Validates the callback against this attempt and returns the code and the client id to use. */
export function parseCallback(url: string, pending: PendingSignIn): { code: string; clientId: string } {
  const params = new URL(url).searchParams;
  const error = params.get("error");
  if (error) throw new Error(error === "access_denied" ? "Sign-in was cancelled" : `Sign-in failed (${error})`);
  if (params.get("state") !== pending.state) throw new Error("Sign-in failed (state mismatch)");
  const code = params.get("code");
  if (!code) throw new Error("Sign-in failed (no authorization code)");
  const issued = params.get("client_id");
  if (pending.clientId === DYNAMIC_CLIENT) {
    if (!issued || issued === DYNAMIC_CLIENT) throw new Error("Sign-in failed (no client id issued)");
    return { code, clientId: issued };
  }
  // Reauthorization must come back for the same registration.
  if (issued && issued !== pending.clientId) throw new Error("Sign-in failed (unexpected client id)");
  return { code, clientId: pending.clientId };
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly expires_in?: unknown;
  readonly error?: unknown;
}

/**
 * Identity claims from an ID token received directly from the token endpoint over TLS
 * (OIDC Core 3.1.3.7 lets TLS stand in for the signature check); issuer, audience, expiry and
 * nonce are still verified.
 */
export function claimsOf(idToken: string, clientId: string, now: number, nonce?: string): { email: string; sub: string } {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("Sign-in failed (malformed ID token)");
  const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const utf8 = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))); // non-ASCII emails
  const json = JSON.parse(utf8) as Record<string, unknown>;
  const audience = Array.isArray(json.aud) ? json.aud : [json.aud];
  if (json.iss !== ISSUER) throw new Error("Sign-in failed (unexpected issuer)");
  if (!audience.includes(clientId)) throw new Error("Sign-in failed (unexpected audience)");
  if (typeof json.exp !== "number" || json.exp * 1000 <= now) throw new Error("Sign-in failed (expired ID token)");
  if (nonce !== undefined && json.nonce !== nonce) throw new Error("Sign-in failed (nonce mismatch)");
  if (typeof json.sub !== "string") throw new Error("Sign-in failed (no subject)");
  return { email: typeof json.email === "string" ? json.email : "", sub: json.sub };
}

async function postToken(form: Record<string, string>, fetchFn: typeof fetch): Promise<TokenResponse & { status: number }> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "error",
  });
  let data: TokenResponse = {};
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    // Non-JSON error page; handled by the status check below.
  }
  return { ...data, status: res.status };
}

function credentialFrom(data: TokenResponse, clientId: string, now: number, identity: { email: string; sub: string }, previousRefresh?: string): ChatgptCredential {
  if (typeof data.access_token !== "string") throw new Error("Sign-in failed (no access token)");
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : previousRefresh;
  if (!refresh) throw new Error("Sign-in failed (no refresh token)");
  const seconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return { clientId, accessToken: data.access_token, refreshToken: refresh, expiresAt: now + seconds * 1000, ...identity };
}

/** Exchanges the authorization code for tokens and checks the identity they belong to. */
export async function exchangeCode(
  code: string,
  clientId: string,
  pending: PendingSignIn,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<ChatgptCredential> {
  const data = await postToken(
    { grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE },
    fetchFn,
  );
  if (data.status !== 200) throw new Error(`Sign-in failed (HTTP ${data.status})`);
  if (typeof data.id_token !== "string") throw new Error("Sign-in failed (no ID token)");
  return credentialFrom(data, clientId, now, claimsOf(data.id_token, clientId, now, pending.nonce));
}

/**
 * Rotates the tokens. A rejected refresh token means the user disconnected: SignedOutError.
 * Identity is kept from the existing credential: once the server has rotated the refresh token,
 * failing on a claim check would throw away the only token that still works.
 */
export async function refreshCredential(cred: ChatgptCredential, fetchFn: typeof fetch = fetch, now: number = Date.now()): Promise<ChatgptCredential> {
  const data = await postToken(
    { grant_type: "refresh_token", client_id: cred.clientId, refresh_token: cred.refreshToken, resource: RESOURCE },
    fetchFn,
  );
  if (data.error === "invalid_grant" || data.status === 401) throw new SignedOutError();
  if (data.status !== 200) throw new Error(`Token refresh failed (HTTP ${data.status})`);
  return credentialFrom(data, cred.clientId, now, { email: cred.email, sub: cred.sub }, cred.refreshToken);
}

export const needsRefresh = (cred: ChatgptCredential, now: number = Date.now()) => cred.expiresAt - EXPIRY_MARGIN_MS <= now;

// ---- Storage --------------------------------------------------------------------------------

const credentialKey = (providerId: string) => `oauth:${providerId}`;
const HOST_ID_KEY = "chatgptHostId";

function isCredential(v: unknown): v is ChatgptCredential {
  const c = v as Record<string, unknown> | null;
  return (
    typeof c === "object" && c !== null &&
    ["clientId", "accessToken", "refreshToken", "email", "sub"].every((k) => typeof c[k] === "string") &&
    typeof c.expiresAt === "number"
  );
}

export async function loadCredential(providerId: string): Promise<ChatgptCredential | undefined> {
  const stored = (await chrome.storage.local.get(credentialKey(providerId)))[credentialKey(providerId)];
  return isCredential(stored) ? stored : undefined;
}

export async function saveCredential(providerId: string, cred: ChatgptCredential): Promise<void> {
  await chrome.storage.local.set({ [credentialKey(providerId)]: cred });
}

export async function deleteCredential(providerId: string): Promise<void> {
  await chrome.storage.local.remove(credentialKey(providerId));
}

/** Removes credentials of services that no longer exist. */
export async function pruneCredentials(keepProviderIds: readonly string[]): Promise<void> {
  const keep = new Set(keepProviderIds.map(credentialKey));
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith("oauth:") && !keep.has(k));
  if (stale.length > 0) await chrome.storage.local.remove(stale);
}

/**
 * A stable random id for this browser profile ("ext_agent_host_id": one per host). OpenAI rejects
 * the authorize request (invalid_authorize_request) unless it is a URN UUID; a bare UUID stored by
 * earlier builds never registered anything, so it is simply replaced.
 */
export async function hostId(): Promise<string> {
  const stored = (await chrome.storage.local.get(HOST_ID_KEY))[HOST_ID_KEY];
  if (typeof stored === "string" && stored.startsWith("urn:uuid:")) return stored;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [HOST_ID_KEY]: id });
  return id;
}
