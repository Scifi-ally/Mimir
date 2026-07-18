import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowRight, Plus, X, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/format";
import { useStore } from "@/store/useStore";

type Operator = ">" | "<" | ">=" | "<=" | "==" | "!=" | "CROSSES_ABOVE" | "CROSSES_BELOW";
type ScheduleMode = "MARKET_OPEN" | "MARKET_CLOSE" | "EVERY_MINUTE" | "TIME" | "ON_DEMAND" | "EVERY_CANDLE";
type Condition = { type: "CONDITION"; indicatorA: string; operator: Operator; indicatorB: string; alertMessage?: string };
type RuleGroup = { type: "AND" | "OR"; rules: RuleNode[] };
type RuleNode = Condition | RuleGroup;

const INDICATORS = [
  { label: "Price / Close", value: "CLOSE" },
  { label: "Open", value: "OPEN" },
  { label: "High", value: "HIGH" },
  { label: "Low", value: "LOW" },
  { label: "Volume", value: "VOLUME" },
  { label: "Volume ratio", value: "VOLUME_RATIO" },
  { label: "Previous close", value: "PREV_CLOSE" },
  { label: "Change %", value: "CHANGE_PCT" },
  { label: "SMA 20", value: "SMA20" },
  { label: "SMA 50", value: "SMA50" },
  { label: "SMA 200", value: "SMA200" },
  { label: "EMA 9", value: "EMA9" },
  { label: "EMA 20", value: "EMA20" },
  { label: "EMA 50", value: "EMA50" },
  { label: "RSI 14", value: "RSI14" },
  { label: "MACD", value: "MACD" },
  { label: "MACD signal", value: "MACD_SIGNAL" },
  { label: "MACD histogram", value: "MACD_HISTOGRAM" },
  { label: "VWAP", value: "VWAP" },
  { label: "ATR 14", value: "ATR14" },
  { label: "ADX 14", value: "ADX14" },
  { label: "SuperTrend", value: "SUPERTREND" },
  { label: "Bollinger upper 20", value: "BB_UPPER20" },
  { label: "Bollinger middle 20", value: "BB_MIDDLE20" },
  { label: "Bollinger lower 20", value: "BB_LOWER20" },
  { label: "Bollinger width 20", value: "BB_WIDTH20" },
  { label: "ROC 14", value: "ROC14" },
  { label: "0", value: "0" },
  { label: "30", value: "30" },
  { label: "50", value: "50" },
  { label: "70", value: "70" },
] as const;

const OPERATORS: Array<{ label: string; value: Operator }> = [
  { label: "is greater than", value: ">" },
  { label: "is less than", value: "<" },
  { label: "is at least", value: ">=" },
  { label: "is at most", value: "<=" },
  { label: "equals", value: "==" },
  { label: "does not equal", value: "!=" },
  { label: "crosses above", value: "CROSSES_ABOVE" },
  { label: "crosses below", value: "CROSSES_BELOW" },
];

const SCHEDULE_OPTIONS: Array<{ label: string; value: ScheduleMode }> = [
  { label: "At market open", value: "MARKET_OPEN" },
  { label: "Every minute during market", value: "EVERY_MINUTE" },
  { label: "Every candle close", value: "EVERY_CANDLE" },
  { label: "At a set time", value: "TIME" },
  { label: "At market close", value: "MARKET_CLOSE" },
  { label: "On demand (manual)", value: "ON_DEMAND" },
];




function scheduleLabel(mode: ScheduleMode, time: string): string {
  if (mode === "MARKET_OPEN") return "at market open";
  if (mode === "MARKET_CLOSE") return "at market close";
  if (mode === "EVERY_MINUTE") return "every minute during market hours";
  if (mode === "EVERY_CANDLE") return "on every candle close";
  if (mode === "ON_DEMAND") return "on demand (manually)";
  return `at ${time || "the selected time"} IST`;
}


