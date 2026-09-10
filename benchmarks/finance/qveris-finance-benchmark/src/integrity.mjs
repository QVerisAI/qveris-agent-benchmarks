import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";

export const CANONICAL_JSON_HASH_PREFIX = "sha256jcs";
export const EVIDENCE_SIGNATURE_ALGORITHM = "ed25519";

function jsonData(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("value is not JSON-serializable");
  }
  return JSON.parse(serialized);
}

function canonicalString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(",")}}`;
}

// RFC-8785-shaped canonical JSON for benchmark data: normalize through JSON
// first (honoring toJSON and JSON's undefined/number behavior), then sort all
// object keys recursively. Benchmark artifacts contain no non-finite numbers.
export function canonicalJsonStringify(value) {
  return canonicalString(jsonData(value));
}

export function canonicalJsonEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export function hashCanonicalJson(value) {
  const digest = createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
  return `${CANONICAL_JSON_HASH_PREFIX}:${digest}`;
}

// Read-only bridge for manifests created before the key-order-independent
// scheme. Never emit this digest for new evidence.
export function hashLegacyJson(value) {
  const digest = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
  return `sha256c:${digest}`;
}

export function jsonHashMatches(expected, value) {
  if (!expected) return false;
  if (String(expected).startsWith(`${CANONICAL_JSON_HASH_PREFIX}:`)) {
    return expected === hashCanonicalJson(value);
  }
  if (String(expected).startsWith("sha256c:")) {
    return expected === hashLegacyJson(value);
  }
  return false;
}

function unsignedManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("evidence manifest must be a JSON object");
  }
  const { evidence_signature: _ignored, ...unsigned } = value;
  return unsigned;
}

export function loadEvidenceSigner(privateKeyPath) {
  if (!privateKeyPath) return null;
  let fd;
  let keyBytes;
  let stat;
  try {
    const pathStat = lstatSync(privateKeyPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error("not a canonical regular file");
    }
    fd = openSync(privateKeyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    stat = fstatSync(fd);
    if (!stat.isFile()
      || pathStat.dev !== stat.dev
      || pathStat.ino !== stat.ino) {
      throw new Error("key identity changed before it was opened");
    }
    keyBytes = readFileSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(privateKeyPath);
    if (stat.dev !== after.dev
      || stat.ino !== after.ino
      || stat.size !== after.size
      || stat.mtimeMs !== after.mtimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino) {
      throw new Error("key changed while it was being loaded");
    }
  } catch (error) {
    throw new Error(`evidence signing key must be a stable canonical regular file: ${privateKeyPath} (${error.message})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`evidence signing key permissions are too broad: ${privateKeyPath}; require mode 0600 or stricter`);
  }
  const privateKey = createPrivateKey(keyBytes);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`evidence signing key must be Ed25519: ${privateKeyPath}`);
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const fingerprint = `sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  return {
    algorithm: EVIDENCE_SIGNATURE_ALGORITHM,
    fingerprint,
    private_key_path: realpathSync(privateKeyPath),
    public_key_spki: publicKeyDer.toString("base64"),
    sign(value) {
      return sign(null, Buffer.from(canonicalJsonStringify(unsignedManifest(value))), privateKey).toString("base64");
    },
  };
}

export function signEvidenceManifest(value, signer) {
  if (!signer) return value;
  const unsigned = unsignedManifest(value);
  return {
    ...unsigned,
    evidence_signature: {
      algorithm: signer.algorithm,
      signer_fingerprint: signer.fingerprint,
      public_key_spki: signer.public_key_spki,
      signature: signer.sign(unsigned),
    },
  };
}

export function verifyEvidenceManifest(value, {
  expectedFingerprint = null,
  required = true,
  label = "evidence manifest",
} = {}) {
  const signature = value?.evidence_signature;
  if (!signature) {
    if (required) throw new Error(`${label} has no cryptographic evidence_signature`);
    return false;
  }
  if (signature.algorithm !== EVIDENCE_SIGNATURE_ALGORITHM) {
    throw new Error(`${label} uses unsupported signature algorithm ${signature.algorithm ?? "<missing>"}`);
  }
  if (!signature.signer_fingerprint || signature.signer_fingerprint !== expectedFingerprint) {
    throw new Error(`${label} signer fingerprint ${signature.signer_fingerprint ?? "<missing>"} does not match the externally trusted key ${expectedFingerprint ?? "<missing>"}`);
  }
  let publicKey;
  try {
    const der = Buffer.from(String(signature.public_key_spki ?? ""), "base64");
    const actualFingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    if (actualFingerprint !== signature.signer_fingerprint) {
      throw new Error("embedded public key fingerprint mismatch");
    }
    publicKey = createPublicKey({ key: der, type: "spki", format: "der" });
  } catch (error) {
    throw new Error(`${label} contains an invalid signing public key (${error.message})`);
  }
  const valid = verify(
    null,
    Buffer.from(canonicalJsonStringify(unsignedManifest(value))),
    publicKey,
    Buffer.from(String(signature.signature ?? ""), "base64"),
  );
  if (!valid) throw new Error(`${label} cryptographic signature verification failed`);
  return true;
}
