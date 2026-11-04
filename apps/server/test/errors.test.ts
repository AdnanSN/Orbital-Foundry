import { describe, expect, it } from "vitest";
import { classifyError, ProviderHttpError, redact } from "../src/llm/errors";

describe("redact", () => {
  it("hides NVIDIA account ids in 404 messages", () => {
    expect(redact("Function 'f1': Not found for account 'Xy12-fake_ID'")).toBe(
      "Function 'f1': Not found for account '[redacted]'",
    );
    expect(redact("Specified function in account 'Xy12-fake_ID' is not found")).toBe(
      "Specified function in account '[redacted]' is not found",
    );
  });

  it("hides Cloudflare account ids in URLs", () => {
    expect(redact("POST /client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run failed")).toBe(
      "POST /client/v4/accounts/[redacted]/ai/run failed",
    );
  });

  it("hides anything key-shaped", () => {
    expect(redact("bad key nvapi-AbC_123-xyz")).toBe("bad key nvapi-[redacted]");
    expect(redact("bad key gsk_abc123XYZ")).toBe("bad key gsk_[redacted]");
    expect(redact("Authorization: Bearer sk.abc/def+ghi=")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("is applied when a provider error is created", () => {
    const err = new ProviderHttpError("nvidia", 404, "Not found for account 'Xy12-fake_ID'");
    expect(err.message).toBe("Not found for account '[redacted]'");
    expect(classifyError(err)).toMatchObject({ kind: "not-found" });
    expect(classifyError(err).message).not.toContain("Xy12");
  });
});
