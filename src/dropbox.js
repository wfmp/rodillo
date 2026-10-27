/* Dropbox upload with OAuth 2 PKCE (no client secret), refresh tokens and an offline retry queue. */
(function (root) {
  "use strict";

  const KEY = "rodillo.dropbox";
  const QUEUE_KEY = "rodillo.dropboxQueue";
  const VERIFIER_KEY = "rodillo.dropboxPkce";

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }
  function remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  const state = () => load(KEY, {});
  const redirectUri = () => location.origin + location.pathname;

  function base64Url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function isConnected() { return !!state().refreshToken; }
  function appKey() { return state().appKey || ""; }
  function setAppKey(key) { const s = state(); s.appKey = (key || "").trim(); save(KEY, s); }

  /** Start the OAuth flow: navigates away to Dropbox and comes back with ?code=. */
  async function connect(key) {
    if (key) setAppKey(key);
    const clientId = appKey();
    if (!clientId) throw new Error("Falta la App key de Dropbox");
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(12)));
    save(VERIFIER_KEY, { verifier, nonce });
    const params = new URLSearchParams({
      client_id: clientId, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      token_access_type: "offline", redirect_uri: redirectUri(), state: nonce,
    });
    location.href = "https://www.dropbox.com/oauth2/authorize?" + params;
  }

  /** Finish the OAuth flow if the page was opened by the Dropbox redirect. Returns true/false/null (not a redirect). */
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return null;
    const pkce = load(VERIFIER_KEY, null);
    history.replaceState(null, "", redirectUri());
    remove(VERIFIER_KEY);
    if (params.has("error")) throw new Error(params.get("error_description") || params.get("error"));
    if (!pkce || params.get("state") !== pkce.nonce) throw new Error("La respuesta de Dropbox no coincide; vuelve a conectar");
    const body = new URLSearchParams({
      code: params.get("code"), grant_type: "authorization_code", client_id: appKey(),
      code_verifier: pkce.verifier, redirect_uri: redirectUri(),
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.refresh_token) throw new Error(data.error_description || data.error || "HTTP " + res.status);
    const s = state();
    s.refreshToken = data.refresh_token;
    s.accessToken = data.access_token;
    s.expiresAt = Date.now() + (data.expires_in || 14400) * 1000 - 60000;
    s.accountId = data.account_id;
    save(KEY, s);
    return true;
  }

  function disconnect() {
    const s = state();
    if (s.accessToken) {
      fetch("https://api.dropboxapi.com/2/auth/token/revoke", { method: "POST", headers: { Authorization: "Bearer " + s.accessToken } }).catch(() => {});
    }
    save(KEY, { appKey: s.appKey });
  }

  async function accessToken() {
    const s = state();
    if (!s.refreshToken) throw new Error("Dropbox no está conectado");
    if (s.accessToken && Date.now() < s.expiresAt) return s.accessToken;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: s.appKey });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === "invalid_grant") { save(KEY, { appKey: s.appKey }); throw new Error("Dropbox desconectado: vuelve a conectar en Ajustes"); }
      throw new Error(data.error_description || data.error || "HTTP " + res.status);
    }
    s.accessToken = data.access_token;
    s.expiresAt = Date.now() + (data.expires_in || 14400) * 1000 - 60000;
    save(KEY, s);
    return s.accessToken;
  }

  /** Upload bytes to the app folder; returns the Dropbox path actually used (renamed if it already existed). */
  async function upload(fileName, bytes) {
    const token = await accessToken();
    const arg = JSON.stringify({ path: "/" + fileName, mode: "add", autorename: true, mute: true });
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": arg },
      body: bytes,
    });
    const text = await res.text();
    if (!res.ok) throw new Error("Dropbox " + res.status + ": " + text.slice(0, 160));
    return JSON.parse(text).path_display;
  }

  async function removeFile(path) {
    const token = await accessToken();
    const res = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error("Dropbox " + res.status);
  }

  // ---------- Offline queue ----------
  function enqueue(fileName, bytes) {
    const q = load(QUEUE_KEY, []).filter((x) => x.name !== fileName);
    q.push({ name: fileName, b64: bytesToBase64(bytes), at: Date.now() });
    save(QUEUE_KEY, q);
  }
  function dequeue(fileName) { save(QUEUE_KEY, load(QUEUE_KEY, []).filter((x) => x.name !== fileName)); }
  function pending() { return load(QUEUE_KEY, []).map((x) => x.name); }

  /** Upload, or keep the file queued for a later retry when it fails. */
  async function uploadOrQueue(fileName, bytes) {
    enqueue(fileName, bytes);
    const path = await upload(fileName, bytes);
    dequeue(fileName);
    return path;
  }

  /** Retry queued uploads; returns the number uploaded. */
  async function flushQueue() {
    if (!isConnected()) return 0;
    let done = 0;
    for (const item of load(QUEUE_KEY, [])) {
      try { await upload(item.name, base64ToBytes(item.b64)); dequeue(item.name); done++; } catch (e) { break; }
    }
    return done;
  }

  root.RodilloDropbox = {
    isConnected, appKey, setAppKey, connect, handleRedirect, disconnect,
    upload, uploadOrQueue, removeFile, flushQueue, pending, dequeue, redirectUri,
  };
})(typeof window !== "undefined" ? window : globalThis);
