import { useState, useMemo } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { motion, useReducedMotion } from "motion/react";
import { api } from "../../convex/_generated/api";
import { slugify } from "@/lib/slugify";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { friendlyError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Grainient from "@/components/Grainient";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Onboarding() {
  const navigate = useNavigate();
  const { signOut } = useAuthActions();
  const createOrg = useMutation(api.organizations.createOrg);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const reduceMotion = useReducedMotion();

  const slug = useMemo(() => slugify(name), [name]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug) return;

    setSaving(true);
    setError("");
    try {
      await createOrg({ name: name.trim(), slug });
      navigate(`/orgs/${slug}`);
    } catch (err) {
      setError(friendlyError(err, "Failed to create workspace. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-neutral-950 p-4">
      {/* Grainient wash — full intensity to match SignIn for a continuous post-auth handoff */}
      {reduceMotion ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(100deg,#94a3b8_0%,#5227FF_55%,#000000_100%)]"
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <Grainient
            color1="#94a3b8"
            color2="#5227FF"
            color3="#000000"
            timeSpeed={0.25}
            colorBalance={0.0}
            warpStrength={1.0}
            warpFrequency={5.0}
            warpSpeed={2.0}
            warpAmplitude={50.0}
            blendAngle={0.0}
            blendSoftness={0.05}
            rotationAmount={500.0}
            noiseScale={2.0}
            grainAmount={0.1}
            grainScale={2.0}
            grainAnimated={false}
            contrast={1.5}
            gamma={1.0}
            saturation={1.0}
            centerX={0.0}
            centerY={0.0}
            zoom={0.9}
          />
        </div>
      )}

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
        className="relative z-10 w-full max-w-md"
      >
        <Card className="border-white/10 bg-background/85 shadow-2xl backdrop-blur-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Create your workspace</CardTitle>
            <p className="text-sm text-muted-foreground">
              A workspace holds agent runs, prompts, ingest tokens, model keys,
              trial eval credits, and the people who review them.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="org-name">Organization name</Label>
                <Input
                  id="org-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Inc."
                  autoFocus
                />
              </div>
              {slug && (
                <p className="text-sm text-muted-foreground">
                  Your URL: <span className="font-mono">blindbench.dev/orgs/{slug}</span>
                </p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                type="submit"
                className="w-full"
                disabled={saving || !name.trim() || !slug}
              >
                {saving ? "Creating..." : "Create"}
              </Button>
            </form>
            <div className="mt-4 text-center">
              <button
                onClick={() => void signOut()}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Sign out
              </button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
