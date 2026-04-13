import { useOnboardingCallout } from "@/hooks/useOnboardingCallout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X, PenLine, Play, MessageSquare, Sparkles } from "lucide-react";

const steps = [
  { icon: PenLine, title: "Write", desc: "Draft your prompt template with variables" },
  { icon: Play, title: "Run", desc: "Generate 3 blind outputs labeled A, B, C" },
  { icon: MessageSquare, title: "Review", desc: "Comment on what works — no version bias" },
  { icon: Sparkles, title: "Optimize", desc: "AI rewrites your prompt from real feedback" },
];

interface WelcomeCardProps {
  onCreateProject: () => void;
}

export function WelcomeCard({ onCreateProject }: WelcomeCardProps) {
  const { show, dismiss } = useOnboardingCallout("onboarding_welcome");

  if (!show) return null;

  return (
    <Card className="relative">
      <button
        onClick={dismiss}
        className="absolute right-3 top-3 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
      <CardContent className="pt-6">
        <h2 className="text-lg font-semibold">Welcome to Hot or Prompt</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Most teams evaluate prompts by reading one version's output and
          deciding it "looks good." That's how bias wins.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Hot or Prompt runs your prompt 3 times and shows outputs labeled A, B,
          C — with no version info. You and your team read them blind, comment on
          what works, and let the optimizer rewrite your prompt based on real
          feedback.
        </p>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
          {steps.map((s, i) => (
            <div
              key={s.title}
              className="flex flex-col items-center gap-2 rounded-lg border p-3 text-center"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                <s.icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs font-medium">
                  {i + 1}. {s.title}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {s.desc}
                </p>
              </div>
            </div>
          ))}
        </div>

        <Button className="mt-6" onClick={onCreateProject}>
          Create your first project
        </Button>
      </CardContent>
    </Card>
  );
}
