/**
 * Who may do what. The whole policy is the three tables in this file and nothing else: no route
 * checks a role by name. `ROLE_PERMISSIONS` says what each role holds, `ROUTE_POLICY` says what each
 * route needs, and `authorize` (middleware) joins them. The dashboard is sent the same lists, so
 * what its menus hide and what the server refuses cannot drift apart.
 *
 * A route that is not in `ROUTE_POLICY` is refused for everyone: a new endpoint is closed until
 * someone decides who may use it (a test fails until they do).
 */

export const ROLES = ['owner', 'manager', 'operations', 'agent', 'accountant'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value);

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  operations: 'Operations',
  agent: 'Confirmation agent',
  accountant: 'Accountant',
};

export const PERMISSIONS = [
  // Looking
  'dashboard.read',
  'orders.read',
  'parcels.read',
  'returns.read',
  'reconciliation.read',
  'stock.read',
  'purchasing.read',
  'partners.read',
  'pr.read',
  'accounting.read',
  'reports.read',
  'integrations.read',
  // Doing
  'confirmations.work',
  'orders.import',
  'returns.checkin',
  'reconciliation.work',
  'stock.adjust',
  'purchasing.write',
  'partners.write',
  'pr.write',
  'accounting.close',
  // Running the system
  'settings.manage',
  'users.manage',
  // Seeing customers' phone numbers (and the links built from them)
  'pii.phone',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const without = (all: readonly Permission[], ...removed: Permission[]): Permission[] => all.filter((p) => !removed.includes(p));

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: without(PERMISSIONS, 'users.manage'),
  operations: [
    'dashboard.read',
    'orders.read',
    'confirmations.work',
    'parcels.read',
    'returns.read',
    'returns.checkin',
    'reconciliation.read',
    'reconciliation.work',
    'stock.read',
    'stock.adjust',
    'purchasing.read',
    'purchasing.write',
    'partners.read',
    'partners.write',
    'pr.read',
    'pr.write',
    'integrations.read',
    'pii.phone',
  ],
  // Works the phones: the confirmation desk, and the phone numbers it needs.
  agent: ['orders.read', 'confirmations.work', 'pii.phone'],
  // Reads the books and closes months. Never sees a customer's phone number.
  accountant: ['dashboard.read', 'reconciliation.read', 'purchasing.read', 'partners.read', 'accounting.read', 'accounting.close', 'reports.read'],
};

export const permissionsOf = (role: Role): readonly Permission[] => ROLE_PERMISSIONS[role];
export const can = (role: Role, permission: Permission): boolean => ROLE_PERMISSIONS[role].includes(permission);
export const canAny = (role: Role, needed: readonly Permission[]): boolean => needed.some((p) => can(role, p));

/** Switched off for now: sign-in is email and password only. Flip to true to bring the authenticator step back. */
export const SECOND_FACTOR_ENFORCED = false;

/** Roles that must sign in with a second factor. */
export const ROLES_REQUIRING_TOTP: readonly Role[] = SECOND_FACTOR_ENFORCED ? ['owner', 'manager'] : [];

// ---- Routes ----

type Needs = Permission | readonly Permission[];

interface Rule {
  /** Matched against the path under `/api/v1`, first match wins. */
  path: RegExp;
  /** Needed for GET and HEAD. Omitted: reading is not offered here. */
  read?: Needs;
  /** Needed for everything else. Omitted: writing is not offered here. */
  write?: Needs;
}

export const ROUTE_POLICY: readonly Rule[] = [
  // Account and user management
  { path: /^\/users(\/|$)/, read: 'users.manage', write: 'users.manage' },

  // The dashboard's headline reads, ahead of the broader rules they would otherwise fall under.
  { path: /^\/reports\/(dashboard|return-rate|funnel)$/, read: 'dashboard.read' },
  { path: /^\/reports\/breakdowns\/month$/, read: 'dashboard.read' },
  { path: /^\/reconciliation\/summary$/, read: ['reconciliation.read', 'dashboard.read'] },
  { path: /^\/stock\/returns-awaiting$/, read: ['returns.read', 'dashboard.read'] },
  { path: /^\/integrations\/status$/, read: ['integrations.read', 'dashboard.read'] },

  { path: /^\/integrations\//, read: 'integrations.read' },
  { path: /^\/reconciliation\//, read: 'reconciliation.read', write: 'reconciliation.work' },

  { path: /^\/stock\/returns\//, write: 'returns.checkin' },
  { path: /^\/stock\/(adjustments|opening-from-shopify)$/, write: 'stock.adjust' },
  { path: /^\/stock\//, read: 'stock.read' },

  { path: /^\/settings\/matching$/, read: ['settings.manage', 'reconciliation.read'], write: 'settings.manage' },
  { path: /^\/settings\//, read: 'settings.manage', write: 'settings.manage' },

  { path: /^\/accounting\/periods\/\d+\/\d+\/close$/, write: 'accounting.close' },
  { path: /^\/accounting\/opening-balances$/, read: 'accounting.read', write: 'accounting.close' },
  { path: /^\/accounting\//, read: 'accounting.read' },

  { path: /^\/confirmations\//, read: 'confirmations.work', write: 'confirmations.work' },
  { path: /^\/(influencers|pr)(\/|$)/, read: 'pr.read', write: 'pr.write' },
  { path: /^\/reports\//, read: 'reports.read' },
  { path: /^\/purchasing\//, read: 'purchasing.read', write: 'purchasing.write' },
  { path: /^\/consignment\//, read: 'partners.read', write: 'partners.write' },
  { path: /^\/orders\/imports?(\/|$)/, read: 'orders.import', write: 'orders.import' },
  { path: /^\/orders(\/|$)/, read: 'orders.read' },
  { path: /^\/parcels(\/|$)/, read: 'parcels.read' },
];

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * What a request needs, as a list where any one is enough; `[]` for a route the policy does not
 * mention, or one that is not offered for that method (refused for everyone).
 */
export const permissionsFor = (method: string, path: string): readonly Permission[] | undefined => {
  const rule = ROUTE_POLICY.find((r) => r.path.test(path));
  if (!rule) return undefined;
  const needs = READ_METHODS.has(method.toUpperCase()) ? rule.read : rule.write;
  if (!needs) return undefined;
  return typeof needs === 'string' ? [needs] : needs;
};

// ---- Personal data ----

/**
 * Keys that carry a customer's phone number, or a link made from one. Stripped from every
 * response for a role without `pii.phone`, wherever they appear in it.
 */
export const PHONE_FIELDS: ReadonlySet<string> = new Set(['phone', 'customerPhone', 'whatsappUrl', 'callUrl', 'whatsapp']);

/** A copy of a response with every phone field set to null, however deep. Other values are untouched. */
export const stripPhones = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(stripPhones) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, PHONE_FIELDS.has(k) && v !== undefined ? null : stripPhones(v)])) as T;
  }
  return value;
};
