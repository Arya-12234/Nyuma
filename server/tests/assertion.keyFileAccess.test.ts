import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertKeyFileRestricted,
  assessKeyFileAcl,
  fileKindRejected,
  parseAclReport,
  windowsAclInvocation,
  type AclReport,
} from "../src/assertion/keyFileAccess.js";

const user = "S-1-5-21-1-2-3-1000";
const system = "S-1-5-18";
const administrators = "S-1-5-32-544";
const fullControl = 2032127;
const secretText = "not-the-real-signing-key-material";

describe("HMAC key file ACL", () => {
  it("accepts only the current account, SYSTEM, and Administrators, including inherited grants", () => {
    expect(assessKeyFileAcl(report([
      allow(system, fullControl, true),
      allow(administrators, fullControl, true),
      allow(user, fullControl, true),
    ]))).toBe("ok");
    expect(assessKeyFileAcl(report([allow(user, 0x1, false)]))).toBe("ok");
  });

  it("rejects other readers whether the grant is explicit or inherited", () => {
    const readers = ["S-1-1-0", "S-1-5-11", "S-1-5-4", "S-1-5-32-545", "S-1-5-21-9-9-9-1001", "Everyone"];
    for (const sid of readers) {
      expect(assessKeyFileAcl(report([allow(user, fullControl, true), allow(sid, 0x1, true)]))).toBe("wide");
      expect(assessKeyFileAcl(report([allow(user, fullControl, false), allow(sid, 0x1, false)]))).toBe("wide");
    }
    expect(assessKeyFileAcl(report([
      allow(user, fullControl, false),
      { sid: null, rights: 0x1, type: "Allow", inherited: true },
    ]))).toBe("wide");
    expect(assessKeyFileAcl(report([allow(system, fullControl, true), allow(administrators, fullControl, true)]))).toBe("wide");
  });

  it("fails closed on an empty ACL, a missing report, and an entry the checker cannot classify", () => {
    expect(assessKeyFileAcl(report([]))).toBe("unverified");
    expect(assessKeyFileAcl(null)).toBe("unverified");
    expect(assessKeyFileAcl({ userSid: "not-a-sid", access: [allow(user, fullControl, false)] })).toBe("unverified");
    expect(assessKeyFileAcl(report([{ sid: user, rights: 1.5, type: "Allow", inherited: false }]))).toBe("unverified");
    expect(assessKeyFileAcl(report([{ sid: user, rights: -1, type: "Allow", inherited: false }]))).toBe("unverified");
    expect(assessKeyFileAcl(report([allow(user, fullControl, false), allow(user, 0x02000000, false)]))).toBe("unverified");
    expect(assessKeyFileAcl(report([{ sid: user, rights: fullControl, type: "Audit", inherited: false }]))).toBe("unverified");
    expect(assessKeyFileAcl(report([{ sid: user, rights: fullControl, type: "allow", inherited: false }]))).toBe("unverified");
    expect(assessKeyFileAcl(report([{ sid: user, rights: fullControl, type: "Allow", inherited: "yes" as unknown as boolean }]))).toBe("unverified");
    expect(parseAclReport("not-json")).toBeNull();
    expect(parseAclReport('{"userSid":"S-1-5-21-1-2-3-1000","access":null}')).toBeNull();
    expect(parseAclReport('{"userSid":"S-1-5-21-1-2-3-1000"}')).toBeNull();
    expect(parseAclReport('{"userSid":"S-1-5-21-1-2-3-1000","access":[{"sid":"S-1-5-21-1-2-3-1000","rights":"1","type":"Allow","inherited":false}]}')).toBeNull();
  });

  it("does not let a deny entry or a non-read right hide another reader or grant access", () => {
    expect(assessKeyFileAcl(report([
      allow(user, fullControl, false),
      { sid: "S-1-1-0", rights: fullControl, type: "Deny", inherited: false },
      allow("S-1-1-0", 0x100000, true),
    ]))).toBe("ok");
    expect(assessKeyFileAcl(report([
      { sid: "S-1-1-0", rights: fullControl, type: "Deny", inherited: false },
      allow("S-1-1-0", 0x1, false),
      allow(user, fullControl, false),
    ]))).toBe("wide");
    expect(assessKeyFileAcl(report([
      { sid: user, rights: fullControl, type: "Deny", inherited: false },
    ]))).toBe("wide");
    expect(assessKeyFileAcl(report([
      { sid: "S-1-1-0", rights: 0x02000000, type: "Deny", inherited: true },
      allow(user, fullControl, false),
    ]))).toBe("unverified");
    expect(assessKeyFileAcl(report([
      allow(user, 0x80000000, false),
      allow("S-1-1-0", 0x10000000, false),
    ]))).toBe("wide");
  });

  it("reads one ACE object and rejects an entry that omits the inherited flag", () => {
    const parsed = parseAclReport(`\uFEFF{"userSid":"${user}","access":{"sid":"${user}","rights":1,"type":"Allow","inherited":false}}`);
    expect(assessKeyFileAcl(parsed)).toBe("ok");
    expect(parseAclReport(`{"userSid":"${user}","access":{"sid":"${user}","rights":1,"type":"Allow"}}`)).toBeNull();
  });

  it("passes the file path only as an environment value", () => {
    const filePath = "C:\\keys\\key $(Remove-Item *); & calc.txt";
    const invocation = windowsAclInvocation(filePath, "C:\\Windows");
    expect(invocation.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      invocation.args[5],
    ]);
    expect(invocation.args.join("\n")).not.toContain(filePath);
    expect(invocation.args[5]).toContain("$env:NYUMA_KEY_FILE");
    expect(invocation.args[5]).toContain("-LiteralPath $path");
    expect(invocation.args[5]).not.toContain("Invoke-Expression");
    expect(invocation.env).toEqual({ SystemRoot: "C:\\Windows", NYUMA_KEY_FILE: filePath });
  });

  it("rejects a symlink, a directory, and a junction before the key is accepted", () => {
    expect(fileKindRejected({ isSymbolicLink: () => true, isFile: () => false })).toBe(true);
    expect(fileKindRejected({ isSymbolicLink: () => true, isFile: () => true })).toBe(true);
    expect(fileKindRejected({ isSymbolicLink: () => false, isFile: () => false })).toBe(true);
    expect(fileKindRejected({ isSymbolicLink: () => false, isFile: () => true })).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), "nyuma-acl-"));
    try {
      const keyFile = join(directory, "key.txt");
      writeFileSync(keyFile, secretText);
      expect(() => assertKeyFileRestricted(directory)).toThrow(/could not be verified/);
      const target = join(directory, "target");
      mkdirSync(target);
      const junction = join(directory, "junction");
      symlinkSync(target, junction, "junction");
      expect(() => assertKeyFileRestricted(junction)).toThrow(/could not be verified/);
      const link = join(directory, "link.txt");
      try {
        symlinkSync(keyFile, link, "file");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM") return;
        throw error;
      }
      expect(() => assertKeyFileRestricted(link)).toThrow(/could not be verified/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function report(access: AclReport["access"]): AclReport {
  return { userSid: user, access };
}

function allow(sid: string, rights: number, inherited: boolean): AclReport["access"][number] {
  return { sid, rights, type: "Allow", inherited };
}
