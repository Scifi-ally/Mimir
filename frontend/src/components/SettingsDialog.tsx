import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SystemConfig, UpdateSystemConfig } from "@/types/api";
import { cn } from "@/lib/format";
import { Tooltip } from "@/components/mimir/tooltip";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = "broker" | "auth_alerts" | "capital" | "exposure" | "strategy" | "execution" | "system";

const TAB_ITEMS: Array<{ key: TabKey; label: string }> = [
  { key: "broker", label: "Broker Integration" },
  { key: "auth_alerts", label: "Auth & Alerts" },
  { key: "capital", label: "Capital Limits" },
  { key: "exposure", label: "Position Limits" },
  { key: "strategy", label: "Strategy Rules" },
  { key: "execution", label: "Execution Engine" },
  { key: "system", label: "System Controls" },
];

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("broker");
  
  // Local form state
  const [formData, setFormData] = useState<Partial<SystemConfig>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [tokenSavedToast, setTokenSavedToast] = useState(false);
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [armingLive, setArmingLive] = useState(false);
  const [armPhraseInput, setArmPhraseInput] = useState("");

  // Load config from backend
  const { data: config, isLoading } = useQuery({
    queryKey: ["system-config"],
    queryFn: () => api.getConfig(true),
    enabled: isOpen,
    staleTime: 0,
  });

  // Trading mode (separate arming flow, not part of the config form)
  const tradingModeQuery = useQuery({
    queryKey: ["trading-mode"],
    queryFn: api.tradingMode,
    enabled: isOpen,
    staleTime: 0,
  });

  const setModeMutation = useMutation({
    mutationFn: ({ mode, confirmationPhrase }: { mode: "PAPER" | "LIVE"; confirmationPhrase?: string }) =>
      api.setTradingMode(mode, confirmationPhrase),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["trading-mode"] });
      queryClient.invalidateQueries({ queryKey: ["system-config"] });
      setArmingLive(false);
      setArmPhraseInput("");
      setActionFeedback({
        type: "success",
        text: res.mode === "LIVE"
          ? `Live trading ARMED. Available margin ₹${Math.round(res.availableMargin ?? 0).toLocaleString("en-IN")}.`
          : "Disarmed — engine is back in paper mode.",
      });
      setTimeout(() => setActionFeedback(null), 6000);
    },
    onError: (err: Error) => {
      setActionFeedback({ type: "error", text: err.message || "Failed to switch trading mode" });
      setTimeout(() => setActionFeedback(null), 6000);
    },
  });

  useEffect(() => {
    if (config) {
      setFormData({ ...config });
    }
    // Also load admin token from local storage
    setAdminTokenInput(localStorage.getItem("mimir_admin_token") || "");
  }, [config, isOpen]);

  // Check dirty state
  const isDirty = useMemo(() => {
    if (!config) return false;
    return Object.keys(formData).some((k) => {
      const key = k as keyof SystemConfig;
      return formData[key] !== config[key];
    });
  }, [formData, config]);

  // Mutation to save settings
  const saveMutation = useMutation({
    mutationFn: async (updated: UpdateSystemConfig) => {
      return api.updateConfig(updated);
    },
    onSuccess: (newConfig) => {
      setFormData({ ...newConfig });
      queryClient.setQueryData(["system-config"], newConfig);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["session"] });
      setSaveSuccessMessage("Settings successfully saved and applied to live engine!");
      setTimeout(() => setSaveSuccessMessage(null), 4000);
    },
    onError: (err: Error) => {
      setActionFeedback({ type: "error", text: err.message || "Failed to update configuration" });
      setTimeout(() => setActionFeedback(null), 5000);
    },
  });

  // Action mutations
  const triggerScanMutation = useMutation({
    mutationFn: () => api.triggerScan(),
    onSuccess: (res) => {
      setActionFeedback({
        type: res.error ? "error" : "success",
        text: res.error || (res.alreadyRunning ? "Scan is already running right now." : "Off-hours scan successfully triggered!"),
      });
      setTimeout(() => setActionFeedback(null), 5000);
    },
    onError: (err: Error) => {
      setActionFeedback({ type: "error", text: err.message || "Failed to trigger scan" });
      setTimeout(() => setActionFeedback(null), 5000);
    },
  });

  const stopScanMutation = useMutation({
    mutationFn: () => api.stopScan(),
    onSuccess: () => {
      setActionFeedback({ type: "success", text: "Scan termination requested. Check activity logs." });
      setTimeout(() => setActionFeedback(null), 5000);
    },
    onError: (err: Error) => {
      setActionFeedback({ type: "error", text: err.message || "Failed to stop scan" });
      setTimeout(() => setActionFeedback(null), 5000);
    },
  });

  const handleInputChange = <K extends keyof SystemConfig>(key: K, value: SystemConfig[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleNumberChange = (key: keyof SystemConfig, valStr: string, isFloat = true) => {
    if (valStr === "") {
      setFormData((prev) => ({ ...prev, [key]: 0 }));
      return;
    }
    const parsed = isFloat ? parseFloat(valStr) : parseInt(valStr, 10);
    if (!isNaN(parsed)) {
      setFormData((prev) => ({ ...prev, [key]: parsed }));
    }
  };

  const toggleSecretVisibility = (field: string) => {
    setShowSecrets((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const handleSave = () => {
    if (!config || saveMutation.isPending) return;

    const payload: UpdateSystemConfig = {};
    for (const [k, v] of Object.entries(formData)) {
      const key = k as keyof SystemConfig;
      if (v !== config[key] && v !== undefined) {
        if (typeof v === "string" && v === "********") continue;
        (payload as Record<string, unknown>)[key] = v;
      }
    }

    if (Object.keys(payload).length > 0) {
      saveMutation.mutate(payload);
    }
  };

  const handleReset = () => {
    if (config) setFormData({ ...config });
  };

  const saveAdminToken = () => {
    const trimmed = adminTokenInput.trim();
    if (trimmed) {
      localStorage.setItem("mimir_admin_token", trimmed);
    } else {
      localStorage.removeItem("mimir_admin_token");
    }
    setTokenSavedToast(true);
    setTimeout(() => setTokenSavedToast(false), 3000);
  };

  const clearLocalTokensAndCache = () => {
    localStorage.removeItem("mimir_admin_token");
    setAdminTokenInput("");
    queryClient.clear();
    setActionFeedback({ type: "success", text: "Local admin token & cache cleared successfully." });
    setTimeout(() => setActionFeedback(null), 4000);
  };

  const renderField = (
    label: string, 
    tooltip: string, 
    type: "text" | "number" | "password", 
    value: string | number | undefined, 
    onChange: (e: any) => void,
    placeholder?: string,
    secretKey?: string
  ) => {
    const isSecret = type === "password";
    const currentType = isSecret && secretKey && showSecrets[secretKey] ? "text" : type;

    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 mb-1.5">
          <label className="text-sm font-semibold text-foreground tracking-tight">{label}</label>
          <Tooltip content={tooltip} align="start">
            <span className="text-[10px] text-muted-foreground/60 hover:text-primary cursor-help">ⓘ</span>
          </Tooltip>
        </div>
        <form className="relative" onSubmit={(e) => e.preventDefault()}>
          {isSecret && (
            <input type="text" name="username" autoComplete="username" className="hidden" />
          )}
          <input
            type={currentType}
            value={value ?? ""}
            onChange={onChange}
            placeholder={placeholder}
            autoComplete="new-password"
            className="w-full bg-transparent text-sm font-mono text-foreground outline-none ring-0 border-0 focus:border-0 px-0 py-2.5 transition-colors shadow-none rounded-none placeholder:text-muted-foreground/30"
            style={{ paddingRight: isSecret ? "4rem" : "0" }}
          />
          {isSecret && secretKey && (
            <button
              type="button"
              onClick={() => toggleSecretVisibility(secretKey)}
              className="absolute right-0 top-1.5 text-[9px] font-bold text-muted-foreground hover:text-foreground transition-colors outline-none ring-0 border border-foreground/10 hover:border-foreground/20 rounded px-2 py-1 uppercase tracking-widest"
            >
              {showSecrets[secretKey] ? "Hide" : "Show"}
            </button>
          )}
        </form>
      </div>
    );
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[80]"
            onClick={onClose}
          />

          {/* Slide-Up Panel */}
          <motion.div
            initial={{ y: "100%", x: "-50%", scale: 0.98 }}
            animate={{ y: 0, x: "-50%", scale: 1 }}
            exit={{ y: "100%", x: "-50%", scale: 0.98 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 bottom-0 z-[90] flex flex-col bg-background text-foreground overflow-hidden h-[86vh] w-full max-w-5xl rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.08)] dark:shadow-[0_-8px_40px_rgba(0,0,0,0.4)] border border-b-0 border-foreground/5 ring-0 outline-none"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-8 pt-8 pb-4 shrink-0">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-black tracking-tight text-foreground">System Settings</h2>
                {isDirty && (
                  <span className="text-[10px] font-extrabold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                    UNSAVED
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-1 overflow-hidden">
              {/* Sidebar Tabs */}
              <div className="w-56 shrink-0 flex flex-col gap-1 px-8 pt-8 overflow-y-auto no-scrollbar">
                {TAB_ITEMS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={cn(
                      "text-xs tracking-wider text-left transition-colors py-2.5 px-3 rounded-md",
                      activeTab === tab.key
                        ? "text-primary font-black bg-foreground/5"
                        : "text-muted-foreground font-bold hover:text-foreground hover:bg-foreground/5"
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Scrollable Content Area */}
              <div className="flex-1 overflow-y-auto px-10 py-8 relative">
                {isLoading ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  </div>
                ) : (
                <div className="max-w-4xl pb-4">
                  
                  {/* TAB 1: BROKER INTEGRATION */}
                  {activeTab === "broker" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      <div className="flex flex-col col-span-1 md:col-span-2">
                        <div className="flex items-center gap-2 mb-1.5">
                          <label className="text-sm font-semibold text-foreground tracking-tight">API Key Configuration Mode</label>
                          <Tooltip content="Use a single API key, or dual API keys to split data analysis and live tick streaming to prevent rate limits." align="start">
                            <span className="text-[10px] text-muted-foreground/60 hover:text-primary cursor-help">ⓘ</span>
                          </Tooltip>
                        </div>
                        <div className="flex items-center gap-6 py-2 border-b border-foreground/15">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="dualMode"
                              checked={formData.useDualApiKeys === false}
                              onChange={() => handleInputChange("useDualApiKeys", false)}
                              className="accent-primary w-3 h-3"
                            />
                            <span className="text-xs font-black text-bull">SINGLE KEY</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="dualMode"
                              checked={formData.useDualApiKeys === true}
                              onChange={() => handleInputChange("useDualApiKeys", true)}
                              className="accent-primary w-3 h-3"
                            />
                            <span className="text-xs font-black text-destructive">DUAL KEYS (RECOMMENDED)</span>
                          </label>
                        </div>
                      </div>

                      {renderField(
                        formData.useDualApiKeys ? "Upstox Feed API Key (Live Ticks)" : "Upstox API Key",
                        formData.useDualApiKeys ? "Dedicated API Key to handle frontend real-time tick streaming & live charts." : "Your primary Upstox API key used for data analysis and tick streaming.",
                        "text",
                        formData.upstoxApiKey,
                        (e) => handleInputChange("upstoxApiKey", e.target.value),
                        "e.g. 8d3b2a1..."
                      )}
                      {renderField(
                        "Upstox Feed API Secret",
                        "The secret corresponding to your Feed API Key.",
                        "password",
                        formData.upstoxApiSecret,
                        (e) => handleInputChange("upstoxApiSecret", e.target.value),
                        "********",
                        "upstoxApiSecret"
                      )}
                      {formData.useDualApiKeys && (
                        <>
                          {renderField(
                            "Upstox Analysis API Key (Background Scanners)",
                            "Separate API Key (UPSTOX_DATA_API_KEY) for heavy historical candle analysis, multi-timeframe scanners, and AI indicators. Prevents rate-limit clashes with live ticks.",
                            "text",
                            formData.upstoxDataApiKey,
                            (e) => handleInputChange("upstoxDataApiKey", e.target.value)
                          )}
                          {renderField(
                            "Upstox Analysis API Secret",
                            "Secret corresponding to your Analysis API Key.",
                            "password",
                            formData.upstoxDataApiSecret,
                            (e) => handleInputChange("upstoxDataApiSecret", e.target.value),
                            "********",
                            "upstoxDataApiSecret"
                          )}
                        </>
                      )}
                      {renderField(
                        "Upstox Redirect URI",
                        "Must exactly match the redirect URI set in Upstox Developer Console. (e.g. https://127.0.0.1:8000/api/auth/upstox/callback)",
                        "text",
                        formData.upstoxRedirectUri,
                        (e) => handleInputChange("upstoxRedirectUri", e.target.value)
                      )}
                    </div>
                  )}

                  {/* TAB 2: AUTH & ALERTS */}
                  {activeTab === "auth_alerts" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2 mb-1.5">
                          <label className="text-sm font-semibold text-foreground tracking-tight">Remote Admin Token (Local Auth)</label>
                          <Tooltip content="Set a secure token to allow remote network access to this dashboard." align="start">
                            <span className="text-[10px] text-muted-foreground/60 hover:text-primary cursor-help">ⓘ</span>
                          </Tooltip>
                        </div>
                        <form className="flex gap-3 relative" onSubmit={(e) => { e.preventDefault(); saveAdminToken(); }}>
                          <input type="text" name="username" autoComplete="username" className="hidden" />
                          <input
                            type={showSecrets.adminToken ? "text" : "password"}
                            value={adminTokenInput}
                            onChange={(e) => setAdminTokenInput(e.target.value)}
                            placeholder="Set custom token..."
                            autoComplete="new-password"
                            className="w-full bg-transparent text-sm font-mono text-foreground outline-none ring-0 border-0 border-b border-foreground/15 focus:border-primary px-0 py-2.5 transition-colors shadow-none rounded-none pr-14 placeholder:text-muted-foreground/30"
                          />
                          <button
                            type="button"
                            onClick={() => toggleSecretVisibility("adminToken")}
                            className="absolute right-[85px] top-2.5 text-[10px] font-extrabold text-muted-foreground hover:text-foreground outline-none"
                          >
                            {showSecrets.adminToken ? "[ Hide ]" : "[ Show ]"}
                          </button>
                          <button
                            onClick={saveAdminToken}
                            className="shrink-0 text-[10px] font-black text-primary underline underline-offset-4 decoration-primary hover:opacity-80 px-2"
                          >
                            [ APPLY ]
                          </button>
                        </form>
                        {localStorage.getItem("mimir_admin_token") && (
                          <div className="text-[10px] font-bold text-bull mt-1">✓ ENABLED</div>
                        )}
                      </div>
                      {renderField(
                        "Discord Webhook URL",
                        "Optional. Receives instant trade alerts, risk violations, and system updates.",
                        "text",
                        formData.discordWebhookUrl,
                        (e) => handleInputChange("discordWebhookUrl", e.target.value)
                      )}
                      {renderField(
                        "Telegram Bot Token",
                        "Optional. Your bot token from BotFather.",
                        "password",
                        formData.telegramBotToken,
                        (e) => handleInputChange("telegramBotToken", e.target.value),
                        "********",
                        "telegramBotToken"
                      )}
                      {renderField(
                        "Telegram Chat ID",
                        "The ID of the group/user where the bot will send messages.",
                        "text",
                        formData.telegramChatId,
                        (e) => handleInputChange("telegramChatId", e.target.value)
                      )}
                    </div>
                  )}

                  {/* TAB 3: CAPITAL LIMITS */}
                  {activeTab === "capital" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      {renderField("Trading Capital (₹)", "Total dedicated capital available to the trading engine. Engine scales positions based on this.", "number", formData.tradingCapital, (e) => handleNumberChange("tradingCapital", e.target.value))}
                      {renderField("Max Deployed Capital (%)", "Maximum percentage of Trading Capital allowed to be tied up in positions at any time.", "number", formData.maxDeployedCapitalPct, (e) => handleNumberChange("maxDeployedCapitalPct", e.target.value))}
                      {renderField("Max Risk Per Trade (%)", "Risk tolerance per trade (Loss if Stop Loss hits). Determines position sizing.", "number", formData.maxRiskPerTradePct, (e) => handleNumberChange("maxRiskPerTradePct", e.target.value))}
                      {renderField("Max Daily Loss (%)", "Global kill switch. Stops taking new trades if account loses this percentage in a day.", "number", formData.maxDailyLossPct, (e) => handleNumberChange("maxDailyLossPct", e.target.value))}
                      {renderField("Weekly Loss Limit (%)", "System pauses for the remainder of the week if this threshold is hit.", "number", formData.weeklyLossLimitPct, (e) => handleNumberChange("weeklyLossLimitPct", e.target.value))}
                      {renderField("Rolling Drawdown Limit (%)", "Hard system pause if drawdown from peak hits this mark.", "number", formData.rollingDrawdownPct, (e) => handleNumberChange("rollingDrawdownPct", e.target.value))}
                    </div>
                  )}

                  {/* TAB 4: POSITION LIMITS */}
                  {activeTab === "exposure" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      {renderField("Max Open Positions", "Absolute limit on concurrent open trades.", "number", formData.maxOpenPositions, (e) => handleNumberChange("maxOpenPositions", e.target.value, false))}
                      {renderField("Max Same Direction Positions", "Limits market exposure by preventing too many parallel longs or shorts.", "number", formData.maxSameDirectionOpenPositions, (e) => handleNumberChange("maxSameDirectionOpenPositions", e.target.value, false))}
                      {renderField("Max Sector Exposure", "Prevents overconcentration in a single sector.", "number", formData.maxSectorExposure, (e) => handleNumberChange("maxSectorExposure", e.target.value, false))}
                      {renderField("Min Risk:Reward Ratio", "Filter out trades that don't offer at least this reward ratio (e.g. 2.0).", "number", formData.minRiskReward, (e) => handleNumberChange("minRiskReward", e.target.value))}
                    </div>
                  )}

                  {/* TAB 5: STRATEGY RULES */}
                  {activeTab === "strategy" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      {renderField("Min Suggestion Score (/100)", "Mimir's AI Composite Score threshold. Higher means stricter trade filtering.", "number", formData.minSuggestionScore, (e) => handleNumberChange("minSuggestionScore", e.target.value))}
                      {renderField("Min AI Confidence (%)", "Machine Learning prediction confidence threshold (0-100).", "number", formData.minAutoConfidencePct, (e) => handleNumberChange("minAutoConfidencePct", e.target.value))}
                      {renderField("Min MTF Confluence (%)", "Percentage of multiple timeframes (5m, 15m, 1h, 1d) that must agree with the trend.", "number", formData.minMtfConfluencePct, (e) => handleNumberChange("minMtfConfluencePct", e.target.value))}
                      {renderField("VIX Pause Threshold", "If India VIX exceeds this number, the engine halts new position entries.", "number", formData.vixPauseThreshold, (e) => handleNumberChange("vixPauseThreshold", e.target.value))}
                    </div>
                  )}

                  {/* TAB 6: EXECUTION ENGINE */}
                  {activeTab === "execution" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      <div className="flex flex-col col-span-full">
                        <div className="flex items-center gap-2 mb-1.5">
                          <label className="text-sm font-semibold text-foreground tracking-tight">Trading Engine Mode</label>
                          <Tooltip content="Paper mode simulates all fills locally with zero risk. Live mode mirrors every engine fill to Upstox as a REAL order — arming requires a typed confirmation." align="start">
                            <span className="text-[10px] text-muted-foreground/60 hover:text-primary cursor-help">ⓘ</span>
                          </Tooltip>
                        </div>

                        <div className="flex items-center justify-between py-3 border-b border-foreground/15">
                          <div className="flex items-center gap-3">
                            {tradingModeQuery.data?.mode === "LIVE" ? (
                              <>
                                <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                                <span className="text-xs font-black text-destructive tracking-widest">LIVE — REAL ORDERS ACTIVE</span>
                              </>
                            ) : (
                              <>
                                <span className="w-2 h-2 rounded-full bg-bull" />
                                <span className="text-xs font-black text-bull tracking-widest">PAPER — SIMULATED FILLS</span>
                              </>
                            )}
                          </div>
                          {tradingModeQuery.data?.mode === "LIVE" ? (
                            <button
                              onClick={() => setModeMutation.mutate({ mode: "PAPER" })}
                              disabled={setModeMutation.isPending}
                              className="text-[10px] font-bold text-bull border border-bull/30 hover:border-bull hover:bg-bull/5 px-4 py-1.5 rounded uppercase tracking-widest transition-colors disabled:opacity-50"
                            >
                              {setModeMutation.isPending ? "Disarming..." : "Disarm → Paper"}
                            </button>
                          ) : (
                            <button
                              onClick={() => setArmingLive(true)}
                              disabled={!tradingModeQuery.data?.brokerAuthenticated}
                              className={cn(
                                "text-[10px] font-bold px-4 py-1.5 rounded uppercase tracking-widest transition-colors border",
                                tradingModeQuery.data?.brokerAuthenticated
                                  ? "text-destructive border-destructive/30 hover:border-destructive hover:bg-destructive/5"
                                  : "text-muted-foreground border-foreground/10 opacity-50 cursor-not-allowed"
                              )}
                            >
                              Arm Live Trading
                            </button>
                          )}
                        </div>

                        {!tradingModeQuery.data?.brokerAuthenticated && tradingModeQuery.data?.mode !== "LIVE" && (
                          <p className="text-[10px] text-muted-foreground mt-2">
                            Connect your Upstox account (Broker Integration tab) to enable live trading.
                          </p>
                        )}

                        <AnimatePresence>
                          {armingLive && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              exit={{ opacity: 0, height: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="mt-4 pt-4 border-t border-destructive/20 space-y-3">
                                <p className="text-xs text-foreground/80 leading-relaxed">
                                  Live mode places <span className="font-bold text-destructive">real orders with real money</span> at
                                  your broker for every engine fill — entries, targets, and stops. Position sizes follow your
                                  capital settings. To confirm, type{" "}
                                  <span className="font-mono font-bold text-foreground select-all">{tradingModeQuery.data?.armPhrase}</span> below.
                                </p>
                                <input
                                  type="text"
                                  value={armPhraseInput}
                                  onChange={(e) => setArmPhraseInput(e.target.value)}
                                  placeholder={tradingModeQuery.data?.armPhrase}
                                  spellCheck={false}
                                  autoComplete="off"
                                  className="w-full bg-transparent text-sm font-mono text-foreground outline-none border-b border-destructive/30 focus:border-destructive px-0 py-2 transition-colors placeholder:text-muted-foreground/30"
                                />
                                <div className="flex gap-3 pt-1">
                                  <button
                                    onClick={() => setModeMutation.mutate({ mode: "LIVE", confirmationPhrase: armPhraseInput })}
                                    disabled={armPhraseInput !== tradingModeQuery.data?.armPhrase || setModeMutation.isPending}
                                    className={cn(
                                      "text-[10px] font-bold px-4 py-1.5 rounded uppercase tracking-widest transition-colors border",
                                      armPhraseInput === tradingModeQuery.data?.armPhrase && !setModeMutation.isPending
                                        ? "text-white bg-destructive border-destructive hover:bg-destructive/90"
                                        : "text-muted-foreground border-foreground/10 opacity-50 cursor-not-allowed"
                                    )}
                                  >
                                    {setModeMutation.isPending ? "Arming..." : "Confirm — Go Live"}
                                  </button>
                                  <button
                                    onClick={() => { setArmingLive(false); setArmPhraseInput(""); }}
                                    className="text-[10px] font-bold text-muted-foreground hover:text-foreground border border-foreground/10 hover:border-foreground/20 px-4 py-1.5 rounded uppercase tracking-widest transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <div className="flex flex-col">
                        <div className="flex items-center gap-2 mb-1.5">
                          <label className="text-sm font-semibold text-foreground tracking-tight">Stop Loss Mode</label>
                          <Tooltip content="FIXED keeps standard SL. TRAILING moves SL up as profit grows." align="start">
                            <span className="text-[10px] text-muted-foreground/60 hover:text-primary cursor-help">ⓘ</span>
                          </Tooltip>
                        </div>
                        <select
                          value={formData.stopLossMode || "FIXED"}
                          onChange={(e) => handleInputChange("stopLossMode", e.target.value as "FIXED" | "TRAILING" | "BREAKEVEN")}
                          className="w-full bg-transparent text-sm font-mono text-foreground outline-none ring-0 border-0 focus:border-0 px-0 py-2.5 transition-colors shadow-none rounded-none cursor-pointer"
                        >
                          <option className="bg-background text-foreground" value="FIXED">FIXED (Standard)</option>
                          <option className="bg-background text-foreground" value="TRAILING">TRAILING (Dynamic Profit Lock)</option>
                        </select>
                      </div>

                      {renderField("Estimated Slippage (BPS)", "Buffer subtracted from expected PnL calculations (10 BPS = 0.1%).", "number", formData.slippageBps, (e) => handleNumberChange("slippageBps", e.target.value))}
                      {renderField("Fixed Brokerage (₹)", "Cost deducted per executed trade in PnL calculations.", "number", formData.brokeragePerOrderInr, (e) => handleNumberChange("brokeragePerOrderInr", e.target.value))}
                      {renderField("Avoid Market Open (Mins)", "Do not trade this many minutes after market open (9:15 AM).", "number", formData.avoidFirstMinutes, (e) => handleNumberChange("avoidFirstMinutes", e.target.value, false))}
                    </div>
                  )}

                  {/* TAB 7: SYSTEM CONTROLS */}
                  {activeTab === "system" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                      <div className="col-span-full space-y-4">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-extrabold text-foreground tracking-tight">System Controls</h3>
                          <Tooltip content="Manual overrides and system cache management." align="start">
                            <span className="text-[10px] text-muted-foreground/60 hover:text-primary cursor-help">ⓘ</span>
                          </Tooltip>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-4 pt-4">
                          <button
                            onClick={() => triggerScanMutation.mutate()}
                            disabled={triggerScanMutation.isPending}
                            className="px-6 py-2.5 rounded flex items-center justify-center gap-2 border border-foreground/10 hover:border-foreground/20 bg-transparent transition-colors disabled:opacity-50 outline-none ring-0"
                          >
                            <span className="text-[10px] font-bold text-bull uppercase tracking-widest">
                              {triggerScanMutation.isPending ? "Scanning..." : "Start Manual Scan"}
                            </span>
                          </button>
                          
                          <button
                            onClick={() => stopScanMutation.mutate()}
                            disabled={stopScanMutation.isPending}
                            className="px-6 py-2.5 rounded flex items-center justify-center gap-2 border border-foreground/10 hover:border-foreground/20 bg-transparent transition-colors disabled:opacity-50 outline-none ring-0"
                          >
                            <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
                              {stopScanMutation.isPending ? "Terminating..." : "Terminate Active Scan"}
                            </span>
                          </button>
                          
                          <button
                            onClick={clearLocalTokensAndCache}
                            className="px-6 py-2.5 rounded flex items-center justify-center gap-2 border border-foreground/10 hover:border-foreground/20 bg-transparent transition-colors outline-none ring-0"
                          >
                            <span className="text-[10px] font-bold text-destructive uppercase tracking-widest">
                              Purge Local Cache
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              )}
            </div>
          </div>

            {/* Global Alerts inside Modal */}
            <div className="absolute bottom-[80px] right-8 flex flex-col gap-2 pointer-events-none z-[100]">
              <AnimatePresence>
                {tokenSavedToast && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-bull/20 text-bull border border-bull/30 px-4 py-2 text-[10px] font-bold rounded shadow-xl backdrop-blur-md pointer-events-auto">
                    Admin token saved locally.
                  </motion.div>
                )}
                {saveSuccessMessage && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-bull/20 text-bull border border-bull/30 px-4 py-2 text-[10px] font-bold rounded shadow-xl backdrop-blur-md pointer-events-auto">
                    {saveSuccessMessage}
                  </motion.div>
                )}
                {actionFeedback && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }} className={cn("px-4 py-2 text-[10px] font-bold rounded shadow-xl backdrop-blur-md pointer-events-auto", actionFeedback.type === "success" ? "bg-bull/20 text-bull border border-bull/30" : "bg-destructive/20 text-destructive border border-destructive/30")}>
                    {actionFeedback.text}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className="px-8 py-6 flex justify-between items-center bg-background shrink-0 relative z-[90]">
              <button onClick={handleReset} className="text-[10px] font-bold text-muted-foreground hover:text-foreground outline-none ring-0 border border-foreground/10 hover:border-foreground/20 bg-transparent px-3 py-1.5 rounded uppercase tracking-widest transition-colors">
                Reset
              </button>
              
              <div className="flex items-center gap-6">
                {tradingModeQuery.data?.mode === "LIVE" ? (
                  <div className="text-[10px] font-black text-destructive animate-pulse tracking-widest flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-destructive rounded-full"/>LIVE BROKER EXECUTION</div>
                ) : (
                  <div className="text-[10px] font-black text-bull tracking-widest flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-bull rounded-full"/>PAPER TRADING (SAFE)</div>
                )}
                <div className="flex gap-3">
                  <button onClick={onClose} className="text-[10px] font-bold text-muted-foreground hover:text-foreground outline-none ring-0 border border-foreground/10 hover:border-foreground/20 bg-transparent px-4 py-1.5 rounded uppercase tracking-widest transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!isDirty || saveMutation.isPending}
                    className={cn(
                      "text-[10px] font-bold outline-none ring-0 border px-4 py-1.5 rounded uppercase tracking-widest transition-colors",
                      isDirty && !saveMutation.isPending ? "text-primary border-primary/30 hover:border-primary hover:bg-primary/5 bg-primary/10" : "text-muted-foreground border-foreground/10 opacity-50 cursor-not-allowed bg-transparent"
                    )}
                  >
                    {saveMutation.isPending ? "Saving..." : "Save Settings"}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
