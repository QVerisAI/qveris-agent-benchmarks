import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalJsonEqual,
  hashCanonicalJson,
  hashLegacyJson,
  jsonHashMatches,
  loadEvidenceSigner,
  signEvidenceManifest,
  verifyEvidenceManifest,
} from "../src/integrity.mjs";

async function signingKey(dir, name) {
  const path = join(dir, name);
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

test("canonical JSON hashes ignore recursive object insertion order", () => {
  const first = { z: 1, a: { y: 2, x: 3 }, rows: [{ b: 2, a: 1 }] };
  const reordered = { rows: [{ a: 1, b: 2 }], a: { x: 3, y: 2 }, z: 1 };
  assert.equal(hashCanonicalJson(first), hashCanonicalJson(reordered));
  assert.equal(canonicalJsonEqual(first, reordered), true);
  assert.equal(canonicalJsonEqual(first, { ...reordered, z: 2 }), false);
  assert.equal(canonicalJsonEqual(undefined, undefined), true);
  assert.equal(canonicalJsonEqual(undefined, null), false);
  assert.equal(canonicalJsonEqual([1, 2], [2, 1]), false);
  assert.match(hashCanonicalJson(first), /^sha256jcs:[0-9a-f]{64}$/);
  assert.notEqual(hashCanonicalJson(first), hashCanonicalJson({ ...reordered, z: 2 }));
  assert.equal(jsonHashMatches(hashLegacyJson(first), first), true, "legacy evidence remains read-verifiable");
});

test("Ed25519 evidence signatures reject content and trust-anchor substitution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evidence-signing-"));
  const trusted = loadEvidenceSigner(await signingKey(dir, "trusted.pem"));
  const attacker = loadEvidenceSigner(await signingKey(dir, "attacker.pem"));
  const signed = signEvidenceManifest({ batch_id: "b1", completed_runs: [{ results_hash: "h1" }] }, trusted);

  assert.equal(verifyEvidenceManifest(signed, {
    expectedFingerprint: trusted.fingerprint,
    label: "test manifest",
  }), true);
  assert.throws(
    () => verifyEvidenceManifest({ ...signed, batch_id: "b2" }, {
      expectedFingerprint: trusted.fingerprint,
      label: "test manifest",
    }),
    /signature verification failed/,
  );
  assert.throws(
    () => verifyEvidenceManifest(signEvidenceManifest({ batch_id: "b1" }, attacker), {
      expectedFingerprint: trusted.fingerprint,
      label: "test manifest",
    }),
    /does not match the externally trusted key/,
  );
});

test("evidence signer rejects broad permissions and symlink key aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evidence-key-boundary-"));
  const keyPath = await signingKey(dir, "private.pem");
  await chmod(keyPath, 0o644);
  assert.throws(() => loadEvidenceSigner(keyPath), /permissions are too broad/);

  await chmod(keyPath, 0o600);
  const aliasPath = join(dir, "alias.pem");
  await symlink(keyPath, aliasPath);
  assert.throws(() => loadEvidenceSigner(aliasPath), /stable canonical regular file/);
});
