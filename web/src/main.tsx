import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./styles.css";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

/** Last line of defense: a render bug shows a recoverable message instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crashed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main id="main" style={{ maxWidth: 640, margin: "80px auto", padding: 16 }}>
        <div className="alert alert-bad" role="alert">
          <div>
            <p style={{ fontWeight: 600 }}>Something broke while drawing this page.</p>
            <p>{this.state.error.message}</p>
            <p style={{ marginTop: 12 }}>
              <button type="button" className="btn-neutral" onClick={() => window.location.reload()}>
                Reload
              </button>
            </p>
          </div>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