function CustomSelect({ value, onChange, options, editable = false, placeholder = "", textValue, onTextChange, disableFilter = false, autoFocus = false }: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ label: string; value: string }>;
  editable?: boolean;
  placeholder?: string;
  textValue?: string;
  onTextChange?: (text: string) => void;
  disableFilter?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLInputElement | HTMLButtonElement>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setCoords({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - 230) });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const currentInputValue = textValue !== undefined ? textValue : value;

  const filteredOptions = editable && currentInputValue && !disableFilter
    ? options.filter((option) => option.value.includes(currentInputValue.toUpperCase()) || option.label.toUpperCase().includes(currentInputValue.toUpperCase()))
    : options;

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [open, filteredOptions.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent event from bubbling up to parents (like the dashboard watchlist listener)
    if (["ArrowUp", "ArrowDown", "Enter", "Escape", " "].includes(e.key)) {
      e.stopPropagation();
    }

    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < filteredOptions.length - 1 ? prev + 1 : prev));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filteredOptions.length) {
        onChange(filteredOptions[highlightedIndex].value);
        setOpen(false);
      } else if (editable) {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <>
      {editable ? (
        <input
          id={placeholder ? `rule-node-${placeholder.toLowerCase().replace(/\s+/g, '-')}` : "rule-node-input"}
          name={placeholder ? `rule-node-${placeholder.toLowerCase().replace(/\s+/g, '-')}` : "rule-node-input"}
          ref={(el) => {
            if (el && autoFocus && document.activeElement !== el) {
              setTimeout(() => el.focus(), 10);
            }
            anchorRef.current = el;
          }}
          type="text"
          autoComplete="off"
          spellCheck="false"
          value={currentInputValue}
          onChange={(event) => {
            if (onTextChange) onTextChange(event.target.value);
            else onChange(event.target.value.toUpperCase().trimStart());
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          aria-label={placeholder || "Indicator"}
          style={{ width: `calc(${Math.max(currentInputValue.length || placeholder.length, 2)}ch + 24px)` }}
          className={cn(
            "rounded-md bg-transparent px-3 py-1.5 text-center text-xs font-bold text-foreground outline-none transition-colors placeholder:text-foreground/30 hover:bg-secondary/30 focus:bg-secondary/50",
            textValue !== undefined && "bg-secondary/20"
          )}
        />
      ) : (
        <button
          ref={anchorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleKeyDown}
          className="whitespace-nowrap rounded-md bg-transparent px-2 py-1.5 text-xs font-bold text-foreground transition-colors hover:bg-secondary/30"
        >
          {selectedLabel}
        </button>
      )}

      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {open && (
            <>
              <button aria-label="Close options" className="fixed inset-0 z-[10000] cursor-default" onClick={() => setOpen(false)} />
              <motion.div
                initial={{ opacity: 0, y: 3, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 3, scale: 0.98 }}
                transition={{ duration: 0.14 }}
                style={{ top: coords.top, left: coords.left }}
                className="fixed z-[10001] flex max-h-[300px] min-w-[140px] flex-col overflow-y-auto rounded-lg border border-border/20 bg-popover p-1 shadow-2xl backdrop-blur-xl text-popover-foreground"
              >
                {filteredOptions.length ? filteredOptions.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => { onChange(option.value); setOpen(false); }}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-left text-[11px] font-medium transition-colors hover:bg-foreground/10",
                      (option.value === value || highlightedIndex === index) ? "bg-foreground/10 text-foreground" : "text-foreground/70",
                    )}
                  >
                    {option.label}
                  </button>
                )) : (
                  <span className="px-3 py-2 text-xs text-muted-foreground">Use the custom value you typed</span>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

function isValidIndicator(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return false;
  if (Number.isFinite(Number(normalized))) return true;
  if (["PRICE", "CLOSE", "OPEN", "HIGH", "LOW", "VOLUME", "VOLUME_RATIO", "PREV_CLOSE", "CHANGE_PCT", "MACD", "MACD_SIGNAL", "MACD_HISTOGRAM", "VWAP", "SUPERTREND"].includes(normalized)) return true;
  const match = normalized.match(/^(SMA|EMA|RSI|ATR|ROC|ADX|BB_UPPER|BB_MIDDLE|BB_LOWER|BB_WIDTH)(\d{1,3})$/);
  return Boolean(match && Number(match[2]) >= 2 && Number(match[2]) <= 500);
}

function validateTree(node: RuleNode, depth = 0): string | null {
  if (depth > 5) return "Conditions can be nested up to five groups deep.";
  if (node.type === "CONDITION") {
    if (!isValidIndicator(node.indicatorA)) return `“${node.indicatorA || "Left value"}” is not a supported indicator or number.`;
    if (!isValidIndicator(node.indicatorB)) return `“${node.indicatorB || "Right value"}” is not a supported indicator or number.`;
    return null;
  }
  if (node.rules.length === 0) return "Every AND/OR group needs at least one condition.";
  for (const child of node.rules) {
    const error = validateTree(child, depth + 1);
    if (error) return error;
  }
  return null;
}

function countConditions(node: RuleNode): number {
  return node.type === "CONDITION" ? 1 : node.rules.reduce((total, child) => total + countConditions(child), 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function AdvancedRuleBuilder({ onComplete, initialRule }: { onComplete: () => void; initialRule?: any }) {
  const queryClient = useQueryClient();
  const showIsland = useStore((state) => state.showIsland);
  const [targetType, setTargetType] = useState(initialRule?.targetType || "ALL");
  const [outputName, setOutputName] = useState(initialRule?.outputName || "");
  const [timeframe, setTimeframe] = useState(initialRule?.timeframe || "15m");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(initialRule?.scheduleMode || "MARKET_OPEN");
  const [scheduleTime, setScheduleTime] = useState(initialRule?.scheduleTime || "09:15");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [conditions, setConditions] = useState<RuleGroup>(() => {
    if (initialRule?.conditions) return initialRule.conditions;
    if (initialRule?.indicatorA && initialRule?.operator && initialRule?.indicatorB) {
      return {
        type: "AND",
        rules: [{ type: "CONDITION", indicatorA: initialRule.indicatorA, operator: initialRule.operator, indicatorB: initialRule.indicatorB }]
      };
    }
    return {
      type: "AND",
      rules: [{ type: "CONDITION", indicatorA: "CLOSE", operator: ">", indicatorB: "EMA20" }],
    };
  });
  
  const scrollRef = useRef<HTMLDivElement>(null);

  const conditionCount = useMemo(() => countConditions(conditions), [conditions]);
  
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conditionCount]);

  const createRuleMutation = useMutation({
    mutationFn: async () => {
      const url = initialRule?.id ? `/api/screener/${initialRule.id}` : "/api/screener";
      const method = initialRule?.id ? "PUT" : "POST";
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "ALL",
          targetType,
          outputName: targetType === "CUSTOM" ? outputName.trim() : undefined,
          timeframe,
          conditions,
          scheduleMode,
          scheduleTime: scheduleMode === "TIME" ? scheduleTime : undefined,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || body?.message || "Failed to save screener");
      return body;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["screener_rules"] });
      onComplete();
    },
  });

  const updateAt = (path: number[], updater: (node: RuleNode) => RuleNode) => {
    setConditions((prev) => {
      const visit = (node: RuleNode, remaining: number[]): RuleNode => {
        if (!remaining.length) return updater(node);
        if (node.type === "CONDITION") return node;
        const [index, ...rest] = remaining;
        return { ...node, rules: node.rules.map((child, childIndex) => childIndex === index ? visit(child, rest) : child) };
      };
      return visit(prev, path) as RuleGroup;
    });
    setValidationError(null);
  };

  const removeAt = (path: number[]) => {
    setConditions((prev) => {
      const visit = (node: RuleNode, remaining: number[]): RuleNode | null => {
        if (!remaining.length) return null;
        if (node.type === "CONDITION") return node;
        const [index, ...rest] = remaining;
        if (rest.length === 0) {
          const newRules = node.rules.filter((_, i) => i !== index);
          return newRules.length ? { ...node, rules: newRules } : null;
        }
        const updatedRules = node.rules.map((child, i) => i === index ? visit(child, rest) : child).filter(Boolean) as RuleNode[];
        return updatedRules.length ? { ...node, rules: updatedRules } : null;
      };
      const result = visit(prev, path);
      return result ? (result as RuleGroup) : { type: "AND", rules: [{ type: "CONDITION", indicatorA: "CLOSE", operator: ">", indicatorB: "EMA20" }] };
    });
    setValidationError(null);
  };

  const appendTo = (path: number[], child: RuleNode) => {
    if (conditionCount >= 50) {
      setValidationError("A screener can contain at most 50 conditions.");
      return;
    }
    updateAt(path, (node) => node.type === "CONDITION" ? node : { ...node, rules: [...node.rules, child] });
  };

  const handleSave = () => {
    const error = validateTree(conditions)
      || (targetType === "CUSTOM" && !outputName.trim() ? "Give the custom watchlist a name." : null)
      || (scheduleMode === "TIME" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime) ? "Use HH:mm for the screener run time." : null)
      || (outputName.trim().length > 100 ? "Watchlist names must be 100 characters or fewer." : null);
    setValidationError(error);
    if (error) return;

    const targetLabels: Record<string, string> = {
      ALL: "all screener targets",
      SUGGESTIONS: "active suggestions",
      OVERNIGHT: "the overnight watchlist",
    };
    const targetLabel = targetType === "CUSTOM" ? outputName.trim() : (targetLabels[targetType] || targetType.toLowerCase());

    showIsland({
      title: initialRule?.id ? "Update this screener?" : "Create this screener?",
      subtitle: `${conditionCount} condition${conditionCount === 1 ? "" : "s"} will scan ${targetLabel} on ${timeframe} ${scheduleLabel(scheduleMode, scheduleTime)}.`,
      confirmText: initialRule?.id ? "Update" : "Create",
      cancelText: "Keep editing",
      onConfirm: async () => {
        await createRuleMutation.mutateAsync();
        return true;
      },
    });
  };

  const renderNode = (node: RuleNode, path: number[], depth: number) => {
    if (node.type === "CONDITION") {
      return (
        <div key={path.join("-")} className="group flex flex-wrap items-center gap-1.5 rounded-lg hover:bg-secondary/10 px-1 py-1 transition-colors">
          <CustomSelect editable placeholder="Indicator" value={node.indicatorA} onChange={(value) => updateAt(path, () => ({ ...node, indicatorA: value }))} options={INDICATORS} />
          <CustomSelect value={node.operator} onChange={(value) => updateAt(path, () => ({ ...node, operator: value as Operator }))} options={OPERATORS} />
          <CustomSelect editable placeholder="Indicator or number" value={node.indicatorB} onChange={(value) => updateAt(path, () => ({ ...node, indicatorB: value }))} options={INDICATORS} />
          
          <input 
            id={`rule-alert-message-${path.join("-")}`}
            name={`rule-alert-message-${path.join("-")}`}
            aria-label="Tag Name"
            type="text" 
            autoComplete="off"
            spellCheck="false"
            placeholder="Tag (e.g. 'Bullish')" 
            value={node.alertMessage || ""} 
            onChange={(e) => updateAt(path, () => ({ ...node, alertMessage: e.target.value }))}
            className="ml-1 rounded bg-transparent px-1 py-0.5 text-[10px] text-foreground/80 outline-none placeholder:text-foreground/30 hover:bg-secondary/30 focus:bg-secondary/50 w-24"
          />

          {path.length > 0 && (
            <button type="button" aria-label="Remove condition" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); removeAt(path); }} className="ml-auto rounded p-0.5 text-foreground/40 hover:bg-destructive/10 hover:text-destructive">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      );
    }

    return (
      <div key={path.join("-") || "root"} className={cn("flex flex-col gap-1.5", depth > 0 && "ml-3 pl-1.5 py-0.5")}>
        <div className="flex flex-wrap items-center gap-2 px-1">
          <CustomSelect
            value={node.type}
            onChange={(value) => updateAt(path, () => ({ ...node, type: value as "AND" | "OR" }))}
            options={[{ label: "All of the following are true", value: "AND" }, { label: "Any of the following are true", value: "OR" }]}
          />
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground">{node.rules.length} item{node.rules.length === 1 ? "" : "s"}</span>
          {depth > 0 && (
            <button type="button" onClick={() => removeAt(path)} className="ml-auto text-[9px] font-bold uppercase tracking-wider text-destructive/70 hover:text-destructive">Remove group</button>
          )}
        </div>
        <div className="flex flex-col gap-1">
          {node.rules.map((child, index) => renderNode(child, [...path, index], depth + 1))}
        </div>
        <div className="flex items-center gap-2 px-1">
          <button type="button" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); appendTo(path, { type: "CONDITION", indicatorA: "RSI14", operator: "<", indicatorB: "30" }); }} className="flex items-center gap-1 rounded px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/60 hover:bg-foreground/5 hover:text-foreground">
            <Plus className="h-2.5 w-2.5" /> Condition
          </button>
          {depth < 5 && (
            <button type="button" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); appendTo(path, { type: "AND", rules: [{ type: "CONDITION", indicatorA: "CLOSE", operator: ">", indicatorB: "SMA50" }] }); }} className="flex items-center gap-1 rounded px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/60 hover:bg-foreground/5 hover:text-foreground">
              <Plus className="h-2.5 w-2.5" /> Group
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto flex w-[610px] shrink-0 flex-col gap-1 px-1 pb-1">
      <div className="px-1 py-1">
        <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="font-semibold text-foreground/60">Scan</span>
          <div>
            <CustomSelect 
               value={targetType} 
               onChange={(val) => {
                 setTargetType(val);
                 if (val !== "CUSTOM") setOutputName("");
               }} 
               options={[
                 { label: "All screener targets", value: "ALL" },
                 { label: "Active suggestions", value: "SUGGESTIONS" },
                 { label: "Overnight watchlist", value: "OVERNIGHT" },
                 { label: "New custom watchlist...", value: "CUSTOM" },
               ]}
               editable={targetType === "CUSTOM"}
               textValue={targetType === "CUSTOM" ? outputName : undefined}
               onTextChange={targetType === "CUSTOM" ? (t) => { setOutputName(t); setValidationError(null); } : undefined}
               placeholder={targetType === "CUSTOM" ? "Watchlist name" : ""}
               disableFilter={true}
               autoFocus={targetType === "CUSTOM"}
            />
          </div>
          <span className="justify-self-end font-semibold text-foreground/60">on</span>
          <div>
            <CustomSelect value={timeframe} onChange={setTimeframe} options={[
              { label: "1 minute", value: "1m" },
              { label: "5 minutes", value: "5m" },
              { label: "15 minutes", value: "15m" },
              { label: "1 hour", value: "1h" },
              { label: "1 day", value: "1d" },
            ]} />
          </div>

          <span className="font-semibold text-foreground/60">Run</span>
          <div className="col-span-3 flex flex-wrap items-center gap-2">
            <CustomSelect value={scheduleMode} onChange={(value) => setScheduleMode(value as ScheduleMode)} options={SCHEDULE_OPTIONS} />
            {scheduleMode === "TIME" && (
              <input
                id="rule-schedule-time"
                name="rule-schedule-time"
                type="time"
                value={scheduleTime}
                onChange={(event) => { setScheduleTime(event.target.value); setValidationError(null); }}
                aria-label="Screener run time"
                className="h-8 rounded-md bg-background/45 px-2 text-xs font-bold text-foreground outline-none focus:bg-secondary/35"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-1 pt-1 text-[10px] font-medium text-muted-foreground">
        <span className="shrink-0 font-mono opacity-80">{conditionCount}/50 conditions</span>
      </div>

      {/* Conditions Editor */}
      <div ref={scrollRef} className="custom-scrollbar max-h-[42vh] overflow-y-auto px-2 py-0 pb-1">
        {renderNode(conditions, [], 0)}
      </div>

      <AnimatePresence mode="wait">
        {(validationError || createRuleMutation.error) && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{validationError || createRuleMutation.error?.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compact Footer */}
      <div className="flex items-center justify-between pt-1 pb-1 px-2">
        <button type="button" onClick={onComplete} className="rounded-xl px-4 py-2.5 text-xs font-semibold text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors">Cancel</button>
        <button type="button" onClick={handleSave} disabled={createRuleMutation.isPending} className="group flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-xs font-semibold text-primary-foreground transition-all hover:opacity-90 disabled:opacity-50 active:scale-[0.98]">
          {createRuleMutation.isPending ? "Saving..." : "Review & Save"}
          {createRuleMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />}
        </button>
      </div>
    </div>
  );
}
