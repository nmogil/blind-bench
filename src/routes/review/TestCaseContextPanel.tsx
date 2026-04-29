import { useState } from "react";
import { ImageIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type TestCaseContext = {
  id: string;
  name: string;
  variableValues: Record<string, string>;
  imageVariables: Array<{
    name: string;
    url: string;
    sizeBytes: number;
    mimeType: string;
  }>;
};

export type ProjectVariable = {
  name: string;
  type: "text" | "image";
  description: string | null;
};

type Props = {
  testCase: TestCaseContext | null;
  variables: ProjectVariable[];
  className?: string;
};

/**
 * Renders the input context for a single review card: variable name → text
 * value or image thumbnail. Click an image to open it at full size.
 *
 * Blind-eval safe: the data passed in carries only test-case identity (which
 * is shared across versions in cycles) and Convex storage URLs (opaque
 * tokens). No version/run/output IDs are referenced.
 */
export function TestCaseContextPanel({ testCase, variables, className }: Props) {
  const [lightbox, setLightbox] = useState<
    { url: string; name: string } | null
  >(null);

  if (!testCase) {
    return (
      <div
        className={cn(
          "rounded-md border bg-background p-2.5 text-xs text-muted-foreground",
          className,
        )}
      >
        No test case bound to this output.
      </div>
    );
  }

  const imageByName = new Map(
    testCase.imageVariables.map((iv) => [iv.name, iv]),
  );
  const orderedNames =
    variables.length > 0
      ? variables.map((v) => v.name)
      : Object.keys(testCase.variableValues);

  return (
    <div
      className={cn(
        "rounded-md border bg-background p-2.5 text-xs",
        className,
      )}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">Test case</span>
        <span className="truncate text-muted-foreground">{testCase.name}</span>
      </div>

      <dl className="space-y-2.5">
        {orderedNames.map((name) => {
          const variable = variables.find((v) => v.name === name);
          const isImage = variable?.type === "image";
          const image = imageByName.get(name);
          const textValue = testCase.variableValues[name];

          if (isImage) {
            return (
              <div key={name} className="flex flex-col gap-1">
                <dt className="font-medium text-muted-foreground">
                  {`{{${name}}}`}
                </dt>
                <dd>
                  {image ? (
                    <button
                      type="button"
                      onClick={() =>
                        setLightbox({ url: image.url, name: image.name })
                      }
                      className="group inline-block overflow-hidden rounded border bg-muted/40 transition-colors hover:border-primary/60"
                      aria-label={`Open ${name} at full size`}
                    >
                      <img
                        src={image.url}
                        alt={`Value of ${name}`}
                        className="h-20 w-20 object-cover transition-transform group-hover:scale-105"
                      />
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground italic">
                      <ImageIcon className="size-3" />
                      not provided
                    </span>
                  )}
                </dd>
              </div>
            );
          }

          if (textValue === undefined || textValue === "") return null;

          return (
            <div key={name} className="flex flex-col gap-1">
              <dt className="font-medium text-muted-foreground">
                {`{{${name}}}`}
              </dt>
              <dd className="whitespace-pre-wrap break-words text-foreground">
                {textValue}
              </dd>
            </div>
          );
        })}
      </dl>

      <Dialog open={lightbox !== null} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent
          className="max-w-[min(95vw,1100px)] sm:max-w-[min(95vw,1100px)]"
          showCloseButton
        >
          <DialogTitle className="sr-only">
            {lightbox ? `Image value of ${lightbox.name}` : "Image preview"}
          </DialogTitle>
          {lightbox && (
            <img
              src={lightbox.url}
              alt={`Full-size value of ${lightbox.name}`}
              className="max-h-[80dvh] w-full rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
