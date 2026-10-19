/** Types for the canonical Codex sign-in store (codex_auth_file_store.mjs, copied from codex-auth-maker). */
import type { CredentialStore } from '@earendil-works/pi-ai';

export declare const CODEX_PROVIDER_ID: 'openai-codex';
export declare const APP_REFRESH_OWNER: 'pi-ai';
export declare function codexAuthRequired(message: string): Error & { code: 'auth_required' };
export declare class CodexAuthFileStore implements CredentialStore {
  constructor(authFilePath: string);
  readonly authFilePath: string;
  borrowedRefreshAttempted: boolean;
  isBorrowed(): Promise<boolean>;
  read(providerId: string): Promise<{ type: 'oauth'; access: string; refresh: string; expires: number; accountId: string } | undefined>;
  list(): Promise<{ providerId: string; type: 'oauth' }[]>;
  modify: CredentialStore['modify'];
  delete(): Promise<never>;
}
