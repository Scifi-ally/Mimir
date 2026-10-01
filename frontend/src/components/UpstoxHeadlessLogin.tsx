import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Variants } from "framer-motion";
import { Loader2, ArrowRight, ShieldCheck, KeyRound, Phone } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/store/useStore";

interface Props {
  type: "trading" | "data";
  onSuccess: () => void;
}

const morphVariants: Variants = {
  initial: { opacity: 0, scaleX: 0.92, scaleY: 0.82 },
  animate: { 
    opacity: 1, 
    scaleX: 1, 
    scaleY: 1,
    transition: { type: "spring", stiffness: 450, damping: 28, mass: 1 }
  },
  exit: { 
    opacity: 0, 
    scaleX: 0.92, 
    scaleY: 0.82,
    transition: { duration: 0.12, ease: "easeIn" }
  }
};

export function UpstoxHeadlessLogin({ type, onSuccess }: Props) {
  const saveMobileNumber = useStore(s => s.saveMobileNumber);
  const savedMobileNumber = useStore(s => s.savedMobileNumber);
  const setSavedMobileNumber = useStore(s => s.setSavedMobileNumber);
  const savePin = useStore(s => s.savePin);
  const savedPin = useStore(s => s.savedPin);
  const setSavedPin = useStore(s => s.setSavedPin);

  const [step, setStep] = useState<"detecting" | "phone" | "otp" | "pin">("detecting");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [pin, setPin] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "phone") phoneRef.current?.focus();
    if (step === "otp") otpRef.current?.focus();
    if (step === "pin") pinRef.current?.focus();
  }, [step]);

  // Auto-fill from the stored credentials.
  //
  // This was previously `useState(savePin ? getDecryptedPin() : "")`, which is
  // why the feature appeared broken: useState ignores its initializer on every
  // render after the first, so the saved value was read once at mount and never
  // again. If the option was off when the dialog opened, the field was empty
  // for the whole session and turning the option on afterwards did nothing -
  // which is precisely the behaviour reported.
  //
  // Keyed on the step, the toggle and the stored values instead, so it responds
  // when the user enables the option in Settings without reopening the app, and
  // when rehydration lands after the first render. The `phone.length === 0`
  // guard means it only ever fills an empty field, so it cannot overwrite
  // something being typed or submitted.
  useEffect(() => {
    if (step === "phone" && saveMobileNumber && savedMobileNumber && phone.length === 0) {
      setPhone(savedMobileNumber);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, saveMobileNumber, savedMobileNumber]);

  useEffect(() => {
    if (step === "pin" && savePin && savedPin && pin.length === 0) {
      setPin(savedPin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, savePin, savedPin]);

  const hasSucceeded = useRef(false);

  // Kick off the session-aware flow: a saved Upstox session usually lands
  // straight on the PIN step (or completes outright), skipping phone + OTP.
  const beginStarted = useRef(false);
  useEffect(() => {
    if (beginStarted.current) return; // StrictMode double-mount guard
    beginStarted.current = true;
    (async () => {
      try {
        const res = await api.headlessAuth.begin(type);
        if (res.status === "success") {
          hasSucceeded.current = true;
          onSuccess();
        } else if (res.status === "awaiting_pin") {
const savedPinVal = savePin ? savedPin : "";
          if (savedPinVal) {
            try {
              const pinRes = await api.headlessAuth.submitPin(savedPinVal);
              if (pinRes.status === "success") {
                hasSucceeded.current = true;
                onSuccess();
                return;
              }
            } catch {
              // Fallback to manual entry on failure
            }
          }
          setStep("pin");
        } else if (res.status === "awaiting_otp") {
          setStep("otp");
        } else {
          setStep("phone");
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to start login");
        setStep("phone");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Do NOT cancel the server-side browser session on unmount.
  //
  // This component is rendered as `content` inside the DynamicIsland portal, so
  // any re-render that recreates the island element unmounts it. The previous
  // unmount handler called /headless/cancel, which runs the server's
  // cleanup() and drops the Playwright page. The user was then left staring at
  // the PIN step with a dead session, and submitting the PIN failed with
  // "No active browser session".
  //
  // A remount is not a cancellation. The flow now ends in exactly two ways:
  //   - success, where the server has already cleaned up after itself, or
  //   - an explicit cancel, handled by the island's cancel affordance.
  // Abandoned sessions are reaped server-side by the idle sweep.

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone || phone.length < 10) return;
    setIsProcessing(true);
    setError(null);
    try {
      const res = await api.headlessAuth.startPhone(type, phone);
      if (saveMobileNumber) {
        setSavedMobileNumber(phone);
      }
      if (res.status === "awaiting_otp") {
        setStep("otp");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start login");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp) return;
    setIsProcessing(true);
    setError(null);
    try {
      const res = await api.headlessAuth.submitOtp(otp);
      if (res.status === "awaiting_pin") {
        const savedPinVal = savePin ? savedPin : "";
        if (savedPinVal) {
          try {
            const pinRes = await api.headlessAuth.submitPin(savedPinVal);
            if (pinRes.status === "success") {
              hasSucceeded.current = true;
              onSuccess();
              return;
            }
          } catch {
            // Fallback to manual entry
          }
        }
        setStep("pin");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to verify OTP");
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    setIsProcessing(true);
    setError(null);
    try {
      const res = await api.headlessAuth.submitPin(pin);
      if (res.status === "success") {
        if (savePin) {
          setSavedPin(pin);
        }
        hasSucceeded.current = true;
        onSuccess();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to verify PIN");
    } finally {
      setIsProcessing(false);
    }
  };

  const inputClass = "w-full bg-background border border-border rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-bull/50 placeholder:text-muted-foreground/50 transition-shadow text-foreground";
  const btnClass = "w-full bg-foreground text-background flex items-center justify-center py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 mt-4";

  return (
    <div className="flex flex-col w-full h-full relative" style={{ padding: "0 8px 16px 8px" }}>
      <AnimatePresence mode="wait">
        {step === "detecting" && (
          <motion.div
            key="detecting"
            variants={morphVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ transformOrigin: "top center" }}
            className="flex flex-col items-center justify-center gap-3 py-6"
          >
            <Loader2 className="w-6 h-6 animate-spin text-bull" />
            <span className="text-sm font-medium text-muted-foreground">Checking saved session…</span>
          </motion.div>
        )}

        {step === "phone" && (
          <motion.form
            key="phone"
            variants={morphVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ transformOrigin: "top center" }}
            className="flex flex-col gap-3"
            onSubmit={handlePhoneSubmit}
          >
            <div className="flex items-center gap-3 text-muted-foreground mb-1">
              <Phone className="w-5 h-5 text-bull" />
              <span className="text-sm font-medium">Upstox Mobile Number</span>
            </div>
            <input
              ref={phoneRef}
              type="tel"
              placeholder="e.g. 9876543210"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className={inputClass}
              disabled={isProcessing}
            />
            {error && <div className="text-destructive text-xs font-medium">{error}</div>}
            <button type="submit" disabled={isProcessing || phone.length < 10} className={btnClass}>
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Get OTP <ArrowRight className="w-4 h-4 ml-2" /></>}
            </button>
          </motion.form>
        )}

        {step === "otp" && (
          <motion.form
            key="otp"
            variants={morphVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ transformOrigin: "top center" }}
            className="flex flex-col gap-3"
            onSubmit={handleOtpSubmit}
          >
            <div className="flex items-center gap-3 text-muted-foreground mb-1">
              <ShieldCheck className="w-5 h-5 text-bull" />
              <span className="text-sm font-medium">Enter 6-digit OTP</span>
            </div>
            <input
              ref={otpRef}
              type="number"
              placeholder="OTP"
              value={otp}
              onChange={e => setOtp(e.target.value)}
              className={inputClass}
              disabled={isProcessing}
            />
            {error && <div className="text-destructive text-xs font-medium">{error}</div>}
            <button type="submit" disabled={isProcessing || !otp} className={btnClass}>
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Verify OTP <ArrowRight className="w-4 h-4 ml-2" /></>}
            </button>
          </motion.form>
        )}

        {step === "pin" && (
          <motion.form
            key="pin"
            variants={morphVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ transformOrigin: "top center" }}
            className="flex flex-col gap-3"
            onSubmit={handlePinSubmit}
          >
            <div className="flex items-center gap-3 text-muted-foreground mb-1">
              <KeyRound className="w-5 h-5 text-bull" />
              <span className="text-sm font-medium">Enter 6-digit PIN</span>
            </div>
            <input
              ref={pinRef}
              type="password"
              placeholder="PIN"
              value={pin}
              onChange={e => setPin(e.target.value)}
              className={inputClass}
              disabled={isProcessing}
            />
            {error && <div className="text-destructive text-xs font-medium">{error}</div>}
            <button type="submit" disabled={isProcessing || !pin} className={btnClass}>
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Complete Login"}
            </button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
