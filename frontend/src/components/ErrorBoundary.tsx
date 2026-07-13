import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught React error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: "24px",
          margin: "24px",
          border: "1px solid #FF3B3B33",
          backgroundColor: "#FF3B3B11",
          color: "#F2F2F2",
          fontFamily: "var(--font-mono, monospace, sans-serif)"
        }}>
          <h2 style={{ color: "#FF3B3B", fontSize: "16px", marginTop: 0 }}>UI Crashed</h2>
          <p style={{ fontSize: "12px", color: "#A0A0A5" }}>An unexpected error occurred in the React tree.</p>
          <pre style={{ 
            fontSize: "11px", 
            color: "#FF3B3B", 
            overflowX: "auto", 
            padding: "12px",
            background: "#00000088"
          }}>
            {this.state.error?.message}
          </pre>
          <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
            <button 
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 16px",
                background: "#1FCB6E",
                color: "#000",
                border: "none",
                cursor: "pointer",
                fontWeight: "bold",
                borderRadius: "4px"
              }}
            >
              Reload Application
            </button>
            <button 
              onClick={() => {
                window.location.href = "/";
              }}
              style={{
                padding: "8px 16px",
                background: "transparent",
                color: "#F2F2F2",
                border: "1px solid #F2F2F2",
                cursor: "pointer",
                fontWeight: "bold",
                borderRadius: "4px"
              }}
            >
              Go to Home
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
