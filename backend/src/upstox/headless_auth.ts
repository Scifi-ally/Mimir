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

/**
 * How long an untouched headless session is kept before being reaped. Generous
 * relative to the time a human needs to read and type an OTP or PIN, but bounded
 * so an abandoned attempt cannot pin a Chromium process indefinitely.
 */
const IDLE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

type Screen = "code" | "pin" | "otp" | "phone";

class UpstoxHeadlessAuth {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentType: "trading" | "data" | null = null;
  /**
   * The type of the most recent attempt, deliberately NOT cleared by cleanup().
   *
   * A user who cancels and then submits a PIN still intends to log in, so the
   * next step must be able to relaunch "the same kind of login" rather than
   * telling them to start over. Keeping this separate from currentType is what
   * lets ensureSession() recover after the page has been dropped.
   */
  private lastKnownType: "trading" | "data" | null = null;
  /** Last time any step was driven, for idle reaping. */
  private lastTouchedAt = 0;

  constructor() {
    // Abandoned attempts must not pin a Chromium process indefinitely now that
    // the client no longer cancels on unmount.
    const timer = setInterval(() => this.reapIdleSessions(), 60_000);
    // Do not hold the event loop open just for the reaper.
    timer.unref?.();
  }

  private touch(): void {
    this.lastTouchedAt = Date.now();
  }

  private async launch(type: "trading" | "data", useSavedSession: boolean) {
    if (this.browser) {
      await this.cleanup();
    }

    this.currentType = type;
    this.lastKnownType = type;
    this.touch();
    const authState = crypto.randomBytes(24).toString("hex") + "_" + type;
    const url = getAuthorizationUrl(authState, type);

    try {
      this.browser = await chromium.launch({ headless: true });
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("Executable doesn't exist") || msg.includes("playwright install")) {
        logger.warn("Playwright bundled chromium not found, trying system browser channels");
        try {
          this.browser = await chromium.launch({ headless: true, channel: "msedge" });
        } catch {
          this.browser = await chromium.launch({ headless: true, channel: "chrome" });
        }
      } else {
        throw err;
      }
    }
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

  /**
   * Guarantee a live page before acting on a step, re-establishing it if the
   * process restarted or the page was dropped between user steps.
   *
   * The browser session is process-local state behind stateless HTTP calls, so
   * it can vanish between "submit OTP" and "submit PIN" (a restart, an explicit
   * cancel, a second begin()). Returning a hard "No active browser session" 500
   * at that point made the login look broken after the user had already done the
   * hard part. Instead, relaunch with the persisted session and re-detect the
   * screen we are actually on; only then report failure.
   *
   * Returns a non-null page/type pair, which also narrows the type for the
   * caller, or null when no session can be recovered.
   */
  private async ensureSession(): Promise<{ page: Page; type: "trading" | "data"; screen: Screen | null } | null> {
    if (this.page && this.currentType) {
      // A live page may have navigated since we last looked.
      const live = await this.detectScreen(1500);
      if (live) return { page: this.page, type: this.currentType, screen: live };
    }
    // currentType is null after a cleanup, so fall back to what was last
    // attempted rather than giving up.
    const resumeType = this.currentType ?? this.lastKnownType;
    if (!resumeType) return null;

    logger.info({ type: resumeType, recovered: !this.currentType }, "Headless session lost; relaunching to recover");
    try {
      await this.launch(resumeType, true);
    } catch (err) {
      logger.warn({ err }, "Failed to relaunch headless session for recovery");
      return null;
    }
    if (!this.page || !this.currentType) return null;
    return { page: this.page, type: this.currentType, screen: await this.detectScreen() };
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
    this.touch();
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
    const session = await this.ensureSession();
    if (!session) {
      throw new Error("No active browser session. Start the login again.");
    }
    this.touch();
    const page = session.page;

    try {
      const mobileInput = page.locator('#mobileNum, input[type="tel"]').first();
      await mobileInput.waitFor({ state: "visible", timeout: 10000 });
      await mobileInput.fill('');
      await mobileInput.pressSequentially(phone, { delay: 100 });

      const getOtpBtn = page.locator('#getOtp, button:has-text("Get OTP")').first();
      await getOtpBtn.click();

      const otpInput = page.locator('#otpNum, input[type="number"], input[name="otp"]').first();
      await otpInput.waitFor({ state: "visible", timeout: 15000 });

      return { status: "awaiting_otp" };
    } catch (e) {
      let errorMsg = null;
      try {
        errorMsg = await page.locator('.eb.ap.aq.ar.as, .error, [role="alert"], .error-msg').first().innerText({ timeout: 1000 });
      } catch { /* ignore */ }

      if (errorMsg) {
        throw new Error(errorMsg, { cause: e }); // Do not cleanup() on validation error
      }

      logger.error({ err: e }, "Failed to find phone input or click Get OTP");
      throw new Error("Failed to start phone verification", { cause: e });
    }
  }

  /** Back-compat: start a fresh full login with a phone number. */
  async start(type: "trading" | "data", phone: string) {
    await this.launch(type, false);
    return this.submitPhone(phone);
  }

