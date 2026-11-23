const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  isRateWithinCircuitBreaker,
  toInr,
  validatePanForHolder,
  detectCircularRoundTrip,
  detectBinaryFormat,
  pureJsSha256,
  evaluateComplianceGate
} = require("./compliance.js");

assert.strictEqual(validatePanForHolder("ABCPP8821F", "Ravindra Prajapat"), "");
assert.notStrictEqual(validatePanForHolder("ABCPA8821F", "Ravindra Prajapat"), "");
assert.notStrictEqual(validatePanForHolder("ABCCP8821F", "Ravindra Prajapat"), "");

assert.strictEqual(isRateWithinCircuitBreaker("USD_INR", 93.37), true);
assert.strictEqual(isRateWithinCircuitBreaker("USD_INR", 9999), false);

assert.strictEqual(toInr(1000, "INR"), 1000);
assert.ok(Math.abs(toInr(100, "USD") - 9337.27) < 0.01);

const normal = evaluateComplianceGate({
  amount: 50, currency: "EUR", toCurrency: "INR", cumulativeInr: 0,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: false
});
assert.strictEqual(normal.code, "APPROVED");

const aml = evaluateComplianceGate({
  amount: 50, currency: "EUR", toCurrency: "INR", cumulativeInr: 0,
  kycName: "Ravindra Prajapat", senderName: "Unknown Third-Party Sender",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: false
});
assert.strictEqual(aml.code, "AML_MISMATCH");

const tx1 = evaluateComplianceGate({
  amount: 1500, currency: "EUR", toCurrency: "INR", cumulativeInr: 0,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: false
});
assert.strictEqual(tx1.code, "APPROVED");

const tx2Smurf = evaluateComplianceGate({
  amount: 1500, currency: "EUR", toCurrency: "INR", cumulativeInr: tx1.projected,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: false
});
assert.strictEqual(tx2Smurf.code, "PROOF_REQUIRED");

const fanIn = evaluateComplianceGate({
  amount: 1000, currency: "EUR", toCurrency: "INR", cumulativeInr: 0, recipientCumulativeInr: 150000,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: false
});
assert.strictEqual(fanIn.code, "PROOF_REQUIRED");

assert.strictEqual(detectCircularRoundTrip([{ from: "INR", to: "USD" }], "USD", "INR"), true);
const roundTripBlock = evaluateComplianceGate({
  amount: 100, currency: "USD", toCurrency: "INR", cumulativeInr: 0,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: false,
  txHistory: [{ from: "INR", to: "USD" }]
});
assert.strictEqual(roundTripBlock.code, "ROUND_TRIP_AML");

const dupDocBlock = evaluateComplianceGate({
  amount: 2500, currency: "EUR", toCurrency: "INR", cumulativeInr: 0,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: true,
  docHash: "abc123hash", usedDocHashes: ["abc123hash"]
});
assert.strictEqual(dupDocBlock.code, "DUPLICATE_DOC_HASH");

const capHit = evaluateComplianceGate({
  amount: 6000, currency: "USD", toCurrency: "EUR", cumulativeInr: 0,
  kycName: "Ravindra Prajapat", senderName: "Ravindra Prajapat",
  docType: "PAN Card", docNum: "ABCPP8821F", hasValidProof: true
});
assert.strictEqual(capHit.code, "ROLLING_CAP_EXCEEDED");

assert.strictEqual(detectBinaryFormat(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), "PDF");
assert.strictEqual(detectBinaryFormat(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D])), "PNG");
assert.strictEqual(detectBinaryFormat(new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F])), null);

assert.strictEqual(
  pureJsSha256("abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
);

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const pinMatch = appSource.match(/const OPS_PIN_SHA256\s*=\s*"([a-f0-9]{64})"/);
assert.ok(pinMatch, "OPS_PIN_SHA256 constant must exist in app.js");
const actualOps2026Hash = crypto.createHash("sha256").update("OPS2026").digest("hex");
assert.strictEqual(pinMatch[1], actualOps2026Hash);
assert.strictEqual(pureJsSha256("OPS2026"), actualOps2026Hash);
assert.strictEqual(appSource.includes('"OPS2026"'), false, "Plain-text OPS2026 must not appear in app.js");

console.log("ALL 21 ORBITPAY SECURITY, FORENSIC, SHA-256 & COMPLIANCE TESTS PASSED!");
