import { describe, it, expect } from "vitest";
import { redactMuseDesktopSecrets } from "@/lib/providerResponse";

describe("provider response redaction", () => {
  it("removes Muse Desktop session secrets without mutating stored data", () => {
    const connection = {
      provider: "muse-desktop",
      providerSpecificData: {
        museAdmissionToken: "admission-secret",
        museNotaryToken: "notary-secret",
        museVmId: "vm-1",
      },
    };
    const result = redactMuseDesktopSecrets(connection);
    expect(result.providerSpecificData).toEqual({ museVmId: "vm-1" });
    expect(connection.providerSpecificData.museAdmissionToken).toBe("admission-secret");
    expect(connection.providerSpecificData.museNotaryToken).toBe("notary-secret");
  });

  it("leaves unrelated provider metadata unchanged", () => {
    const connection = {
      provider: "muse",
      providerSpecificData: { museAdmissionToken: "legacy-value" },
    };
    expect(redactMuseDesktopSecrets(connection)).toBe(connection);
  });
});
