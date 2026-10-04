import test from "node:test";
import assert from "node:assert/strict";
import { validateRegistrationNumber, validateSearchInput } from "./input-validation.js";

test("validateSearchInput should normalize supported input", () => {
  assert.deepEqual(
    validateSearchInput({
      keyword: "  胰腺癌  ",
      registration_number: "  ChiCTR2500111173 ",
      year: 2025,
      max_results: 10,
    }),
    {
      keyword: "胰腺癌",
      registrationNumber: "ChiCTR2500111173",
      year: 2025,
      maxResults: 10,
    }
  );
});

test("validateSearchInput should reject unsafe result limits and years", () => {
  assert.throws(() => validateSearchInput({ max_results: 0 }), /max_results/);
  assert.throws(() => validateSearchInput({ max_results: Infinity }), /max_results/);
  assert.throws(() => validateSearchInput({ year: Number.NaN }), /year/);
  assert.throws(() => validateSearchInput({ year: 1999 }), /year/);
});

test("validateRegistrationNumber should reject malformed identifiers", () => {
  assert.equal(validateRegistrationNumber("ChiCTR2500111173"), "ChiCTR2500111173");
  assert.throws(() => validateRegistrationNumber("../../etc/passwd"), /registration_number/);
  assert.throws(() => validateRegistrationNumber("ChiCTR123"), /registration_number/);
});
