export declare const DEFAULT_BASE_IMAGE: string;
export declare const IMAGE_REPO: string;
export declare const MIN_PI_VERSION: string;
export declare const DEFAULT_PIDS_LIMIT: number;
export declare const DEFAULT_PIDASH_HOST: string;
export declare const DEFAULT_PIDIFF_HOST: string;
export declare const VALID_PEER_CONTAINER_RE: RegExp;
export declare const DEFAULT_PASSTHROUGH_ENV_KEYS: string[];

export interface BuildPaths {
  lockPath: string;
  statusPath: string;
  logPath: string;
}

export interface TargetPeerImage {
  baseImage: string;
  piVersion: string;
  hash: string;
  tag: string;
  containerfilePath: string;
  installPyPath: string;
  installSourcesPath: string;
}

export interface PodmanRunArgsOptions {
  containerName?: string;
  imageTag: string;
  uid?: number;
  gid?: number;
  selinuxEnforcing?: boolean;
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  piConfigDir: string;
  agentDir: string;
  hostAuthJsonPath?: string | null;
  hostModelsJsonPath?: string | null;
  entrypointPath: string;
  gitconfigSeedPath: string;
  workspacePath: string;
  comsDir: string;
  cname: string;
  project: string;
  purpose?: string;
  session?: string;
  pidashHost?: string;
  pidiffHost?: string;
  pidashPort?: number;
  passthroughEnvKeys?: string[];
  env?: Record<string, string | undefined>;
}

export interface BuildStatusSnapshot {
  state: "idle" | "building" | "ready" | "error";
  targetTag: string | null;
  pid?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  logPath: string;
}

export interface BackgroundBuildResult {
  status: "ready" | "building" | "error";
  targetTag: string | null;
  logPath: string;
  pid?: number | null;
  error?: string;
}

export interface ResolveImageForSpawnResult {
  action: "run" | "building" | "error";
  imageTag: string | null;
  targetTag: string | null;
  usingFallback: boolean;
  logPath: string;
  pid?: number | null;
  error?: string;
}

export declare function clearCachedHostPiVersion(): void;
export declare function createPodmanLogger(logPath?: string): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  isDebugEnabled: () => boolean;
};

export declare function resolveDefaultBuildPaths(homeDir?: string): BuildPaths;
export declare function resolveSandboxBaseDir(homeDir?: string): string;
export declare function resolvePackageRoot(moduleUrl?: string): string;
export declare function isValidPeerContainerName(value: unknown): value is string;
export declare function validateBaseImage(baseImage: unknown): { ok: true; value: string } | { ok: false; error: string };
export declare function parseSemver(raw: unknown): { version: string; major: number; minor: number; patch: number } | null;
export declare function compareSemver(a: string, b: string): number | null;
export declare function detectHostPiVersion(opts?: { piVersion?: string; minVersion?: string; execFileSync?: (...args: any[]) => any }): string;
export declare function detectHostPiVersionAsync(opts?: { piVersion?: string; minVersion?: string; execFile?: (...args: any[]) => Promise<any> }): Promise<string>;
export declare function computePeerImageHash(inputs: {
  containerfileContent?: string;
  installPyContent?: string;
  installSourcesContent?: string;
  baseImage: string;
  piVersion: string;
}): string;
export declare function buildPeerImageTag(hash: string): string;
export declare function resolveTargetPeerImage(opts?: Record<string, any>): TargetPeerImage;
export declare function resolveTargetPeerImageAsync(opts?: Record<string, any>): Promise<TargetPeerImage>;
export declare function sanitizeContainerToken(value: unknown, maxLen?: number): string;
export declare function buildPeerContainerName(project: string, cname: string): string;
export declare function isSelinuxEnforcing(readFileFn?: (p: string, enc: BufferEncoding) => string): boolean;
export declare function rewriteRemoteToHttps(remoteUrl: unknown): string | null;
export declare function resolveHostGitIdentity(cwd: string, execFn?: (...args: any[]) => any): { name: string; email: string };
export declare function resolveHostOriginHttpsUrl(cwd: string, execFn?: (...args: any[]) => any): string | null;
export declare function prepareSandboxWorkspace(opts: {
  sandboxDir: string;
  sourceCwd: string;
  project: string;
  cname: string;
  execFileSync?: (...args: any[]) => any;
  logger?: ReturnType<typeof createPodmanLogger>;
}): { workspaceDir: string; cloned: boolean; revived: boolean };
export declare function buildPodmanRunArgs(opts: PodmanRunArgsOptions): string[];
export declare function isPidAlive(pid: unknown): boolean;
export declare function readBuildLock(lockPath: string): Record<string, any> | null;
export declare function isBuildLockActive(lockPath: string, pidAliveFn?: (pid: number) => boolean): { active: boolean; owner: Record<string, any> | null };
export declare function acquireBuildLock(
  lockPath: string,
  payload: Record<string, any>,
  pidAliveFn?: (pid: number) => boolean,
): { acquired: boolean; owner: Record<string, any> | null; release: () => void };
export declare function isPodmanAvailable(execFn?: (...args: any[]) => any): boolean;
export declare function isPodmanAvailableAsync(execFn?: (...args: any[]) => Promise<any>): Promise<boolean>;
export declare function podmanImageExists(imageTag: string, execFn?: (...args: any[]) => any): boolean;
export declare function podmanImageExistsAsync(imageTag: string, execFn?: (...args: any[]) => Promise<any>): Promise<boolean>;
export declare function listCachedPeerImageTags(opts?: { execFileSync?: (...args: any[]) => any }): string[];
export declare function listCachedPeerImageTagsAsync(opts?: { execFile?: (...args: any[]) => Promise<any> }): Promise<string[]>;
export declare function pruneStalePeerImages(keepTag: string, opts?: Record<string, any>): string[];
export declare function readBuildStatus(opts?: Record<string, any>): BuildStatusSnapshot;
export declare function startBackgroundPeerImageBuild(opts?: Record<string, any>): BackgroundBuildResult;
export declare function startBackgroundPeerImageBuildAsync(opts?: Record<string, any>): Promise<BackgroundBuildResult>;
export declare function resolveImageForSpawn(opts?: Record<string, any>): ResolveImageForSpawnResult;
export declare function resolveImageForSpawnAsync(opts?: Record<string, any>): Promise<ResolveImageForSpawnResult>;
export declare function runPeerImageBuildWorker(opts: Record<string, any>): { ok: boolean; skipped: boolean; targetTag: string; logPath: string; error?: string };
