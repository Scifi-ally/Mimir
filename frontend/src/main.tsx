import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isPermanentFailure } from "./lib/api";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10 * 1000, // 10 seconds (Dashboard needs fresh data)
      gcTime: 5 * 60 * 1000, // 5 minutes
      // Do not retry a 4xx. Upstox endpoints return 401 until OAuth completes,
      // and the dashboard polls them continuously — retrying those produced a
      // permanent request storm that also burned CPU on the render loop.
      retry: (failureCount, error) => {
        if (isPermanentFailure(error)) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* reducedMotion="user" makes every framer-motion animation in the app
        respect the OS "reduce motion" setting - it strips transforms but keeps
        opacity, so panels still fade in and nothing is vestibular. */}
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
