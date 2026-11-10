import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

/** LocalSystem. */
const SYSTEM_SID = "S-1-5-18";
/** Built-in Administrators. Local administrators can read files by taking ownership; this matches root on Unix. */
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** File content read, plus the generic masks that include it. Checked without 32-bit bitwise coercion. */
const READ_BITS = [0x1, 0x10000000, 0x80000000];
/**
 * Specific rights that do not reveal file bytes, plus generic execute/write and the SACL bit.
 * Any other bit is unexpected and fails closed.
 */
const NON_READ_BITS = [
  0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100,
  0x10000, 0x20000, 0x40000, 0x80000, 0x100000,
  0x01000000, 0x20000000, 0x40000000,
];

export class KeyFileAccessError extends Error {
  constructor(readonly reason: "wide" | "unverified") {
    super(
      reason === "wide"
        ? "The assertion signing key file is too widely readable."
        : "The assertion signing key file permissions could not be verified.",
    );
    this.name = "KeyFileAccessError";
  }
}

export interface AclAce {
  sid: string | null;
  rights: number;
  type: string;
  /** Present so an inherited grant cannot be dropped before the SID rule runs. */
  inherited: boolean;
}

export interface AclReport {
  userSid: string;
  access: AclAce[];
}

/**
 * Accepts file-content read only for the current account, SYSTEM, and Administrators.
 * Inherited ACEs use the same rule. An empty list, an untranslated identity, a right this
 * checker does not recognize, or an ACE type other than Allow or Deny fails closed.
 * A Deny ACE never grants access and cannot hide an Allow.
 */
export function assessKeyFileAcl(report: AclReport | null): "ok" | "wide" | "unverified" {
  if (!report || !/^S-1-\d+(-\d+)+$/.test(report.userSid) || report.access.length === 0) return "unverified";
  const trusted = new Set([report.userSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  let currentUserCanRead = false;
  for (const ace of report.access) {
    if (ace.inherited !== true && ace.inherited !== false) return "unverified";
    if (ace.type !== "Allow" && ace.type !== "Deny") return "unverified";
    const rights = classifyRights(ace.rights);
    if (rights === "unexpected") return "unverified";
    if (ace.type === "Deny" || rights === "none") continue;
    if (ace.sid === null || !trusted.has(ace.sid)) return "wide";
    if (ace.sid === report.userSid) currentUserCanRead = true;
  }
  return currentUserCanRead ? "ok" : "wide";
}

/** The path is an environment value, never a PowerShell argument or an expanded script string. */
export function windowsAclInvocation(filePath: string, systemRoot: string): {
  executable: string;
  args: readonly string[];
  env: Record<string, string>;
} {
  return {
    executable: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ACL_SCRIPT],
    env: { SystemRoot: systemRoot, NYUMA_KEY_FILE: filePath },
  };
}

/** A symlink is rejected even when `lstat` also reports it as a file. Other non-files are rejected too. */
export function fileKindRejected(info: { isSymbolicLink(): boolean; isFile(): boolean }): boolean {
  return info.isSymbolicLink() || !info.isFile();
}

export function assertKeyFileRestricted(filePath: string): void {
  const info = lstatSync(filePath);
  if (fileKindRejected(info)) throw new KeyFileAccessError("unverified");
  if (process.platform === "win32") {
    assertWindowsAcl(filePath);
    return;
  }
  if ((info.mode & 0o077) !== 0) throw new KeyFileAccessError("wide");
}

export function parseAclReport(stdout: string): AclReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { userSid?: unknown; access?: unknown };
  if (typeof record.userSid !== "string") return null;
  const rows = Array.isArray(record.access)
    ? record.access
    : record.access && typeof record.access === "object"
      ? [record.access]
      : null;
  if (!rows) return null;
  const access: AclAce[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const ace = row as { sid?: unknown; rights?: unknown; type?: unknown; inherited?: unknown };
    if (ace.sid !== null && typeof ace.sid !== "string") return null;
    if (typeof ace.rights !== "number" || typeof ace.type !== "string" || typeof ace.inherited !== "boolean") return null;
    access.push({ sid: ace.sid, rights: ace.rights, type: ace.type, inherited: ace.inherited });
  }
  return { userSid: record.userSid, access };
}

function assertWindowsAcl(filePath: string): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new KeyFileAccessError("unverified");
  const invocation = windowsAclInvocation(filePath, systemRoot);
  let stdout = "";
  try {
    stdout = execFileSync(invocation.executable, [...invocation.args], {
      env: invocation.env,
      windowsHide: true,
      timeout: 15_000,
      encoding: "utf8",
    });
  } catch {
    throw new KeyFileAccessError("unverified");
  }
  const decision = assessKeyFileAcl(parseAclReport(stdout));
  if (decision === "ok") return;
  throw new KeyFileAccessError(decision === "wide" ? "wide" : "unverified");
}

function classifyRights(rights: number): "read" | "none" | "unexpected" {
  if (!Number.isInteger(rights) || rights < 0 || rights > 0xffffffff) return "unexpected";
  let remaining = rights;
  let reads = false;
  for (const bit of READ_BITS) {
    if (bitIsSet(remaining, bit)) {
      reads = true;
      remaining -= bit;
    }
  }
  for (const bit of NON_READ_BITS) {
    if (bitIsSet(remaining, bit)) remaining -= bit;
  }
  if (remaining !== 0) return "unexpected";
  return reads ? "read" : "none";
}

function bitIsSet(value: number, bit: number): boolean {
  return Math.floor(value / bit) % 2 === 1;
}

const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:NYUMA_KEY_FILE
if ([string]::IsNullOrWhiteSpace($path)) { throw 'missing path' }
$item = Get-Item -LiteralPath $path -Force
if ([int]$item.Attributes -band [int][IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
$acl = Get-Acl -LiteralPath $path
$userSid = [string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$access = @($acl.Access | ForEach-Object {
  $sid = $null
  try { $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $null }
  [PSCustomObject]@{
    sid = $sid
    rights = [int]$_.FileSystemRights
    type = [string]$_.AccessControlType
    inherited = [bool]$_.IsInherited
  }
})
@{ userSid = $userSid; access = $access } | ConvertTo-Json -Compress -Depth 4
`.trim();