  async submitOTP(otp: string) {
    const session = await this.ensureSession();
    if (!session) {
      throw new Error("No active browser session. Start the login again.");
    }
    this.touch();
    const page = session.page;

    try {
      const otpInput = page.locator('#otpNum, input[type="number"], input[name="otp"]').first();
      await otpInput.waitFor({ state: "visible", timeout: 10000 });
      await otpInput.fill('');
      await otpInput.pressSequentially(otp, { delay: 100 });

      const continueBtn = page.locator('#continueBtn, button:has-text("Continue")').first();

      const errorPromise = page.waitForFunction(() => {
        const bodyText = document.body.innerText.toLowerCase();
        if (bodyText.includes('incorrect otp') || bodyText.includes('invalid otp') || bodyText.includes('wrong otp')) {
           return "Incorrect OTP entered";
        }
        const errs = document.querySelectorAll('.eb.ap.aq.ar.as, .error, [role="alert"], .error-msg, .invalid-feedback, .error-text');
        for (const err of Array.from(errs)) {
          if (err instanceof HTMLElement && err.innerText && err.innerText.trim().length > 0 && err.offsetParent !== null) {
            return err.innerText.trim();
          }
        }
        return false;
      }, { timeout: 14500 }).then(res => res ? res.jsonValue() : null).catch(() => null);

      const pinInputPromise = page.waitForSelector('#val, input[type="password"], input[name="pin"]', { state: "visible", timeout: 15000 }).catch(() => null);

      await continueBtn.click();

      const raceResult = await Promise.race([
        pinInputPromise,
        errorPromise
      ]);

      if (typeof raceResult === 'string') {
        throw new Error("VALIDATION:" + raceResult);
      }

      const pinInput = await pinInputPromise;
      if (pinInput) {
        return { status: "awaiting_pin" };
      }
      throw new Error("Invalid OTP or Upstox didn't proceed");
    } catch (e) {
      logger.error({ err: e }, "Failed to submit OTP");
      if (e instanceof Error && e.message.startsWith("VALIDATION:")) {
        throw new Error(e.message.replace("VALIDATION:", ""), { cause: e });
      }
      throw new Error("Failed to submit OTP", { cause: e });
    }
  }

  async submitPIN(pin: string) {
    // Recover rather than hard-fail: the PIN step is the last one, and losing
    // the page just before it discarded a login the user had already completed
    // phone + OTP for.
    const session = await this.ensureSession();
    if (!session) {
      throw new Error("No active browser session. Start the login again.");
    }
    // Name the step we actually landed on. A recovered session usually resumes
    // at phone (the saved Upstox session expired), and "Failed to complete
    // login" tells the user nothing about why their PIN was ignored.
    if (session.screen && session.screen !== "pin" && session.screen !== "code") {
      logger.info({ screen: session.screen }, "PIN submitted but session is on an earlier step");
      throw new Error(
        session.screen === "phone"
          ? "Your Upstox session expired, so phone number and OTP are required again before the PIN. Start the login again."
          : "Upstox is asking for the OTP again before the PIN can be entered. Start the login again.",
      );
    }
    this.touch();
    const page = session.page;
    const type = session.type;

    try {
      const pinInput = page.locator('#val, input[type="password"], input[name="pin"]').first();
      await pinInput.waitFor({ state: "visible", timeout: 10000 });
      await pinInput.fill('');
      await pinInput.pressSequentially(pin, { delay: 100 });

      const continueBtn = page.locator('#continueBtn, button:has-text("Continue")').first();

      const errorPromise = page.waitForFunction(() => {
        const bodyText = document.body.innerText.toLowerCase();
        if (bodyText.includes('incorrect pin') || bodyText.includes('invalid pin') || bodyText.includes('wrong pin')) {
           return "Incorrect PIN entered";
        }
        const errs = document.querySelectorAll('.eb.ap.aq.ar.as, .error, [role="alert"], .error-msg, #pin-error, .invalid-feedback, .error-text');
        for (const err of Array.from(errs)) {
          if (err instanceof HTMLElement && err.innerText && err.innerText.trim().length > 0 && err.offsetParent !== null) {
            return err.innerText.trim();
          }
        }
        return false;
      }, { timeout: 14500 }).then(res => res ? res.jsonValue() : null).catch(() => null);

      const redirectPromise = page.waitForNavigation({ url: /code=/, timeout: 15000 }).catch(() => null);
      
      await continueBtn.click();

      const raceResult = await Promise.race([
        redirectPromise,
        errorPromise
      ]);

      if (typeof raceResult === 'string') {
        throw new Error("VALIDATION:" + raceResult);
      }

      const response = await redirectPromise;
      let finalCode: string | null = null;

      if (!response) {
        for (let i = 0; i < 15; i++) {
          await page.waitForTimeout(1000);
          const currentUrl = page.url();
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
      if (e instanceof Error && e.message.startsWith("VALIDATION:")) {
        throw new Error(e.message.replace("VALIDATION:", ""), { cause: e });
      }
      throw new Error("Failed to complete login", { cause: e });
    }
  }

  async cleanup() {
    // Clear every field unconditionally. These were nested inside
    // `if (this.browser)`, so a half-torn-down session (browser already gone but
    // page still set) left a stale `page` that later calls would happily use.
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentType = null;
    this.lastTouchedAt = 0;
  }

  /**
   * Drop sessions nobody is using.
   *
   * The client no longer cancels on unmount - a remount is not a cancellation,
   * and cancelling there was what killed live logins mid-flow. That means an
   * abandoned attempt (user closed the island and walked away) would otherwise
   * hold a Playwright browser open forever, one Chromium process per attempt.
   * Anything untouched for IDLE_TIMEOUT_MS is reaped.
   */
  private reapIdleSessions(): void {
    if (!this.page && !this.browser) return;
    if (!this.lastTouchedAt) return;
    if (Date.now() - this.lastTouchedAt < IDLE_SESSION_TIMEOUT_MS) return;
    logger.info(
      { idleMs: Date.now() - this.lastTouchedAt },
      "Reaping idle headless auth session",
    );
    void this.cleanup();
  }
}

export const upstoxHeadlessAuth = new UpstoxHeadlessAuth();
