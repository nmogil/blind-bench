import { useState } from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { Menu, XIcon } from "lucide-react";
import { SideNavContent } from "./SideNavContent";
import { useOrgLayout } from "@/components/layouts/OrgLayout";

/**
 * Mobile navigation drawer — hamburger trigger + left-sliding Sheet. Rendered
 * only on mobile (< md) by TopBar; desktop uses the always-visible `SideNav`.
 *
 * Reuses `SideNavContent` to keep a single source of truth for nav structure.
 * The drawer closes automatically when a NavLink is clicked (`onNavigate`).
 */
export function MobileNavDrawer() {
  const { openNewProjectDialog } = useOrgLayout();
  const [open, setOpen] = useState(false);

  return (
    <DrawerPrimitive.Root open={open} onOpenChange={setOpen}>
      <DrawerPrimitive.Trigger
        aria-label="Open navigation"
        className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:hidden"
      >
        <Menu className="h-5 w-5" />
      </DrawerPrimitive.Trigger>
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DrawerPrimitive.Popup
          aria-label="Primary navigation"
          className="fixed left-0 top-0 z-50 flex h-full w-72 flex-col gap-1 bg-popover p-3 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-hidden duration-200 data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
        >
          <div className="flex items-center justify-end pb-1">
            <DrawerPrimitive.Close
              aria-label="Close navigation"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <XIcon className="h-4 w-4" />
            </DrawerPrimitive.Close>
          </div>
          <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
            <SideNavContent
              onNewProject={openNewProjectDialog}
              onNavigate={() => setOpen(false)}
            />
          </nav>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
