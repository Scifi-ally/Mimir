import { X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertHistory } from "./AlertHistory";

export function AlertsDrawer({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
          />
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 right-0 z-50 w-full max-w-sm border-l border-border bg-background p-4 shadow-2xl sm:max-w-md flex flex-col"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 rounded-full p-1 opacity-70 transition-opacity hover:bg-accent/10 hover:opacity-100"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="flex-1 min-h-0 overflow-hidden mt-6">
              <AlertHistory />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
