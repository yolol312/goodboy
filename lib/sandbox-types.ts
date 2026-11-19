// The test sandbox (track M, M1; plan §19): the shapes shared by the scan (lib/sandbox-scan.ts),
// which reads a project, and the sandbox renderer, writer and runner (lib/sandbox-render.ts,
// lib/sandbox-files.ts, lib/sandbox-run.ts), which build the containers from it. The app and every test run on an internal network with no egress;
// external hosts resolve to dummies that record what the app sends.

export type SandboxStack = 'jvm' | 'node' | 'python';
export type StoreKind = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongo';
/** What an outbound host speaks, which decides its dummy: http → HTTP stubs (WireMock), smtp →
 *  mail sink (Mailpit), ldap → test directory (OpenLDAP); `other` has no dummy and is reported. */
export type OutboundKind = 'http' | 'smtp' | 'ldap' | 'other';

/** A place in the project: repo-relative path and 1-based line. */
export interface Where {
  file: string;
  line: number;
}

export interface SandboxBuild {
  /** gradle, maven, npm, pnpm, yarn, bun, pip, poetry, uv. */
  tool: string;
  /** The runtime version the project asks for (JDK `21`, Node `20`, Python `3.12`), or null. */
  runtimeVersion: string | null;
  /** Downloads dependencies into the caches (preparation step, network on). */
  depsCommand: string[];
  /** Builds the runnable app (preparation step). */
  buildCommand: string[];
  /** Runs the unit and integration tests offline (run step, no network). */
  testCommand: string[];
  /** Starts the built app inside its container. */
  startCommand: string[];
  /** Repo-relative build output the start command uses (a jar, `dist/`, …), or null. */
  artifact: string | null;
}

export interface SandboxApp {
  port: number;
  /** `/` or the servlet context path. */
  contextPath: string;
  /** A path that answers once the app is up (`/actuator/health`, `/`). */
  healthPath: string;
  /** Repo-relative config files the app loads (application*.yml, .env*, settings modules). */
  configFiles: string[];
}

export interface SandboxStore {
  kind: StoreKind;
  /** Image tag to run (from the driver, the config or a pinned default). */
  version: string;
  /** Database name the app uses, when the config names one. */
  database: string | null;
  /** Config keys that hold its address, credentials and name (keys only, never values). */
  configKeys: string[];
  where: Where;
}

export interface SandboxOutbound {
  /** Host name or IP literal as configured or written in code. */
  host: string;
  port: number | null;
  scheme: string | null;
  kind: OutboundKind;
  /** Where the host is configured or written. */
  where: Where;
  /** The call site that uses it (HTTP client, mail sender, LDAP context, SDK), or null when none
   *  was found: such a host is reported, not given a dummy. */
  callSite: Where | null;
  /** Written in code rather than config: the config override cannot move it. */
  hardcoded: boolean;
  /** An IP literal: it gets its dummy by address on an internal subnet, not by a DNS alias. */
  ipLiteral: boolean;
}

export interface SandboxScan {
  root: string;
  stack: SandboxStack;
  /** Frameworks seen (spring-boot, thymeleaf, jsp, express, next, react, fastapi, …). */
  frameworks: string[];
  build: SandboxBuild;
  app: SandboxApp;
  stores: SandboxStore[];
  outbound: SandboxOutbound[];
  /** Secret-looking config keys (names only). */
  secretKeys: string[];
  /** What the scan could not decide; the user answers these before `sandbox-init`. */
  questions: string[];
  /** Problems that stop a sandbox (no build tool found, an unsupported store, …). */
  problems: string[];
}

/** The local, untracked answers a sandbox needs (`.goodboy/sandbox/local.json`). */
export interface SandboxLocal {
  /** Absolute path of the database dump; mounted read-only, never copied into the repo. */
  dump: string | null;
  /** Dump format: `sql` (plain) or `custom` (pg_dump -Fc). */
  dumpFormat: 'sql' | 'custom' | null;
  /** The sandbox holds real data (M6a): set by `sandbox-local --dump`, kept when the dump is
   *  removed, cleared by `sandbox-down --volumes`. Absent means false. */
  realData?: boolean;
  /** Absolute paths of registered input logs (M6b, `sandbox-local --input`): files or dirs of production
   *  data the model must not read. Registering one puts the project in real-data mode. Absent means none. */
  inputs?: string[];
}

/** What `sandbox-run` checks before a suite runs; a test record carries it. */
export interface SandboxCheck {
  /** Every running sandbox container is on internal networks only. */
  inner_only: boolean;
  /** A probe on the internal network could neither resolve a public name nor reach a public IP. */
  egress_blocked: boolean;
  /** Each outbound host resolves to (or is routed to) its dummy inside the network. */
  hosts_to_dummies: boolean;
  /** What failed, with the command and its output. */
  problems: string[];
}
