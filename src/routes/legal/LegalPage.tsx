import { Link } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface LegalPageProps {
  content: string;
}

export function LegalPage({ content }: LegalPageProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="text-primary"
            >
              <rect
                x="0.75"
                y="0.75"
                width="22.5"
                height="22.5"
                rx="5.25"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M0.75 6A5.25 5.25 0 0 1 6 0.75h6v22.5H6A5.25 5.25 0 0 1 0.75 18Z"
                fill="currentColor"
              />
              <line
                x1="12"
                y1="0.75"
                x2="12"
                y2="23.25"
                stroke="currentColor"
                strokeWidth="1"
                opacity="0.9"
              />
            </svg>
            Blind Bench
          </Link>
          <nav className="flex items-center gap-5 text-sm text-muted-foreground">
            <Link to="/legal/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
            <Link to="/legal/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <article
          className={cn(
            "text-[0.95rem] leading-[1.7] text-muted-foreground",
            "[&_h1]:text-foreground [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:mb-3",
            "[&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-3",
            "[&_h3]:text-foreground [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2",
            "[&_p]:my-4",
            "[&_strong]:text-foreground [&_strong]:font-semibold",
            "[&_em]:italic",
            "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:opacity-85",
            "[&_ul]:my-4 [&_ul]:ml-5 [&_ul]:list-disc",
            "[&_ol]:my-4 [&_ol]:ml-5 [&_ol]:list-decimal",
            "[&_li]:my-1",
            "[&_hr]:my-8 [&_hr]:border-border",
            "[&_table]:w-full [&_table]:my-6 [&_table]:border-collapse [&_table]:text-sm",
            "[&_th]:text-foreground [&_th]:font-semibold [&_th]:text-left [&_th]:py-2 [&_th]:px-3 [&_th]:border-b-2 [&_th]:border-border",
            "[&_td]:py-2 [&_td]:px-3 [&_td]:border-b [&_td]:border-border [&_td]:align-top",
          )}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </article>
      </main>
    </div>
  );
}
