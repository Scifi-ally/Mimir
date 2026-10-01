import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./useStore";

/**
 * Stored headless-login credentials.
 *
 * These assertions exist because the auto-fill was reported broken and the cause
 * was invisible in the output: `useState(savePin ? getDecryptedPin() : "")`
 * reads the saved value once at mount and never again, so enabling the option
 * after the dialog opened did nothing. Pinning the store side here means the
 * "off means deleted" contract cannot silently regress either.
 */
describe("stored headless-login credentials", () => {
  beforeEach(() => {
    useStore.getState().clearSavedCredentials();
  });

  it("stores the PIN when the option is on", () => {
    const s = useStore.getState();
    s.setSavePin(true);
    s.setSavedPin("1234");
    expect(useStore.getState().savePin).toBe(true);
    expect(useStore.getState().savedPin).toBe("1234");
  });

  it("ERASES the stored PIN when the option is turned off", () => {
    const s = useStore.getState();
    s.setSavePin(true);
    s.setSavedPin("1234");

    useStore.getState().setSavePin(false);

    // The old behaviour flipped only the boolean and left the secret on disk,
    // so the setting did not describe what was actually stored.
    expect(useStore.getState().savePin).toBe(false);
    expect(useStore.getState().savedPin).toBe("");
  });

  it("ERASES the stored mobile number when the option is turned off", () => {
    const s = useStore.getState();
    s.setSaveMobileNumber(true);
    s.setSavedMobileNumber("9876543210");

    useStore.getState().setSaveMobileNumber(false);

    expect(useStore.getState().saveMobileNumber).toBe(false);
    expect(useStore.getState().savedMobileNumber).toBe("");
  });

  it("erases everything at once via clearSavedCredentials", () => {
    const s = useStore.getState();
    s.setSavePin(true);
    s.setSavedPin("1234");
    s.setSaveMobileNumber(true);
    s.setSavedMobileNumber("9876543210");

    useStore.getState().clearSavedCredentials();

    const after = useStore.getState();
    expect(after.savePin).toBe(false);
    expect(after.savedPin).toBe("");
    expect(after.saveMobileNumber).toBe(false);
    expect(after.savedMobileNumber).toBe("");
  });

  it("treats an empty string as a clear, so a cleared field cannot store a blank secret", () => {
    const s = useStore.getState();
    s.setSavePin(true);
    s.setSavedPin("1234");
    useStore.getState().setSavedPin("");
    expect(useStore.getState().savedPin).toBe("");
  });

  it("does not leak the PIN to non-Tauri/web callers through getDecryptedPin unless saved", () => {
    expect(useStore.getState().getDecryptedPin()).toBe("");
    useStore.getState().setSavePin(true);
    useStore.getState().setSavedPin("9999");
    expect(useStore.getState().getDecryptedPin()).toBe("9999");
  });
});