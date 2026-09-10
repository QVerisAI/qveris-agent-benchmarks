import assert from "node:assert/strict";
import test from "node:test";
import { verifyAnswerAgainstEvidence } from "../src/a-stock-verification.mjs";

test("null and undefined assertion values are not coerced into numeric zero", () => {
  const verification = verifyAnswerAgainstEvidence({
    result: { final_answer: "The source does not disclose this value." },
    task: { track: "open", controls: {} },
    snapshot: {
      canonical_assertions: [
        { claim: "undisclosed one", value: null },
        { claim: "undisclosed two", value: undefined },
      ],
      evidence: [],
    },
  });
  assert.equal(verification.checks.some((check) => check.id === "key_numbers_match_frozen_evidence"), false);
});
