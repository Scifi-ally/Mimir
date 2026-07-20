import { chromium, Browser, BrowserContext, Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { getAuthorizationUrl, exchangeCodeForToken } from "./auth";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { upstoxConnectionManager } from "../intelligence/connection_manager";

// Persisted Playwright storage state (Upstox session cookies). While this is
// valid, re-authorizing skips phone + OTP and only asks for the 6-digit PIN.
const SESSION_FILE = path.join(process.cwd(), ".upstox_session.json");

type Screen = "code" | "pin" | "otp" | "phone";

class UpstoxHeadlessAuth {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentType: "trading" | "data" | null = null;

  private async launch(type: "trading" | "data", useSavedSession: boolean) {
    if (this.browser) {
      await this.cleanup();
    }

    this.currentType = type;
    const authState = crypto.randomBytes(24).toString("hex") + "_" + type;
    const url = getAuthorizationUrl(authState, type);

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(useSavedSession && fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {}),
    });
    this.page = await this.context.newPage();

    logger.info({ type, reusedSession: useSavedSession && fs.existsSync(SESSION_FILE) }, "Starting headless Upstox auth");
    await this.page.goto(url, { waitUntil: "networkidle" });
  }

  /** Poll for whichever login screen Upstox landed us on. */
  private async detectScreen(timeoutMs = 15000): Promise<Screen | null> {
    const page = this.page;
    if (!page) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.url().includes("code=")) return "code";
      // Id-based selectors first — the generic type selectors overlap between screens
      if (await page.locator('#val, input[name="pin"]').first().isVisible().catch(() => false)) return "pin";
      if (await page.locator('#mobileNum, input[type="tel"]').first().isVisible().catch(() => false)) return "phone";
      if (await page.locator('#otpNum, input[name="otp"], input[type="number"]').first().isVisible().catch(() => false)) return "otp";
      if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) return "pin";
      await page.waitForTimeout(400);
    }
    return null;
  }

  private async saveSession(): Promise<void> {
    try {
      if (this.context) {
        await this.context.storageState({ path: SESSION_FILE });
        logger.info("Upstox browser session saved for fast re-authorization");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to persist Upstox browser session");
    }
  }

  private async finishWithCode(): Promise<{ status: "success" }> {
    const type = this.currentType!;
    const urlObj = new URL(this.page!.url());
    const code = urlObj.searchParams.get("code");
    if (!code) throw new Error("Redirect reached but no authorization code present");
    await exchangeCodeForToken(code, type);
    if (type === "data") {
      upstoxConnectionManager.resetCircuitBreakerAndConnect();
    }
    await this.saveSession();
    await this.cleanup();
    return { status: "success" };
  }

  /**
   * Entry point. Reuses the saved Upstox session when available so the user
   * usually lands straight on the PIN step (or straight through to success).
   */
  async begin(type: "trading" | "data"): Promise<{ status: "success" | "awaiting_pin" | "awaiting_otp" | "awaiting_phone" }> {
    const hasSession = fs.existsSync(SESSION_FILE);
    await this.launch(type, hasSession);

    const screen = await this.detectScreen();

    if (screen === "code") return this.finishWithCode();
    if (screen === "pin") return { status: "awaiting_pin" };
    if (screen === "otp") return { status: "awaiting_otp" };
    if (screen === "phone") {
      // Saved session no longer valid — drop it so we don't retry it next time
      if (hasSession) {
        fs.rmSync(SESSION_FILE, { force: true });
        logger.info("Saved Upstox session expired; falling back to full phone login");
      }
      return { status: "awaiting_phone" };
    }

    await this.cleanup();
    throw new Error("Could not load the Upstox login page");
  }

  /** Submit phone number on an already-open login page (from begin()). */
  async submitPhone(phone: string) {
    if (!this.page) throw new Error("No active browser session");

    try {
      const mobileInput = this.page.locator('#mobileNum, input[type="tel"]').first();
      await mobileInput.waitFor({ state: "visible", timeout: 10000 });
      await mobileInput.pressSequentially(phone, { delay: 100 });

      const getOtpBtn = this.page.locator('#getOtp, button:has-text("Get OTP")').first();
      await getOtpBtn.click();

      const otpInput = this.page.locator('#otpNum, input[type="number"], input[name="otp"]').first();
      await otpInput.waitFor({ state: "visible", timeout: 15000 });

      return { status: "awaiting_otp" };
    } catch (e) {
      let errorMsg = null;
      try {
        errorMsg = await this.page.locator('.eb.ap.aq.ar.as').first().innerText({ timeout: 1000 });
      } catch { /* ignore */ }
      if (errorMsg) {
        await this.cleanup();
        throw new Error(errorMsg, { cause: e });
      }

      logger.error({ err: e }, "Failed to find phone input or click Get OTP");
      await this.cleanup();
      throw new Error("Failed to start phone verification", { cause: e });
    }
  }

  /** Back-compat: start a fresh full login with a phone number. */
  async start(type: "trading" | "data", phone: string) {
    await this.launch(type, false);
    return this.submitPhone(phone);
  }

  async submitOTP(otp: string) {
    if (!this.page) throw new Error("No active browser session");

    try {
      const otpInput = this.page.locator('#otpNum, input[type="number"], input[name="otp"]').first();
      await otpInput.waitFor({ state: "visible", timeout: 10000 });
      await otpInput.pressSequentially(otp, { delay: 100 });

      const continueBtn = this.page.locator('#continueBtn, button:has-text("Continue")').first();
      await continueBtn.click();

      const pinInput = this.page.locator('#val, input[type="password"], input[name="pin"]').first();
      try {
        await pinInput.waitFor({ state: "visible", timeout: 5000 });
        return { status: "awaiting_pin" };
      } catch (err) {
        const errorMsg = await this.page.locator('.eb.ap.aq.ar.as, .error, [role="alert"], .error-msg').first().innerText({ timeout: 1000 }).catch(() => null);
        if (errorMsg) throw new Error(errorMsg, { cause: err });
        throw new Error("Invalid OTP or Upstox didn't proceed", { cause: err });
      }
    } catch (e) {
      logger.error({ err: e }, "Failed to submit OTP");
      await this.cleanup();
      throw new Error("Failed to submit OTP", { cause: e });
    }
  }

  async submitPIN(pin: string) {
    if (!this.page || !this.currentType) throw new Error("No active browser session");
    const type = this.currentType;

    try {
      const pinInput = this.page.locator('#val, input[type="password"], input[name="pin"]').first();
      await pinInput.waitFor({ state: "visible", timeout: 10000 });
      await pinInput.pressSequentially(pin, { delay: 100 });

      const continueBtn = this.page.locator('#continueBtn, button:has-text("Continue")').first();

      const redirectPromise = this.page.waitForNavigation({ url: /code=/, timeout: 15000 }).catch(() => null);
      await continueBtn.click();

      const response = await redirectPromise;
      let finalCode: string | null = null;

      if (!response) {
        for (let i = 0; i < 15; i++) {
          await this.page.waitForTimeout(1000);
          const currentUrl = this.page.url();
          if (currentUrl.includes("code=")) {
            const urlObj = new URL(currentUrl);
            finalCode = urlObj.searchParams.get("code");
            break;
          }
        }
      } else {
        const urlObj = new URL(response.url());
        finalCode = urlObj.searchParams.get("code");
      }

      if (finalCode) {
        await exchangeCodeForToken(finalCode, type);
        if (type === "data") {
          upstoxConnectionManager.resetCircuitBreakerAndConnect();
        }
        // Persist cookies so the next authorize skips phone + OTP
        await this.saveSession();
        await this.cleanup();
        return { status: "success" };
      }

      throw new Error("Did not receive authorization code");
    } catch (e) {
      logger.error({ err: e }, "Failed to submit PIN");
      await this.cleanup();
      throw new Error("Failed to complete login", { cause: e });
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    this.currentType = null;
  }
}

export const upstoxHeadlessAuth = new UpstoxHeadlessAuth();
