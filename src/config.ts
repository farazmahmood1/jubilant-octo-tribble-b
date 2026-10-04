import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Treats empty strings as "not set", which is what a blank line in .env means. */
const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// backend/.env wins; the repo-root .env (used by the spike scripts) fills in anything missing,
// so credentials only ever live in one place. A key present but blank does not count as set,
// otherwise `FOO=` copied from .env.example would hide a real value in the file below.
for (const file of [resolve(projectRoot, '.env'), resolve(projectRoot, '..', '.env')]) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(dotenv.parse(readFileSync(file)))) {
    if (clean(value) && !clean(process.env[key])) process.env[key] = value;
  }
}

// A blank line in .env (FOO=) means "not set", so it must not override a default.
const env: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).map(([key, value]) => [key, clean(value)]),
);
// Windows env lookups are case-insensitive, Linux ones are not; accept either spelling.
env.DATABASE_URL = env.DATABASE_URL ?? env.database_url;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
  DATABASE_URL: z.string().min(1).optional(),
  // On by default so a fresh deploy creates its tables; off to start against a database whose
  // migrations are applied by hand.
  DB_MIGRATE_ON_BOOT: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() !== 'false'),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),
  // Temporary single-user sign-in. Replaced by real accounts (users table, argon2 hashes, roles)
  // once the schema exists.
  AUTH_EMAIL: z.string().default('owner@nurorganics.pk'),
  AUTH_PASSWORD: z.string().default('change-me'),
  AUTH_SECRET: z.string().optional(),
  AUTH_SESSION_HOURS: z.coerce.number().int().positive().default(12),
  // The one write to Shopify the plan allows: the confirmation tag, set when the desk records a call.
  // Off unless this is true, and it needs the write_orders scope on the Shopify app.
  SHOPIFY_WRITE_CONFIRMATION_TAGS: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() === 'true'),
  POSTEX_ALLOW_WRITES: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() === 'true'),
});

const parsed = schema.safeParse(env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}
const values = parsed.data;

export interface ShopifyStoreConfig {
  /** Stable key used in the database and in URLs. */
  key: string;
  label: string;
  /** The part before .myshopify.com */
  shop: string;
  clientId?: string;
  clientSecret?: string;
  /** Only for an older admin-created custom app. */
  accessToken?: string;
}

export interface PostexAccountConfig {
  key: string;
  label: string;
  token: string;
}

const shopifyStore = (
  key: string,
  label: string,
  prefix: string,
  fallbackShop?: string,
): ShopifyStoreConfig | undefined => {
  const shop = clean(env[`${prefix}SHOP`])?.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '') ?? fallbackShop;
  if (!shop) return undefined;
  const store: ShopifyStoreConfig = { key, label, shop };
  const clientId = clean(env[`${prefix}CLIENT_ID`]);
  const clientSecret = clean(env[`${prefix}CLIENT_SECRET`]);
  const accessToken = clean(env[`${prefix}ACCESS_TOKEN`]);
  if (clientId) store.clientId = clientId;
  if (clientSecret) store.clientSecret = clientSecret;
  if (accessToken) store.accessToken = accessToken;
  return store;
};

/** Accepts either the explicit per-brand variable names or the shorter original ones. */
const postexAccount = (key: string, label: string, variables: string[]): PostexAccountConfig | undefined => {
  const token = variables.map((name) => clean(env[name])).find(Boolean);
  return token ? { key, label, token } : undefined;
};

/** A store counts as usable once it has either a static token or a client ID + secret pair. */
export const isShopifyStoreReady = (store: ShopifyStoreConfig): boolean =>
  Boolean(store.accessToken ?? (store.clientId && store.clientSecret));

export const config = {
  auth: {
    email: values.AUTH_EMAIL.toLowerCase(),
    password: values.AUTH_PASSWORD,
    // Without a fixed secret, sessions simply end when the server restarts.
    secret: values.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    // Also keys the sealing of authenticator secrets: without a fixed one they cannot be read again after a restart.
    secretIsFixed: Boolean(values.AUTH_SECRET),
    sessionHours: values.AUTH_SESSION_HOURS,
    usingDefaults: !clean(env.AUTH_EMAIL) || !clean(env.AUTH_PASSWORD),
  },
  env: values.NODE_ENV,
  isProduction: values.NODE_ENV === 'production',
  port: values.PORT,
  logLevel: values.LOG_LEVEL,
  corsOrigin: values.CORS_ORIGIN === '*' ? '*' : values.CORS_ORIGIN.split(',').map((o) => o.trim()),
  databaseUrl: values.DATABASE_URL,
  migrateOnBoot: values.DB_MIGRATE_ON_BOOT,
  shopify: {
    apiVersion: values.SHOPIFY_API_VERSION,
    writeConfirmationTags: values.SHOPIFY_WRITE_CONFIRMATION_TAGS,
    stores: [
      shopifyStore('nur', 'NUR by Juggun', 'SHOPIFY_'),
      shopifyStore('organics', "Juggun's Organics", 'SHOPIFY_ORGANICS_'),
    ].filter((s): s is ShopifyStoreConfig => Boolean(s)),
  },
  postex: {
    allowWrites: values.POSTEX_ALLOW_WRITES,
    accounts: [
      postexAccount('nur', 'NUR by Juggun', ['POSTEX_NUR_BY_JUGGUN_TOKEN', 'POSTEX_TOKEN']),
      postexAccount('organics', "Juggun's Organics", ['POSTEX_JUGGUNS_ORGANICS_TOKEN', 'POSTEX_ORGANICS_TOKEN']),
    ].filter((a): a is PostexAccountConfig => Boolean(a)),
  },
} as const;

// PostEx has no sandbox, so a stray write hits real parcels and real money. Writes stay off
// outside production, whatever the .env says.
if (config.postex.allowWrites && !config.isProduction) {
  throw new Error('POSTEX_ALLOW_WRITES cannot be true outside production: PostEx has no test environment.');
}

// Default credentials are a development convenience and must never ship.
if (config.isProduction && (config.auth.usingDefaults || !values.AUTH_SECRET)) {
  throw new Error('Production requires AUTH_EMAIL, AUTH_PASSWORD and AUTH_SECRET to be set.');
}

export type Config = typeof config;
