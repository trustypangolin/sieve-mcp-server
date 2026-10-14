import type { TlsMode } from './protocol/client.js';

export type { TlsMode };

/** An account as used at runtime (credentials decrypted, env overrides applied). */
export interface SieveAccount {
  id: string;
  name: string;
  host: string;
  port: number;
  tls: TlsMode;
  user: string;
  /** Empty string means "supplied via environment variable". */
  password: string;
  /** Optional SASL authorization identity (act as another user, admin setups only). */
  authzid?: string;
  /** Skip certificate verification. Only for self-signed certs you trust. */
  allowInvalidCertificate?: boolean;
}

/** An account as safe to show: no password. */
export interface PublicAccount extends Omit<SieveAccount, 'password'> {
  passwordSource: 'stored' | 'environment' | 'missing';
}

export type AccountInput = Omit<SieveAccount, 'id'>;
