import { useEffect } from "react";
import privacyContent from "../../../project-docs/legal/privacy.md?raw";
import { LegalPage } from "./LegalPage";

export function Privacy() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Privacy Policy — Blind Bench";
    return () => {
      document.title = prev;
    };
  }, []);

  return <LegalPage content={privacyContent} />;
}
