import { useEffect } from "react";
import termsContent from "../../../project-docs/legal/terms.md?raw";
import { LegalPage } from "./LegalPage";

export function Terms() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Terms of Service — Blind Bench";
    return () => {
      document.title = prev;
    };
  }, []);

  return <LegalPage content={termsContent} />;
}
