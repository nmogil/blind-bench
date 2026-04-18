import { Component, type ErrorInfo, type ReactNode } from "react";
import { posthog } from "@/lib/posthog";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    posthog.captureException(error, {
      react_component_stack: info.componentStack,
      source: "react_error_boundary",
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Something unexpected happened
          </h1>
          <p className="max-w-md text-muted-foreground">
            An error occurred that we didn't anticipate. Reloading the page
            usually fixes it. If the problem persists, please reach out to
            support.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Reload page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
