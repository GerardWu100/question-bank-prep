/**
 * pi-ai credential store backed by a Codex-format sign-in file (auth.json).
 *
 * This is the canonical copy. Every project that calls the ChatGPT (Codex)
 * subscription through pi-ai carries an identical copy, so all of them read,
 * lock and refresh one shared auth.json the same way.
 *
 * Who may refresh the file
 * ------------------------
 * OpenAI replaces the refresh token on every refresh, so exactly one party
 * may refresh one sign-in. The file itself says who that is:
 *
 * - "refresh_owner": "pi-ai" (written by login.mjs in codex-auth-maker):
 *   apps own the sign-in. Any app may refresh it, one at a time, under a
 *   cross-process lock beside the file (auth.json.lock).
 * - no marker (written by the Codex CLI, normally ~/.codex/auth.json):
 *   borrowed. The Codex CLI owns refresh; apps only read it. An expired
 *   borrowed token reports "auth_required" instead of refreshing.
 * - file missing: nothing to read; login.mjs may create it.
 *
 * File shape (Codex CLI compatible):
 *     {"auth_mode": "chatgpt", "OPENAI_API_KEY": null,
 *      "tokens": {"id_token"?, "access_token", "refresh_token", "account_id"},
 *      "last_refresh": ISO time, "refresh_owner"?: "pi-ai"}
 * pi-ai credential shape:
 *     {"type": "oauth", "access", "refresh", "expires": epoch ms, "accountId"}
 */

import { randomUUID } from "node:crypto";
import { chown, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export const CODEX_PROVIDER_ID = "openai-codex";
// Marker value that makes a sign-in file app-owned (refreshable by apps).
export const APP_REFRESH_OWNER = "pi-ai";
// Claim inside the access token that carries the ChatGPT account id.
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OWNER_READ_WRITE_MODE = 0o600;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const MILLISECONDS_PER_SECOND = 1000;
// Every app on the machine shares this lock. The heartbeat lets a later
// process recover after one died while holding it. Keep these values equal in
// every copy of this file, or two apps could refresh the same token at once.
const LOCK_OPTIONS = {
    realpath: false,
    stale: 10_000,
    retries: { retries: 30, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
};

/**
 * Decode the payload of a JSON Web Token (JWT) without verifying it.
 *
 * Only the expiry and account id are read; OpenAI verifies the token.
 */
function decodeTokenPayload(token) {
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("Invalid access token shape.");
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

/** Error whose message is safe to show: the sign-in must be renewed. */
export function codexAuthRequired(message) {
    return Object.assign(new Error(message), { code: "auth_required" });
}

/**
 * Credential store that reads and writes one Codex-format sign-in file.
 *
 * pi-ai refreshes an expired token inside ``modify``. The file is re-read
 * under the lock, so a refresh another process made in the meantime is used
 * rather than overwritten.
 */
export class CodexAuthFileStore {
    /**
     * @param {string} authFilePath Absolute path of auth.json.
     */
    constructor(authFilePath) {
        this.authFilePath = authFilePath;
        // Set when pi-ai tried to refresh a borrowed (read-only) sign-in.
        this.borrowedRefreshAttempted = false;
    }

    async readCodexFile() {
        try {
            return JSON.parse(await readFile(this.authFilePath, "utf8"));
        } catch (error) {
            if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    /**
     * True when apps must not refresh this file: it exists and the Codex CLI
     * (not codex-auth-maker) wrote it.
     */
    async isBorrowed() {
        const codexFile = await this.readCodexFile();
        return codexFile !== null && codexFile.refresh_owner !== APP_REFRESH_OWNER;
    }

    toCredential(codexFile) {
        const tokens = codexFile?.tokens;
        if ((codexFile?.auth_mode && codexFile.auth_mode !== "chatgpt") ||
            typeof tokens?.access_token !== "string" || !tokens.access_token.trim() ||
            typeof tokens?.refresh_token !== "string" || !tokens.refresh_token.trim()) {
            return undefined;
        }
        let payload;
        try {
            payload = decodeTokenPayload(tokens.access_token);
        } catch {
            return undefined;
        }
        const accountId = tokens.account_id || payload?.[OPENAI_AUTH_CLAIM]?.chatgpt_account_id;
        if (!Number.isFinite(payload?.exp) || typeof accountId !== "string" || !accountId.trim()) {
            return undefined;
        }
        return {
            type: "oauth",
            access: tokens.access_token,
            refresh: tokens.refresh_token,
            expires: payload.exp * MILLISECONDS_PER_SECOND,
            accountId,
        };
    }

    async read(providerId) {
        if (providerId !== CODEX_PROVIDER_ID) return undefined;
        return this.toCredential(await this.readCodexFile());
    }

    async list() {
        const credential = await this.read(CODEX_PROVIDER_ID);
        return credential ? [{ providerId: CODEX_PROVIDER_ID, type: "oauth" }] : [];
    }

    async modify(providerId, updateCredential) {
        if (providerId !== CODEX_PROVIDER_ID) {
            throw new Error("Unsupported credential provider.");
        }
        if (await this.isBorrowed()) {
            this.borrowedRefreshAttempted = true;
            throw codexAuthRequired("The Codex CLI owns this sign-in. Run `codex login`, or point the app at an auth.json made by codex-auth-maker.");
        }
        await mkdir(dirname(this.authFilePath), { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
        const release = await lockfile.lock(this.authFilePath, LOCK_OPTIONS);
        try {
            // Re-read under the lock: another process may have refreshed.
            const codexFile = await this.readCodexFile();
            const current = this.toCredential(codexFile);
            const updated = await updateCredential(current);
            if (!updated) return current;
            if (updated.access === current?.access && updated.refresh === current?.refresh &&
                updated.accountId === current?.accountId) return updated;

            const fileToWrite = {
                ...(codexFile && typeof codexFile === "object" && !Array.isArray(codexFile) ? codexFile : {}),
                auth_mode: "chatgpt",
                OPENAI_API_KEY: null,
                tokens: {
                    ...(current?.accountId === updated.accountId ? codexFile.tokens : {}),
                    access_token: updated.access,
                    refresh_token: updated.refresh,
                    account_id: updated.accountId,
                },
                last_refresh: new Date().toISOString(),
                refresh_owner: APP_REFRESH_OWNER,
            };
            await this.writeAtomically(fileToWrite);
            return updated;
        } finally {
            await release();
        }
    }

    /**
     * Replace the file in one step and keep its owner.
     *
     * Containers often run as root while the host user owns the file. Giving
     * the new file the old owner keeps it readable by the host user and by
     * apps that run as that user. chown needs CAP_CHOWN; without it the file
     * keeps this process's owner, which is still correct for a single user.
     */
    async writeAtomically(fileToWrite) {
        let previousOwner = null;
        try {
            const previous = await stat(this.authFilePath);
            previousOwner = { uid: previous.uid, gid: previous.gid };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const temporaryPath = `${this.authFilePath}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, JSON.stringify(fileToWrite, null, 2), {
                mode: OWNER_READ_WRITE_MODE, flag: "wx",
            });
            if (previousOwner) {
                await chown(temporaryPath, previousOwner.uid, previousOwner.gid).catch(() => {});
            }
            await rename(temporaryPath, this.authFilePath);
        } finally {
            await rm(temporaryPath, { force: true });
        }
    }

    async delete() {
        throw new Error("Refusing to delete the sign-in file.");
    }
}
