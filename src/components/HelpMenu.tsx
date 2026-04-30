import { useState } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { toggleCheatSheet } from "@/lib/shortcutCheatSheetState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HelpCircle,
  Keyboard,
  RotateCcw,
  MessageCircle,
  ExternalLink,
  Info,
  FileText,
  Shield,
  Compass,
} from "lucide-react";

export function HelpMenu() {
  const resetCallouts = useMutation(api.userPreferences.resetCallouts);
  const setCopilotDismissed = useMutation(
    api.userPreferences.setCopilotDismissed,
  );
  const setCopilotCollapsed = useMutation(
    api.userPreferences.setCopilotCollapsed,
  );
  const navigate = useNavigate();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center justify-center rounded-md h-11 w-11 hover:bg-accent transition-colors sm:h-8 sm:w-8">
          <HelpCircle className="h-5 w-5 sm:h-4 sm:w-4" />
          <span className="sr-only">Help</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={async () => {
              await Promise.all([
                setCopilotDismissed({ dismissed: false }),
                setCopilotCollapsed({ collapsed: false }),
              ]);
            }}
          >
            <Compass className="mr-2 h-4 w-4" />
            Show setup co-pilot
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggleCheatSheet()}>
            <Keyboard className="mr-2 h-4 w-4" />
            Keyboard shortcuts
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void resetCallouts({})}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset onboarding tips
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              window.open("mailto:feedback@blindbench.dev")
            }
          >
            <MessageCircle className="mr-2 h-4 w-4" />
            Send feedback
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              window.open("https://docs.blindbench.dev", "_blank")
            }
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            Documentation
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate("/legal/terms")}>
            <FileText className="mr-2 h-4 w-4" />
            Terms of Service
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/legal/privacy")}>
            <Shield className="mr-2 h-4 w-4" />
            Privacy Policy
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAboutOpen(true)}>
            <Info className="mr-2 h-4 w-4" />
            About Blind Bench
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Blind Bench</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Blind-evaluate LLM outputs so the best writing wins — not the
            loudest opinion.
          </p>
          <p className="text-xs text-muted-foreground mt-2">Version 0.9-pre</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
